import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { ExerciseForm, type ExerciseFormValues } from "@/components/exercise/exercise-form";
import { updateExerciseAction } from "@/actions/exercise-actions";
import { findExercise } from "@/infra/repositories/exercise-repository";

export default async function EditExercisePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const exercise = await findExercise(id);
  if (!exercise) notFound();

  const tagsOf = (kind: string) =>
    exercise.tags
      .filter((t) => t.tag.kind === kind)
      .map((t) => t.tag.name)
      .join(", ");

  const str = (v: number | null) => (v == null ? "" : String(v));

  const initial: ExerciseFormValues = {
    id: exercise.id,
    name: exercise.name,
    nameKana: exercise.nameKana ?? "",
    description: exercise.description ?? "",
    coachingPoint: exercise.coachingPoint ?? "",
    commonMistake: exercise.commonMistake ?? "",
    category: exercise.category,
    metricType: exercise.metricType,
    difficulty: exercise.difficulty,
    defaultSets: str(exercise.defaultSets),
    defaultReps: str(exercise.defaultReps),
    defaultDistanceMeters: str(exercise.defaultDistanceMeters),
    defaultDurationSeconds: str(exercise.defaultDurationSeconds),
    defaultRestSeconds: str(exercise.defaultRestSeconds),
    videoUrl: exercise.videoUrl ?? "",
    source: exercise.source,
    status: exercise.status,
    targets: exercise.targets.map((t) => t.target),
    generalTags: tagsOf("GENERAL"),
    equipmentTags: tagsOf("EQUIPMENT"),
    bodyPartTags: tagsOf("BODY_PART"),
  };

  const action = updateExerciseAction.bind(null, exercise.id);

  return (
    <>
      <PageHeader title="種目を編集" description={exercise.name} />
      <ExerciseForm
        action={action}
        initial={initial}
        submitLabel="保存する"
        cancelHref={`/exercises/${exercise.id}`}
      />
    </>
  );
}
