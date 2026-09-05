"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  sessionFromMenuSchema,
  sessionInputSchema,
  sessionItemResultSchema,
} from "@/domain/session/schema";
import { actionOk, type ActionResult } from "@/domain/shared/result";
import { parseForm, toActionError } from "@/lib/form";
import {
  addSessionItem,
  createSession,
  createSessionFromMenu,
  deleteSession,
  deleteSessionItem,
  toggleSessionItemDone,
  updateSession,
  updateSessionItemResult,
} from "@/infra/repositories/session-repository";
import { prisma } from "@/infra/db/prisma";

/** テンプレートを展開して 1 回分の練習を作る（最も使われる導線）。 */
export async function createSessionFromMenuAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const parsed = parseForm(sessionFromMenuSchema, formData);
  if (!parsed.ok) return parsed.result;

  let id: string;
  try {
    const created = await createSessionFromMenu(parsed.data);
    id = created.id;
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath("/sessions");
  redirect(`/sessions/${id}`);
}

/** テンプレートを使わず、空のセッションを作る。 */
export async function createSessionAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const parsed = parseForm(sessionInputSchema, formData);
  if (!parsed.ok) return parsed.result;

  let id: string;
  try {
    const created = await createSession(parsed.data);
    id = created.id;
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath("/sessions");
  redirect(`/sessions/${id}`);
}

export async function updateSessionAction(
  id: string,
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const parsed = parseForm(sessionInputSchema, formData);
  if (!parsed.ok) return parsed.result;

  try {
    await updateSession(id, parsed.data);
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath("/sessions");
  revalidatePath(`/sessions/${id}`);
  return actionOk({ id }, "保存しました");
}

export async function deleteSessionAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await deleteSession(id);
  revalidatePath("/sessions");
  redirect("/sessions");
}

export async function setSessionStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !status) return;
  await prisma.trainingSession.update({ where: { id }, data: { status } });
  revalidatePath(`/sessions/${id}`);
  revalidatePath("/sessions");
}

// --- 実施記録 ---------------------------------------------------------------

export async function toggleSessionItemAction(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("sessionId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return;
  await toggleSessionItemDone(itemId);
  revalidatePath(`/sessions/${sessionId}`);
}

export async function updateSessionItemAction(
  sessionId: string,
  itemId: string,
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  // done は hidden("") + checkbox("true") の 2 値で届くため配列で受ける
  const parsed = parseForm(sessionItemResultSchema, formData, ["done"]);
  if (!parsed.ok) return parsed.result;
  try {
    await updateSessionItemResult(itemId, parsed.data);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/sessions/${sessionId}`);
  return actionOk(null, "記録しました");
}

export async function deleteSessionItemAction(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("sessionId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return;
  await deleteSessionItem(itemId);
  revalidatePath(`/sessions/${sessionId}`);
}

/** 当日その場で足した種目を記録に加える。 */
export async function addSessionItemAction(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("sessionId") ?? "");
  const exerciseId = String(formData.get("exerciseId") ?? "");
  const freeName = String(formData.get("name") ?? "").trim();
  const blockName = String(formData.get("blockName") ?? "").trim() || "追加";
  if (!sessionId) return;

  let name = freeName;
  if (exerciseId) {
    const ex = await prisma.exercise.findUnique({
      where: { id: exerciseId },
      select: { name: true },
    });
    name = ex?.name ?? freeName;
  }
  if (!name) return;

  await addSessionItem(sessionId, {
    exerciseId: exerciseId || null,
    exerciseNameSnapshot: name,
    blockNameSnapshot: blockName,
  });
  revalidatePath(`/sessions/${sessionId}`);
}
