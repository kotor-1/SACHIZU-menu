/**
 * Running Prescription Engine v2 — EnvelopeTier の導出（§4.5）。
 *
 * ADVANCED になるのは以下すべてを満たすときだけ:
 *   1. effective maturity（constraintCategory）= POST
 *   2. effective confidence >= MEDIUM
 *   3. trainingAgeTier ∈ {TRAINED, ADVANCED}
 *
 * E15 の growth velocity は CHECK_ONLY のため、tier eligibility へ自動的に
 * CIRCA 制約を追加しない。ここでは `constraintCategory === "POST"` と
 * `trainingAgeTier ∈ {TRAINED, ADVANCED}` の2条件だけを見ればよい。
 * それ以外はすべて DEVELOPMENTAL（成人の初心者も DEVELOPMENTAL。T-POP-05）。
 */
import type { EnvelopeTier, TrainingAgeTier } from "../types/subject";
import type { MaturityConstraintCategory } from "./maturity";

export function deriveEnvelopeTier(
  constraintCategory: MaturityConstraintCategory,
  trainingAgeTier: TrainingAgeTier,
): EnvelopeTier {
  const trainingAgeQualifies = trainingAgeTier === "TRAINED" || trainingAgeTier === "ADVANCED";
  if (constraintCategory === "POST" && trainingAgeQualifies) {
    return "ADVANCED";
  }
  return "DEVELOPMENTAL";
}
