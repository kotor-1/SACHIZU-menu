/**
 * Running Prescription Engine v2 — Training Age Tier の導出（§4.5）。
 *
 * `ADVANCED` は `coachAssignedTier` の明示指定でしか成立しない。
 * `structuredSprintYears` だけからは何年経過していても `TRAINED` までしか
 * 到達しない（20年でも ADVANCED にはならない）。倍率・係数は一切使わない。
 */
import type { TrainingAgeInput, TrainingAgeTier } from "../types/subject";

/**
 * §4.5:
 *   coachAssignedTier あり → その値をそのまま使う（ADVANCED もここでのみ成立）。
 *   無い場合:
 *     structuredSprintYears = null → BEGINNER（データ欠損を上級扱いしない）
 *     < 1                          → BEGINNER
 *     1 〜 < 3                     → DEVELOPING
 *     >= 3                         → TRAINED（何年でも ADVANCED にはしない）
 */
export function deriveTrainingAgeTier(input: TrainingAgeInput): TrainingAgeTier {
  if (input.coachAssignedTier != null) {
    return input.coachAssignedTier;
  }
  const years = input.structuredSprintYears;
  if (years === null) return "BEGINNER";
  if (years < 1) return "BEGINNER";
  if (years < 3) return "DEVELOPING";
  return "TRAINED";
}

/** trainingAge が「わかっている」かどうか（GROUP の empty-member 判定等で使う）。 */
export function isTrainingAgeKnown(input: TrainingAgeInput): boolean {
  return input.coachAssignedTier != null || input.structuredSprintYears !== null;
}
