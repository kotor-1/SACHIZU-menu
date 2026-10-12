import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import type { ExercisePurposeValue } from "@/domain/exercise/constants";
import { TRAINING_GOAL_LABELS, type TrainingGoal } from "@/domain/training-proposal/conditions";
import type { TrainingComposerOutput, TrainingComposerSelection } from "@/domain/training-proposal/contracts";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";
import type { TrainingComposerInput } from "./generate";

/**
 * Exercise.purposes that make a candidate more relevant to the primary goal. An ordering cue
 * for the no-AI proposal only: eligibility and safety are decided before it, doses after it.
 */
const GOAL_PURPOSES: Record<TrainingGoal, readonly ExercisePurposeValue[]> = {
  ACCEL: ["ACCELERATION", "POWER", "GROUND_CONTACT", "POSTURE"],
  MAX_SPEED: ["MAX_VELOCITY", "RHYTHM", "GROUND_CONTACT", "ARM_SWING"],
  SPEED_ENDURANCE: ["RHYTHM", "POSTURE", "ARM_SWING"],
  BASIC: ["POSTURE", "TECHNIQUE", "BALANCE"],
  TECHNIQUE: ["TECHNIQUE", "POSTURE", "RHYTHM"],
  MOVEMENT: ["MOBILITY", "HIP_JOINT", "ANKLE_JOINT", "BALANCE"],
  STRENGTH: ["STRENGTH", "POWER", "BALANCE"],
  PRECOMP: ["MOBILITY", "POSTURE", "RHYTHM"],
  RECOVERY: ["RECOVERY", "MOBILITY", "BALANCE"],
};

/**
 * The App's own proposal, used when the Composer is unavailable or its answer does not pass
 * the checks. One candidate per family; movement is taken in turn from each stage so every
 * available stage appears. Doses come from the same App rules as every other item, and the
 * texts are the App's plain defaults, so nothing here is presented as an AI judgement.
 */
export function ruleBasedTrainingSelection(input: TrainingComposerInput): TrainingComposerOutput {
  const wanted = new Set<string>(GOAL_PURPOSES[input.conditions.primaryGoal]);
  const relevance = (row: ComposerCatalogExercise) => row.purposes.filter(purpose => wanted.has(purpose)).length;
  const reviewed = (row: ComposerCatalogExercise) => row.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED" ? 0 : 1;
  const registered = (row: ComposerCatalogExercise) => row.defaultSets !== null || row.defaultReps !== null
    || row.defaultDurationSeconds !== null || row.defaultDistanceMeters !== null ? 0 : 1;
  // Array.prototype.sort is stable, so the catalog order settles any remaining tie.
  const onePerFamily = (rows: readonly ComposerCatalogExercise[]) => {
    const families = new Set<string>();
    return [...rows].sort((a, b) => relevance(b) - relevance(a) || reviewed(a) - reviewed(b) || registered(a) - registered(b)
      || (a.difficulty ?? 9) - (b.difficulty ?? 9)).filter(row => {
      const family = input.families[row.id] ?? row.id;
      if (families.has(family)) return false;
      families.add(family); return true;
    });
  };
  const pool = onePerFamily(input.movement);
  const queues = [...new Set(pool.map(row => input.stages[row.id] ?? 0))].sort((a, b) => a - b)
    .map(stage => pool.filter(row => (input.stages[row.id] ?? 0) === stage));
  const movement: ComposerCatalogExercise[] = [];
  while (movement.length < input.requiredMovement && queues.some(queue => queue.length)) {
    for (const queue of queues) if (queue.length && movement.length < input.requiredMovement) movement.push(queue.shift()!);
  }
  movement.sort((a, b) => (input.stages[a.id] ?? 0) - (input.stages[b.id] ?? 0));
  const select = (row: ComposerCatalogExercise): TrainingComposerSelection => {
    const { item, annotation } = suggestCatalogItem(row, input.conditions, "rule-based");
    return { exerciseId: row.id, reason: item.reason, intensity: annotation.intensity, relationship: "COMBINABLE", alternativeGroup: null };
  };
  return { movement: movement.map(select), strength: onePerFamily(input.strength).slice(0, input.requiredStrength).map(select),
    explanation: `AIを使わない基本提案です。条件に合う登録種目から、似た動作が重ならないように、段階（可動域から疾走への接続まで）ごとに順に選びました。主目的「${TRAINING_GOAL_LABELS[input.conditions.primaryGoal]}」に関係する種目を優先しています。`,
    uncertainty: "理由と強度の文は定型です。種目の組み合わせと数量は、指導者が確認して必要に応じて編集してください。" };
}
