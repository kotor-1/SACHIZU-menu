/**
 * Running Prescription Engine v2 — Readiness の入出力型（§13）。
 *
 * [R5 helper file] §22 R5 の新規ファイル一覧には無いが、painGate / actions / swap / aiSafeContext と
 * planning が同じ型を参照するため、循環 import を避ける目的でここに集約する。しきい値・red flag グループ・
 * SWAP 先などの**データは一切持たない**（すべて RuleSet.readinessRules）。
 *
 * [R5 representation errata]（§13 に記載）:
 *   - §13.2 の「`STOP` + `MEDICAL_EVALUATION_RECOMMENDED`」のような複合出力は、単一 enum の
 *     `SafetyOutcome` に潰さず `stopPlanning: boolean` と `safetyOutcome` に分けて表す。
 *   - `ReadinessDecision` は「その日の判断」であり、健康情報そのものは持たない（部位・red flag・尺度値を含めない）。
 *     `transientFindings` は UI 表示用でプレスクリプションには保存しない。
 *   - `readinessWindowState` は R7（週次）を先取りしないための明示的な状態。`NOT_EVALUATED` を `ACTIVE` と推測しない。
 */
import { z } from "zod";
import { isoDateSchema } from "../types/primitives";
import { findingSchema } from "../types/findings";
import { readinessActionCodeSchema, safetyOutcomeSchema, type ReadinessActionCode } from "../types/readiness";
import { runningTrainingMethodSchema } from "../types/method";
import { loadClassSchema } from "../rules/schema";
import { AGE_BANDS } from "../types/subject";

/**
 * §13.3 の「readiness 窓（§12.3）内」を R5 で評価するための状態。窓の判定そのものは R7（週次）の責務。
 *   ACTIVE        = 窓の中（48–72h に高強度イベント等）。missing-wellness ルールを適用する
 *   INACTIVE      = 窓の外。適用しない
 *   NOT_EVALUATED = 週次評価が未接続（R4/R5 の既定）。ACTIVE と推測しない
 */
export const READINESS_WINDOW_STATES = ["ACTIVE", "INACTIVE", "NOT_EVALUATED"] as const;
export const readinessWindowStateSchema = z.enum(READINESS_WINDOW_STATES);
export type ReadinessWindowState = z.infer<typeof readinessWindowStateSchema>;

/** ResolvedAgeBand（R3 context 層の観測状態）を Zod でも受け取れるようにしたもの。UNKNOWN を U12 等へ偽装しない。 */
export const resolvedAgeBandSchema = z.union([z.enum(AGE_BANDS), z.literal("UNKNOWN")]);

export const readinessContextSchema = z
  .object({
    /** 評価基準日。RuleSet の選択に使う（domain は現在時刻を読まない）。 */
    planningDate: isoDateSchema,
    /** R3 が解決した年齢帯（UNKNOWN を含む）。 */
    ageBand: resolvedAgeBandSchema,
    /** これから計画する Method（§13.2 の「計画に HIGH_* あり」の判定に使う）。 */
    method: runningTrainingMethodSchema,
    /**
     * 任意。渡した場合は RuleSet の MethodMeta.loadClass と一致しなければならない
     * （真実の出所を二重化しないため、実際の判定には RuleSet の値を使う）。
     */
    loadClass: loadClassSchema.nullable().optional(),
    readinessWindowState: readinessWindowStateSchema,
  })
  .strict();
export type ReadinessContext = z.infer<typeof readinessContextSchema>;

/**
 * [R5 errata] 独立した signal（RuleSet の1行）ごとの **raw trigger**。
 *
 * effective action（`actions`）は優先順位で正規化した結果なので、CoachOverride で高優先 action が外れたり、
 * その Method には適用できなかったりしたときに「下位 signal から出ていた action」を復元できない。
 * 再正規化（§13.6）のために、どの signal がどの action を出したかを判断に持たせる。
 * 保持するのは RuleSet の rule id と action だけで、**健康情報の値そのものは持たない**（処方にも保存しない）。
 */
export const readinessTriggerSchema = z
  .object({ ruleId: z.string().min(1), actions: z.array(readinessActionCodeSchema).min(1) })
  .strict();
