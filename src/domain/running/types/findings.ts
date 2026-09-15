/**
 * Running Prescription Engine v2 — Finding / FindingSeverity / RationaleLine（§2.5）。
 *
 * R1 では Finding の「発生条件」（aggregation・plausibility 等）は実装しない。
 * ここにあるのは型と Zod schema だけ。
 */
import { z } from "zod";
import { anyUnitQuantityIntervalSchema, anyUnitRangeSchema, evidenceIdSchema } from "./primitives";

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

export const findingSchema = z.object({
  code: z.string().min(1),
  severity: findingSeveritySchema,
  scope: findingScopeSchema,
  metric: z.string().optional(),
  value: anyUnitQuantityIntervalSchema.optional(),
  limit: anyUnitRangeSchema.optional(),
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
