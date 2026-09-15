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
  anyUnitRangeSchema,
  evidenceIdSchema,
  isoDateSchema,
  stopPolicyIdSchema,
} from "../types/primitives";
import { envelopeTierSchema } from "../types/subject";
import { loadCategorySchema } from "../types/load";
import { INTENSITY_REFERENCE_KINDS, timingMethodSchema } from "../types/intensity";
import { evidenceRecordSchema } from "../evidence/schema";

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
  })
  .superRefine((rule, ctx) => {
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
  })
  .superRefine((rule, ctx) => {
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
});
export type StopPolicy = z.infer<typeof stopPolicySchema>;

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
    constraints: notYetImplementedArraySchema,
    timingTolerances: z.array(timingToleranceRuleSchema),
    stopPolicies: z.array(stopPolicySchema),
    aggregationRules: notYetImplementedArraySchema,
    weeklyRules: notYetImplementedArraySchema,
    readinessRules: notYetImplementedArraySchema,
    phaseRules: notYetImplementedArraySchema,
    competitionRules: notYetImplementedArraySchema,
    plausibility: z.array(plausibilityRuleSchema),
    vmaxEstimationModels: notYetImplementedArraySchema,
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
