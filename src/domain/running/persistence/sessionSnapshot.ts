/**
 * Running Prescription Engine v2 — セッション作成時のスナップショットと planningSnapshotJson（§11.5・§12.2・§17.1–§17.3）。
 *
 * [R9] `createSessionFromMenu()`（repository）から呼ばれる、RuleSet に依存しない純粋関数だけを置く。
 *   - RuleSet loader / manifest / production RuleSet JSON / planner / 集計・週次の評価関数を import しない
 *     （§17.1 不変条件2。`tests/repository/running/` の import graph 監査で確認する）。
 *   - JSON が壊れていてもコピーを止めない・値を書き換えない。結果を `findings` に記録するだけ（§17.3）。
 *   - 集計（R6）・週次評価（R7）は RuleSet を必要とする domain policy なので、repository では評価しない。
 *     R10 の application layer が保存済みの ruleSetVersion + contentHash に一致する RuleSet で評価し、
 *     `SessionPlanningEvaluationInput` として渡す。渡されなければ NOT_EVALUATED（PLANNING_EVALUATION_NOT_SUPPLIED）。
 */
import { z } from "zod";
import { sessionAggregateSchema } from "../aggregation/schema";
import { isValidCalendarDate } from "../planning/schema";
import { findingSchema, type Finding } from "../types/findings";
import { historyCoverageLevelSchema, loadCategorySchema, loadEventSchema, type LoadCategory, type LoadSnapshot } from "../types/load";
import { runningTrainingMethodSchema } from "../types/method";
import { runningPrescriptionSchema } from "../types/prescription";
import { isoDateSchema, isoDateTimeSchema, type IsoDate, type IsoDateTime } from "../types/primitives";
import { parseJsonColumn } from "./jsonColumn";
import { provenanceSchema } from "./provenance";

// ---------------------------------------------------------------------------
// legacy Exercise.category → LoadCategory（§12.2）
// ---------------------------------------------------------------------------

/** §12.2 の legacy 行。ここに無い category は OTHER（強度は記録されていないため常に UNKNOWN 扱い）。 */
export const LEGACY_EXERCISE_LOAD_CATEGORY: Readonly<Record<string, LoadCategory>> = {
  SPRINT: "RUNNING_HIGH_INTENSITY",
  HURDLE: "HURDLES",
  JUMP: "PLYOMETRIC",
  STRENGTH: "STRENGTH",
};

export function legacyLoadCategoryOfExerciseCategory(category: string): LoadCategory {
  return LEGACY_EXERCISE_LOAD_CATEGORY[category] ?? "OTHER";
}

// ---------------------------------------------------------------------------
// v2 の loadSnapshot（plan 時点の MethodMeta のコピー）
// ---------------------------------------------------------------------------

/**
 * 保存済みの処方 JSON から plan 時点の loadSnapshot を読む。RuleSet には問い合わせない。
 * JSON が null / 壊れている / schema に合わない / loadSnapshot の無い旧 snapshot（R8 まで）なら null。
 */
