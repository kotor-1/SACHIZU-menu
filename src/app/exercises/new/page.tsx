import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import {
  EMPTY_EXERCISE_FORM,
  ExerciseForm,
  type ExerciseFormValues,
} from "@/components/exercise/exercise-form";
import { createExerciseAction } from "@/actions/exercise-actions";
import { parseDraftPayload } from "@/domain/ai/draft-schema";
import { prisma } from "@/infra/db/prisma";

export const metadata = { title: "種目を登録｜SACHIZU" };

/**
 * 種目の新規登録。
 *
 * ?draft=<id> が付いていると、AI が作った下書きでフォームを埋める。
 * Phase 2 で「動画 → AI 下書き → コーチが修正 → 登録」を繋ぐのはこの導線で、
 * 画面側の追加実装は不要になる。
 */
export default async function NewExercisePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string }>;
}) {
  const { draft: draftId } = await searchParams;
  let initial: ExerciseFormValues = EMPTY_EXERCISE_FORM;
  let fromDraft = false;

  if (draftId) {
    const draft = await prisma.exerciseDraft.findUnique({ where: { id: draftId } });
    if (!draft) notFound();

    const payload = parseDraftPayload(draft.payload);
    fromDraft = true;
    initial = {
      ...EMPTY_EXERCISE_FORM,
      name: payload.name ?? "",
      nameKana: payload.nameKana ?? "",
      description: payload.description ?? "",
      coachingPoint: payload.coachingPoint ?? "",
      commonMistake: payload.commonMistake ?? "",
      category: payload.category ?? "DRILL",
      metricType: payload.metricType ?? "REPS",
      difficulty: payload.difficulty ?? 3,
      defaultSets: payload.defaultSets != null ? String(payload.defaultSets) : "",
      defaultReps: payload.defaultReps != null ? String(payload.defaultReps) : "",
      defaultDistanceMeters:
        payload.defaultDistanceMeters != null ? String(payload.defaultDistanceMeters) : "",
      defaultDurationSeconds:
        payload.defaultDurationSeconds != null ? String(payload.defaultDurationSeconds) : "",
      defaultRestSeconds:
        payload.defaultRestSeconds != null ? String(payload.defaultRestSeconds) : "",
      targets: payload.targets ?? [],
      generalTags: (payload.generalTags ?? []).join(", "),
      equipmentTags: (payload.equipmentTags ?? []).join(", "),
      bodyPartTags: (payload.bodyPartTags ?? []).join(", "),
      // AI 由来であることを記録し、既定で「下書き」として保存させる
      source: "AI_DRAFT",
      status: "DRAFT",
    };
  }

  return (
    <>
      <PageHeader
        title="種目を登録"
        description={
          fromDraft
            ? "AIの下書きを読み込みました。内容を確認・修正して登録してください。"
            : "登録した種目は、メニュー作成画面から呼び出して使います。"
        }
      />
      <ExerciseForm
        action={createExerciseAction}
        initial={initial}
        submitLabel="登録する"
        cancelHref="/exercises"
        draftId={fromDraft ? draftId : undefined}
      />
    </>
  );
}
