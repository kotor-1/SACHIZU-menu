/** JSON-safe subset used by the existing SessionItemRow client component. */
export type SessionItemRowDto = {
  id: string;
  done: boolean;
  exercise: { id: string } | null;
  exerciseNameSnapshot: string;
  plannedSets: number | null;
  plannedReps: number | null;
  plannedDistanceMeters: number | null;
  plannedDurationSeconds: number | null;
  plannedRestSeconds: number | null;
  plannedIntensityPercent: number | null;
  plannedLoadKg: number | null;
  plannedNote: string | null;
  actualSets: number | null;
  actualReps: number | null;
  actualDistanceMeters: number | null;
  actualDurationSeconds: number | null;
  actualLoadKg: number | null;
  actualNote: string | null;
};

export function presentSessionItemRow(item: SessionItemRowDto): SessionItemRowDto {
  return {
    id: item.id,
    done: item.done,
    exercise: item.exercise === null ? null : { id: item.exercise.id },
    exerciseNameSnapshot: item.exerciseNameSnapshot,
    plannedSets: item.plannedSets,
    plannedReps: item.plannedReps,
    plannedDistanceMeters: item.plannedDistanceMeters,
    plannedDurationSeconds: item.plannedDurationSeconds,
    plannedRestSeconds: item.plannedRestSeconds,
    plannedIntensityPercent: item.plannedIntensityPercent,
    plannedLoadKg: item.plannedLoadKg,
    plannedNote: item.plannedNote,
    actualSets: item.actualSets,
    actualReps: item.actualReps,
    actualDistanceMeters: item.actualDistanceMeters,
    actualDurationSeconds: item.actualDurationSeconds,
    actualLoadKg: item.actualLoadKg,
    actualNote: item.actualNote,
  };
}
