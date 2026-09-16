/**
 * Running Prescription Engine v2 — RuleSet schema（§6.1, §7.2, §19.1）。
 *
 * R2 の中心ファイル。versioned RuleSet JSON（`rules/sets/<version>.json`）の
 * 形と、正式仕様§19.1が要求する cross-validation を実装する。
 *
 * 重要: このファイルは「型と Zod schema」のみ。実際の数値・Evidence・
 * Template 一覧などのデータは `rules/sets/rs-2026.09.0.json` に置く
 * （Fable H-9 / 監査 L-3・M-7 の再発防止 — TS に数値を直書きしない）。
 *
 * R2 で意図的にまだ実装しないもの（§22 R2 のスコープ外）:
 *   - eligibility / plausibility / timing tolerance / stop policy を
 *     「評価する」関数（データ構造のみ。評価はR3以降）
 *   - aggregationRules / weeklyRules / readinessRules / phaseRules /
 *     competitionRules の実データ（R2では必ず空配列。z.never() で
 *     スキーマ上も「今は空である」ことを強制する）
 *   - constraints（R3 の動的 Constraint。§4.4 の Eligibility とは別概念。
 *     R2では空配列固定）
 */
import { z } from "zod";
import {
  RUNNING_TRAINING_METHODS,
  runningTrainingMethodSchema,
  type RunningTrainingMethod,
} from "../types/method";
import {
  runningSelectionSchema,
  recoveryStructureSchema,
  ALL_TEMPLATE_IDS,
  TEMPLATE_IDS_BY_METHOD,
} from "../types/template";
import {
  RACE_EVENTS,
  anyUnitRangeSchema,
  evidenceIdSchema,
  isoDateSchema,
  raceEventSchema,
  stopPolicyIdSchema,
} from "../types/primitives";
import { ageBandSchema, ENVELOPE_TIERS, envelopeTierSchema, trainingAgeTierSchema } from "../types/subject";
import { loadCategorySchema } from "../types/load";
import { TRAINING_PHASES } from "../../menu/constants";
import { rangePositionSchema } from "../types/prescription";
import { INTENSITY_REFERENCE_KINDS, TIMED_MARK_EVENTS, timedMarkEventSchema, timingMethodSchema } from "../types/intensity";
import { RED_FLAGS, bodyRegionSchema, readinessActionCodeSchema, redFlagSchema, safetyOutcomeSchema } from "../types/readiness";
import { evidenceRecordSchema } from "../evidence/schema";
import { stopPolicyRuntimeIssues, stopPolicyRuntimeSchema } from "../types/monitoring";

// ---------------------------------------------------------------------------
// Template id 名前空間チェック（§3.3, §22 R2 完了条件）
// ---------------------------------------------------------------------------

/** Method ごとの template id 接頭辞。§3.3 の命名（ACC_/MV_/SES_/... ）をそのままデータ化。 */
const TEMPLATE_ID_PREFIX_BY_METHOD: Record<RunningTrainingMethod, string> = {
  ACCELERATION: "ACC_",
  MAX_VELOCITY: "MV_",
  SPRINT_ENDURANCE_SHORT: "SES_",
  LONG_SPRINT_RACE_SPECIFIC: "LSR_",
  TEMPO_EXTENSIVE: "TE_",
  TEMPO_INTENSIVE: "TI_",
  RESISTED_SPRINT: "RS_",
  ASSISTED_SPRINT: "AS_",
  EVENT_APPROACH_SPEED: "EA_",
  STRIDE: "ST_",
};

const runningTrainingMethodSet = new Set<string>(RUNNING_TRAINING_METHODS);

// ---------------------------------------------------------------------------
// MethodMeta（§3.2）
// ---------------------------------------------------------------------------

export const LOAD_CLASSES = ["HIGH_NEURAL", "HIGH_METABOLIC", "MODERATE", "LOW"] as const;
export const loadClassSchema = z.enum(LOAD_CLASSES);
export type LoadClass = z.infer<typeof loadClassSchema>;

export const PRIMARY_DOSE_UNITS = ["DISTANCE", "DURATION", "ATTEMPTS"] as const;
export const primaryDoseUnitSchema = z.enum(PRIMARY_DOSE_UNITS);

export const HIGH_SPEED_EXPOSURE_MODELS = [
  "NONE",
  "FLY_ZONE",
  "DISTANCE_MINUS_ACCEL_INTERVAL",
  "WHOLE_REP",
] as const;
export const highSpeedExposureModelSchema = z.enum(HIGH_SPEED_EXPOSURE_MODELS);

const intensityReferenceKindSchema = z.enum(
  INTENSITY_REFERENCE_KINDS as unknown as [string, ...string[]],
);

export const methodMetaSchema = z.object({
  method: runningTrainingMethodSchema,
  loadClass: loadClassSchema,
  weeklyLoadCategory: loadCategorySchema,
  primaryDoseUnit: primaryDoseUnitSchema,
  allowedIntensityReferences: z.array(intensityReferenceKindSchema).min(1),
  intensityFallback: intensityReferenceKindSchema.nullable(),
  highSpeedExposureModel: highSpeedExposureModelSchema,
  requiresRecoveryStructure: z.boolean(),
  enabledByDefault: z.boolean(),
  advancedOnly: z.boolean(),
  stopPolicyIds: z.array(stopPolicyIdSchema).min(1),
});
export type MethodMeta = z.infer<typeof methodMetaSchema>;

// ---------------------------------------------------------------------------
// SessionTemplate（データ実体。§3.3）
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] SessionTemplate.startType は §3.3 で
 * `"BLOCK" | "THREE_POINT" | "STANDING" | "FALLING" | "FLYING"`（5値）と
 * 定義されている。R1 の `types/intensity.ts` の `START_TYPES`（TimedMark 用、
 * 4値・FALLING を含まない）とは仕様上ハッキリ別の enum（§2 と §3.3 で
 * 値の数が異なる）なので、混同せずここで独立に定義する。
 */
export const SESSION_TEMPLATE_START_TYPES = [
  "BLOCK",
  "THREE_POINT",
  "STANDING",
  "FALLING",
  "FLYING",
] as const;
export const sessionTemplateStartTypeSchema = z.enum(SESSION_TEMPLATE_START_TYPES);

const sessionTemplateIdSchema = z.enum(ALL_TEMPLATE_IDS as unknown as [string, ...string[]]);
const raceEventForTemplateSchema = z.enum(["100m", "200m", "400m", "400mH"]);

/**
 * §7.5 の complexity（LOW < MEDIUM < HIGH）。
 *
 * [R3 gap-fill] R2 実装時に `ruleSetSessionTemplateSchema` へ `complexity`
 * フィールドを追加し忘れており、§7.5 の分類表が JSON 化されていなかった
 * （R2 の他のセクション — methods/envelopes/evidence/timing/stopPolicies/
 * plausibility の実数値・実データ — はこの変更で一切変えていない）。
 * R3 の Constraint 層（§7.5「maturity ∈ {PRE, EFFECTIVE_UNKNOWN, CIRCA} または
 * trainingAge=BEGINNER のとき自動生成は complexity ≤ MEDIUM」）がこの値を
 * 必要とするため、ここで追加し §7.5 の分類表をそのまま38 template全件へ書き込む。
 */
export const COMPLEXITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export const complexitySchema = z.enum(COMPLEXITIES);
export type Complexity = z.infer<typeof complexitySchema>;

/**
 * [R4 structured metadata] planning が template の意味を ID・表示名から推測しないための機械可読フィールド。
 *   - `approachType`: EVENT_APPROACH_SPEED の助走区分（§4.4 の SHORT / FULL）。他 Method は null
 *   - `resistanceBand`: RESISTED_SPRINT の sled 負荷 band（VELOCITY_DECREMENT.band と一致させる）。
 *     vdec を使わない template（HILL）と他 Method は null
 *   - `fixedDistanceField`: `displayDistanceM` を処方値として固定するフィールド（§7.3 ①）。
 *     null = displayDistanceM は表示専用（SES 等）または距離を固定しない
 */
export const APPROACH_TYPES = ["SHORT", "FULL"] as const;
export const RESISTANCE_BANDS = ["LIGHT", "MODERATE", "HEAVY", "VERY_HEAVY"] as const;
export const FIXED_DISTANCE_FIELDS = ["repDistanceM", "flyZoneM"] as const;

export const ruleSetSessionTemplateSchema = z.object({
  id: sessionTemplateIdSchema,
  method: runningTrainingMethodSchema,
  labelJa: z.string().min(1),
  coachingAliases: z.array(z.string().min(1)),
  recoveryStructure: recoveryStructureSchema.nullable(),
  startType: sessionTemplateStartTypeSchema.optional(),
  displayDistanceM: z.number().positive().optional(),
  enabledByDefault: z.boolean(),
  advancedOnly: z.boolean(),
  primaryEvents: z.array(raceEventForTemplateSchema).optional(),
  complexity: complexitySchema,
  approachType: z.enum(APPROACH_TYPES).nullable(),
  resistanceBand: z.enum(RESISTANCE_BANDS).nullable(),
  fixedDistanceField: z.enum(FIXED_DISTANCE_FIELDS).nullable(),
});
export type RuleSetSessionTemplate = z.infer<typeof ruleSetSessionTemplateSchema>;

// ---------------------------------------------------------------------------
// Envelope（§7.2）
// ---------------------------------------------------------------------------

export const ENVELOPE_FIELDS = [
  "repDistanceM",
  "buildUpM",
  "flyZoneM",
  "decelerationM",
  "repDurationS",
  "repsPerSet",
  "sets",
  "totalReps",
  "repRestS",
  "setRestS",
  "intraRepRestS",
  "sessionVolumeM",
  "flyVolumeM",
  "intensityPercent",
  "attempts",
  "vdecPercent",
] as const;
export const envelopeFieldSchema = z.enum(ENVELOPE_FIELDS);
export type EnvelopeField = z.infer<typeof envelopeFieldSchema>;

export const JUDGEMENTS = ["SOURCE_BACKED", "ENGINE_POLICY", "OPEN"] as const;
export const judgementSchema = z.enum(JUDGEMENTS);
export type Judgement = z.infer<typeof judgementSchema>;

/**
 * §7.2 の `recommended: Range | null` 等は Unit を固定しない（field ごとに
 * 単位が違う: m / s / reps / sets / percent）。R1 の `anyUnitRangeSchema`
 * （Unit を問わない Range）をそのまま使う。cross-validation で
 * 「同一セル内の3層は同じ unit」を別途 refine する。
 */
