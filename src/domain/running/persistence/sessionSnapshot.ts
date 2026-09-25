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
import { canonicalStringify, sha256Utf8Hex } from "../../shared/canonical-json";
import { canonicalPlausibilityIssueIdentity } from "../plausibility/review";
import { appliedPlausibilityReviewSchema } from "../types/plausibilityReview";
import { sessionAggregateSchema } from "../aggregation/schema";
import { isValidCalendarDate } from "../planning/schema";
import { findingSchema, type Finding, type FindingSeverity } from "../types/findings";
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
  /** [R10-B2] `MenuTemplate.runningContextJson` が無い・壊れている（policy 入力を捏造しない）。 */
  "RUNNING_CONTEXT_UNAVAILABLE",
  /** [R10-B2] `RunningMenuContext.plannedAt` の暦日が、実際にセッションを作成する日付と一致しない。 */
  "SESSION_DATE_CONTEXT_MISMATCH",
  /** [R10-B2] RUNNING_V2 項目の prescriptionJson が壊れていて、メニュー全体の集計を安全に計算できない。 */
  "SNAPSHOT_JSON_INVALID",
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

/**
 * [R11-B1] 明示確認の監査記録（`Provenance.findingConfirmations` と同形）。
 * 確認した Finding が無い保存では key 自体を持たない（`undefined`）。
 */
export const findingConfirmationsSchema = z
  .array(z.object({ code: z.string().min(1), at: isoDateTimeSchema }).strict())
  .max(50)
  .refine((list) => new Set(list.map((c) => c.code)).size === list.length, {
    message: "findingConfirmations に code の重複があります",
  })
  .optional();
export type FindingConfirmationRecord = { code: string; at: IsoDateTime };