export function snapshotLoadOfPrescriptionJson(prescriptionJson: string | null): LoadSnapshot | null {
  const parsed = parseJsonColumn(prescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
  return parsed.ok ? (parsed.value.loadSnapshot ?? null) : null;
}

/**
 * SessionItem.loadCategory のスナップショット値（Exercise 削除後・RuleSet 改版後も週次文脈に使う）。
 *   - RUNNING_V2: 処方 JSON の `loadSnapshot.weeklyLoadCategory`。読めないときだけ null
 *   - LEGACY で Exercise がある: §12.2 の対応表（表に無い category は OTHER）
 *   - LEGACY で Exercise が無い（自由入力）: null（履歴側で OTHER に落とす）
 */
export function snapshotLoadCategory(item: {
  prescriptionKind: string;
  prescriptionJson: string | null;
  exerciseCategory: string | null;
}): LoadCategory | null {
  if (item.prescriptionKind === "RUNNING_V2") return snapshotLoadOfPrescriptionJson(item.prescriptionJson)?.weeklyLoadCategory ?? null;
  if (item.prescriptionKind !== "LEGACY") return null;
  return item.exerciseCategory === null ? null : legacyLoadCategoryOfExerciseCategory(item.exerciseCategory);
}

export function loadCategoryOrNull(value: string | null): LoadCategory | null {
  const parsed = loadCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// SessionPlanningEvaluationInput（R10 application layer → repository の seam）
// ---------------------------------------------------------------------------

export const PLANNING_NOT_EVALUATED_REASONS = [
  /** repository に評価結果が渡されなかった（R9 の既定。FAIL ではない）。 */
  "PLANNING_EVALUATION_NOT_SUPPLIED",
  /** [R10] 48h/72h 窓に必要な plannedAt（タイムゾーン付き時刻）が無い（§12 [R7 errata]）。 */
  "PLANNED_AT_UNAVAILABLE",
  /** [R10] 同じメニューの RUNNING_V2 項目の ruleSetVersion / contentHash が混在（1版に統一しない）。 */
  "MIXED_RULESET_VERSIONS",
  /** [R10] 保存済みの ruleSetVersion + contentHash に一致する RuleSet を読めない（active 版で代用しない）。 */
  "RULESET_VERSION_UNAVAILABLE",
] as const;

const notEvaluatedSchema = z
  .object({
    status: z.literal("NOT_EVALUATED"),
    reasons: z.array(z.enum(PLANNING_NOT_EVALUATED_REASONS)).min(1),
  })
  .strict();

/** 評価に使った RuleSet（保存済み MenuItem の ruleSetVersion + contentHash と一致しなければ保存しない）。 */
const evaluatedRuleSetSchema = z.object({ version: z.string().min(1), contentHash: z.string().min(1) }).strict();

/** `WeeklyContextResult`（weekly/schema.ts の型）の保存用 schema。型との一致は tests で確認する。 */
export const weeklyContextResultSchema = z
  .object({
    evaluatedAt: isoDateTimeSchema.nullable(),
    coverage72h: z.union([historyCoverageLevelSchema, z.literal("NOT_EVALUATED")]),
    events48h: z.array(loadEventSchema),
    events72h: z.array(loadEventSchema),
    highSessions7d: z.number().int().nonnegative(),
    readinessRequired: z.boolean(),
    weeklyPositionCap: z.literal("LOWER_BOUND").nullable(),
    autogenBlockedMethods: z.array(runningTrainingMethodSchema),
    findings: z.array(findingSchema),
  })
  .strict();

const aggregationEvaluationInputSchema = z.discriminatedUnion("status", [
  notEvaluatedSchema,
  z.object({ status: z.literal("EVALUATED"), ruleSet: evaluatedRuleSetSchema, result: sessionAggregateSchema }).strict(),
]);

const weeklyEvaluationInputSchema = z.discriminatedUnion("status", [
  notEvaluatedSchema,
  z
    .object({
      status: z.literal("EVALUATED"),
      ruleSet: evaluatedRuleSetSchema,
      /** evaluateWeeklyContext は計画項目（Method / loadClass）ごとの評価なので、RUNNING_V2 の MenuItem ごとに持つ。 */
      items: z.array(z.object({ menuItemId: z.string().min(1), result: weeklyContextResultSchema }).strict()).min(1),
    })
    .strict(),
]);

export const sessionPlanningEvaluationInputSchema = z
  .object({
    aggregation: aggregationEvaluationInputSchema,
    weeklyContext: weeklyEvaluationInputSchema,
    findings: z.array(findingSchema),
  })
  .strict();
export type SessionPlanningEvaluationInput = z.input<typeof sessionPlanningEvaluationInputSchema>;

// ---------------------------------------------------------------------------
// planningSnapshotJson（保存形式 v1）
// ---------------------------------------------------------------------------

export const COMPETITION_LOAD_CATEGORIES = ["RACE", "RELAY"] as const;

export const planningSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    plannedDate: isoDateSchema.nullable(),
    plannedAt: isoDateTimeSchema.nullable(),
    aggregation: aggregationEvaluationInputSchema,
    weeklyContext: z.discriminatedUnion("status", [
      notEvaluatedSchema,
      z
        .object({
          status: z.literal("EVALUATED"),
          ruleSet: evaluatedRuleSetSchema,
          /** 保存時に repository が SessionItem.sortOrder を付ける（SessionItem は MenuItem を参照しないため）。 */
          items: z
            .array(z.object({ menuItemId: z.string().min(1), sortOrder: z.number().int().nonnegative(), result: weeklyContextResultSchema }).strict())
            .min(1),
        })
        .strict(),
    ]),
    /** 渡された評価の findings → repository の RuleSet 非依存なスナップショット検証の findings の順。 */
    findings: z.array(findingSchema),
    /**
     * [R11] 大会セッションの負荷カテゴリ（大会セッション作成時に設定）。無ければ load history は RACE を
     * 「generic competition running load fallback」として使う（個人種目だったと推定する意味ではない）。
     */
    competitionLoadCategory: z.enum(COMPETITION_LOAD_CATEGORIES).optional(),
  })
  .strict();