export const envelopeCellSchema = z
  .object({
    recommended: anyUnitRangeSchema.nullable(),
    coachEditable: anyUnitRangeSchema,
    hardSafety: anyUnitRangeSchema.nullable(),
    evidenceIds: z.array(evidenceIdSchema),
    judgement: judgementSchema,
  })
  .superRefine((cell, ctx) => {
    // recommended ⊆ coachEditable（recommended が null = エンジンは値を置かない。§7.2）。
    if (cell.recommended !== null) {
      if (cell.recommended.unit !== cell.coachEditable.unit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "EnvelopeCell.recommended と coachEditable の unit が一致しません",
          path: ["recommended", "unit"],
        });
      }
      if (cell.recommended.min < cell.coachEditable.min || cell.recommended.max > cell.coachEditable.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "EnvelopeCell.recommended は coachEditable に包含されている必要があります（recommended ⊆ coachEditable）",
          path: ["recommended"],
        });
      }
    }
    // hardSafety != null のときのみ coachEditable ⊆ hardSafety（§7.2, §22 R2要求）。
    if (cell.hardSafety !== null) {
      if (cell.hardSafety.unit !== cell.coachEditable.unit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "EnvelopeCell.hardSafety と coachEditable の unit が一致しません",
          path: ["hardSafety", "unit"],
        });
      }
      if (cell.coachEditable.min < cell.hardSafety.min || cell.coachEditable.max > cell.hardSafety.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "EnvelopeCell.coachEditable は hardSafety に包含されている必要があります（coachEditable ⊆ hardSafety、hardSafety != null の場合のみ）",
          path: ["coachEditable"],
        });
      }
    }
  });
export type EnvelopeCell = z.infer<typeof envelopeCellSchema>;

export const envelopeSchema = z.object({
  method: runningTrainingMethodSchema,
  tier: envelopeTierSchema,
  templateIds: z.array(sessionTemplateIdSchema).min(1),
  recoveryStructure: recoveryStructureSchema.nullable(),
  fields: z.record(envelopeFieldSchema, envelopeCellSchema),
});
export type Envelope = z.infer<typeof envelopeSchema>;

// ---------------------------------------------------------------------------
// EligibilityRule（§4.4 の表。R2ではデータのみ・評価関数は作らない）
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] 正式仕様は §4.4 を表形式でのみ提示しており、
 * `EligibilityRule` 自体の TS 型は定義していない。以下は表の列
 * （Method/Template グループ × maturity カテゴリ × 判定）をそのまま
 * 構造化するために設計した最小限の型。
 */
export const MATURITY_CATEGORIES = ["PRE", "EFFECTIVE_UNKNOWN", "CIRCA", "POST"] as const;
export const maturityCategorySchema = z.enum(MATURITY_CATEGORIES);

export const ELIGIBILITY_OUTCOMES = ["AUTO", "MANUAL", "INELIGIBLE"] as const;
export const eligibilityOutcomeSchema = z.enum(ELIGIBILITY_OUTCOMES);

/**
 * [R4 structured metadata] EligibilityRule の追加条件（§4.5）。`conditionNote` は説明専用で、
 * planning は conditionNote を読まずにこの構造だけで判定する。
 *   - requires*: すべて満たしたときだけ行の outcome をそのまま使う
 *   - whenUnmet: 条件を満たさないときの扱い。`MANUAL_WITH_REVIEW`（AUTO 行: 自動生成しない・コーチ手動+REVIEW）/
 *     `INELIGIBLE_NON_OVERRIDABLE`（MANUAL 行: 選択不可・override 不可）。requires* が1つも無ければ null
 * phase に依存する条件は `requiresPhaseEvaluation` で表し、ここには置かない（R7）。
 */
export const ELIGIBILITY_UNMET_ACTIONS = ["MANUAL_WITH_REVIEW", "INELIGIBLE_NON_OVERRIDABLE"] as const;

export const trainingPhaseSchema = z.enum(TRAINING_PHASES);

/**
 * [R7 correction] 1つの AND 条件束（disjunction の1枝）。§4.5 には
 * 「tier=ADVANCED、または (POST & tier≥DEVELOPING & phase≠TRANSITION)」のように
 * OR で書かれた条件があり、単一の AND では正しく表現できない
 * （PASS WITH CHANGES 指摘: TRANSITION を一律ブロックする単純化は population eligibility
 * の意味を変えてしまうため不採用）。`eligibilityConditionsSchema.anyOf` はこの branch の
 * 配列を持ち、**どれか1つの branch を満たせば行の条件は満たされる**（OR）。branch 内部は
 * 引き続き AND。conditionNote / ruleId のテキスト解析は一切しない。
 */
export const eligibilityConditionBranchSchema = z
  .object({
    requiresEnvelopeTier: envelopeTierSchema.nullable(),
    requiresTrainingAgeTiers: z.array(trainingAgeTierSchema).min(1).nullable(),
    requiresPrimaryEvents: z.array(raceEventSchema).min(1).nullable(),
    requiresAllowAdvancedMethods: z.boolean(),
    requiresMeasuredVelocityDecrement: z.boolean(),
    requiresVmaxConfidenceAtLeast: z.enum(["MEDIUM", "HIGH"]).nullable(),
    /**
     * [R7 structured metadata] §4.5 の phase 依存条件（例: SES の「phase≠TRANSITION」）。
     * 満たさない phase の集合。`requiresPhaseEvaluation=true` の行の branch だけが持てる
     * （conditionNote の自由文を解析しない。phase=null（未評価）のときは **この branch は**
     * 条件を満たしたと仮定しない — ただし他の branch が phase に依存していなければ、その
     * branch は phase の有無に関わらず独立に判定できる。「どれか1つの phase 条件がある
     * → 行全体が未評価」という扱いはしない）。
     */
    requiresPhaseNotIn: z.array(trainingPhaseSchema).min(1).nullable(),
  })
  .strict();
export type EligibilityConditionBranch = z.infer<typeof eligibilityConditionBranchSchema>;

function branchHasRequirement(b: EligibilityConditionBranch): boolean {
  return (
    b.requiresEnvelopeTier !== null ||
    b.requiresTrainingAgeTiers !== null ||
    b.requiresPrimaryEvents !== null ||
    b.requiresAllowAdvancedMethods ||
    b.requiresMeasuredVelocityDecrement ||
    b.requiresVmaxConfidenceAtLeast !== null ||
    b.requiresPhaseNotIn !== null
  );
}

/**
 * [R4 structured metadata] EligibilityRule の追加条件（§4.5）。`conditionNote` は説明専用で、
 * planning は conditionNote を読まずにこの構造だけで判定する。
 *   - requires*: すべて満たしたときだけ行の outcome をそのまま使う（`anyOf` が null のとき）
 *   - anyOf: [R7 correction] 非 null なら上の flat な requires* は使わず（すべて既定値でなければ
 *     ならない）、branch のどれか1つを満たせばよい（OR）。1行に複数の独立した資格経路がある
 *     ケース（例: SES POST の tier=ADVANCED 経路 と POST&tier≥DEVELOPING&phase≠TRANSITION 経路）
 *     を、SES 専用の TS 分岐を書かずに generic evaluator だけで扱うための最小限の disjunction 表現。
 *   - whenUnmet: 条件を満たさないときの扱い。`MANUAL_WITH_REVIEW`（AUTO 行: 自動生成しない・コーチ手動+REVIEW）/
 *     `INELIGIBLE_NON_OVERRIDABLE`（MANUAL 行: 選択不可・override 不可）。requires* / anyOf が
 *     1つも無ければ null
 * phase に依存する条件は `requiresPhaseEvaluation` で表し、ここには置かない（R7）。
 */
export const eligibilityConditionsSchema = z
  .object({
    requiresEnvelopeTier: envelopeTierSchema.nullable(),
    requiresTrainingAgeTiers: z.array(trainingAgeTierSchema).min(1).nullable(),
    requiresPrimaryEvents: z.array(raceEventSchema).min(1).nullable(),
    requiresAllowAdvancedMethods: z.boolean(),
    requiresMeasuredVelocityDecrement: z.boolean(),
    requiresVmaxConfidenceAtLeast: z.enum(["MEDIUM", "HIGH"]).nullable(),
    /**
     * [R7 structured metadata] §4.5 の phase 依存条件（例: SES の「phase≠TRANSITION」）。
     * 満たさない phase の集合。`requiresPhaseEvaluation=true` の行だけが持てる（conditionNote の
     * 自由文を解析しない。phase=null（未評価）のときは条件を満たしたと仮定しない — 別途
     * `requiresPhaseEvaluation` 側で「phase が無ければ AUTO へ昇格しない」を担保する）。
     */
    requiresPhaseNotIn: z.array(trainingPhaseSchema).min(1).nullable(),
    /** [R7 correction] OR（§4.5 のような disjunction）。非 null のときは他の requires* は使わない。 */
    anyOf: z.array(eligibilityConditionBranchSchema).min(2).nullable(),
    whenUnmet: z.enum(ELIGIBILITY_UNMET_ACTIONS).nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.anyOf === null) return;
    const flatHasRequirement =
      c.requiresEnvelopeTier !== null ||
      c.requiresTrainingAgeTiers !== null ||
      c.requiresPrimaryEvents !== null ||
      c.requiresAllowAdvancedMethods ||
      c.requiresMeasuredVelocityDecrement ||
      c.requiresVmaxConfidenceAtLeast !== null ||
      c.requiresPhaseNotIn !== null;
    if (flatHasRequirement) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "anyOf を指定する行は、平坦な requires*/requiresPhaseNotIn を同時に持てません（OR は anyOf の branch だけで表す）",
        path: ["anyOf"],
      });
    }
    c.anyOf.forEach((branch, i) => {
      if (!branchHasRequirement(branch)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "anyOf の branch は何らかの requires* を持つ必要があります", path: ["anyOf", i] });
      }
    });
  });
export type EligibilityConditions = z.infer<typeof eligibilityConditionsSchema>;

export function eligibilityConditionsHaveRequirement(c: EligibilityConditions): boolean {
  if (c.anyOf !== null) return true;
  return (
    c.requiresEnvelopeTier !== null ||
    c.requiresTrainingAgeTiers !== null ||
    c.requiresPrimaryEvents !== null ||
    c.requiresAllowAdvancedMethods ||
    c.requiresMeasuredVelocityDecrement ||
    c.requiresVmaxConfidenceAtLeast !== null ||
    c.requiresPhaseNotIn !== null
  );
}

/** 条件が（flat または anyOf のどの branch であれ）phase に依存する行かどうか。 */
export function eligibilityConditionsReferencePhase(c: EligibilityConditions): boolean {
  if (c.anyOf !== null) return c.anyOf.some((b) => b.requiresPhaseNotIn !== null);
  return c.requiresPhaseNotIn !== null;
}

/**
 * [R4 structured metadata] エンジンが値を置くときの上限（§4.4 の「自動（reps≤3）」「自動（lower half）」）。
 * コーチが明示入力した値には適用しない（超えた場合は REQUIRE_COACH_REVIEW）。
 */
export const autoGenerationLimitsSchema = z
  .object({
    maxTotalReps: z.number().int().positive().nullable(),
    positionCap: z.enum(["LOWER_HALF"]).nullable(),
  })
  .strict();