const legacySessionReviewsSchema = z.array(z.object({
  menuItemId: z.string().min(1), review: appliedPlausibilityReviewSchema,
}).strict()).max(50).superRefine((entries, ctx) => {
  if (new Set(entries.map(({ review }) => review.issueDigest)).size !== entries.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate review" });
  for (const { review } of entries) {
    if (sha256Utf8Hex(canonicalStringify(canonicalPlausibilityIssueIdentity(review))) !== review.issueDigest) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Review digest mismatch" });
  }
}).optional();

export const sessionPlanningEvaluationInputSchema = z
  .object({
    aggregation: aggregationEvaluationInputSchema,
    weeklyContext: weeklyEvaluationInputSchema,
    findings: z.array(findingSchema),
    /**
     * [R10-B2] application layer が評価に使ったメニュー内容の指紋（§30〜§37 stale evaluation protection）。
     * `createSessionFromMenu()` が実際にコピーする直前の menu から同じ指紋を再計算し、一致しなければ
     * 保存全体を中止する。RuleSet を読まずに DB の生値だけで計算する（`buildSourceMenuFingerprint`）。
     */
    sourceMenuFingerprint: z.string().min(1),
    /**
     * [R11-B1] セッション作成時に、コーチが明示確認した REQUIRE_CONFIRMATION の監査記録
     * （backward-compatible optional）。**その作成時の評価に実在した code だけ**を記録する
     * （client が送った任意文字列は保存しない）。確認しても Finding は消さない（§23 別管理）。
     */
    findingConfirmations: findingConfirmationsSchema,
    legacyPlausibilityReviews: legacySessionReviewsSchema,
    reviewedItemIds: z.array(z.string().min(1)).max(1000).optional(),
    sourceMenuContextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  })
  .strict();
export type SessionPlanningEvaluationInput = z.input<typeof sessionPlanningEvaluationInputSchema>;

// ---------------------------------------------------------------------------
// sourceMenuFingerprint（R10-B2 stale evaluation protection）
// ---------------------------------------------------------------------------

/** 指紋の対象になる MenuItem の生値。実際に aggregation / weekly / legacy adapter が読む列だけを持つ。 */
export type FingerprintMenuItemInput = {
  id: string;
  sortOrder: number;
  prescriptionKind: string;
  ruleSetVersion: string | null;
  ruleSetContentHash: string | null;
  prescriptionJson: string | null;
  provenanceJson?: string | null;
  sets: number | null;
  reps: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  restSeconds: number | null;
  intensityPercent: number | null;
  loadKg: number | null;
  /** LEGACY 項目の Exercise.category（削除済み・自由入力なら null）。RUNNING_V2 は null。 */
  exerciseCategory: string | null;
};

export type FingerprintCanonicalItem = {
  id: string;
  sortOrder: number;
  prescriptionKind: string;
  ruleSetVersion: string | null;
  ruleSetContentHash: string | null;
  prescriptionJson: string | null;
  provenanceJson?: string | null;
  sets: number | null;
  reps: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  restSeconds: number | null;
  intensityPercent: number | null;
  loadKg: number | null;
  exerciseCategory: string | null;
};

/**
 * evaluation に影響しうる値だけを、決定的な順序・キーで並べた払い出し値にする（§31〜§34）。
 *   - 呼び出し側は「実際にセッションへコピーする順序」（block.sortOrder → item.sortOrder）で items を渡す。
 *     配列の順序自体が「項目の並び替え」の変化を検出する。sortOrder はさらに個々の値のズレも検出するための冗長な保険。
 *   - rationale・表示専用ラベルなど evaluation に影響しない値は含めない。
 *   - RuleSet loader を読まない・DB の生値だけで計算する（application service と repository の両方で
 *     同じ結果になることを保証するため）。
 *   - ここでは hash 計算をしない（`src/domain/running/**` は Node.js 組み込みモジュールに依存できない。
 *     §1.6）。呼び出し側（infra / actions）が `JSON.stringify` + SHA-256 で `sourceMenuFingerprint` にする。
 */
export function canonicalSourceMenuFingerprintPayload(items: readonly FingerprintMenuItemInput[]): FingerprintCanonicalItem[] {
  return items.map((i) => ({
    id: i.id,
    sortOrder: i.sortOrder,
    prescriptionKind: i.prescriptionKind,
    ruleSetVersion: i.ruleSetVersion,
    ruleSetContentHash: i.ruleSetContentHash,
    prescriptionJson: i.prescriptionJson,
    provenanceJson: i.provenanceJson ?? null,
    sets: i.sets,
    reps: i.reps,
    distanceMeters: i.distanceMeters,
    durationSeconds: i.durationSeconds,
    restSeconds: i.restSeconds,
    intensityPercent: i.intensityPercent,
    loadKg: i.loadKg,
    exerciseCategory: i.exerciseCategory,
  }));
}

// ---------------------------------------------------------------------------
// [R11-B1] Session 確認 challenge の canonicalization
// ---------------------------------------------------------------------------

/**
 * 確認対象 Finding の canonical 形。**localized message ではなく domain Finding の値**を使う
 * （`Finding` schema に実在する field だけ。存在しない field を作らない）。
 *
 * `code` が同じでも `value` / `limit` / `metric` / `scope` が変われば別物として扱う
 * （例: 総走行距離 9,000m の確認を 15,000m の確認へ流用できないようにする）。
 */
export type CanonicalConfirmationFinding = {
  code: string;
  severity: FindingSeverity;
  scope: Finding["scope"];
  metric: string | null;
  value: { lower: number | null; upper: number | null; unit: string } | null;
  limit: { min: number; max: number; unit: string } | null;
};

export function canonicalConfirmationFinding(finding: Finding): CanonicalConfirmationFinding {
  return {
    code: finding.code,
    severity: finding.severity,
    scope: finding.scope,
    metric: finding.metric ?? null,
    value: finding.value === undefined ? null : { lower: finding.value.lower, upper: finding.value.upper, unit: finding.value.unit },
    limit: finding.limit === undefined ? null : { min: finding.limit.min, max: finding.limit.max, unit: finding.limit.unit },
  };
}

/** canonical Finding を決定的な順序に並べる（順序差では digest を変えない。重複は件数ごと保持）。 */
function stableFindings(findings: readonly Finding[]): CanonicalConfirmationFinding[] {
  return findings
    .map(canonicalConfirmationFinding)
    .map((value) => ({ key: JSON.stringify(value), value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.value);
}

const sortedCopy = (values: readonly string[]): string[] => [...values].sort();

type CanonicalInterval = { lower: number | null; upper: number | null; unit: string; source: string; confidence: string };

function canonicalInterval(interval: {
  lower: number | null;
  upper: number | null;
  unit: string;
  source: string;
  confidence: string;
}): CanonicalInterval {
  return { lower: interval.lower, upper: interval.upper, unit: interval.unit, source: interval.source, confidence: interval.confidence };
}

type ParsedEvaluation = z.output<typeof sessionPlanningEvaluationInputSchema>;
type ParsedAggregate = Extract<ParsedEvaluation["aggregation"], { status: "EVALUATED" }>["result"];
type ParsedWeeklyResult = Extract<ParsedEvaluation["weeklyContext"], { status: "EVALUATED" }>["items"][number]["result"];

/**
 * [R11-B1.1] R6 集計結果の canonical 形（field 順を明示し、`JSON.stringify` に並び順を委ねない）。
 * null は保持する（「未実測だから 0」にしない R6 契約をそのまま digest へ反映する）。
 */
function canonicalAggregate(result: ParsedAggregate) {
  return {
    totalRunningDistanceM: canonicalInterval(result.totalRunningDistanceM),
    plannedHighSpeedExposureM: canonicalInterval(result.plannedHighSpeedExposureM),
    actualHighSpeedExposureM: result.actualHighSpeedExposureM === null ? null : canonicalInterval(result.actualHighSpeedExposureM),
    nearMaxSprintVolumeM: canonicalInterval(result.nearMaxSprintVolumeM),
    longSprintVolumeM: canonicalInterval(result.longSprintVolumeM),
    tempoVolumeM: canonicalInterval(result.tempoVolumeM),
    strideVolumeM: canonicalInterval(result.strideVolumeM),
    plyometricContacts: canonicalInterval(result.plyometricContacts),
    strengthLoad: result.strengthLoad,
    raceExposure: { count: result.raceExposure.count, distanceM: canonicalInterval(result.raceExposure.distanceM) },
    relayExposure: { count: result.relayExposure.count, legDistanceM: canonicalInterval(result.relayExposure.legDistanceM) },
    highIntensityBudgetUse: {
      recommended: result.highIntensityBudgetUse.recommended,
      coachEditable: result.highIntensityBudgetUse.coachEditable,
    },
    highIntensityMethods: sortedCopy(result.highIntensityMethods),
    completeness: result.completeness,
    findings: stableFindings(result.findings),
  };
}

/**
 * [R11-B1.1] R7 週次文脈の結果の canonical 形。
 *
 * **除外するもの**（意図的）:
 *   - `evaluatedAt`（時刻。同じ policy 結果なら同じ digest にする §9）
 *   - `events48h` / `events72h`（LoadEvent の生履歴。confirmation は raw source data ではなく
 *     **planning policy result** に対して行うという契約 §14/§21。履歴の中身が変わっても
 *     policy 結果が同一なら確認は有効）
 */
function canonicalWeeklyResult(result: ParsedWeeklyResult) {
  return {
    coverage72h: result.coverage72h,
    highSessions7d: result.highSessions7d,
    readinessRequired: result.readinessRequired,
    weeklyPositionCap: result.weeklyPositionCap,
    autogenBlockedMethods: sortedCopy(result.autogenBlockedMethods),
    findings: stableFindings(result.findings),
  };
}

export type CanonicalSessionConfirmationEvaluationPayload = {
  legacyReviewDigests?: { menuItemId: string; issueDigest: string }[];
  sourceMenuContextFingerprint?: string;
  schemaVersion: 1;
  sourceMenuFingerprint: string;
  aggregation:
    | { status: "NOT_EVALUATED"; reasons: string[] }
    | { status: "EVALUATED"; ruleSet: { version: string; contentHash: string }; result: ReturnType<typeof canonicalAggregate> };
  weeklyContext:
    | { status: "NOT_EVALUATED"; reasons: string[] }
    | {
        status: "EVALUATED";
        ruleSet: { version: string; contentHash: string };
        items: { menuItemId: string; result: ReturnType<typeof canonicalWeeklyResult> }[];
      };
  findings: CanonicalConfirmationFinding[];
};

/**
 * [R11-B1.1] 「コーチが確認した Session planning evaluation」の canonical payload。
 *
 * confirmation は **現在の policy 評価結果**に対して行うものなので、Menu の内容（`sourceMenuFingerprint`）だけでなく
 * 評価結果そのもの（R6 集計・R7 週次・全 Finding・評価できなかった理由・使った RuleSet identity）を対象にする。
 * これにより MenuItem が同じでも、対象グループ設定（availableMinutes / plannedAt）・大会文脈・週次結果が
 * 変わっていれば digest が変わり、以前の確認を流用できない。
 *
 * 含めないもの:
 *   - `findingConfirmations`（確認そのもの。challenge の入力へ循環させない §10）
 *   - 時刻（`evaluatedAt` など §9）・raw な LoadEvent 履歴（§14）
 *   - 健康 / readiness の生値（そもそも evaluation に含まれない §11）
 *
 * hash はここで計算しない（`src/domain/running/**` は Node 組み込みに依存できない §1.6）。
 */
export function canonicalSessionConfirmationEvaluationPayload(
  evaluation: SessionPlanningEvaluationInput,
): CanonicalSessionConfirmationEvaluationPayload {
  const parsed = sessionPlanningEvaluationInputSchema.parse(evaluation);
  return {
    schemaVersion: 1,
    sourceMenuFingerprint: parsed.sourceMenuFingerprint,
    aggregation:
      parsed.aggregation.status === "EVALUATED"
        ? {
            status: "EVALUATED",
            ruleSet: { version: parsed.aggregation.ruleSet.version, contentHash: parsed.aggregation.ruleSet.contentHash },
            result: canonicalAggregate(parsed.aggregation.result),
          }
        : { status: "NOT_EVALUATED", reasons: sortedCopy(parsed.aggregation.reasons) },
    weeklyContext:
      parsed.weeklyContext.status === "EVALUATED"
        ? {
            status: "EVALUATED",
            ruleSet: { version: parsed.weeklyContext.ruleSet.version, contentHash: parsed.weeklyContext.ruleSet.contentHash },
            items: [...parsed.weeklyContext.items]
              .map((item) => ({ menuItemId: item.menuItemId, result: canonicalWeeklyResult(item.result) }))
              .sort((a, b) => (a.menuItemId < b.menuItemId ? -1 : a.menuItemId > b.menuItemId ? 1 : 0)),
          }
        : { status: "NOT_EVALUATED", reasons: sortedCopy(parsed.weeklyContext.reasons) },
    findings: stableFindings(parsed.findings),
    ...(parsed.legacyPlausibilityReviews ? { legacyReviewDigests: parsed.legacyPlausibilityReviews.map(({ menuItemId, review }) => ({ menuItemId, issueDigest: review.issueDigest })).sort((a,b) => a.issueDigest.localeCompare(b.issueDigest)) } : {}),
  };
}

/** 確認 challenge の payload（決定的。時刻・乱数・秘密鍵を含めない）。 */
export type CanonicalConfirmationChallengePayload = {
  schemaVersion: 2;
  menuTemplateId: string;
  sessionDate: string;
  sourceMenuFingerprint: string;
  /** [R11-B1.1] 現在の planning evaluation 全体の digest（`canonicalSessionConfirmationEvaluationPayload` の hash）。 */
  evaluationDigest: string;
  /** 明示確認の対象（意味を明確にするため、digest とは別に列挙する）。 */
  requiredFindings: CanonicalConfirmationFinding[];
};

/**
 * [R11-B1] コーチが「見た評価」と「保存直前に server が再評価した内容」を照合するための payload。
 * [R11-B1.1] Menu の指紋と確認対象 Finding だけでなく、**evaluation 全体の digest** を含める（schemaVersion 2）。
 *
 *   - **時刻・乱数・確認時刻を含めない**（同じ評価なら再計算で必ず同じ値になる。§14）
 *   - 健康情報・readiness の生値は含めない（§44）
 *   - 配列順の違いだけで値が変わらないよう安定ソートする。同一 Finding の重複は件数も含めて保持する
 *   - ここでは hash を計算しない（§1.6）。呼び出し側（actions）が SHA-256 で challenge 文字列にする
 */
export function canonicalConfirmationChallengePayload(args: {
  menuTemplateId: string;
  sessionDate: string;
  sourceMenuFingerprint: string;
  evaluationDigest: string;
  findings: readonly Finding[];
}): CanonicalConfirmationChallengePayload {
  return {
    schemaVersion: 2,
    menuTemplateId: args.menuTemplateId,
    sessionDate: args.sessionDate,
    sourceMenuFingerprint: args.sourceMenuFingerprint,
    evaluationDigest: args.evaluationDigest,
    requiredFindings: stableFindings(args.findings.filter((f) => f.severity === "REQUIRE_CONFIRMATION")),
  };
}

/**
 * [R10-B2 §35・§36] application service が評価した時点の menu と、`createSessionFromMenu()` が
 * 実際にコピーする直前の menu とで `sourceMenuFingerprint` が一致しないときに投げる。
 * transaction 全体を中止する（Session row を作らない）。メッセージはそのまま Action の表示に使える。
 */
export class PlanningEvaluationStaleError extends Error {
  constructor() {
    super("メニュー内容が更新されたため、もう一度開始してください");
    this.name = "PlanningEvaluationStaleError";
  }
}

// ---------------------------------------------------------------------------
// planningSnapshotJson（保存形式 v1）
// ---------------------------------------------------------------------------

export const COMPETITION_LOAD_CATEGORIES = ["RACE", "RELAY"] as const;

export const competitionLoadCategoriesSchema = z.union([
  z.tuple([z.literal("RACE")]),
  z.tuple([z.literal("RELAY")]),
  z.tuple([z.literal("RACE"), z.literal("RELAY")]),
]);
export type CompetitionLoadCategories = z.infer<typeof competitionLoadCategoriesSchema>;

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
     * [R11-B6] 旧大会セッションの read compatibility 専用。新規writerはplural fieldだけを保存する。
     * 無ければ load history は RACE を「generic competition running load fallback」として使う
     * （個人種目だったと推定する意味ではない）。
     */
    competitionLoadCategory: z.enum(COMPETITION_LOAD_CATEGORIES).optional(),
    /**
     * [R11-B6] 新規の大会実績が持つ category 集合。順序も schema の一部であり、
     * RACE → RELAY 以外の順序・重複・空配列を保存しない。旧 singular field とは排他的。
     */
    competitionLoadCategories: competitionLoadCategoriesSchema.optional(),
    /** [R10-B2] 保存時点の監査用（stale check 自体は書込み前に完了済み）。評価が無ければ持たない。 */
    sourceMenuFingerprint: z.string().min(1).optional(),
    /**
     * [R11-B1] セッション作成時にコーチが明示確認した REQUIRE_CONFIRMATION の監査記録。
     * 旧 snapshot はこの key を持たない（optional。schemaVersion は 1 のまま）。
     */
    findingConfirmations: findingConfirmationsSchema,
    legacyPlausibilityReviews: legacySessionReviewsSchema,
    reviewedItemIds: z.array(z.string().min(1)).max(1000).optional(),
    sourceMenuContextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.competitionLoadCategory !== undefined && snapshot.competitionLoadCategories !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["competitionLoadCategories"],
        message: "competition load category の singular / plural は同時に保存できません",
      });
    }
  });
