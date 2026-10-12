import type { ComposerCatalogExercise, EditableComposition } from "@/domain/menu-composition/contracts";
import { exerciseRepetitionCountMatches } from "@/domain/menu-composition/dose-counting";
import { trainingReducedLoad, type TrainingConditions } from "./conditions";
import { TRAINING_SECTION_NAMES, type TrainingItemAnnotation } from "./contracts";
import { assessExerciseEligibility } from "./eligibility";

/** Movement is the app's core: ten independent families whenever the conditions allow them. */
export const TRAINING_MOVEMENT_TARGET = 10;
/** Strength-focused goals receive a fuller strength section; other goals keep a short supporting set. */
export function trainingStrengthTarget(conditions: Pick<TrainingConditions, "primaryGoal">): number {
  return conditions.primaryGoal === "STRENGTH" ? 6 : 3;
}

export function trainingAvailability(catalog: readonly ComposerCatalogExercise[], conditions: TrainingConditions) {
  const assessed = catalog.map(row => ({ row, eligibility: assessExerciseEligibility(row, conditions) }));
  const rows = assessed.filter(x => x.eligibility.eligible);
  const movement = rows.filter(x => x.eligibility.section === "MOVEMENT");
  const strength = rows.filter(x => x.eligibility.section === "STRENGTH");
  return { movement, strength, movementStages: [...new Set(movement.map(x => x.eligibility.stage))],
    requiredMovement: Math.min(TRAINING_MOVEMENT_TARGET, new Set(movement.map(x => x.eligibility.family)).size),
    requiredStrength: Math.min(trainingStrengthTarget(conditions), new Set(strength.map(x => x.eligibility.family)).size),
    /** Most frequent reasons that removed otherwise relevant exercises of each section (for the shortage message). */
    blockingReasons: {
      MOVEMENT: topReasons(assessed.filter(x => x.eligibility.section === "MOVEMENT" && !x.eligibility.eligible)),
      STRENGTH: topReasons(assessed.filter(x => x.eligibility.section === "STRENGTH" && !x.eligibility.eligible)),
    } };
}
function topReasons(rows: { eligibility: { reasons: string[] } }[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const reason of row.eligibility.reasons) {
    // Catalog-quality codes describe the data, not the user's conditions.
    if (["UNREVIEWED_EXERCISE", "MOVEMENT_DESCRIPTION_MISSING", "RUNNING_ENGINE_ONLY", "UNSUPPORTED_EXERCISE_CATEGORY"].includes(reason)) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason]) => reason);
}