export type AutoGenerationLimits = z.infer<typeof autoGenerationLimitsSchema>;

export const eligibilityRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    method: runningTrainingMethodSchema,
    templateIds: z.array(sessionTemplateIdSchema).min(1),
    maturityCategory: maturityCategorySchema,
    outcome: eligibilityOutcomeSchema,
    requiresReview: z.boolean(),
    overrideAllowed: z.boolean().nullable(),
    conditionNote: z.string().nullable(),
    /**
     * [R3 addition] outcome="AUTO" の行のうち、実際には §4.5 の
     * competition-phase 依存条件（例: SES の "phase≠TRANSITION"）を含む
     * ものだけ true にする。R3 は phase（R7）を実装しないため、
     * このフラグが true の行を「evaluator が無条件で AUTO と信じてよい」
     * 対象から明示的に除外できるようにする（conditionNote の自由文を
     * テキスト解析して判定するような脆い実装を避けるための構造化）。
     * 既存64行のうち outcome/requiresReview/overrideAllowed/conditionNote
     * の値・意味は一切変更していない。
     */
    requiresPhaseEvaluation: z.boolean(),
    conditions: eligibilityConditionsSchema,
    autoGenerationLimits: autoGenerationLimitsSchema,
  })
  .superRefine((rule, ctx) => {
    const hasRequirement = eligibilityConditionsHaveRequirement(rule.conditions);
    if (hasRequirement !== (rule.conditions.whenUnmet !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "conditions.whenUnmet は requires* が1つ以上あるときだけ（かつそのとき必ず）指定します",
        path: ["conditions", "whenUnmet"],
      });
    }
    if (rule.outcome === "INELIGIBLE" && (hasRequirement || rule.autoGenerationLimits.maxTotalReps !== null || rule.autoGenerationLimits.positionCap !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outcome=INELIGIBLE の行は conditions / autoGenerationLimits を持てません",
        path: ["conditions"],
      });
    }
    if (rule.outcome === "INELIGIBLE" && rule.overrideAllowed === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outcome=INELIGIBLE のとき overrideAllowed は true/false のいずれかが必須です（§8.3）",
        path: ["overrideAllowed"],
      });
    }
    if (rule.outcome !== "INELIGIBLE" && rule.overrideAllowed !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outcome≠INELIGIBLE のとき overrideAllowed は null である必要があります（override は ineligible な選択肢にのみ意味を持つ）",
        path: ["overrideAllowed"],
      });
    }
    if (rule.requiresPhaseEvaluation && rule.outcome !== "AUTO") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "requiresPhaseEvaluation は outcome=AUTO の行にのみ意味があります",
        path: ["requiresPhaseEvaluation"],
      });
    }
    if (eligibilityConditionsReferencePhase(rule.conditions) && !rule.requiresPhaseEvaluation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "phase に依存する requiresPhaseNotIn（flat または anyOf の branch）は requiresPhaseEvaluation=true の行にのみ指定できます",
        path: ["conditions"],
      });
    }
  });
export type EligibilityRule = z.infer<typeof eligibilityRuleSchema>;

// ---------------------------------------------------------------------------
// PlausibilityRule（§8.5。R2ではデータのみ・評価関数はR6）
// ---------------------------------------------------------------------------

export const PLAUSIBILITY_SCOPES = ["ITEM_FIELD", "SESSION_TOTAL", "MENU_TOTAL", "INPUT", "RATIO"] as const;
export const plausibilityScopeSchema = z.enum(PLAUSIBILITY_SCOPES);

const thresholdSchema = z
  .object({
    min: z.number().nullable(),
    max: z.number().nullable(),
  })
  .nullable();

/**
 * [R4 structured metadata] scope=INPUT の plausibility がどの入力を検査するか。planning は ruleId ではなく
 * この構造で対象の行を選ぶ。
 */
export const plausibilityInputTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TIMED_MARK"), event: timedMarkEventSchema }).strict(),
  z.object({ kind: z.literal("HEIGHT_CM") }).strict(),
  z.object({ kind: z.literal("COACH_EDIT_APPROACH_DISTANCE_M") }).strict(),
]);
export type PlausibilityInputTarget = z.infer<typeof plausibilityInputTargetSchema>;

/**
 * [R6 structured metadata] scope≠INPUT の plausibility が、出力（処方・セッション）のどの量を検査するか。
 * R6 の `checkOutputPlausibility` は ruleId や targetLabel の文字列ではなくこの構造で対象を選ぶ。
 *   - PRESCRIPTION_FIELD: 処方の1フィールド（sets / repsPerSet / totalReps / rest / buildUpM / flyZoneM / repDurationS）
 *   - REP_DISTANCE:       1本の距離（Method ごとの意味は rep の判別共用体から導く。MV/AS は build-up + fly の合計）
 *   - ITEM_TOTAL_DISTANCE: 1項目の総走行距離（回数×1本の距離。deceleration を含めない）
 *   - SESSION_TOTAL_DISTANCE: メニュー全体の総走行距離（§11）
 *   - TOTAL_REPS_VS_RECOMMENDED: totalReps ÷ Envelope の recommended.max 比（sets/reps 取り違え疑い）
 */
export const PLAUSIBILITY_OUTPUT_TARGETS = [
  "PRESCRIPTION_FIELD",
  "REP_DISTANCE",
  "ITEM_TOTAL_DISTANCE",
  "SESSION_TOTAL_DISTANCE",
  "TOTAL_REPS_VS_RECOMMENDED",
] as const;
export const plausibilityOutputTargetSchema = z.enum(PLAUSIBILITY_OUTPUT_TARGETS);
export type PlausibilityOutputTarget = z.infer<typeof plausibilityOutputTargetSchema>;

export const plausibilityRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    scope: plausibilityScopeSchema,
    targetLabel: z.string().min(1),
    /** ENVELOPE_FIELD に対応する場合のみ設定。入力系（INPUT）や RATIO は null。 */
    field: envelopeFieldSchema.nullable(),
    /** 対象 Method。null = Method を問わず適用（総量・入力系のルール）。 */
    appliesToMethods: z.array(runningTrainingMethodSchema).nullable(),
    /** 表示用の単位ラベル（m/s/cm等）。plausibility は Envelope の Unit 体系と別物のため自由文字列。 */
    unit: z.string().min(1),
    confirmThreshold: thresholdSchema,
    blockThreshold: thresholdSchema,
    /** scope="RATIO" のときのみ設定（例: totalReps ≥ recommended.totalReps.max × 3）。 */
    ratioMultiplier: z.number().positive().nullable(),
    note: z.string().nullable(),
    inputTarget: plausibilityInputTargetSchema.nullable(),
    /** [R6] scope≠INPUT の行が検査する出力の量。scope=INPUT の行は null。 */
    outputTarget: plausibilityOutputTargetSchema.nullable(),
  })
  .superRefine((rule, ctx) => {
    if ((rule.scope === "INPUT") !== (rule.outputTarget === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outputTarget は scope≠INPUT の行にだけ（かつ必ず）指定します",
        path: ["outputTarget"],
      });
    }
    if (rule.outputTarget === "PRESCRIPTION_FIELD" && rule.field === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outputTarget=PRESCRIPTION_FIELD の行は field が必須です",
        path: ["field"],
      });
    }
    if ((rule.scope === "INPUT") !== (rule.inputTarget !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputTarget は scope=INPUT の行にだけ（かつ必ず）指定します",
        path: ["inputTarget"],
      });
    }
    if (rule.scope === "RATIO" && rule.ratioMultiplier === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scope=RATIO のとき ratioMultiplier が必須です",
        path: ["ratioMultiplier"],
      });
    }
    if (rule.scope !== "RATIO" && rule.ratioMultiplier !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scope≠RATIO のとき ratioMultiplier は null である必要があります",
        path: ["ratioMultiplier"],
      });
    }
    if (rule.scope === "RATIO" && (rule.confirmThreshold !== null || rule.blockThreshold !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scope=RATIO のとき confirmThreshold/blockThreshold は null（比率のみで判定）",
        path: ["confirmThreshold"],
      });
    }
  });
export type PlausibilityRule = z.infer<typeof plausibilityRuleSchema>;

// ---------------------------------------------------------------------------
// TimingToleranceRule（§10.2。R2ではデータのみ・監視はR8）
// ---------------------------------------------------------------------------

export const timingToleranceRuleSchema = z.object({
  timing: timingMethodSchema,
  /** null = 数値 tolerance を置かない（COACH_ONLY 固定。RADAR_LASER/UNKNOWN）。 */
  toleranceS: z.number().nonnegative().nullable(),
  /** "2/fps" のように fps 依存の場合の係数。VIDEO のみ設定。 */
  toleranceSPerFps: z.number().positive().nullable(),
  numericStopAllowed: z.boolean(),
  /** tolerance/参照 がこの比率を超えたら COACH_ONLY に切り替える（§10.2 の追加条件）。 */
  coachOnlyRatioThreshold: z.number().positive().nullable(),
  evidenceIds: z.array(evidenceIdSchema),
  judgement: judgementSchema,
  provisional: z.literal(true),
});
export type TimingToleranceRule = z.infer<typeof timingToleranceRuleSchema>;

// ---------------------------------------------------------------------------
// StopPolicy（§10.3。R2ではデータのみ・monitor関数はR8）
// ---------------------------------------------------------------------------

export const stopPolicySchema = z.object({
  id: stopPolicyIdSchema,
  method: runningTrainingMethodSchema,
  appliesToRecoveryStructure: recoveryStructureSchema.nullable(),
  referenceDescription: z.string().min(1),
  /** 判定条件の説明（自然言語。実行可能なロジックはR8で monitor.ts に実装）。 */
  ruleDescriptionJa: z.string().min(1),
  consecutiveFailuresToStop: z.number().int().positive().nullable(),
  numericStopAvailable: z.boolean(),
  /**
   * [R4 structured metadata] 同じ method × recoveryStructure に複数 policy がある場合の選択条件（§10.3）。
   *   ANY: 唯一の policy / AUTO_CONDITIONS_MET: eligibility が override なしで AUTO 条件を満たした処方 /
   *   MANUAL_OR_OVERRIDE: 手動選択・override 経由の処方。planning は policy id の文字列で選ばない。
   */
  appliesToEligibilityPath: z.enum(["ANY", "AUTO_CONDITIONS_MET", "MANUAL_OR_OVERRIDE"]),
  /**
   * [R8 structured metadata] §10.3 の表の実行時挙動（参照の決め方・1回目/連続 FAIL の action・startQuality・
   * technique・vdec・全力化・予定数の単位）。`ruleDescriptionJa` は説明専用で、monitor は id も説明文も解析しない。
   * 既存の `consecutiveFailuresToStop` / `numericStopAvailable` の値は変えず、矛盾しないことだけを検証する。
   */
  runtime: stopPolicyRuntimeSchema,
}).superRefine((policy, ctx) => {
  for (const message of stopPolicyRuntimeIssues(policy)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["runtime"] });
  }
});
export type StopPolicy = z.infer<typeof stopPolicySchema>;

