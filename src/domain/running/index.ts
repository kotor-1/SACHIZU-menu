/**
 * Running Prescription Engine v2 — 公開 API（§1.5）。
 *
 * ここから export されるのは「今すぐ外部（将来の R2 以降のファイル、または
 * 他のドメイン層）から必要になるもの」だけ。内部の schema ファクトリ
 * （`rangeSchema` / `quantityIntervalSchema` / `fieldValueSchema` 等）や、
 * ファイル間の配線用に使っている内部定数（`TEMPLATE_ID_SCHEMA_BY_METHOD` 等）は
 * ここから export しない。
 *
 * R1 時点では §1.5 の公開 API 関数（`getActiveRuleSet` 等）はまだ1つも
 * 実装していない（すべて R2 以降）。ここに並んでいるのは R1 で作った
 * domain types / schemas と、Evidence model の2つの純粋関数だけ。
 */

// --- Method / Template -------------------------------------------------------
export {
  RUNNING_TRAINING_METHODS,
  runningTrainingMethodSchema,
  type RunningTrainingMethod,
} from "./types/method";
export {
  runningSelectionSchema,
  recoveryStructureSchema,
  type RunningSelection,
  type TemplateIdByMethod,
  type SessionTemplateId,
  type SessionTemplate,
  type RecoveryStructure,
} from "./types/template";

// --- Primitives（公開が必要な最小限） ----------------------------------------
// `rangeSchema` / `softRangeSchema` / `quantityIntervalSchema` はジェネリックな
// schema 組立専用関数（内部実装）のため、このファイルの冒頭コメントどおり
// export しない。必要な型（`Range` / `SoftRange` / `QuantityInterval`）は
// 下記のとおり型としてのみ公開する。domain 内部（R2 以降の同ディレクトリ配下）
// から直接使う場合は `./types/primitives` を直接 import すること。
export {
  unitSchema,
  dataSourceSchema,
  confidenceSchema,
  raceEventSchema,
  competitionPrioritySchema,
  type Unit,
  type Range,
  type SoftRange,
  type DataSource,
  type Confidence,
  type QuantityInterval,
  type EvidenceId,
  type StopPolicyId,
  type RaceEvent,
  type CompetitionPriority,
  type Brand,
} from "./types/primitives";

// --- Intensity ---------------------------------------------------------------
export {
  intensityReferenceSchema,
  timingMethodSchema,
  type IntensityReference,
  type TimingMethod,
  type VelocityEstimate,
  type TimedMark,
} from "./types/intensity";

// --- Subject / Population（型のみ。resolveSubjectProfile は R3） -------------
export {
  subjectSchema,
  ageBandSchema,
  maturityStatusSchema,
  maturityConfidenceSchema,
  trainingAgeTierSchema,
  envelopeTierSchema,
  type Subject,
  type AthleteProfile,
  type GroupProfile,
  type AgeBand,
  type MaturityStatus,
  type MaturityConfidence,
  type MaturityAssessment,
  type TrainingAgeInput,
  type TrainingAgeTier,
  type EnvelopeTier,
  type PerformanceMark,
} from "./types/subject";

// --- Prescription domain types ------------------------------------------------
// `fieldValueSchema` もジェネリックな schema 組立専用関数のため export しない
// （`FieldValue` 型のみ公開。理由は Primitives セクションのコメントと同じ）。
export {
  flyRepSchema,
  splitSegmentSchema,
  restPlanSchema,
  runningPrescriptionSchema,
  directnessSchema,
  prescriptionConfidenceSchema,
  type FieldValue,
  type FlyRep,
  type SplitSegment,
  type RestPlan,
  type RepSpecByMethod,
  type RunningPrescription,
  type RunningPrescriptionValue,
  type Directness,
  type PrescriptionConfidence,
} from "./types/prescription";

// --- Findings ------------------------------------------------------------------
export {
  findingSchema,
  findingSeveritySchema,
  rationaleLineSchema,
  type Finding,
  type FindingSeverity,
  type RationaleLine,
} from "./types/findings";

// --- Readiness の入力型（§13.1） ---------------------------------------------
export {
  readinessActionCodeSchema,
  safetyOutcomeSchema,
  painReportSchema,
  readinessReportSchema,
  bodyRegionSchema,
  redFlagSchema,
  type ReadinessActionCode,
  type SafetyOutcome,
  type PainReport,
  type ReadinessReport,
  type BodyRegion,
  type RedFlag,
} from "./types/readiness";