export type PlanningSnapshot = z.infer<typeof planningSnapshotSchema>;

/** セッションの日付入力から plannedDate / plannedAt を取り出す（時刻を補わない）。 */
export function plannedDateTimeOf(raw: string): { plannedDate: IsoDate | null; plannedAt: IsoDateTime | null } {
  const dateTime = isoDateTimeSchema.safeParse(raw);
  if (dateTime.success) {
    const date = raw.slice(0, 10);
    return isValidCalendarDate(date) ? { plannedDate: date as IsoDate, plannedAt: dateTime.data } : { plannedDate: null, plannedAt: null };
  }
  const date = isoDateSchema.safeParse(raw);
  return date.success && isValidCalendarDate(raw) ? { plannedDate: date.data, plannedAt: null } : { plannedDate: null, plannedAt: null };
}

export type SnapshotItemInput = {
  menuItemId: string;
  sortOrder: number;
  prescriptionKind: string;
  prescriptionJson: string | null;
  provenanceJson: string | null;
  ruleSetVersion: string | null;
  ruleSetContentHash: string | null;
  loadCategory: LoadCategory | null;
};

function snapshotFinding(code: string, severity: Finding["severity"], params: Record<string, string | number>): Finding {
  return { code, severity, scope: "ITEM", metric: Object.entries(params).map(([k, v]) => `${k}=${v}`).join(","), evidenceIds: [] };
}

/**
 * コピーした JSON 列を検証する（§17.3）。失敗しても例外にしない。metric には sortOrder・列名・理由コードだけを入れ、
 * JSON の内容や Zod のメッセージは入れない。
 */