// ---------------------------------------------------------------------------
// Event definitions（[R4 structured metadata]）
// ---------------------------------------------------------------------------

/**
 * 計時記録の種目（TimedMark.event）とレース種目（RaceEvent）の距離定義。planning が "FLY20" / "400m" の
 * ような文字列から距離を読み取らないために RuleSet に置く（研究由来の数値ではなく種目の定義）。
 */
export const eventDefinitionsSchema = z
  .object({
    timedMarks: z.array(
      z
        .object({
          event: timedMarkEventSchema,
          distanceM: z.number().positive(),
          /** FROM_START = スタートからの計時 / FLY_ZONE = 助走後の計測区間 */
          segment: z.enum(["FROM_START", "FLY_ZONE"]),
        })
        .strict(),
    ),
    raceEvents: z.array(
      z
        .object({
          event: raceEventSchema,
          distanceM: z.number().positive(),
          hurdles: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type EventDefinitions = z.infer<typeof eventDefinitionsSchema>;

// ---------------------------------------------------------------------------
// ReadinessRule（§13。R5 で正式化。R2/R3/R4 では z.array(z.never()) で空配列固定していた）
// ---------------------------------------------------------------------------

/**
 * [R5] §13 の readiness ルールを versioned data として持つ最小の判別共用体。
 * 汎用 DSL にはしない（条件は §13.2〜§13.4 が定義する形だけを表現する）。
 * planning / readiness の runtime は、この構造だけを読んで判断する
 * （id・説明文・Method 名の文字列を解析しない。R4 と同じ原則）。
 */
export const READINESS_WELLNESS_METRICS = ["SORENESS", "FATIGUE", "SLEEP_QUALITY"] as const;
export const readinessWellnessMetricSchema = z.enum(READINESS_WELLNESS_METRICS);
export type ReadinessWellnessMetric = z.infer<typeof readinessWellnessMetricSchema>;

export const READINESS_COMPARISONS = ["GTE", "LTE", "EQ"] as const;
export const readinessComparisonSchema = z.enum(READINESS_COMPARISONS);

const ageBandListSchema = z.array(z.enum(["U12", "U15", "U18", "ADULT"])).min(1);

const swapTargetSchema = z
  .object({
    method: runningTrainingMethodSchema,
    /** null = その Method の全 template を候補にする（eligibility は候補ごとに再評価する）。 */
    templateIds: z.array(sessionTemplateIdSchema).min(1).nullable(),
  })
  .strict();

export const readinessRuleSchema = z.discriminatedUnion("kind", [
  /** §13.2: red flag のグループと、その stop の重さ（severityRank が大きいほど厳しい）。stopPlanning は常に true。 */
  z
    .object({
      kind: z.literal("PAIN_RED_FLAG_GROUP"),
      id: z.string().min(1),
      redFlags: z.array(redFlagSchema).min(1),
      safetyOutcome: z.enum(["MEDICAL_EVALUATION_RECOMMENDED", "COACH_REVIEW"]),
      severityRank: z.number().int().positive(),
      overridable: z.literal(false),
    })
    .strict(),
  /** §13.2: status=PRESENT（red flag なし）。 */
  z
    .object({
      kind: z.literal("PAIN_PRESENT"),
      id: z.string().min(1),
      actions: z.array(readinessActionCodeSchema).min(1),
      safetyOutcome: safetyOutcomeSchema,
      /** CoachOverride で解除できる action（§13.2 は CANCEL_HIGH_INTENSITY のみ）。 */
      overridableActions: z.array(readinessActionCodeSchema),
    })
    .strict(),
  /** §13.2: 成長期の部位ガイダンス（診断ではない表示のみ）。 */
  z
    .object({
      kind: z.literal("PAIN_GROWTH_PERIOD_GUIDANCE"),
      id: z.string().min(1),
      regions: z.array(bodyRegionSchema).min(1),
      appliesToAgeBands: ageBandListSchema,
      findingCode: z.string().min(1),
    })
    .strict(),
  /** §13.2: status=NOT_ASKED の youth（HIGH_* を自動生成しない）。 */
  z
    .object({
      kind: z.literal("PAIN_NOT_ASKED"),
      id: z.string().min(1),
      appliesToAgeBands: ageBandListSchema,
      appliesToLoadClasses: z.array(loadClassSchema).min(1),
      actions: z.array(readinessActionCodeSchema),
      findingCode: z.string().min(1),
    })
    .strict(),
  /** §13.3: performanceStatus。 */
  z
    .object({
      kind: z.literal("PERFORMANCE_STATUS"),
      id: z.string().min(1),
      status: z.enum(["DOWN", "UNKNOWN"]),
      actions: z.array(readinessActionCodeSchema).min(1),
    })
    .strict(),
  /** §13.3: 1–5 尺度のしきい値。`countsTowardSignalCount` が true の行は「2つ以上」の数え上げ対象。 */
  z
    .object({
      kind: z.literal("WELLNESS_SIGNAL"),
      id: z.string().min(1),
      metric: readinessWellnessMetricSchema,
      comparison: readinessComparisonSchema,
      threshold: z.number().int().min(1).max(5),
      actions: z.array(readinessActionCodeSchema),
      countsTowardSignalCount: z.boolean(),
    })
    .strict(),
  /** §13.3: 数え上げた signal 数に対する action（minSignals が大きい行が優先）。 */
  z
    .object({
      kind: z.literal("SIGNAL_COUNT"),
      id: z.string().min(1),
      minSignals: z.number().int().positive(),
      actions: z.array(readinessActionCodeSchema).min(1),
    })
    .strict(),
  /** §13.3: readiness 窓が ACTIVE で soreness/fatigue/sleep がすべて null。 */
  z
    .object({
      kind: z.literal("MISSING_WELLNESS_IN_ACTIVE_WINDOW"),
      id: z.string().min(1),
      actions: z.array(readinessActionCodeSchema).min(1),
    })
    .strict(),
  /** §13.4: SWAP 先（候補は eligibility を再評価する。KEEP_CURRENT は Method を変えない）。 */
  z
    .object({
      kind: z.literal("SWAP_TARGET"),
      id: z.string().min(1),
      fromMethods: z.array(runningTrainingMethodSchema).min(1),
      outcome: z.enum(["SWAP", "KEEP_CURRENT"]),
      targets: z.array(swapTargetSchema),
    })
    .strict(),
]).superRefine((rule, ctx) => {
  if (rule.kind === "SWAP_TARGET" && (rule.outcome === "SWAP") !== (rule.targets.length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "outcome=SWAP のときだけ targets を持ちます（KEEP_CURRENT は Method を変えない）",
      path: ["targets"],
    });
  }
});
export type ReadinessRule = z.infer<typeof readinessRuleSchema>;

// ---------------------------------------------------------------------------
// AggregationRule（§11。R6で正式化。R5までは z.array(z.never()) で空配列固定）
//
// ここに置くのは §11 の **ENGINE-POLICY だけ**。Method ごとの量の上限は Envelope
// （recommended.max / coachEditable.max）が single source of truth なので、
// 「ACC=300m」のような数値をここへ再入力しない（導出のしかただけを持つ）。
// ---------------------------------------------------------------------------

/** §11.2 の推定加速距離 A（区間。1値にしない）。source=ESTIMATED / confidence=LOW で扱う。 */
export const AGGREGATION_NEAR_MAX_MODELS = [
  "REP_DISTANCE",        // ACC / RS: 1本の距離 × 本数
  "BUILD_UP_PLUS_FLY",   // MV / AS: (build-up + fly) × 本数
  "DISPLAY_DISTANCE",    // SES / LONG: 表示距離（LONG INCOMPLETE は区間合計）× 本数
  "APPROACH_IF_FULL",    // EA: approachType=FULL のときだけ助走距離 × 試技数
  "NONE",                // TE / TI / STRIDE: 定義上 0（[0,0] RULE_DEFINITION）
] as const;
export const aggregationNearMaxModelSchema = z.enum(AGGREGATION_NEAR_MAX_MODELS);
export type AggregationNearMaxModel = z.infer<typeof aggregationNearMaxModelSchema>;

/** §11.4 の Method 合計をどの Envelope セルの上限と比べるか。 */
export const AGGREGATION_VOLUME_METRICS = ["sessionVolumeM", "flyVolumeM", "attempts"] as const;
export const aggregationVolumeMetricSchema = z.enum(AGGREGATION_VOLUME_METRICS);
export type AggregationVolumeMetric = z.infer<typeof aggregationVolumeMetricSchema>;

/** §11.1 の Method 別合計（longSprintVolumeM / tempoVolumeM / strideVolumeM）のどれに足すか。 */
export const AGGREGATION_VOLUME_CATEGORIES = ["LONG_SPRINT", "TEMPO", "STRIDE", "NONE"] as const;
export const aggregationVolumeCategorySchema = z.enum(AGGREGATION_VOLUME_CATEGORIES);

/** Envelope のどちらの上限を使うか（数値そのものは Envelope 側にある）。 */
export const ENVELOPE_CAP_BOUNDS = ["RECOMMENDED_MAX", "COACH_EDITABLE_MAX"] as const;
export const envelopeCapBoundSchema = z.enum(ENVELOPE_CAP_BOUNDS);
export type EnvelopeCapBound = z.infer<typeof envelopeCapBoundSchema>;

/** legacy 項目（v2 ではない MenuItem）の category が集計上何を意味するか。 */
export const LEGACY_CATEGORY_CONTRIBUTIONS = [
  "RUNNING_DISTANCE", // 走行距離として集計する
  "CONTACTS",         // 接地数（plyometricContacts）として集計する
  "NOT_RUNNING",      // 定義上 0（走行距離にも接地数にもならない）
  "UNKNOWN",          // 走かどうかを既存 category semantics から断定できない → null を伝播
] as const;
export const legacyCategoryContributionSchema = z.enum(LEGACY_CATEGORY_CONTRIBUTIONS);
export type LegacyCategoryContribution = z.infer<typeof legacyCategoryContributionSchema>;

export const aggregationRuleSchema = z.discriminatedUnion("kind", [
  /** §11.2 推定加速距離 A（tier 別の区間）。 */
  z
    .object({
      kind: z.literal("ACCEL_INTERVAL"),
      id: z.string().min(1),
      tier: envelopeTierSchema,
      lowerM: z.number().nonnegative().finite(),
      upperM: z.number().nonnegative().finite(),
    })
    .strict(),
  /** §11.2 RELAY の助走許容。R7 の competition ロジックは含まない（数値だけ）。 */
  z
    .object({ kind: z.literal("RELAY_ALLOWANCE"), id: z.string().min(1), allowanceM: z.number().nonnegative().finite() })
    .strict(),
  /** Method ごとの集計の仕方（上限比較に使うセル・nearMax の求め方・量カテゴリ）。 */
  z
    .object({
      kind: z.literal("METHOD_AGGREGATION"),
      id: z.string().min(1),
      method: runningTrainingMethodSchema,
      volumeMetric: aggregationVolumeMetricSchema,
      nearMaxModel: aggregationNearMaxModelSchema,
      volumeCategory: aggregationVolumeCategorySchema,
    })
    .strict(),
  /** §11.4 高強度予算（量への乗数ではなく、Envelope 上限の按分）。 */
  z
    .object({
      kind: z.literal("HIGH_INTENSITY_BUDGET"),
      id: z.string().min(1),
      threshold: z.number().positive().finite(),
      /** recommended.max が null の Method で分母に使う上限。 */
      fallbackBound: envelopeCapBoundSchema,
      findingCode: z.string().min(1),
      editableFindingCode: z.string().min(1),
    })
    .strict(),
  /** §11.4 tempo / stride の合計上限（上限値そのものは Envelope から読む）。 */
  z
    .object({
      kind: z.literal("SESSION_VOLUME_LIMIT"),
      id: z.string().min(1),
      metric: aggregationVolumeCategorySchema.exclude(["NONE"]),
      capMethod: runningTrainingMethodSchema,
      capField: aggregationVolumeMetricSchema,
      capBound: envelopeCapBoundSchema,
      findingCode: z.string().min(1),
    })
    .strict(),
  /** legacy 項目の category semantics（推測でなく版管理されたデータとして持つ）。 */
  z
    .object({
      kind: z.literal("LEGACY_CATEGORY"),
      id: z.string().min(1),
      category: z.string().min(1),
      contribution: legacyCategoryContributionSchema,
    })
    .strict(),
]);
export type AggregationRule = z.infer<typeof aggregationRuleSchema>;

// ---------------------------------------------------------------------------
// WeeklyRule（§12。R7で正式化。R6までは z.array(z.never()) で空配列固定していた）
//
// 48h/72h・7日 guard の**しきい値と対象カテゴリだけ**をここに置く。Method 別の回復時間は
// 絶対に持たない（§12.3「Method 別に 48h/72h を分けない」）。
// ---------------------------------------------------------------------------

export const weeklyRuleSchema = z.discriminatedUnion("kind", [
  /** §12.3 の 48h / 72h window（Method に依らず単一の時間）。 */
  z
    .object({
      kind: z.literal("WINDOW_HOURS"),
      id: z.string().min(1),
      highWindowHours: z.number().positive().finite(),
      readinessWindowHours: z.number().positive().finite(),
      evidenceIds: z.array(evidenceIdSchema),
    })
    .strict(),
  /** §12.3 の対象カテゴリ（走 vs 非走）。 */
  z
    .object({
      kind: z.literal("RELEVANT_CATEGORIES"),
      id: z.string().min(1),
      runningCategories: z.array(loadCategorySchema).min(1),
      nonRunningCategories: z.array(loadCategorySchema).min(1),
    })
    .strict(),
  /** §12.4 WEEKLY_HIGH_SESSIONS。 */
  z
    .object({
      kind: z.literal("HIGH_SESSIONS_7D"),
      id: z.string().min(1),
      threshold: z.number().int().positive(),
      findingCode: z.string().min(1),
    })
    .strict(),
  /** §12.4 WEEKLY_JHS_REST_DAYS。対象 ageBand は RuleSet データ（TS に "U15" を書かない）。 */
  z
    .object({
      kind: z.literal("YOUTH_REST_DAYS"),
      id: z.string().min(1),
      ageBand: ageBandSchema,
      minRestDays: z.number().int().nonnegative(),
      findingCode: z.string().min(1),
    })
    .strict(),
  /** §12.4 WEEKLY_JHS_HOURS。 */
  z
    .object({
      kind: z.literal("YOUTH_MAX_MINUTES_7D"),
      id: z.string().min(1),
      ageBand: ageBandSchema,
      maxMinutes: z.number().positive(),
      findingCode: z.string().min(1),
    })
    .strict(),
  /** §12.3 HISTORY_UNKNOWN（coverage72h=NONE 時の loadClass 別扱い）。 */
  z
    .object({
      kind: z.literal("HISTORY_UNKNOWN_POLICY"),
      id: z.string().min(1),
      affectedLoadClasses: z.array(loadClassSchema).min(1),
      findingCode: z.string().min(1),
    })
    .strict(),
])
  .superRefine((rule, ctx) => {
    if (rule.kind === "WINDOW_HOURS" && rule.highWindowHours > rule.readinessWindowHours) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "highWindowHours は readinessWindowHours 以下である必要があります",
        path: ["highWindowHours"],
      });
    }
  });
export type WeeklyRule = z.infer<typeof weeklyRuleSchema>;

// ---------------------------------------------------------------------------
// PhaseRule（§14.1〜§14.2。R7で正式化）
//
// Phase が変えるのは methodPriority（候補の並び。selection は変えない）と dose の位置上限だけ。
// hard stop・pain gate・rest 短縮には一切関与しない（§14.1）。
// ---------------------------------------------------------------------------

export const phaseRuleSchema = z
  .object({
    phase: trainingPhaseSchema,
    /** 候補の優先順（先頭ほど優先）。R7 では selection を自動で並べ替えない（将来 candidate ordering 用）。 */
    methodPriority: z.array(runningTrainingMethodSchema),
    /** §9.3 の位置上限（dose field だけに効く。intensity reference には触れない）。 */
    dosePositionCap: rangePositionSchema,
    /** この phase では自動生成しない loadClass（手動は可）。 */
    blockedAutogenLoadClasses: z.array(loadClassSchema),
    /** PRE_COMPETITION の障害切替期 INFO 等、数値制限を伴わない案内。null = 無し。 */
    infoFindingCode: z.string().min(1).nullable(),
    infoEvidenceIds: z.array(evidenceIdSchema),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (new Set(rule.methodPriority).size !== rule.methodPriority.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "methodPriority に重複があります", path: ["methodPriority"] });
    }
    if (rule.infoFindingCode === null && rule.infoEvidenceIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "infoEvidenceIds は infoFindingCode があるときだけ指定します",
        path: ["infoEvidenceIds"],
      });
    }
  });
