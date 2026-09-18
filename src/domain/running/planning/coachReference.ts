/**
 * Running Prescription Engine v2 — [R10-B4A.2] コーチ手入力の強度基準（Coach manual reference）の入力 contract。
 *
 * Action / UI から受け取るのは「区間の距離と目標タイム（1点）」だけで、ここで正式な `IntensityReference`
 * （`PlanRequest.coachReference` に渡す `CoachReferenceInput`）へ正規化する。R10-B4A.2 では TARGET_SPLIT のみ。
 *
 * - 目標タイムは入力された値そのもの（`lower = upper = targetTimeS`）。中央値・推定値・PB 由来の値を作らない。
 * - `source = "COACH_ENTERED"`。confidence は既存 domain の慣習（コーチ入力参照の inputData / 手入力距離は MEDIUM）に従う。
 *   これは「入力された計画値」の扱いであり、選手の performance evidence ではない（Subject の data confidence・EnvelopeTier・
 *   prescriptionConfidence / directness をこの入力を理由に引き上げない。GROUP では inputDataConfidenceCap も従来どおり適用）。
 * - TimedMark / PB / Vmax / SAME_DISTANCE_BEST へ変換しない（予定値は予定値のまま）。
 * - どの Method で使えるかはここでは決めない（RuleSet の `MethodMeta.allowedIntensityReferences` を planner が検証する）。
 * - COACH 以外の actor は `PlanRequest.coachReference` を持てない（planRequestSchema の superRefine。§18）。
 * - 距離・時間の科学的な下限 / 上限はここで作らない（正の有限値だけを検証する）。
 */
import { z } from "zod";
import type { Confidence } from "../types/primitives";
import { coachReferenceInputSchema, type CoachReferenceInput } from "./schema";

/** 既存 domain の慣習: コーチ入力参照の inputData（individualize.ts）・コーチ手入力距離（ATTEMPTS）と同じ MEDIUM。 */
export const COACH_ENTERED_REFERENCE_CONFIDENCE: Confidence = "MEDIUM";

const coachTargetSplitSegmentInputSchema = z
  .object({
    distanceM: z.number().finite().positive(),
    targetTimeS: z.number().finite().positive(),
  })
  .strict();

export const coachManualReferenceInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("TARGET_SPLIT"),
      segments: z.array(coachTargetSplitSegmentInputSchema).min(1),
    })
    .strict(),
]);
export type CoachManualReferenceInput = z.infer<typeof coachManualReferenceInputSchema>;

/** 入力（距離 + 目標タイム1点）→ 正式な CoachReferenceInput（IntensityReference の TARGET_SPLIT）。 */
export function toCoachReferenceInput(input: CoachManualReferenceInput): CoachReferenceInput {
  return coachReferenceInputSchema.parse({
    kind: "TARGET_SPLIT",
    segments: input.segments.map((s) => ({
      distanceM: s.distanceM,
      targetS: { lower: s.targetTimeS, upper: s.targetTimeS, unit: "s", source: "COACH_ENTERED", confidence: COACH_ENTERED_REFERENCE_CONFIDENCE },
    })),
  });
}
