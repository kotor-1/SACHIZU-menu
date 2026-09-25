/**
 * Running Prescription Engine v2 — Finding / FindingSeverity / RationaleLine（§2.5）。
 *
 * R1 では Finding の「発生条件」（aggregation・plausibility 等）は実装しない。
 * ここにあるのは型と Zod schema だけ。
 */
import { z } from "zod";
import { anyUnitQuantityIntervalSchema, anyUnitRangeSchema, evidenceIdSchema } from "./primitives";
import { isoDateSchema } from "./primitives";
import { timedMarkEventSchema, timingMethodSchema } from "./intensity";

/** Exact semantic source metadata retained on planner-produced input findings. */
export const findingSourceRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TIMED_MARK"), record: z.object({
    event: timedMarkEventSchema,
    timeS: z.number().positive().finite(),
    date: isoDateSchema,
    timing: timingMethodSchema,
    videoFps: z.number().positive().optional(),
    wind: z.number().nullable().optional(),
    startType: z.enum(["BLOCK", "THREE_POINT", "STANDING", "FLYING"]).optional(),
    surface: z.enum(["TRACK", "GRASS", "ARTIFICIAL", "ROAD", "OTHER"]).nullable().optional(),
    spikes: z.boolean().nullable().optional(),
  }).strict() }).strict(),
  z.object({
    kind: z.literal("HEIGHT_POINT"),
    memberIdentity: z.string().trim().min(1).max(128).nullable(),
    date: isoDateSchema,
    heightCm: z.number().positive().finite(),
  }).strict(),
]);
export type FindingSourceRecord = z.infer<typeof findingSourceRecordSchema>;

export const FINDING_SEVERITIES = [
  "INFO",
  "WARN",
  "REQUIRE_CONFIRMATION",
  "REQUIRE_COACH_REVIEW",
  "BLOCK_AUTOGEN",
  "BLOCK",
] as const;
export const findingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const FINDING_SCOPES = ["ITEM", "SESSION", "WEEK"] as const;
export const findingScopeSchema = z.enum(FINDING_SCOPES);

export const PLAUSIBILITY_POLICIES = [
  "METHOD_POLICY_HARD",
  "PRODUCT_DATA_SANITY_HARD",
  "COACH_OVERRIDABLE_STRONG_REVIEW",
  "NON_OVERRIDABLE_DATA_SANITY_HARD",
  "DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW",
] as const;
export const plausibilityPolicySchema = z.enum(PLAUSIBILITY_POLICIES);
export type PlausibilityPolicy = z.infer<typeof plausibilityPolicySchema>;

export const PLAUSIBILITY_CERTAINTIES = [
  "CONFIRMED_EXCEED",
  "POSSIBLE_EXCEED",
  "CONFIRMED_WITHIN",
  "UNEVALUABLE",
  "DATA_QUALITY",
] as const;
export const plausibilityCertaintySchema = z.enum(PLAUSIBILITY_CERTAINTIES);
export type PlausibilityCertainty = z.infer<typeof plausibilityCertaintySchema>;

export const PLAUSIBILITY_PRESENTATION_KINDS = [
  "METHOD_POLICY",
  "PRODUCT_DATA_SANITY",
  "STRONG_REVIEW_REQUIRED",
  "DATA_QUALITY",
  "INTERVAL_UNCERTAIN",
] as const;
export const plausibilityPresentationKindSchema = z.enum(PLAUSIBILITY_PRESENTATION_KINDS);

export const findingPlausibilitySchema = z.object({
  ruleId: z.string().min(1),
  policy: z.union([plausibilityPolicySchema, z.literal("DATA_QUALITY")]),
  certainty: plausibilityCertaintySchema,
  presentationKind: plausibilityPresentationKindSchema,
  boundary: z.object({ side: z.enum(["MIN", "MAX"]), threshold: z.number() }).optional(),
  /** Server/domain-produced input findings bind review targets to the selected source record. */
  sourceRecord: findingSourceRecordSchema.optional(),
});

export const findingSchema = z.object({
  code: z.string().min(1),
  severity: findingSeveritySchema,
  scope: findingScopeSchema,
  metric: z.string().optional(),
  value: anyUnitQuantityIntervalSchema.optional(),
  limit: anyUnitRangeSchema.optional(),
  /** Structured, rule-bound plausibility classification. Optional for legacy snapshots. */
  plausibility: findingPlausibilitySchema.optional(),
  evidenceIds: z.array(evidenceIdSchema),
});
export type Finding = z.infer<typeof findingSchema>;

// ---------------------------------------------------------------------------
// RationaleLine
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] 正式仕様は `RunningPrescription.rationale: RationaleLine[]` を
 * 「コード + パラメータ。表示は rationale/ で日本語化」とだけ書いており、
 * `RationaleLine` 自体の具体的なフィールド構成は定義していない
 * （`src/domain/running/rationale/` は日本語レンダラの置き場としてのみ
 * §1.4 に登場する）。legacy の `rationale: string[]`（直接日本語文字列を
 * 保持する）とは異なり、v2 では「コードと引数」を保持し、表示側で
 * enum キーをそのまま出さない設計にする、という §2.5 の意図を汲んで
 * 最小限の構造を定義した。
 */
export const rationaleLineSchema = z.object({
  code: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type RationaleLine = z.infer<typeof rationaleLineSchema>;