export type PhaseRule = z.infer<typeof phaseRuleSchema>;

// ---------------------------------------------------------------------------
// CompetitionRule（§14.3〜§14.4。R7で正式化）
//
// 1行 = 1つの (priority × tier × 日範囲) バケット。generic resolver（competition/windows.ts）が
// 該当する全行を集めて「最も制約の強い結果」に合成する。priority 文字列の巨大 switch は持たない。
// ---------------------------------------------------------------------------

export const COMPETITION_PRIORITIES = ["TRAINING_MEET", "NORMAL", "IMPORTANT", "PEAK"] as const;
export const competitionPrioritySchema = z.enum(COMPETITION_PRIORITIES);
export type CompetitionPriority = z.infer<typeof competitionPrioritySchema>;

export const NEW_STIMULUS_POLICIES = ["NONE", "REVIEW_BLOCK_AUTOGEN"] as const;
export const newStimulusPolicySchema = z.enum(NEW_STIMULUS_POLICIES);

export const taperGuidanceSchema = z
  .object({
    reductionPercentLower: z.number().positive().max(100),
    reductionPercentUpper: z.number().positive().max(100),
    evidenceId: evidenceIdSchema,
    applicabilityNotes: z.string().min(1),
  })
  .strict()
  .refine((t) => t.reductionPercentLower <= t.reductionPercentUpper, {
    message: "reductionPercentLower は reductionPercentUpper 以下である必要があります",
    path: ["reductionPercentLower"],
  });
export type TaperGuidance = z.infer<typeof taperGuidanceSchema>;

export const competitionRuleSchema = z
  .object({
    id: z.string().min(1),
    /** null = 全 priority 共通（n=0 の行だけが使う）。 */
    priority: competitionPrioritySchema.nullable(),
    /** null = tier を問わない。PEAK だけ ADVANCED / DEVELOPMENTAL で行を分ける。 */
    tier: envelopeTierSchema.nullable(),
    dayMin: z.number().int().min(0).max(14),
    dayMax: z.number().int().min(0).max(14),
    /** n=0 専用: race を負荷イベント化する。 */
    raceIsLoadEvent: z.boolean(),
    /** n=0 専用: race 以外の HIGH_* に REQUIRE_COACH_REVIEW を付ける。 */
    nonRaceHighReviewOnRaceDay: z.boolean(),
    blockedAutogenLoadClasses: z.array(loadClassSchema),
    /** blockedAutogenLoadClasses の例外になる Method（STRIDE 等。無条件で例外）。 */
    autogenExceptionMethods: z.array(runningTrainingMethodSchema),
    /** ACCELERATION だけの例外条件（template.displayDistanceM <= この値のときだけ例外）。 */
    autogenExceptionAccMaxDistanceM: z.number().positive().nullable(),
    /** 例外に該当した item へ適用する位置上限（ブロックの代わりに使う）。 */
    autogenExceptionPositionCap: rangePositionSchema.nullable(),
    dosePositionCap: rangePositionSchema.nullable(),
    newStimulusPolicy: newStimulusPolicySchema,
    /** false = この window では LONG の recoveryStructure=INCOMPLETE を不適格にする。 */
    longIncompleteAllowed: z.boolean(),
    taperGuidance: taperGuidanceSchema.nullable(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.dayMin > rule.dayMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dayMin は dayMax 以下である必要があります", path: ["dayMin"] });
    }
    if (rule.dayMin !== 0 && rule.raceIsLoadEvent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "raceIsLoadEvent は dayMin=0 の行にだけ指定できます", path: ["raceIsLoadEvent"] });
    }
    if (rule.dayMin !== 0 && rule.nonRaceHighReviewOnRaceDay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "nonRaceHighReviewOnRaceDay は dayMin=0 の行にだけ指定できます",
        path: ["nonRaceHighReviewOnRaceDay"],
      });
    }
    const hasException = rule.autogenExceptionMethods.length > 0 || rule.autogenExceptionAccMaxDistanceM !== null;
    if (hasException && (rule.blockedAutogenLoadClasses.length === 0 || rule.autogenExceptionPositionCap === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "autogenException* は blockedAutogenLoadClasses と autogenExceptionPositionCap があるときだけ指定します",
        path: ["autogenExceptionMethods"],
      });
    }
    if (!hasException && rule.autogenExceptionPositionCap !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "autogenExceptionPositionCap は例外条件があるときだけ指定します",
        path: ["autogenExceptionPositionCap"],
      });
    }
    if (rule.taperGuidance !== null && (rule.priority !== "PEAK" || rule.tier !== "ADVANCED")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "taperGuidance は priority=PEAK かつ tier=ADVANCED の行にだけ指定できます（§14.4）",
        path: ["taperGuidance"],
      });
    }
    if (rule.taperGuidance !== null && rule.dayMin < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "taperGuidance は大会 8–14 日前の行にだけ指定できます（§14.4）",
        path: ["taperGuidance"],
      });
    }
  });