export function snapshotItemFindings(items: readonly SnapshotItemInput[]): Finding[] {
  const findings: Finding[] = [];
  for (const item of items) {
    if (item.prescriptionKind !== "RUNNING_V2") continue;
    const prescription = parseJsonColumn(item.prescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
    if (!prescription.ok) {
      findings.push(
        snapshotFinding("SNAPSHOT_JSON_INVALID", "REQUIRE_COACH_REVIEW", { sortOrder: item.sortOrder, column: "plannedPrescriptionJson", reason: prescription.reason }),
      );
    }
    const provenance = parseJsonColumn(item.provenanceJson, provenanceSchema, { rejectHealthKeys: true });
    if (!provenance.ok) {
      findings.push(
        snapshotFinding("SNAPSHOT_JSON_INVALID", "REQUIRE_COACH_REVIEW", { sortOrder: item.sortOrder, column: "plannedProvenanceJson", reason: provenance.reason }),
      );
    }
    if (item.loadCategory === null) {
      // 壊れた JSON、または loadSnapshot の無い旧 snapshot のときだけ（R9 以降の新規保存では起きない）
      findings.push(snapshotFinding("SNAPSHOT_LOAD_CATEGORY_UNRESOLVED", "REQUIRE_COACH_REVIEW", { sortOrder: item.sortOrder }));
    }
  }
  return findings;
}

/** 渡された評価が、このメニューの保存済み項目と整合しているか（RuleSet を読まずに列だけで確認する）。 */
function evaluationIssues(evaluation: z.output<typeof sessionPlanningEvaluationInputSchema>, items: readonly SnapshotItemInput[]): string[] {
  const issues: string[] = [];
  const v2Items = items.filter((i) => i.prescriptionKind === "RUNNING_V2");
  const sameRuleSet = (item: SnapshotItemInput, ref: { version: string; contentHash: string }) =>
    item.ruleSetVersion === ref.version && item.ruleSetContentHash === ref.contentHash;

  if (evaluation.aggregation.status === "EVALUATED") {
    const ref = evaluation.aggregation.ruleSet;
    if (v2Items.some((i) => !sameRuleSet(i, ref))) {
      issues.push("aggregation の RuleSet がメニューの RUNNING_V2 項目の ruleSetVersion / contentHash と一致しません（混在時は NOT_EVALUATED）");
    }
  }
  if (evaluation.weeklyContext.status === "EVALUATED") {
    const ref = evaluation.weeklyContext.ruleSet;
    const seen = new Set<string>();
    for (const entry of evaluation.weeklyContext.items) {
      if (seen.has(entry.menuItemId)) issues.push("weeklyContext.items の menuItemId が重複しています");
      seen.add(entry.menuItemId);
      const item = v2Items.find((i) => i.menuItemId === entry.menuItemId);
      if (!item) issues.push("weeklyContext.items の menuItemId がこのメニューの RUNNING_V2 項目ではありません");
      else if (!sameRuleSet(item, ref)) issues.push("weeklyContext の RuleSet が項目の ruleSetVersion / contentHash と一致しません");
    }
  }
  return issues;
}

/**
 * planningSnapshotJson の内容を作る（書込み前・読み取り専用）。
 *   - evaluation あり: schema と、保存済み項目との整合（menuItemId・ruleSetVersion + contentHash）を確認して保存する。
 *     整合しない評価は保存しない（例外）
 *   - evaluation なし: aggregation / weeklyContext は NOT_EVALUATED（PLANNING_EVALUATION_NOT_SUPPLIED）
 */
export function buildPlanningSnapshot(args: {
  sessionDateInput: string;
  items: readonly SnapshotItemInput[];
  evaluation?: SessionPlanningEvaluationInput;
}): PlanningSnapshot {
  const { plannedDate, plannedAt } = plannedDateTimeOf(args.sessionDateInput);
  const snapshotFindings = snapshotItemFindings(args.items);
  const notSupplied = { status: "NOT_EVALUATED", reasons: ["PLANNING_EVALUATION_NOT_SUPPLIED"] } as const;

  if (args.evaluation === undefined) {
    return planningSnapshotSchema.parse({
      schemaVersion: 1,
      plannedDate,
      plannedAt,
      aggregation: notSupplied,
      weeklyContext: notSupplied,
      findings: snapshotFindings,
    });
  }

  const evaluation = sessionPlanningEvaluationInputSchema.parse(args.evaluation);
  const issues = evaluationIssues(evaluation, args.items);
  if (issues.length > 0) throw new Error(`planning evaluation をこのメニューの snapshot と一緒に保存できません: ${issues.join(" / ")}`);

  const sortOrderOf = new Map(args.items.map((i) => [i.menuItemId, i.sortOrder]));
  return planningSnapshotSchema.parse({
    schemaVersion: 1,
    plannedDate,
    plannedAt,
    aggregation: evaluation.aggregation,
    weeklyContext:
      evaluation.weeklyContext.status === "EVALUATED"
        ? {
            ...evaluation.weeklyContext,
            items: evaluation.weeklyContext.items.map((entry) => ({ menuItemId: entry.menuItemId, sortOrder: sortOrderOf.get(entry.menuItemId), result: entry.result })),
          }
        : evaluation.weeklyContext,
    findings: [...evaluation.findings, ...snapshotFindings],
  });
}
