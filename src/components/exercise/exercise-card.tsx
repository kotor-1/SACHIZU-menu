import Link from "next/link";
import { Card } from "@/components/ui";
import { formatPrescription } from "@/domain/shared/prescription";
import type { ExerciseWithRelations } from "@/infra/repositories/exercise-repository";
import { CategoryBadge, DifficultyBadge, StatusBadge, TargetBadge } from "./exercise-badges";

export function ExerciseCard({ exercise }: { exercise: ExerciseWithRelations }) {
  const prescription = formatPrescription({
    sets: exercise.defaultSets,
    reps: exercise.defaultReps,
    distanceMeters: exercise.defaultDistanceMeters,
    durationSeconds: exercise.defaultDurationSeconds,
    restSeconds: exercise.defaultRestSeconds,
  });

  return (
    <Card className="flex h-full flex-col transition-shadow hover:shadow-md">
      <Link href={`/exercises/${exercise.id}`} className="flex flex-1 flex-col p-4">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <CategoryBadge category={exercise.category} />
          <StatusBadge status={exercise.status} />
        </div>

        <h3 className="text-base leading-snug font-semibold text-slate-900">
          {exercise.name}
        </h3>

        {exercise.description && (
          <p className="mt-1.5 line-clamp-2 text-sm text-slate-500">
            {exercise.description}
          </p>
        )}

        {prescription && (
          <p className="mt-2 font-mono text-xs text-slate-600">推奨 {prescription}</p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
          <DifficultyBadge level={exercise.difficulty} />
          {exercise.targets.slice(0, 3).map((t) => (
            <TargetBadge key={t.target} target={t.target} />
          ))}
        </div>

        {exercise.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1 text-xs text-slate-400">
            {exercise.tags.map((t) => (
              <span key={t.tagId}>#{t.tag.name}</span>
            ))}
          </div>
        )}
      </Link>
    </Card>
  );
}
