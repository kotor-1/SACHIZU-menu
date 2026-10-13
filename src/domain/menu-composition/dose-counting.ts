import type { ComposerCatalogExercise, ExercisePlanItem } from "./contracts";

type CountInstruction = Pick<ExercisePlanItem, "executionInstruction" | "plannedNote">;
export type ExerciseCountingCatalog = {
  videoGuidance: Pick<NonNullable<ComposerCatalogExercise["videoGuidance"]>, "countingUnit" | "videoAnalysisStatus"> | null;
};
type CountCatalog = ExerciseCountingCatalog;

function approvedCountingUnit(exercise?: CountCatalog) {
  return exercise?.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED" ? exercise.videoGuidance.countingUnit : null;
}

export function exerciseUsesTotalCount(exercise?: CountCatalog): boolean {
  return ["TOTAL_REPS", "ALTERNATING_TOTAL"].includes(approvedCountingUnit(exercise) ?? "");
}

/** Only explicit side counts are read; movement-cycle definitions are not doses. */
function sideCounts(item: CountInstruction): number[] {
  const text = `${item.executionInstruction}\n${item.plannedNote}`.normalize("NFKC");
  const patterns = [
    /(?:片側|片脚|片足|反対側|右側|左側|右脚|左脚|右足|左足)(?:は|を)?\s*(\d+)\s*回/gu,
    /(?:左右|両側)\s*(?:各|それぞれ)\s*(\d+)\s*回/gu,
    /(?:左右|両側)\s*(\d+)\s*回\s*ずつ/gu,
    /(\d+)\s*reps?\s*(?:per|each)\s*side/giu,
  ];
  return patterns.flatMap(pattern => [...text.matchAll(pattern)]
    .filter(match => !/^\s*(?:ずつ)?\s*(?:では(?:ない|なく|ありません)|で(?:は)?数えない)/u.test(text.slice(match.index! + match[0].length)))
    .map(match => Number(match[1])));
}

/** The one per-side count an instruction states (「片足10回…反対側10回」), or null when it states none or several. */
export function statedSideCount(item: CountInstruction): number | null {
  const counts = [...new Set(sideCounts(item))];
  return counts.length === 1 ? counts[0] : null;
}

export function exerciseUsesPerSideCount(item: CountInstruction, exercise?: CountCatalog): boolean {
  const approved = approvedCountingUnit(exercise);
  // A reviewed round-trip/custom definition must not become PER_SIDE from prose.
  if (approved !== null) return approved === "PER_SIDE";
  return sideCounts(item).length > 0 || /回数欄は片側の回数/u.test(`${item.executionInstruction}\n${item.plannedNote}`);
}

/** PER_SIDE is a stored per-side quantity. Never double or rewrite that value. */
export function exerciseRepetitionCountMatches(item: CountInstruction & Pick<ExercisePlanItem, "plannedReps">, exercise?: CountCatalog): boolean {
  if (item.plannedReps === null) return true;
  const perSide = exerciseUsesPerSideCount(item, exercise);
  if (!perSide && !exerciseUsesTotalCount(exercise)) return true;
  if (sideCounts(item).some(count => (perSide ? count : count * 2) !== item.plannedReps)) return false;
  const text = `${item.executionInstruction}\n${item.plannedNote}`.normalize("NFKC");
  // An optional total can describe both sides, but cannot replace the per-side field.
  const totals = [...text.matchAll(/(?:左右|両側)(?:で|の)?\s*(?:合計|合わせて)\s*(\d+)\s*回/gu)]
    .filter(match => !/^\s*(?:では(?:ない|なく|ありません)|で(?:は)?数えない)/u.test(text.slice(match.index! + match[0].length)));
  return totals.every(match => Number(match[1]) === item.plannedReps! * (perSide ? 2 : 1));
}
