/**
 * Running Prescription Engine v2 — PlanRequest / PlanResult の型と Zod schema（§9.1, §8.3, §19.1）。
 *
 * [R4 helper file] §22 R4 の新規ファイル一覧には無いが、planning/ 配下の複数 step
 * （normalize / eligibility / placement / build）が同じ入出力型を参照するため、
 * 循環 import を避ける目的でここに集約する。数値の閾値は一切持たない。
 *
 * [R4 errata]（§9.1 に記載）:
 *   - `planningDate: IsoDate` を追加（RuleSet 選択・ageBand・記録鮮度の評価基準日）。
 *     `menuContext.plannedDate` は null 可、非 null なら planningDate と一致必須。
 *     domain は `Date.now()` / `new Date()` を使わない。
 *   - `ruleSetVersion` は受け付けない（`.strict()` で拒否。§18.1）。
 *   - `coachReference` を追加（COACH だけが RACE_PACE / TARGET_SPLIT /
 *     VELOCITY_DECREMENT / COACH_DEFINED を入力できる）。
 *   - [R5] `readiness` は `ReadinessDecision | null`。**判定済みの decision だけ**を受け取り、生の
 *     `ReadinessReport`（pain / soreness / reporter 等）は `.strict()` が拒否する。健康情報の生値は
 *     PlanRequest に入れない（§13.5）。`null` = readiness 未接続（§13.2/§13.3 を評価しない）。
 *   - [R6] `menuContext.otherItems` は `AggregationItem[]`（§11）。**現在計画中の項目は含めない**
 *     （planning が1回だけ自分を足す。同じ項目を2回集計しない）。`menuContext.competitions` は R7 の型が
 *     未実装のため空配列固定のまま。`history`（R1 の LoadEvent）と `phase` は受け取るが R6 では
 *     評価しない（中立。R7 で接続）。これは最終的な PlanRequest contract ではない。
 */
import { z } from "zod";
import { TRAINING_PHASES } from "../../menu/constants";
import { isoDateSchema, isoDateTimeSchema, unitSchema } from "../types/primitives";
import { runningSelectionSchema, type RunningSelection } from "../types/template";
import { subjectSchema } from "../types/subject";
import { weeklyHistoryInputSchema } from "../types/load";
import { aiPlannerActorSchema, coachActorSchema, systemActorSchema } from "../types/actor";
import { intensityReferenceSchema, type IntensityReference } from "../types/intensity";
import { envelopeFieldSchema } from "../rules/schema";
import { readinessDecisionSchema } from "../readiness/schema";
import { aggregationItemSchema } from "../aggregation/schema";
import { competitionRefSchema } from "../competition/schema";
import type { Finding, FindingSeverity } from "../types/findings";
import type { EvidenceId } from "../types/primitives";
import type { RunningPrescriptionValue } from "../types/prescription";

// ---------------------------------------------------------------------------
// 日付（カレンダーとして実在するか）
// ---------------------------------------------------------------------------

/** YYYY-MM-DD が実在する日付か（`2026-02-30` を拒否する）。`Date` は使わない。 */
export function isValidCalendarDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

// ---------------------------------------------------------------------------
// coachReference（[R4 errata] COACH だけが入力できる強度参照）
// ---------------------------------------------------------------------------

/**
 * コーチが入力できる参照 kind。MEASURED_VMAX / FLY_SPLIT / SAME_DISTANCE_BEST は
 * 実測データ由来であり、コーチ入力で「実測」を偽装させないため含めない。
 */
export const COACH_REFERENCE_KINDS = ["RACE_PACE", "TARGET_SPLIT", "VELOCITY_DECREMENT", "COACH_DEFINED"] as const;
export type CoachReferenceKind = (typeof COACH_REFERENCE_KINDS)[number];
export type CoachReferenceInput = Extract<IntensityReference, { kind: CoachReferenceKind }>;

function isFilledPositiveInterval(v: { lower: number | null; upper: number | null }): boolean {
  return v.lower !== null && v.upper !== null && v.lower > 0 && v.upper > 0 && Number.isFinite(v.lower) && Number.isFinite(v.upper);
}

