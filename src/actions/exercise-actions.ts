"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exerciseInputSchema } from "@/domain/exercise/schema";
import { parseCsvInput } from "@/domain/shared/zod-helpers";
import { actionOk, type ActionResult } from "@/domain/shared/result";
import { parseForm, toActionError } from "@/lib/form";
import {
  archiveExercise,
  createExercise,
  deleteExercise,
  duplicateExercise,
  toggleExerciseFavorite,
  updateExercise,
} from "@/infra/repositories/exercise-repository";
import { pruneOrphanTags } from "@/infra/repositories/tag-repository";
import { prisma } from "@/infra/db/prisma";

/** タグ入力はカンマ区切りの 1 テキストなので、検証前に配列へ展開する。 */
function expandTagInputs(formData: FormData): void {
  for (const key of ["generalTags", "equipmentTags", "bodyPartTags"] as const) {
    const raw = formData.get(key);
    formData.delete(key);
    for (const tag of parseCsvInput(raw)) formData.append(key, tag);
  }
}

const ARRAY_KEYS = [
  "targets",
  "purposes",
  "events",
  "generalTags",
  "equipmentTags",
  "bodyPartTags",
];

export async function createExerciseAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  expandTagInputs(formData);
  const parsed = parseForm(exerciseInputSchema, formData, ARRAY_KEYS);
  if (!parsed.ok) return parsed.result;

  let id: string;
  try {
    const created = await createExercise(parsed.data);
    id = created.id;

    // AI 下書きから登録した場合は、その下書きを「登録済み」にして紐付ける。
    // 下書きと確定データを別テーブルに保つことで、後から出どころを追える。
    const draftId = String(formData.get("draftId") ?? "");
    if (draftId) {
      await prisma.exerciseDraft.updateMany({
        where: { id: draftId, status: "PENDING_REVIEW" },
        data: { status: "APPLIED", appliedExerciseId: created.id },
      });
      revalidatePath("/ai");
    }
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath("/exercises");
  // 下書き確定フローから来た場合はそのまま詳細へ送りたいので redirect する
  redirect(`/exercises/${id}`);
}

export async function updateExerciseAction(
  id: string,
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  expandTagInputs(formData);
  const parsed = parseForm(exerciseInputSchema, formData, ARRAY_KEYS);
  if (!parsed.ok) return parsed.result;

  try {
    await updateExercise(id, parsed.data);
    await pruneOrphanTags();
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath("/exercises");
  revalidatePath(`/exercises/${id}`);
  return actionOk({ id }, "保存しました");
}

export async function deleteExerciseAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // メニューで使われている種目は消さずにアーカイブへ回す。
  // 参照は SetNull されるが、コーチの意図しないメニュー破損を防ぐため。
  const usage = await prisma.menuItem.count({ where: { exerciseId: id } });
  if (usage > 0) {
    await archiveExercise(id);
  } else {
    await deleteExercise(id);
    await pruneOrphanTags();
  }

  revalidatePath("/exercises");
  redirect("/exercises");
}

export async function archiveExerciseAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await archiveExercise(id);
  revalidatePath("/exercises");
  revalidatePath(`/exercises/${id}`);
}

/** アーカイブから戻す。 */
export async function restoreExerciseAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await prisma.exercise.update({ where: { id }, data: { status: "REVIEWED" } });
  revalidatePath("/exercises");
  revalidatePath(`/exercises/${id}`);
}

/** 似た種目を作るための複製。複製後は編集画面へ送る（内容を見直してから確定させるため）。 */
export async function duplicateExerciseAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const copy = await duplicateExercise(id);
  revalidatePath("/exercises");
  redirect(`/exercises/${copy.id}/edit`);
}

/** 一覧・詳細どちらからも呼べる、お気に入りの ON/OFF トグル。 */
export async function toggleExerciseFavoriteAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await toggleExerciseFavorite(id);
  revalidatePath("/exercises");
  revalidatePath(`/exercises/${id}`);
}