export type ReadinessTrigger = z.infer<typeof readinessTriggerSchema>;

export const readinessDecisionSchema = z
  .object({
    /** §13.3 の離散 action（優先順位順に正規化済み。倍率・係数は一切持たない）。 */
    actions: z.array(readinessActionCodeSchema),
    /** 正規化前の signal 単位の内訳（§13.6 の再正規化に使う）。 */
    triggers: z.array(readinessTriggerSchema),
    /** true = その日の走処方を作らない（§13.2 の STOP。override 不可）。 */
    stopPlanning: z.boolean(),
    safetyOutcome: safetyOutcomeSchema,
    /** AI に渡してよい当日のシグナル（§13.5）。健康情報そのものではない。 */
    highIntensityAllowedToday: z.union([z.boolean(), z.literal("UNKNOWN")]),
    /** 痛みの確認が取れていない（§13.2 NOT_ASKED）。override では解除できない。 */
    painCheckRequired: z.boolean(),
    /** UI 表示用。処方には保存しない（§13.5）。 */
    transientFindings: z.array(findingSchema),
    /** 判断に使った RuleSet。plan 側と一致しなければ適用しない。 */
    ruleSet: z
      .object({
        version: z.string().min(1),
        contentHash: z.string().min(1),
        status: z.enum(["DRAFT", "ACTIVE", "RETIRED"]),
      })
      .strict(),
    /** 由来の記録（どの Method の文脈で評価したか）。action の適用は Method ごとの意味で行う。 */
    evaluatedFor: z
      .object({ method: runningTrainingMethodSchema, loadClass: loadClassSchema })
      .strict(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.stopPlanning && d.highIntensityAllowedToday !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stopPlanning=true のとき highIntensityAllowedToday は false です",
        path: ["highIntensityAllowedToday"],
      });
    }
    if (d.actions.includes("NO_CHANGE") && d.actions.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "NO_CHANGE は他の action と併存できません（§13.3）",
        path: ["actions"],
      });
    }
    if (new Set(d.actions).size !== d.actions.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "actions に重複があります", path: ["actions"] });
    }
    // actions は triggers の正規化結果でなければならない（片方だけを書き換えた判断を受け付けない）。
    const fromTriggers = normalizeReadinessActions(d.triggers.flatMap((t) => t.actions));
    const expected = fromTriggers.length > 0 ? fromTriggers : (["NO_CHANGE"] as ReadinessActionCode[]);
    if (JSON.stringify(expected) !== JSON.stringify(d.actions)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actions は triggers を優先順位で正規化した結果と一致する必要があります",
        path: ["actions"],
      });
    }
    // §13.6: 高強度をやめる判断（CANCEL / SWAP）が出ている日は highIntensityAllowedToday を true にしない。
    const blocksHighIntensity = d.actions.includes("CANCEL_HIGH_INTENSITY") || d.actions.includes("SWAP_TO_LOWER_LOAD_METHOD");
    if (blocksHighIntensity && d.highIntensityAllowedToday === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "CANCEL_HIGH_INTENSITY / SWAP_TO_LOWER_LOAD_METHOD があるとき highIntensityAllowedToday は true になりません",
        path: ["highIntensityAllowedToday"],
      });
    }
  });
export type ReadinessDecision = z.infer<typeof readinessDecisionSchema>;

/**
 * §13.3 の優先順位（明示された policy）。RuleSet のしきい値やグループとは別に、
 * action の強さの順序だけをここで固定する（配列順・ルール評価順に依存させないため）。
 */
export const READINESS_ACTION_PRIORITY = [
  "CANCEL_HIGH_INTENSITY",
  "SWAP_TO_LOWER_LOAD_METHOD",
  "USE_LOWER_BOUND",
  "INCREASE_REST",
  "REQUIRE_COACH_REVIEW",
  "NO_CHANGE",
] as const;

/** 収集した action を優先順位順に正規化する（重複除去、NO_CHANGE は単独のときだけ残す）。 */
export function normalizeReadinessActions(actions: Iterable<ReadinessActionCode>): ReadinessActionCode[] {
  const set = new Set(actions);
  if (set.size > 1) set.delete("NO_CHANGE");
  return READINESS_ACTION_PRIORITY.filter((a) => set.has(a));
}