export const coachReferenceInputSchema = intensityReferenceSchema
  .superRefine((ref, ctx) => {
    if (!(COACH_REFERENCE_KINDS as readonly string[]).includes(ref.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `coachReference.kind=${ref.kind} はコーチ入力として受け付けません（実測参照を偽装しない）`,
        path: ["kind"],
      });
      return;
    }
    if (ref.kind === "RACE_PACE" && !isFilledPositiveInterval(ref.targetTimeS)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RACE_PACE.targetTimeS は lower/upper とも正の有限値が必要です",
        path: ["targetTimeS"],
      });
    }
    if (ref.kind === "TARGET_SPLIT") {
      ref.segments.forEach((seg, i) => {
        if (!isFilledPositiveInterval(seg.targetS)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "TARGET_SPLIT.segments[].targetS は lower/upper とも正の有限値が必要です",
            path: ["segments", i, "targetS"],
          });
        }
      });
    }
  })
  .transform((ref) => ref as CoachReferenceInput);

// ---------------------------------------------------------------------------
// CoachFieldEdit（コーチ入力。coachEditable 内で override 不要）
// ---------------------------------------------------------------------------

/**
 * [R4 errata] `approachDistanceM` は EnvelopeCell ではない（§7.4 R2 errata）が、
 * EVENT_APPROACH_SPEED の手入力値としてだけ CoachFieldEdit で受け付ける。
 */
export const COACH_EDIT_NON_ENVELOPE_FIELDS = ["approachDistanceM"] as const;
export const coachEditFieldSchema = z.union([envelopeFieldSchema, z.enum(COACH_EDIT_NON_ENVELOPE_FIELDS)]);
export type CoachEditField = z.infer<typeof coachEditFieldSchema>;

export const coachFieldEditSchema = z
  .object({
    field: coachEditFieldSchema,
    value: z.number().finite(),
    unit: unitSchema,
  })
  .strict();
export type CoachFieldEdit = z.infer<typeof coachFieldEditSchema>;

// ---------------------------------------------------------------------------
// CoachOverride（§8.3）
// ---------------------------------------------------------------------------

/**
 * [R5 errata] readiness の override は `CANCEL_HIGH_INTENSITY` **1種類だけ**（§13.2/§13.3）。
 * STOP / MEDICAL_EVALUATION_RECOMMENDED / PAIN_CHECK_REQUIRED / SWAP / USE_LOWER_BOUND /
 * INCREASE_REST は override 対象にできない（型として書けない）。
 */
export const coachOverrideTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ELIGIBILITY"), ruleId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("READINESS"), action: z.literal("CANCEL_HIGH_INTENSITY") }).strict(),
  z
    .object({
      kind: z.literal("FIELD"),
      field: envelopeFieldSchema,
      layer: z.enum(["COACH_EDITABLE", "HARD_SAFETY"]),
    })
    .strict(),
]);