export type PlanningSnapshot = z.infer<typeof planningSnapshotSchema>;

export type CompetitionLoadCategoriesReadResult =
  | {
      kind: "RESOLVED";
      source: "PLURAL" | "LEGACY_SINGULAR" | "HISTORICAL_FALLBACK";
      categories: CompetitionLoadCategories;
    }
  | {
      kind: "UNREADABLE";
      reason: "INVALID_PLURAL" | "CONFLICTING_FIELDS" | "UNKNOWN_VERSION";
    };

/**
 * Competition Session の負荷 category を snapshot だけから読む。
 *
 * 完全に壊れた旧 JSON と category key の無い旧行は historical generic RACE を維持する。
 * 一方、plural key が見える新形式は corruption を識別できるため、推測で RACE に落とさない。
 */
export function readCompetitionLoadCategories(raw: string | null): CompetitionLoadCategoriesReadResult {
  if (raw === null) return { kind: "RESOLVED", source: "HISTORICAL_FALLBACK", categories: ["RACE"] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "RESOLVED", source: "HISTORICAL_FALLBACK", categories: ["RACE"] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "RESOLVED", source: "HISTORICAL_FALLBACK", categories: ["RACE"] };
  }

  const record = value as Record<string, unknown>;
  const hasPlural = Object.prototype.hasOwnProperty.call(record, "competitionLoadCategories");
  const hasSingular = Object.prototype.hasOwnProperty.call(record, "competitionLoadCategory");
  if (hasPlural && hasSingular) return { kind: "UNREADABLE", reason: "CONFLICTING_FIELDS" };
  if (hasPlural) {
    if (record.schemaVersion !== 1) return { kind: "UNREADABLE", reason: "UNKNOWN_VERSION" };
    const parsed = planningSnapshotSchema.safeParse(value);
    if (!parsed.success || parsed.data.competitionLoadCategories === undefined) {
      return { kind: "UNREADABLE", reason: "INVALID_PLURAL" };
    }
    return { kind: "RESOLVED", source: "PLURAL", categories: parsed.data.competitionLoadCategories };
  }

  const parsed = planningSnapshotSchema.safeParse(value);
  if (hasSingular && parsed.success && parsed.data.competitionLoadCategory !== undefined) {
    return { kind: "RESOLVED", source: "LEGACY_SINGULAR", categories: [parsed.data.competitionLoadCategory] };
  }
  return { kind: "RESOLVED", source: "HISTORICAL_FALLBACK", categories: ["RACE"] };
}

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
  for (const { menuItemId, review } of evaluation.legacyPlausibilityReviews ?? []) {
    if (!items.some((item) => item.menuItemId === menuItemId && item.prescriptionKind !== "RUNNING_V2") ||
        evaluation.aggregation.status !== "EVALUATED" || review.ruleSet.version !== evaluation.aggregation.ruleSet.version ||
        review.ruleSet.contentHash !== evaluation.aggregation.ruleSet.contentHash) issues.push("Legacy review binding mismatch");
  }
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
    sourceMenuFingerprint: evaluation.sourceMenuFingerprint,
    ...(evaluation.legacyPlausibilityReviews?.length ? { legacyPlausibilityReviews: evaluation.legacyPlausibilityReviews } : {}),
    ...(evaluation.reviewedItemIds ? { reviewedItemIds: evaluation.reviewedItemIds } : {}),
    ...(evaluation.sourceMenuContextFingerprint ? { sourceMenuContextFingerprint: evaluation.sourceMenuContextFingerprint } : {}),
    // [R11-B1] 確認が無い作成では key 自体を持たせない（旧 snapshot と同じ形）。
    ...(evaluation.findingConfirmations !== undefined && evaluation.findingConfirmations.length > 0
      ? { findingConfirmations: evaluation.findingConfirmations }
      : {}),
  });
}

/** R11-B6 actual competition record 用。planning policy を評価せず、category 集合だけを明示保存する。 */
export function buildCompetitionPlanningSnapshot(
  sessionDateInput: string,
  categories: CompetitionLoadCategories,
): PlanningSnapshot {
  const base = buildPlanningSnapshot({ sessionDateInput, items: [] });
  return planningSnapshotSchema.parse({ ...base, competitionLoadCategories: categories });
}