export type CompetitionRule = z.infer<typeof competitionRuleSchema>;

// ---------------------------------------------------------------------------
// ConstraintRule（§8.2, §7.5。R3で正式化。R2では z.array(z.never()) で空配列固定していた）
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] 正式仕様は §8.2（ageBand 制約）・§7.5（maturity/trainingAge に
 * よる complexity 上限）を表形式でのみ提示しており、`ConstraintRule` 自体の
 * TS 型は定義していない。§4.4 の `EligibilityRule`（Method×Template×maturity
 * カテゴリの許可/不許可）とは別概念 —— こちらは「年齢帯・成熟度・trainingAge」
 * という**属性ディメンション**に対して「この Method/Template は使えない」
 * 「自動生成の complexity 上限はここまで」を宣言する、より横断的な制約。
 * 汎用 DSL にはせず、R3 に必要な3ディメンション（AGE_BAND / MATURITY_CATEGORY /
 * TRAINING_AGE_TIER）だけを表現する最小構造にした。数値倍率フィールドは
 * 意図的に持たせない（許可集合の制約であり、量への係数ではない）。
 */
export const CONSTRAINT_DIMENSIONS = ["AGE_BAND", "MATURITY_CATEGORY", "TRAINING_AGE_TIER"] as const;
export const constraintDimensionSchema = z.enum(CONSTRAINT_DIMENSIONS);

export const TRAINING_AGE_TIERS_FOR_CONSTRAINT = ["BEGINNER", "DEVELOPING", "TRAINED", "ADVANCED"] as const;

const constraintMatchSchema = z.discriminatedUnion("dimension", [
  z.object({ dimension: z.literal("AGE_BAND"), ageBands: z.array(z.enum(["U12", "U15", "U18", "ADULT"])).min(1) }),
  z.object({ dimension: z.literal("MATURITY_CATEGORY"), categories: z.array(maturityCategorySchema).min(1) }),
  z.object({
    dimension: z.literal("TRAINING_AGE_TIER"),
    tiers: z.array(z.enum(TRAINING_AGE_TIERS_FOR_CONSTRAINT)).min(1),
  }),
]);
export type ConstraintMatch = z.infer<typeof constraintMatchSchema>;

export const constraintRuleSchema = z
  .object({
    id: z.string().min(1),
    match: constraintMatchSchema,
    disallowedMethods: z.array(runningTrainingMethodSchema),
    disallowedTemplateIds: z.array(sessionTemplateIdSchema),
    /** null = complexity 上限なし（このディメンションでは制約しない）。 */
    maxAutoComplexity: complexitySchema.nullable(),
    /** disallowedMethods/disallowedTemplateIds が空でないときのみ意味を持つ。 */
    overrideAllowed: z.boolean().nullable(),
    judgement: judgementSchema,
    provisional: z.boolean(),
  })
  .superRefine((rule, ctx) => {
    const hasDisallowed = rule.disallowedMethods.length > 0 || rule.disallowedTemplateIds.length > 0;
    if (hasDisallowed && rule.overrideAllowed === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "disallowedMethods/disallowedTemplateIds が非空のとき overrideAllowed は true/false が必須です",
        path: ["overrideAllowed"],
      });
    }
    if (!hasDisallowed && rule.overrideAllowed !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "disallowed対象が無いとき overrideAllowed は null である必要があります",
        path: ["overrideAllowed"],
      });
    }
  });
export type ConstraintRule = z.infer<typeof constraintRuleSchema>;

// ---------------------------------------------------------------------------
// RuleSet（§6.1）
// ---------------------------------------------------------------------------

export const RULE_SET_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export const ruleSetStatusSchema = z.enum(RULE_SET_STATUSES);
export type RuleSetStatus = z.infer<typeof ruleSetStatusSchema>;

/**
 * R3以降でしか実装しない配列。`z.array(z.never())` にすることで、
 * 「型としても R2 では絶対に空配列以外を許さない」ことを保証する
 * （§22 R2「先回りしない」の型レベルでの強制）。R3等でこの配列を
 * 実際に埋める段になったら、このファイルを編集して実際の要素型に
 * 差し替える（意図的な破壊的スキーマ変更）。
 */
const notYetImplementedArraySchema = z.array(z.never());