/** Content gate, deliberately independent of session duration. Human selection may be partial. */
export function assessTrainingComposition(composition: EditableComposition, annotations: Record<string, TrainingItemAnnotation>,
  conditions: TrainingConditions, catalog: readonly ComposerCatalogExercise[], options: { proposal: boolean }): string[] {
  const issues: string[] = [];
  if (composition.blocks.length !== 3 || composition.blocks.some((b, i) => b.name !== TRAINING_SECTION_NAMES[i])) issues.push("THREE_SECTIONS_REQUIRED");
  const availability = trainingAvailability(catalog, conditions);
  const reduced = trainingReducedLoad(conditions);
  const seen = new Set<string>();
  for (const [blockIndex, block] of composition.blocks.entries()) {
    let priorStage = -1;
    const families = new Set<string>();
    const stages = new Set<number>();
    for (const item of block.items) {
      if (item.type === "RUNNING_POLICY") { if (blockIndex !== 1) issues.push("RUNNING_SECTION_REQUIRED"); continue; }
      if (item.type !== "CATALOG_EXERCISE") { issues.push("CATALOG_EXERCISE_REQUIRED"); continue; }
      const row = catalog.find(x => x.id === item.exerciseId);
      if (!row) { issues.push("UNKNOWN_EXERCISE"); continue; }
      const eligibility = assessExerciseEligibility(row, conditions);
      if (!eligibility.eligible) issues.push(...eligibility.reasons);
      if (eligibility.section !== (blockIndex === 0 ? "MOVEMENT" : blockIndex === 2 ? "STRENGTH" : "RUNNING")) issues.push("WRONG_EXERCISE_SECTION");
      if (seen.has(row.id)) issues.push("DUPLICATE_EXERCISE");
      seen.add(row.id);
      const annotation = annotations[item.id];
      if (!annotation?.intensity.trim()) issues.push("INTENSITY_REQUIRED");
      if (annotation?.relationship === "ALTERNATIVE" && !annotation.alternativeGroup) issues.push("ALTERNATIVE_GROUP_REQUIRED");
      if (options.proposal && families.has(eligibility.family)) issues.push("DUPLICATE_MOVEMENT_FAMILY");
      families.add(eligibility.family);
      if (options.proposal && blockIndex === 0 && priorStage > eligibility.stage) issues.push("MOVEMENT_ORDER_INVALID");
      priorStage = eligibility.stage;
      stages.add(eligibility.stage);
      const units = [item.plannedReps, item.plannedDurationSeconds, item.plannedDistanceMeters];
      if (units.filter(x => x !== null).length !== 1 || item.plannedSets === null || item.plannedRestSeconds === null) issues.push("DOSE_INCOMPLETE");
      const primary = row.metricType === "REPS" ? item.plannedReps : row.metricType === "TIME" ? item.plannedDurationSeconds : item.plannedDistanceMeters;
      if (primary === null) issues.push("REGISTERED_UNIT_MISMATCH");
      if (!item.reason.trim() || !item.executionInstruction.trim()) issues.push("PURPOSE_AND_INSTRUCTION_REQUIRED");
      if (!exerciseRepetitionCountMatches(item, row)) issues.push("DOSE_COUNT_MISMATCH");
      if (item.plannedDistanceMeters !== null && (conditions.environment.straightMeters === null || item.plannedDistanceMeters > conditions.environment.straightMeters)) issues.push("EXERCISE_DISTANCE_EXCEEDS_SPACE");
      const text = `${item.executionInstruction} ${item.plannedNote}`.normalize("NFKC");
      if (/数量未設定|回数(?:は|が)?未設定|実施量(?:は|が)?未定/u.test(text) && primary !== null) issues.push("DOSE_TEXT_CONFLICT");
      for (const match of text.matchAll(/(?:\b|[^\d])(\d+)\s*セット/gu)) if (Number(match[1]) !== item.plannedSets) issues.push("DOSE_TEXT_CONFLICT");
      for (const match of text.matchAll(/(?:休息|休憩|レスト)(?:は|を|:|：)?\s*(\d+)\s*秒/gu)) if (Number(match[1]) !== item.plannedRestSeconds) issues.push("REST_TEXT_CONFLICT");
      const allProposedText = `${text} ${item.reason} ${annotation?.intensity ?? ""}`;
      if (/全力疾走|ダッシュ|(?:\d+)\s*m(?:走|スプリント)/u.test(allProposedText)) issues.push("RUNNING_INSTRUCTION_OUTSIDE_ENGINE");
      // Conservative proposal/edit bounds, not new physiological prescription rules.
      if ((item.plannedSets ?? 0) > (reduced ? 2 : 4) || (item.plannedReps ?? 0) > (reduced ? 12 : 30)
        || (item.plannedDurationSeconds ?? 0) > (reduced ? 30 : 60) || (item.plannedRestSeconds ?? 0) > 300) issues.push("DOSE_REQUIRES_COACH_REVIEW");
      if (reduced && (annotation?.intensity ?? "").split(/[。！!？?；;\n]/u).some(clause => /全力|限界|最大努力|高強度/u.test(clause)
        && !/避け|行わない|禁止|せず/u.test(clause))) issues.push("LOAD_CONDITION_CONFLICT");
    }
    if (options.proposal && blockIndex === 0 && families.size < availability.requiredMovement) issues.push("MOVEMENT_PROPOSALS_MISSING");
    if (options.proposal && blockIndex === 0 && availability.requiredMovement >= TRAINING_MOVEMENT_TARGET
      && availability.movementStages.some(stage => !stages.has(stage))) issues.push("MOVEMENT_STAGE_MISSING");
    if (options.proposal && blockIndex === 2 && families.size < availability.requiredStrength) issues.push("STRENGTH_PROPOSALS_MISSING");
  }
  return [...new Set(issues)];
}