export const coachOverrideSchema = z
  .object({
    target: coachOverrideTargetSchema,
    newValue: z.number().finite().optional(),
    reason: z.string().trim().min(10, "CoachOverride.reason は10文字以上必要です"),
    confirmedTwice: z.boolean(),
    actor: coachActorSchema,
    at: isoDateTimeSchema,
  })
  .strict()
  .superRefine((o, ctx) => {
    // [R5] READINESS override は confirmedTwice を要求しない（§8.3 の二重確認は ELIGIBILITY / HARD_SAFETY のみ）。
    const needsDoubleConfirm = o.target.kind === "ELIGIBILITY" || (o.target.kind === "FIELD" && o.target.layer === "HARD_SAFETY");
    if (needsDoubleConfirm && !o.confirmedTwice) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ELIGIBILITY / HARD_SAFETY の override は confirmedTwice=true が必須です（§8.3）",
        path: ["confirmedTwice"],
      });
    }
    if (o.target.kind === "FIELD" && o.newValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "FIELD override には newValue が必要です",
        path: ["newValue"],
      });
    }
    if (o.target.kind !== "FIELD" && o.newValue !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${o.target.kind} override は数値（newValue）を持てません`,
        path: ["newValue"],
      });
    }
  });
export type CoachOverride = z.infer<typeof coachOverrideSchema>;

// ---------------------------------------------------------------------------
// PlanRequest（§9.1 + R4 errata）
// ---------------------------------------------------------------------------

/**
 * `actor` は COACH の場合 branded `CoachActor` として解決する（plain object リテラルの
 * `{ kind: "COACH" }` を型として PlanRequest に入れられない）。認証ではない（R11）。
 */
export const planRequestActorSchema = z.union([coachActorSchema, aiPlannerActorSchema, systemActorSchema]);

export const menuContextSchema = z
  .object({
    phase: z.enum(TRAINING_PHASES).nullable(),
    plannedDate: isoDateSchema.nullable(),
    /**
     * [R7] 48h/72h を厳密に計算するための時刻。`plannedDate` が null なら必須で null。
     * `plannedDate` が非 null のとき、`plannedAt` は null（大会の「何日前」は date で評価できるが
     * 厳密な 48h/72h window は NOT_EVALUATED にする）か、`plannedDate` と同じ暦日でなければならない。
     * OS 時刻や 00:00/12:00/23:59 を補わない（§9.1・§12 [R7 errata]）。
     */
    plannedAt: isoDateTimeSchema.nullable(),
    /** [R7] §14 の大会近接ウィンドウ評価に使う。id の重複は拒否する。 */
    competitions: z.array(competitionRefSchema),
    /**
     * [R6] このメニューの**他の**項目（§11 の集計対象）。現在計画中の項目は含めない。
     * v2 の項目は完成した処方のスナップショット、legacy の項目は最小限の要約だけを渡す。
     */
    otherItems: z.array(aggregationItemSchema),
    availableMinutes: z.number().positive().finite().nullable(),
  })
  .strict()
  .superRefine((menu, ctx) => {
    if (menu.plannedDate === null && menu.plannedAt !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "plannedDate が無い場合 plannedAt も null である必要があります", path: ["plannedAt"] });
    }
    if (menu.plannedAt !== null && menu.plannedDate !== null && menu.plannedAt.slice(0, 10) !== menu.plannedDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "plannedAt の暦日は plannedDate と一致する必要があります",
        path: ["plannedAt"],
      });
    }
    const ids = new Set<string>();
    for (const [i, c] of menu.competitions.entries()) {
      if (ids.has(c.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `CompetitionRef.id が重複しています: ${c.id}`, path: ["competitions", i, "id"] });
      }
      ids.add(c.id);
    }
  });

export const planRequestSchema = z
  .object({
    planningDate: isoDateSchema,
    selection: runningSelectionSchema,
    subject: subjectSchema,
    menuContext: menuContextSchema,
    /** [R7 errata] §12 の正式 contract。coverage を明示させ、NONE を COMPLETE と取り違えない。 */
    history: weeklyHistoryInputSchema.nullable(),
    /** [R5] `resolveReadinessAction()` が返した判断のみ。生の ReadinessReport は `.strict()` が拒否する。 */
    readiness: readinessDecisionSchema.nullable(),
    positionPreference: z.enum(["LOWER", "MIDDLE"]).nullable(),
    coachEdits: z.array(coachFieldEditSchema),
    overrides: z.array(coachOverrideSchema),
    coachReference: coachReferenceInputSchema.nullable(),
    actor: planRequestActorSchema,
  })
  .strict()
  .superRefine((req, ctx) => {
    if (!isValidCalendarDate(req.planningDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "planningDate が実在する日付ではありません", path: ["planningDate"] });
    }
    if (req.menuContext.plannedDate !== null) {
      if (!isValidCalendarDate(req.menuContext.plannedDate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "menuContext.plannedDate が実在する日付ではありません",
          path: ["menuContext", "plannedDate"],
        });
      } else if (req.menuContext.plannedDate !== req.planningDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "menuContext.plannedDate が指定されている場合、planningDate と一致する必要があります（[R4 errata]）",
          path: ["menuContext", "plannedDate"],
        });
      }
    }

    if (req.actor.kind !== "COACH") {
      if (req.coachEdits.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `actor=${req.actor.kind} は coachEdits を持てません（§18）`, path: ["coachEdits"] });
      }
      if (req.overrides.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `actor=${req.actor.kind} は overrides を持てません（§18）`, path: ["overrides"] });
      }
      if (req.coachReference !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `actor=${req.actor.kind} は coachReference を持てません（[R4 errata]）`,
          path: ["coachReference"],
        });
      }
    }

    const editedFields = new Set<string>();
    req.coachEdits.forEach((edit, i) => {
      if (editedFields.has(edit.field)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `coachEdits に field の重複があります: ${edit.field}`, path: ["coachEdits", i, "field"] });
      }
      editedFields.add(edit.field);
    });

    const overrideKeys = new Set<string>();
    req.overrides.forEach((o, i) => {
      if (req.actor.kind === "COACH" && o.actor.ownerId !== req.actor.ownerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "override の actor は PlanRequest の actor（COACH）と一致する必要があります",
          path: ["overrides", i, "actor"],
        });
      }
      const key =
        o.target.kind === "ELIGIBILITY"
          ? `E:${o.target.ruleId}`
          : o.target.kind === "READINESS"
            ? `R:${o.target.action}`
            : `F:${o.target.field}`;
      if (overrideKeys.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `overrides の対象が重複しています: ${key}`, path: ["overrides", i, "target"] });
      }
      overrideKeys.add(key);
      if (o.target.kind === "FIELD" && editedFields.has(o.target.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `同じ field（${o.target.field}）に coachEdit と FIELD override を同時に指定できません（値の出所が曖昧になる）`,
          path: ["overrides", i, "target"],
        });
      }
    });
  });

export type PlanRequest = z.infer<typeof planRequestSchema>;

// ---------------------------------------------------------------------------
// PlanResult（§9.1）
// ---------------------------------------------------------------------------

export const ELIGIBILITY_REASON_CODES = [
  "ELIGIBILITY_RULE_INELIGIBLE",
  "CONSTRAINT_DISALLOWED",
  "ELIGIBILITY_CONDITIONS_UNMET",
  "ADVANCED_ONLY_NOT_PERMITTED",
  "AUTOGEN_NOT_ALLOWED_FOR_MANUAL_MODE",
  "CONDITIONAL_AUTO_REQUIRES_PHASE",
  "CONDITIONAL_AUTO_NOT_MET",
  "COMPLEXITY_ABOVE_AUTO_CAP",
  "OVERRIDE_REQUIRED",
  "OVERRIDE_NOT_ALLOWED",
  "REFERENCE_UNAVAILABLE",
  "LOW_CONFIDENCE_HIGH_METABOLIC_AUTOGEN_BLOCKED",
  /** [R5] その日の痛みの確認が取れていない状態での HIGH_*（§13.2 NOT_ASKED）。override では解除できない。 */
  "READINESS_CHECK_REQUIRED",
  /** [R5] §13.3 CANCEL_HIGH_INTENSITY。コーチのみ READINESS override で実施できる（確認要求は残る）。 */
  "READINESS_HIGH_INTENSITY_CANCELLED",
  /** [R5] §13.3 SWAP_TO_LOWER_LOAD_METHOD。黙って別 Method へ変換せず substitutes を返す（override 不可）。 */
  "READINESS_SWAP_RECOMMENDED",
  /** [R7] §14.3 PEAK×ADVANCED n5-7: LONG の recoveryStructure=INCOMPLETE を明示的に不適格にする。override 可。 */
  "COMPETITION_LONG_INCOMPLETE_BLOCKED",
  /** [R7] §12.3 / §14.3 由来の自動生成停止（hard ineligible ではない。COACH は手動 + REVIEW で継続可）。 */
  "WEEKLY_PHASE_COMPETITION_AUTOGEN_BLOCKED",
] as const;
export type EligibilityReasonCode = (typeof ELIGIBILITY_REASON_CODES)[number];

/** §22 R4 domain type。どの規則が、override 可能かどうかを必ず持つ。 */
export type EligibilityReason = {
  code: EligibilityReasonCode;
  /** 対象規則の id（EligibilityRule.ruleId / ConstraintRule.id / R4 の合成 gate id）。無ければ null。 */
  ruleId: string | null;
  overrideAllowed: boolean | null;
};

/**
 * [R4 errata] INELIGIBLE にも `findings` を持たせる。不適格の理由そのものは `reasons`（EligibilityReason）に置き、
 * `findings` には結果の種類に依らない横断情報（`RULESET_DRAFT`、NOT_EVALUATED 系、入力確認など）だけを置く
 * （同じ内容を二重化しない）。RuleSet を選んだ後の結果（OK / INELIGIBLE / BLOCKED）では、DRAFT RuleSet の使用が
 * 常に `RULESET_DRAFT` で観測できる。PlanRequest が parse できず RuleSet 選択前に BLOCKED になる場合は付かない。
 */
export type PlanResult =
  | { status: "OK"; prescription: RunningPrescriptionValue; sessionFindings: Finding[] }
  | { status: "INELIGIBLE"; reasons: EligibilityReason[]; substitutes: RunningSelection[]; findings: Finding[] }
  | { status: "BLOCKED"; findings: Finding[] };

// ---------------------------------------------------------------------------
// Finding helper（ITEM scope 固定。SESSION/WEEK は R6/R7）
// ---------------------------------------------------------------------------

export function itemFinding(
  code: string,
  severity: FindingSeverity,
  extra: Partial<Pick<Finding, "metric" | "value" | "limit">> & { evidenceIds?: EvidenceId[] } = {},
): Finding {
  return {
    code,
    severity,
    scope: "ITEM",
    ...(extra.metric !== undefined ? { metric: extra.metric } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
    ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
    evidenceIds: extra.evidenceIds ?? [],
  };
}