// --- Load（型のみ。導出・週次判定は R7） -------------------------------------
export { loadCategorySchema, loadEventSchema, type LoadCategory, type LoadEvent } from "./types/load";

// --- Actor / AI boundary の基礎型 --------------------------------------------
export {
  actorSchema,
  coachActorSchema,
  createCoachActor,
  generationRecordSchema,
  type Actor,
  type CoachActor,
  type AiPlannerActor,
  type SystemActor,
  type GenerationRecord,
} from "./types/actor";

// --- Evidence model ------------------------------------------------------------
export {
  evidenceRecordSchema,
  sourceTypeSchema,
  evidenceLevelForSourceType,
  evidenceUsageSchema,
  evidenceVerificationSchema,
  type EvidenceRecord,
  type SourceType,
  type EvidenceLevel,
  type EvidencePopulation,
  type EvidenceUsage,
  type EvidenceVerification,
  type PerformanceLevel,
  type Sport,
} from "./evidence/schema";

export {
  deriveDirectness,
  type DirectnessEvidenceInput,
  type EvidencePopulationContext,
} from "./evidence/directness";

export {
  derivePrescriptionConfidence,
  type ConfidenceInputs,
  type UsedEvidenceSummary,
  type HistoryCoverage,
} from "./evidence/confidence";

// --- RuleSet（R2） ------------------------------------------------------------
// manifest/hash 計算などの内部配線（`readManifest`/`computeContentHash` 等は
// `scripts/running-ruleset-hash.ts` 側）や、schema 組み立て専用のジェネリック
// helper はここから export しない（Primitives セクションと同じ方針）。
export {
  ruleSetSchema,
  methodMetaSchema,
  ruleSetSessionTemplateSchema,
  envelopeSchema,
  envelopeCellSchema,
  eligibilityRuleSchema,
  plausibilityRuleSchema,
  timingToleranceRuleSchema,
  stopPolicySchema,
  type RuleSet,
  type RuleSetStatus,
  type MethodMeta,
  type RuleSetSessionTemplate,
  type Envelope,
  type EnvelopeCell,
  type EnvelopeField,
  type EligibilityRule,
  type PlausibilityRule,
  type TimingToleranceRule,
  type StopPolicy,
  type Judgement,
} from "./rules/schema";

export { getRuleSet, getActiveRuleSet, type ActiveRuleSetResult } from "./rules/loader";

// --- Athlete context（R3） -----------------------------------------------------
// §1.5 の R3 公開 API は `resolveSubjectProfile` だけ。eligibility 解決・LONG/ASSISTED
// 候補判定・ageBand/maturity/trainingAge/constraints/performance の各 helper は
// R4 内部ロジック用であり root からは export しない（必要なら
// `src/domain/running/context/*` を直接 import する）。
export { resolveSubjectProfile, type ResolveSubjectProfileInput, type SubjectProfile } from "./context/subject";

// --- Planning engine（R4） ----------------------------------------------------
// §1.5 の R4 公開 API は `planRunningPrescription` と入出力型だけ。selectEnvelope / placeValue /
// individualize / derivePlanningConfidence / validateSelection / buildPrescription 等の各 step と、
// RuleSet 差し替え用の `planRunningPrescriptionWithRuleSet`（テスト専用）は root から export しない。
export { planRunningPrescription, type PlanRequest, type PlanResult } from "./planning";

// --- Readiness / Pain gate（R5） ----------------------------------------------
// §1.5 の R5 公開 API は `resolveReadinessAction` と入出力型だけ。内部ロジック
// （evaluatePainGate / deriveReadinessActions / resolveSwapTargets / buildAiSafeSubjectContext）は
// root から export しない（必要なら `src/domain/running/readiness/*` を直接 import する）。
// AI に渡してよい文脈の型 `AiSafeSubjectContext` だけは、呼び出し側が「これ以外を渡さない」ことを
// 型で担保できるよう公開する（値を作る関数は公開しない）。
export {
  resolveReadinessAction,
  type ReadinessContext,
  type ReadinessDecision,
  type ReadinessWindowState,
} from "./readiness";
export type { AiSafeSubjectContext } from "./readiness/aiSafeContext";