export const ruleSetSchema = z
  .object({
    ruleSetVersion: z.string().min(1),
    status: ruleSetStatusSchema,
    validFrom: isoDateSchema,
    supersedes: z.string().nullable(),
    engineSchemaVersion: z.literal(1),
    changelog: z.array(z.string()),
    evidence: z.array(evidenceRecordSchema),
    methods: z.array(methodMetaSchema),
    templates: z.array(ruleSetSessionTemplateSchema),
    envelopes: z.array(envelopeSchema),
    eligibility: z.array(eligibilityRuleSchema),
    constraints: z.array(constraintRuleSchema),
    timingTolerances: z.array(timingToleranceRuleSchema),
    stopPolicies: z.array(stopPolicySchema),
    aggregationRules: z.array(aggregationRuleSchema),
    weeklyRules: z.array(weeklyRuleSchema),
    readinessRules: z.array(readinessRuleSchema),
    phaseRules: z.array(phaseRuleSchema),
    competitionRules: z.array(competitionRuleSchema),
    plausibility: z.array(plausibilityRuleSchema),
    vmaxEstimationModels: notYetImplementedArraySchema,
    eventDefinitions: eventDefinitionsSchema,
  })
  .superRefine((rs, ctx) => {
    // ---- Method / Template -------------------------------------------------
    const methodsSeen = new Set<string>();
    for (const [i, m] of rs.methods.entries()) {
      if (methodsSeen.has(m.method)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `MethodMeta が重複しています: ${m.method}`,
          path: ["methods", i, "method"],
        });
      }
      methodsSeen.add(m.method);
      for (const [si, sid] of m.stopPolicyIds.entries()) {
        if (!rs.stopPolicies.some((sp) => sp.id === sid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MethodMeta.stopPolicyIds が実在しない StopPolicy を参照しています: ${sid}`,
            path: ["methods", i, "stopPolicyIds", si],
          });
        }
      }
    }

    const templateIdsSeen = new Set<string>();
    for (const [i, t] of rs.templates.entries()) {
      if (templateIdsSeen.has(t.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `templateId が重複しています: ${t.id}`,
          path: ["templates", i, "id"],
        });
      }
      templateIdsSeen.add(t.id);

      // templateId が Method 値と文字列衝突しないこと。
      if (runningTrainingMethodSet.has(t.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `templateId が Method 名と衝突しています: ${t.id}`,
          path: ["templates", i, "id"],
        });
      }
      // prefix namespace の整合。
      const expectedPrefix = TEMPLATE_ID_PREFIX_BY_METHOD[t.method];
      if (!t.id.startsWith(expectedPrefix)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `templateId ${t.id} は method ${t.method} の接頭辞 "${expectedPrefix}" で始まる必要があります`,
          path: ["templates", i, "id"],
        });
      }
      // method × template が R1 の RunningSelection 型と一致すること（TEMPLATE_IDS_BY_METHODで実在確認）。
      if (!(TEMPLATE_IDS_BY_METHOD[t.method] as readonly string[]).includes(t.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `templateId ${t.id} は R1 型（TemplateIdByMethod）上 method ${t.method} の組み合わせとして存在しません`,
          path: ["templates", i, "id"],
        });
      } else {
        const parsed = runningSelectionSchema.safeParse({ method: t.method, templateId: t.id });
        if (!parsed.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `method×templateId の組み合わせが R1 の RunningSelection schema で拒否されました: ${t.method} + ${t.id}`,
            path: ["templates", i],
          });
        }
      }
      // LONG のみ recoveryStructure 必須、他は null（R1 型と同じ制約をここでも保証）。
      if (t.method === "LONG_SPRINT_RACE_SPECIFIC") {
        if (t.recoveryStructure === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "LONG_SPRINT_RACE_SPECIFIC の template は recoveryStructure が必須です",
            path: ["templates", i, "recoveryStructure"],
          });
        }
      } else if (t.recoveryStructure !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${t.method} の template は recoveryStructure が null である必要があります`,
          path: ["templates", i, "recoveryStructure"],
        });
      }
      // [R4 structured metadata] の整合。
      if ((t.method === "EVENT_APPROACH_SPEED") !== (t.approachType !== null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "approachType は EVENT_APPROACH_SPEED の template にだけ（かつ必ず）指定します",
          path: ["templates", i, "approachType"],
        });
      }
      if (t.resistanceBand !== null && t.method !== "RESISTED_SPRINT") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "resistanceBand は RESISTED_SPRINT の template にだけ指定できます",
          path: ["templates", i, "resistanceBand"],
        });
      }
      if (t.fixedDistanceField !== null && t.displayDistanceM === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fixedDistanceField を指定する template は displayDistanceM（固定する値）が必要です",
          path: ["templates", i, "fixedDistanceField"],
        });
      }
    }
    // ---- Evidence -----------------------------------------------------------
    const evidenceIdsSeen = new Set<string>();
    for (const [i, e] of rs.evidence.entries()) {
      if (evidenceIdsSeen.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Evidence id が重複しています: ${e.id}`,
          path: ["evidence", i, "id"],
        });
      }
      evidenceIdsSeen.add(e.id);
    }
    const evidenceById = new Map(rs.evidence.map((e) => [e.id, e] as const));

    // ---- Envelope -------------------------------------------------------------
    const envelopeKeysSeen = new Set<string>();
    for (const [i, env] of rs.envelopes.entries()) {
      const key = `${env.method}::${env.tier}::${env.recoveryStructure ?? "NULL"}::${[...env.templateIds].sort().join(",")}`;
      if (envelopeKeysSeen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Envelope キー（method+tier+recoveryStructure+templateIds）が重複しています: ${key}`,
          path: ["envelopes", i],
        });
      }
      envelopeKeysSeen.add(key);

      for (const tid of env.templateIds) {
        if (!templateIdsSeen.has(tid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Envelope.templateIds が実在しない template を参照しています: ${tid}`,
            path: ["envelopes", i, "templateIds"],
          });
        }
      }
      if (env.method === "LONG_SPRINT_RACE_SPECIFIC" && env.recoveryStructure === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "LONG_SPRINT_RACE_SPECIFIC の Envelope は recoveryStructure（FULL/INCOMPLETE）が必須です",
          path: ["envelopes", i, "recoveryStructure"],
        });
      }

      for (const [field, cell] of Object.entries(env.fields)) {
        if (!cell) continue;
        for (const [ei, evId] of cell.evidenceIds.entries()) {
          const evidence = evidenceById.get(evId);
          if (!evidence) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Envelope.fields.${field}.evidenceIds が実在しない Evidence を参照しています: ${evId}`,
              path: ["envelopes", i, "fields", field, "evidenceIds", ei],
            });
            continue;
          }
          if (evidence.usage !== "PRESCRIPTION") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Envelope は usage=PRESCRIPTION の Evidence しか参照できません（${evId} は usage=${evidence.usage}）。CONTEXT_ONLY/CHECK_ONLY を数値根拠にすることはできません（Fable C-8 / T-EV-03）`,
              path: ["envelopes", i, "fields", field, "evidenceIds", ei],
            });
          }
        }
      }
    }

    // ---- Eligibility ----------------------------------------------------------
    for (const [i, rule] of rs.eligibility.entries()) {
      for (const tid of rule.templateIds) {
        if (!templateIdsSeen.has(tid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `EligibilityRule.templateIds が実在しない template を参照しています: ${tid}`,
            path: ["eligibility", i, "templateIds"],
          });
        }
      }
    }
    const eligibilityIdsSeen = new Set<string>();
    for (const [i, rule] of rs.eligibility.entries()) {
      if (eligibilityIdsSeen.has(rule.ruleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `EligibilityRule.ruleId が重複しています: ${rule.ruleId}`,
          path: ["eligibility", i, "ruleId"],
        });
      }
      eligibilityIdsSeen.add(rule.ruleId);
    }

    // ---- Plausibility -----------------------------------------------------------
    const plausibilityIdsSeen = new Set<string>();
    for (const [i, rule] of rs.plausibility.entries()) {
      if (plausibilityIdsSeen.has(rule.ruleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `PlausibilityRule.ruleId が重複しています: ${rule.ruleId}`,
          path: ["plausibility", i, "ruleId"],
        });
      }
      plausibilityIdsSeen.add(rule.ruleId);
    }

    // ---- StopPolicy -----------------------------------------------------------
    const stopPolicyIdsSeen = new Set<string>();
    for (const [i, sp] of rs.stopPolicies.entries()) {
      if (stopPolicyIdsSeen.has(sp.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `StopPolicy.id が重複しています: ${sp.id}`,
          path: ["stopPolicies", i, "id"],
        });
      }
      stopPolicyIdsSeen.add(sp.id);
    }
    // [R4] method × recoveryStructure ごとに、ANY が1件だけ、または AUTO_CONDITIONS_MET と
    // MANUAL_OR_OVERRIDE が1件ずつ（policy を一意に選べること）。
    const policyGroups = new Map<string, typeof rs.stopPolicies>();
    for (const sp of rs.stopPolicies) {
      const key = `${sp.method}::${sp.appliesToRecoveryStructure ?? "NULL"}`;
      policyGroups.set(key, [...(policyGroups.get(key) ?? []), sp]);
    }
    for (const [key, group] of policyGroups) {
      const paths = group.map((sp) => sp.appliesToEligibilityPath).sort().join(",");
      if (paths !== "ANY" && paths !== "AUTO_CONDITIONS_MET,MANUAL_OR_OVERRIDE") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `StopPolicy（${key}）の appliesToEligibilityPath は ANY 1件、または AUTO_CONDITIONS_MET + MANUAL_OR_OVERRIDE の1件ずつである必要があります（実際: ${paths}）`,
          path: ["stopPolicies"],
        });
      }
    }

    // ---- Event definitions --------------------------------------------------------
    const markEventsSeen = new Set<string>();
    for (const [i, def] of rs.eventDefinitions.timedMarks.entries()) {
      if (markEventsSeen.has(def.event)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `eventDefinitions.timedMarks が重複しています: ${def.event}`, path: ["eventDefinitions", "timedMarks", i] });
      }
      markEventsSeen.add(def.event);
    }
    const raceEventsSeen = new Set<string>();
    for (const [i, def] of rs.eventDefinitions.raceEvents.entries()) {
      if (raceEventsSeen.has(def.event)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `eventDefinitions.raceEvents が重複しています: ${def.event}`, path: ["eventDefinitions", "raceEvents", i] });
      }
      raceEventsSeen.add(def.event);
    }

    // LONG 用 stop policy と recoveryStructure の整合（§10.3）。
    const lsrStopIds = new Set(
      rs.stopPolicies.filter((sp) => sp.method === "LONG_SPRINT_RACE_SPECIFIC").map((sp) => sp.id),
    );
    if (lsrStopIds.size > 0) {
      const fullPolicies = rs.stopPolicies.filter(
        (sp) => sp.method === "LONG_SPRINT_RACE_SPECIFIC" && sp.appliesToRecoveryStructure === "FULL",
      );
      const incompletePolicies = rs.stopPolicies.filter(
        (sp) =>
          sp.method === "LONG_SPRINT_RACE_SPECIFIC" && sp.appliesToRecoveryStructure === "INCOMPLETE",
      );
      if (fullPolicies.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "LONG_SPRINT_RACE_SPECIFIC + FULL 用の StopPolicy が最低1件必要です（SP_LSR_FULL 等）",
          path: ["stopPolicies"],
        });
      }
      if (incompletePolicies.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "LONG_SPRINT_RACE_SPECIFIC + INCOMPLETE 用の StopPolicy が最低1件必要です（SP_LSR_INCOMPLETE_ADV 等）",
          path: ["stopPolicies"],
        });
      }
    }

    // ---- ReadinessRule ----------------------------------------------------------
    const readinessIdsSeen = new Set<string>();
    for (const [i, rule] of rs.readinessRules.entries()) {
      if (readinessIdsSeen.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ReadinessRule.id が重複しています: ${rule.id}`,
          path: ["readinessRules", i, "id"],
        });
      }
      readinessIdsSeen.add(rule.id);
      if (rule.kind === "PAIN_RED_FLAG_GROUP") {
        for (const flag of rule.redFlags) {
          const others = rs.readinessRules.filter(
            (r) => r.kind === "PAIN_RED_FLAG_GROUP" && r.id !== rule.id && (r.redFlags as readonly string[]).includes(flag),
          );
          if (others.length > 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `red flag ${flag} が複数の PAIN_RED_FLAG_GROUP に属しています（判定が曖昧になる）`,
              path: ["readinessRules", i, "redFlags"],
            });
          }
        }
      }
      if (rule.kind === "SWAP_TARGET") {
        for (const method of rule.fromMethods) {
          const others = rs.readinessRules.filter(
            (r) => r.kind === "SWAP_TARGET" && r.id !== rule.id && (r.fromMethods as readonly string[]).includes(method),
          );
          if (others.length > 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Method ${method} の SWAP_TARGET が複数あります`,
              path: ["readinessRules", i, "fromMethods"],
            });
          }
        }
        for (const [ti, target] of rule.targets.entries()) {
          for (const tid of target.templateIds ?? []) {
            const template = rs.templates.find((t) => t.id === tid);
            if (!template || template.method !== target.method) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `SWAP_TARGET.targets が実在しない template（または Method 不一致）を参照しています: ${tid}`,
                path: ["readinessRules", i, "targets", ti, "templateIds"],
              });
            }
          }
        }
      }
      if (rule.kind === "SIGNAL_COUNT") {
        const duplicate = rs.readinessRules.some((r) => r.kind === "SIGNAL_COUNT" && r.id !== rule.id && r.minSignals === rule.minSignals);
        if (duplicate) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `SIGNAL_COUNT.minSignals=${rule.minSignals} の行が重複しています`,
            path: ["readinessRules", i, "minSignals"],
          });
        }
      }
    }

    // ---- AggregationRule（R6）----------------------------------------------------
    const aggIdsSeen = new Set<string>();
    for (const [i, rule] of rs.aggregationRules.entries()) {
      if (aggIdsSeen.has(rule.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `AggregationRule.id が重複しています: ${rule.id}`, path: ["aggregationRules", i, "id"] });
      }
      aggIdsSeen.add(rule.id);
      if (rule.kind === "ACCEL_INTERVAL" && rule.lowerM > rule.upperM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ACCEL_INTERVAL は lowerM <= upperM である必要があります",
          path: ["aggregationRules", i, "upperM"],
        });
      }
      if (rule.kind === "ACCEL_INTERVAL") {
        const dup = rs.aggregationRules.some((r) => r.kind === "ACCEL_INTERVAL" && r.id !== rule.id && r.tier === rule.tier);
        if (dup) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `tier ${rule.tier} の ACCEL_INTERVAL が複数あります（A は tier ごとに1つ）`,
            path: ["aggregationRules", i, "tier"],
          });
        }
      }
      if (rule.kind === "METHOD_AGGREGATION") {
        const dup = rs.aggregationRules.some((r) => r.kind === "METHOD_AGGREGATION" && r.id !== rule.id && r.method === rule.method);
        if (dup) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Method ${rule.method} の METHOD_AGGREGATION が複数あります`,
            path: ["aggregationRules", i, "method"],
          });
        }
      }
      if (rule.kind === "LEGACY_CATEGORY") {
        const dup = rs.aggregationRules.some((r) => r.kind === "LEGACY_CATEGORY" && r.id !== rule.id && r.category === rule.category);
        if (dup) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `legacy category ${rule.category} の LEGACY_CATEGORY が複数あります`,
            path: ["aggregationRules", i, "category"],
          });
        }
      }
      if (rule.kind === "SESSION_VOLUME_LIMIT") {
        const dup = rs.aggregationRules.some((r) => r.kind === "SESSION_VOLUME_LIMIT" && r.id !== rule.id && r.metric === rule.metric);
        if (dup) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `metric ${rule.metric} の SESSION_VOLUME_LIMIT が複数あります`,
            path: ["aggregationRules", i, "metric"],
          });
        }
      }
    }
    const budgetRules = rs.aggregationRules.filter((r) => r.kind === "HIGH_INTENSITY_BUDGET");
    if (rs.aggregationRules.length > 0 && budgetRules.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "HIGH_INTENSITY_BUDGET はちょうど1行必要です",
        path: ["aggregationRules"],
      });
    }

    // ---- WeeklyRule（R7）----------------------------------------------------------
    const weeklyIdsSeen = new Set<string>();
    const weeklyKindsSeen = new Set<string>();
    for (const [i, rule] of rs.weeklyRules.entries()) {
      if (weeklyIdsSeen.has(rule.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `WeeklyRule.id が重複しています: ${rule.id}`, path: ["weeklyRules", i, "id"] });
      }
      weeklyIdsSeen.add(rule.id);
      if (weeklyKindsSeen.has(rule.kind) && rule.kind !== "HISTORY_UNKNOWN_POLICY") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `WeeklyRule.kind=${rule.kind} は複数指定できません`,
          path: ["weeklyRules", i, "kind"],
        });
      }
      weeklyKindsSeen.add(rule.kind);
    }

    // ---- PhaseRule（R7）------------------------------------------------------------
    const phasesSeen = new Set<string>();
    for (const [i, rule] of rs.phaseRules.entries()) {
      if (phasesSeen.has(rule.phase)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `PhaseRule.phase が重複しています: ${rule.phase}`, path: ["phaseRules", i, "phase"] });
      }
      phasesSeen.add(rule.phase);
    }

    // ---- CompetitionRule（R7）-------------------------------------------------------
    const competitionIdsSeen = new Set<string>();
    for (const [i, rule] of rs.competitionRules.entries()) {
      if (competitionIdsSeen.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `CompetitionRule.id が重複しています: ${rule.id}`,
          path: ["competitionRules", i, "id"],
        });
      }
      competitionIdsSeen.add(rule.id);
      // 同じ (priority, tier) の日範囲が重なっていないこと（誤って同じバケットを二重登録しない）。
      for (const [j, other] of rs.competitionRules.entries()) {
        if (j <= i) continue;
        if (other.priority !== rule.priority || other.tier !== rule.tier) continue;
        const overlaps = rule.dayMin <= other.dayMax && other.dayMin <= rule.dayMax;
        if (overlaps) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `CompetitionRule の日範囲が重複しています: ${rule.id} と ${other.id}`,
            path: ["competitionRules", i, "dayMin"],
          });
        }
      }
      if (rule.autogenExceptionAccMaxDistanceM !== null) {
        const hasAccTemplate = rs.templates.some((t) => t.method === "ACCELERATION" && t.fixedDistanceField === "repDistanceM");
        if (!hasAccTemplate) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "autogenExceptionAccMaxDistanceM を判定できる ACCELERATION template（fixedDistanceField=repDistanceM）がありません",
            path: ["competitionRules", i, "autogenExceptionAccMaxDistanceM"],
          });
        }
      }
    }

    // ---- ConstraintRule ---------------------------------------------------------
    const constraintIdsSeen = new Set<string>();
    for (const [i, c] of rs.constraints.entries()) {
      if (constraintIdsSeen.has(c.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ConstraintRule.id が重複しています: ${c.id}`,
          path: ["constraints", i, "id"],
        });
      }
      constraintIdsSeen.add(c.id);
      for (const [ti, tid] of c.disallowedTemplateIds.entries()) {
        if (!templateIdsSeen.has(tid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `ConstraintRule.disallowedTemplateIds が実在しない template を参照しています: ${tid}`,
            path: ["constraints", i, "disallowedTemplateIds", ti],
          });
        }
      }
    }

    // ---- unit sanity for envelope fields ---------------------------------------
    const expectedUnitByField: Partial<Record<EnvelopeField, string>> = {
      repDistanceM: "m",
      buildUpM: "m",
      flyZoneM: "m",
      decelerationM: "m",
      repDurationS: "s",
      repsPerSet: "reps",
      sets: "sets",
      totalReps: "reps",
      repRestS: "s",
      setRestS: "s",
      intraRepRestS: "s",
      sessionVolumeM: "m",
      flyVolumeM: "m",
      intensityPercent: "percent",
      attempts: "reps",
      vdecPercent: "percent",
    };
    for (const [i, env] of rs.envelopes.entries()) {
      for (const [field, cell] of Object.entries(env.fields)) {
        if (!cell) continue;
        const expected = expectedUnitByField[field as EnvelopeField];
        if (expected && cell.coachEditable.unit !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Envelope.fields.${field} の unit は "${expected}" である必要があります（実際: ${cell.coachEditable.unit}）`,
            path: ["envelopes", i, "fields", field, "coachEditable", "unit"],
          });
        }
      }
    }
  });
