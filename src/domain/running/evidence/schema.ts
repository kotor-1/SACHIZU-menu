/**
 * Running Prescription Engine v2 — EvidenceRecord（§5.1, §5.2）。
 *
 * 重要（Fable C-8）: `directness` と `prescriptionConfidence` は
 * **ここに保存しない**。両方とも runtime 導出であり、`directness.ts` /
 * `confidence.ts` の純粋関数が担当する。`evidenceRecordSchema` は
 * `.strict()` にしてあるため、誤って `directness` / `prescriptionConfidence`
 * のようなキーを含む JSON を渡すと **parse が失敗する**（型でもランタイムでも
 * 静的保存を防ぐ）。
 *
 * R1 では実際の文献データ（Haugen 2019 等）は一切投入しない。
 * `src/domain/running/rules/` と `rs-2026.09.0.json` は R2 で作る。
 * ここにあるのはスキーマと、§5.2 の「sourceType → evidenceLevel」の
 * 機械的な対応表（純粋関数）だけ。
 */
import { z } from "zod";
import { ageBandSchema, maturityStatusSchema } from "../types/subject";
import { evidenceIdSchema } from "../types/primitives";

// ---------------------------------------------------------------------------
// sourceType / evidenceLevel（§5.1, §5.2）
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = [
  "META_ANALYSIS",
  "SYSTEMATIC_REVIEW",
  "RCT",
  "CROSSOVER_REPEATED_MEASURES",
  "QUASI_EXPERIMENTAL",
  "OBSERVATIONAL",
  "MECHANISTIC",
  "NARRATIVE_REVIEW",
  "CONSENSUS_STATEMENT",
  "GOVERNING_BODY_GUIDANCE",
  "COACHING_BEST_PRACTICE",
  "ELITE_COACH_PRACTICE",
  "EXPERT_OPINION",
  "ENGINE_POLICY",
] as const;
export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const EVIDENCE_LEVELS = [1, 2, 3, 4, 5] as const;
export const evidenceLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

/**
 * §5.2 の対応表そのもの。研究デザインの「強さ」であり、
 * 「処方への適用可能性」ではない（そちらは directness.ts の役割。
 * Moran の meta-analysis が Haugen より「上」と誤読される事故を防ぐ —
 * Fable H-2 対応）。
 */
const EVIDENCE_LEVEL_BY_SOURCE_TYPE: Record<SourceType, EvidenceLevel> = {
  META_ANALYSIS: 1,
  SYSTEMATIC_REVIEW: 1,
  CONSENSUS_STATEMENT: 1,
  RCT: 2,
  CROSSOVER_REPEATED_MEASURES: 3,
  QUASI_EXPERIMENTAL: 3,
  OBSERVATIONAL: 3,
  MECHANISTIC: 3,
  NARRATIVE_REVIEW: 3,
  GOVERNING_BODY_GUIDANCE: 3,
  COACHING_BEST_PRACTICE: 4,
  ELITE_COACH_PRACTICE: 4,
  EXPERT_OPINION: 5,
  ENGINE_POLICY: 5,
};

/** §5.2 の表を機械的に適用するだけの純粋関数。判断・重み付けは一切しない。 */
export function evidenceLevelForSourceType(sourceType: SourceType): EvidenceLevel {
  return EVIDENCE_LEVEL_BY_SOURCE_TYPE[sourceType];
}

// ---------------------------------------------------------------------------
// population
// ---------------------------------------------------------------------------

export const SEXES = ["MALE", "FEMALE"] as const;
export const PERFORMANCE_LEVELS = ["YOUTH_DEVELOPING", "TRAINED", "NATIONAL", "ELITE"] as const;
export const performanceLevelSchema = z.enum(PERFORMANCE_LEVELS);
export type PerformanceLevel = z.infer<typeof performanceLevelSchema>;

export const SPORTS = ["TRACK_SPRINT", "TEAM_SPORT", "ENDURANCE", "MIXED", "GENERAL"] as const;
export const sportSchema = z.enum(SPORTS);
export type Sport = z.infer<typeof sportSchema>;

const anyOrArray = <T extends z.ZodTypeAny>(item: T) => z.union([z.array(item), z.literal("ANY")]);

export const evidencePopulationSchema = z.object({
  ageBands: anyOrArray(ageBandSchema),
  maturity: anyOrArray(maturityStatusSchema),
  sexes: anyOrArray(z.enum(SEXES)),
  performanceLevels: anyOrArray(performanceLevelSchema),
  sport: sportSchema,
  n: z.number().int().positive().nullable().optional(),
});
export type EvidencePopulation = z.infer<typeof evidencePopulationSchema>;

// ---------------------------------------------------------------------------
// reference / usage / verification / reportedBy
// ---------------------------------------------------------------------------

export const evidenceReferenceSchema = z.object({
  citation: z.string().min(1),
  year: z.number().int().nullable(),
  doi: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

export const EVIDENCE_USAGES = ["PRESCRIPTION", "CONTEXT_ONLY", "CHECK_ONLY"] as const;
export const evidenceUsageSchema = z.enum(EVIDENCE_USAGES);
export type EvidenceUsage = z.infer<typeof evidenceUsageSchema>;

export const EVIDENCE_VERIFICATIONS = ["SECONDARY_REPORT_ONLY", "PRIMARY_CHECKED"] as const;
export const evidenceVerificationSchema = z.enum(EVIDENCE_VERIFICATIONS);
export type EvidenceVerification = z.infer<typeof evidenceVerificationSchema>;

export const EVIDENCE_REPORTERS = [
  "PERPLEXITY_DR",
  "CLAUDE_DR",
  "CHATGPT_DR",
  "GEMINI_DR",
  "FABLE_REVIEW",
  "HUMAN",
] as const;
export const evidenceReporterSchema = z.enum(EVIDENCE_REPORTERS);

// ---------------------------------------------------------------------------
// EvidenceRecord
// ---------------------------------------------------------------------------

/**
 * `.strict()` が Fable C-8 の実装上の要。`directness` や
 * `prescriptionConfidence` のような余分なキーを含む入力は
 * **schema レベルで拒否**される（黙って無視されるのではなく parse エラーになる）。
 */
export const evidenceRecordSchema = z
  .object({
    id: evidenceIdSchema,
    sourceType: sourceTypeSchema,
    studyDesign: z.string().nullable(),
    population: evidencePopulationSchema,
    reference: evidenceReferenceSchema,
    evidenceLevel: evidenceLevelSchema,
    applicabilityNotes: z.string(),
    usage: evidenceUsageSchema,
    verification: evidenceVerificationSchema,
    reportedBy: z.array(evidenceReporterSchema).min(1),
    provisional: z.boolean(),
  })
  .strict()
  .refine((e) => e.evidenceLevel === evidenceLevelForSourceType(e.sourceType), {
    message:
      "evidenceLevel は sourceType から§5.2の対応表で機械的に決まる値と一致している必要があります",
    path: ["evidenceLevel"],
  });

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
