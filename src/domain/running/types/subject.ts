/**
 * Running Prescription Engine v2 — Population & Athlete Context の型（§4.1〜§4.5）。
 *
 * 重要: これは型と Zod schema だけ。`resolveSubjectProfile()`（R3）は実装しない。
 * 具体的には以下を一切行わない（正式仕様 §4 の R1 向け禁止事項）:
 *   - UNKNOWN → PRE への変換
 *   - maturity / tier の判定ロジック
 *   - 年齢から PHV を推定する計算（Mirwald 式・growth velocity 計算）
 *
 * `MaturityAssessment.equation` のように、将来 Mirwald 式などを受け取る
 * 入力フィールドは型として用意するが、それを**計算する関数はここに置かない**。
 */
import { z } from "zod";
import { isoDateSchema, raceEventSchema } from "./primitives";
import { timedMarkSchema, velocityEstimateSchema, type TimedMark } from "./intensity";

// ---------------------------------------------------------------------------
// AgeBand（暦年齢。maturation とは独立）
// ---------------------------------------------------------------------------

export const AGE_BANDS = ["U12", "U15", "U18", "ADULT"] as const;
export const ageBandSchema = z.enum(AGE_BANDS);
export type AgeBand = z.infer<typeof ageBandSchema>;

// ---------------------------------------------------------------------------
// Maturity
// ---------------------------------------------------------------------------

export const MATURITY_STATUSES = ["PRE", "CIRCA", "POST", "UNKNOWN"] as const;
export const maturityStatusSchema = z.enum(MATURITY_STATUSES);
export type MaturityStatus = z.infer<typeof maturityStatusSchema>;

export const MATURITY_CONFIDENCES = ["LOW", "MEDIUM", "HIGH"] as const;
export const maturityConfidenceSchema = z.enum(MATURITY_CONFIDENCES);
export type MaturityConfidence = z.infer<typeof maturityConfidenceSchema>;

export const MATURITY_ASSESSMENT_METHODS = [
  "NONE",
  "COACH_OBSERVATION",
  "PARENT_REPORT",
  "GROWTH_VELOCITY",
  "MATURITY_OFFSET_EQUATION",
] as const;
export const maturityAssessmentMethodSchema = z.enum(MATURITY_ASSESSMENT_METHODS);

export const maturityEquationSchema = z.object({
  id: z.enum(["MIRWALD_2002", "OTHER"]),
  offsetYears: z.number(),
  se: z.number().optional(),
});

export const maturityAssessmentSchema = z.object({
  status: maturityStatusSchema,
  confidence: maturityConfidenceSchema,
  method: maturityAssessmentMethodSchema,
  assessedAt: isoDateSchema.nullable(),
  heightHistory: z
    .array(z.object({ date: isoDateSchema, heightCm: z.number().positive().finite() }))
    .optional(),
  equation: maturityEquationSchema.nullable().optional(),
});
export type MaturityAssessment = z.infer<typeof maturityAssessmentSchema>;

// ---------------------------------------------------------------------------
// TrainingAge / EnvelopeTier
// ---------------------------------------------------------------------------

export const TRAINING_AGE_TIERS = ["BEGINNER", "DEVELOPING", "TRAINED", "ADVANCED"] as const;
export const trainingAgeTierSchema = z.enum(TRAINING_AGE_TIERS);
export type TrainingAgeTier = z.infer<typeof trainingAgeTierSchema>;

export const trainingAgeInputSchema = z.object({
  // [R3 defect fix] z.number().nonnegative() だけでは +Infinity を拒否できない
  // （NaN は基底の z.number() が既に拒否するが、Infinity は「非負の有限でない数」
  // として通過してしまう）。R3 の Training Age validation 要件
  // （負値・NaN・Infinity をすべて拒否）を満たすため `.finite()` を追加する。
  // 他のフィールド・意味は変更していない。
  structuredSprintYears: z.number().nonnegative().finite().nullable(),
  coachAssignedTier: trainingAgeTierSchema.nullable().optional(),
});
export type TrainingAgeInput = z.infer<typeof trainingAgeInputSchema>;

/** Envelope の系統（DEVELOPMENTAL / ADVANCED）。導出ロジックは R3。 */
export const ENVELOPE_TIERS = ["DEVELOPMENTAL", "ADVANCED"] as const;
export const envelopeTierSchema = z.enum(ENVELOPE_TIERS);
export type EnvelopeTier = z.infer<typeof envelopeTierSchema>;

// ---------------------------------------------------------------------------
// PerformanceMark（= TimedMark の別名。§1.4 の subject.ts コメントに合わせる）
// ---------------------------------------------------------------------------

export const performanceMarkSchema = timedMarkSchema;
export type PerformanceMark = TimedMark;

// ---------------------------------------------------------------------------
// AthleteProfile / GroupProfile / Subject
// ---------------------------------------------------------------------------

const primaryEventSchema = z.union([
  raceEventSchema,
  z.literal("HURDLES"),
  z.literal("LJ"),
  z.literal("TJ"),
  z.literal("HJ"),
  z.literal("PV"),
  z.literal("OTHER"),
]);

export const athleteProfileSchema = z.object({
  birthDate: isoDateSchema.nullable(),
  ageBandOverride: ageBandSchema.optional(),
  schoolGrade: z.string().nullable().optional(),
  sexForNorms: z.enum(["MALE", "FEMALE"]).nullable().optional(),
  primaryEvent: primaryEventSchema,
  maturity: maturityAssessmentSchema,
  trainingAge: trainingAgeInputSchema,
  marks: z.array(performanceMarkSchema),
  vmax: velocityEstimateSchema.nullable().optional(),
  allowAdvancedMethods: z.boolean(),
});
export type AthleteProfile = z.infer<typeof athleteProfileSchema>;

/**
 * GroupProfile のメンバーは AthleteProfile のうち §4.1 で明示された5フィールド
 * だけを持つ（`.pick()` で AthleteProfile と定義がズレないようにする）。
 */
export const groupProfileMemberSchema = athleteProfileSchema.pick({
  birthDate: true,
  ageBandOverride: true,
  maturity: true,
  trainingAge: true,
  primaryEvent: true,
});
export type GroupProfileMember = z.infer<typeof groupProfileMemberSchema>;

export const groupProfileSchema = z.object({
  label: z.string().min(1),
  members: z.array(groupProfileMemberSchema),
  memberCountHint: z.number().int().positive().optional(),
  availableMinutes: z.number().positive().nullable().optional(),
  allowAdvancedMethods: z.boolean(),
});
export type GroupProfile = z.infer<typeof groupProfileSchema>;

export const subjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GROUP"), profile: groupProfileSchema }),
  z.object({ kind: z.literal("ATHLETE"), profile: athleteProfileSchema }),
]);
export type Subject = z.infer<typeof subjectSchema>;