export type RuleSet = z.infer<typeof ruleSetSchema>;

// ---------------------------------------------------------------------------
// Completeness チェック（§22 R2 完了条件。ruleSetSchema 本体からは意図的に分離）
// ---------------------------------------------------------------------------

/**
 * `ruleSetSchema` は「構造として正しい RuleSet かどうか」だけを見る
 * （テスト用の最小 fixture もこの schema で検証できる必要があるため）。
 *
 * 一方、§22 R2 の完了条件（「全 Method の MethodMeta がある」「§3.3 の全
 * template が存在する」「§10.2 の全 TimingMethod がある」）は
 * **本番 RuleSet（rs-2026.09.0）だけに求められる網羅性**であり、
 * `tests/fixtures/running/rs-test-*.json` のような意図的に小さい RuleSet
 * には求めない。そのため `ruleSetSchema` の `.superRefine()` には含めず、
 * 本番 RuleSet の完全性を検証したいテスト（`ruleset.test.ts`）から明示的に
 * 呼び出す独立関数として提供する。
 */
export function checkRuleSetCompleteness(rs: RuleSet): string[] {
  const problems: string[] = [];

  const methodsSeen = new Set(rs.methods.map((m) => m.method));
  for (const method of RUNNING_TRAINING_METHODS) {
    if (!methodsSeen.has(method)) {
      problems.push(`canonical Method ${method} の MethodMeta がありません`);
    }
  }

  const templateIdsSeen = new Set(rs.templates.map((t) => t.id));
  for (const method of RUNNING_TRAINING_METHODS) {
    for (const id of TEMPLATE_IDS_BY_METHOD[method]) {
      if (!templateIdsSeen.has(id)) {
        problems.push(`R1 型に存在する template ${id}（${method}）が RuleSet に定義されていません`);
      }
    }
  }

  // [R5] §13: 全 RedFlag がいずれかのグループに属し、全 Method に SWAP_TARGET があること。
  const groupedFlags = new Set(rs.readinessRules.flatMap((r) => (r.kind === "PAIN_RED_FLAG_GROUP" ? r.redFlags : [])));
  for (const flag of RED_FLAGS) {
    if (!groupedFlags.has(flag)) problems.push(`ReadinessRule に RedFlag ${flag} の PAIN_RED_FLAG_GROUP がありません`);
  }
  const swapMethods = new Set(rs.readinessRules.flatMap((r) => (r.kind === "SWAP_TARGET" ? r.fromMethods : [])));
  for (const method of RUNNING_TRAINING_METHODS) {
    if (!swapMethods.has(method)) problems.push(`ReadinessRule に Method ${method} の SWAP_TARGET がありません`);
  }

  // [R6] §11: 全 Method に METHOD_AGGREGATION、全 tier に ACCEL_INTERVAL、高強度予算が1行あること。
  if (rs.aggregationRules.length > 0) {
    const aggMethods = new Set(rs.aggregationRules.flatMap((r) => (r.kind === "METHOD_AGGREGATION" ? [r.method] : [])));
    for (const method of RUNNING_TRAINING_METHODS) {
      if (!aggMethods.has(method)) problems.push(`AggregationRule に Method ${method} の METHOD_AGGREGATION がありません`);
    }
    const aggTiers = new Set(rs.aggregationRules.flatMap((r) => (r.kind === "ACCEL_INTERVAL" ? [r.tier] : [])));
    for (const tier of ENVELOPE_TIERS) {
      if (!aggTiers.has(tier)) problems.push(`AggregationRule に tier ${tier} の ACCEL_INTERVAL（推定加速距離 A）がありません`);
    }
    if (!rs.aggregationRules.some((r) => r.kind === "HIGH_INTENSITY_BUDGET")) {
      problems.push("AggregationRule に HIGH_INTENSITY_BUDGET がありません");
    }
    if (!rs.aggregationRules.some((r) => r.kind === "RELAY_ALLOWANCE")) {
      problems.push("AggregationRule に RELAY_ALLOWANCE がありません");
    }
  }

  // [R7] §12: WeeklyRule の必須 kind、§14: 全 TrainingPhase に PhaseRule、全 priority に
  // CompetitionRule の n=1 行があること。
  if (rs.weeklyRules.length > 0) {
    const weeklyKinds = new Set(rs.weeklyRules.map((r) => r.kind));
    for (const kind of ["WINDOW_HOURS", "RELEVANT_CATEGORIES", "HIGH_SESSIONS_7D", "YOUTH_REST_DAYS", "YOUTH_MAX_MINUTES_7D", "HISTORY_UNKNOWN_POLICY"] as const) {
      if (!weeklyKinds.has(kind)) problems.push(`WeeklyRule に kind=${kind} がありません`);
    }
  }
  if (rs.phaseRules.length > 0) {
    const phasesSeen = new Set(rs.phaseRules.map((r) => r.phase));
    for (const phase of TRAINING_PHASES) {
      if (!phasesSeen.has(phase)) problems.push(`PhaseRule に phase=${phase} がありません`);
    }
  }
  if (rs.competitionRules.length > 0) {
    for (const priority of COMPETITION_PRIORITIES) {
      const hasDayOne = rs.competitionRules.some((r) => (r.priority === priority || r.priority === null) && r.dayMin <= 1 && r.dayMax >= 1);
      if (!hasDayOne) problems.push(`CompetitionRule に priority=${priority} の n=1 行がありません`);
    }
    const hasDayZero = rs.competitionRules.some((r) => r.dayMin === 0 && r.raceIsLoadEvent);
    if (!hasDayZero) problems.push("CompetitionRule に n=0（raceIsLoadEvent）の行がありません");
    const hasTaper = rs.competitionRules.some((r) => r.taperGuidance !== null);
    if (!hasTaper) problems.push("CompetitionRule に taperGuidance（ADVANCED×PEAK）の行がありません");
  }

  const markEvents = new Set(rs.eventDefinitions.timedMarks.map((d) => d.event));
  for (const event of TIMED_MARK_EVENTS) {
    if (!markEvents.has(event)) problems.push(`eventDefinitions.timedMarks に ${event} がありません`);
  }
  const raceEvents = new Set(rs.eventDefinitions.raceEvents.map((d) => d.event));
  for (const event of RACE_EVENTS) {
    if (!raceEvents.has(event)) problems.push(`eventDefinitions.raceEvents に ${event} がありません`);
  }

  const timingMethodsSeen = new Set(rs.timingTolerances.map((t) => t.timing));
  for (const timing of ["HAND", "PHOTO_CELL", "FAT", "VIDEO", "RADAR_LASER", "UNKNOWN"] as const) {
    if (!timingMethodsSeen.has(timing)) {
      problems.push(`TimingToleranceRule に timing=${timing} がありません（§10.2 は全 TimingMethod を要求）`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Manifest entry（§6.2）
// ---------------------------------------------------------------------------

export const manifestEntrySchema = z.object({
  version: z.string().min(1),
  status: ruleSetStatusSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, "contentHash は SHA-256 の16進文字列（64文字）である必要があります"),
  validFrom: isoDateSchema,
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.array(manifestEntrySchema).superRefine((entries, ctx) => {
  const versionsSeen = new Set<string>();
  for (const [i, e] of entries.entries()) {
    if (versionsSeen.has(e.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `manifest に version の重複があります: ${e.version}`,
        path: [i, "version"],
      });
    }
    versionsSeen.add(e.version);
  }
});
export type Manifest = z.infer<typeof manifestSchema>;
