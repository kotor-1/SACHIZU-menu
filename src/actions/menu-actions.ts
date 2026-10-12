"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  menuBlockInputSchema,
  menuInputSchema,
  menuItemInputSchema,
  type MenuItemInput,
} from "@/domain/menu/schema";
import { parseCsvInput } from "@/domain/shared/zod-helpers";
import { actionError, actionOk, type ActionResult } from "@/domain/shared/result";
import { parseForm, toActionError } from "@/lib/form";
import {
  addBlock,
  addMenuItem,
  createMenu,
  deleteBlock,
  deleteMenu,
  deleteMenuItem,
  duplicateMenu,
  findMenuItemPrescriptionKind,
  moveBlock,
  moveMenuItem,
  reorderBlocks,
  reorderMenuItems,
  updateBlock,
  updateMenu,
  updateMenuItem,
} from "@/infra/repositories/menu-repository";
import { pruneOrphanTags } from "@/infra/repositories/tag-repository";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { exerciseRepetitionCountMatches } from "@/domain/menu-composition/dose-counting";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";

async function repetitionCountError(input: MenuItemInput): Promise<ActionResult<never> | null> {
  if (input.reps === null || !input.exerciseId) return null;
  const exercise = (await listComposerCatalog(DEFAULT_OWNER_ID)).find(row => row.id === input.exerciseId);
  if (exercise && isRunningExerciseForV2(exercise)) return null;
  if (exerciseRepetitionCountMatches({ plannedReps: input.reps, executionInstruction: input.note ?? "", plannedNote: "" }, exercise)) return null;
  return actionError("実施指示の回数と数値欄が一致していません。片側ごとの回数か左右合計かを確認してください。", {
    reps: ["数え方に合わせて回数と実施指示をそろえてください。"],
  });
}

function expandTags(formData: FormData): void {
  const raw = formData.get("tags");
  formData.delete("tags");
  for (const tag of parseCsvInput(raw)) formData.append("tags", tag);
}

export async function createMenuAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  expandTags(formData);
  const parsed = parseForm(menuInputSchema, formData, ["tags"]);
  if (!parsed.ok) return parsed.result;

  let id: string;
  try {
    // 既定ブロック（W-up〜クールダウン）を最初から入れておく。
    // 空のメニューから始めるより、埋めるだけの方が速い。
    // 既定ブロックの有無。チェックボックスの前に hidden("false") を置いているため、
    // 「チェック済み = 値が 2 つ届き true を含む」で判定する。
    const values = formData.getAll("withDefaultBlocks").map(String);
    const withDefaultBlocks = values.length === 0 || values.includes("true");
    const created = await createMenu(parsed.data, withDefaultBlocks);
    id = created.id;
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath("/menus");
  redirect(`/menus/${id}`);
}

export async function updateMenuAction(
  id: string,
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  expandTags(formData);
  const parsed = parseForm(menuInputSchema, formData, ["tags"]);
  if (!parsed.ok) return parsed.result;

  try {
    await updateMenu(id, parsed.data);
    await pruneOrphanTags();
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath("/menus");
  revalidatePath(`/menus/${id}`);
  return actionOk({ id }, "保存しました");
}

export async function deleteMenuAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  // セッションからの参照は SetNull される（過去の記録は消えない）
  await deleteMenu(id);
  await pruneOrphanTags();
  revalidatePath("/menus");
  redirect("/menus");
}

export async function duplicateMenuAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const copy = await duplicateMenu(id);
  revalidatePath("/menus");
  redirect(`/menus/${copy.id}`);
}

// --- ブロック ---------------------------------------------------------------

export async function addBlockAction(
  menuId: string,
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const parsed = parseForm(menuBlockInputSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    await addBlock(menuId, parsed.data);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/menus/${menuId}`);
  return actionOk(null, "ブロックを追加しました");
}

export async function updateBlockAction(
  menuId: string,
  blockId: string,
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const parsed = parseForm(menuBlockInputSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    await updateBlock(blockId, parsed.data);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/menus/${menuId}`);
  return actionOk(null, "保存しました");
}

export async function deleteBlockAction(formData: FormData): Promise<void> {
  const menuId = String(formData.get("menuId") ?? "");
  const blockId = String(formData.get("blockId") ?? "");
  if (!blockId) return;
  await deleteBlock(blockId);
  revalidatePath(`/menus/${menuId}`);
}

export async function moveBlockAction(formData: FormData): Promise<void> {
  const menuId = String(formData.get("menuId") ?? "");
  const blockId = String(formData.get("blockId") ?? "");
  const direction = formData.get("direction") === "up" ? "up" : "down";
  if (!blockId) return;
  await moveBlock(blockId, direction);
  revalidatePath(`/menus/${menuId}`);
}

// --- アイテム（処方）--------------------------------------------------------

export async function addMenuItemAction(
  menuId: string,
  blockId: string,
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const parsed = parseForm(menuItemInputSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    const countError = await repetitionCountError(parsed.data);
    if (countError) return countError;
    await addMenuItem(blockId, parsed.data);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/menus/${menuId}`);
  return actionOk(null, "追加しました");
}

export async function updateMenuItemAction(
  menuId: string,
  itemId: string,
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  // [R10-B1 §37] RUNNING_V2 は汎用（legacy）編集の対象外。専用の running-actions を使う。
  // repository の updateMenuItem も独立に同じ guard を持つ（二重の守り）。
  const kind = await findMenuItemPrescriptionKind(itemId);
  if (kind === "RUNNING_V2") {
    return actionError("この項目は走トレーニング（RUNNING_V2）の処方です。専用の編集操作を使用してください。");
  }
  if (kind === "RUNNING_POLICY") {
    return actionError("この走処方は汎用の項目編集では変更できません。");
  }
  const parsed = parseForm(menuItemInputSchema, formData);
  if (!parsed.ok) return parsed.result;
  try {
    const countError = kind === "RUNNING_UNPRESCRIBED" ? null : await repetitionCountError(parsed.data);
    if (countError) return countError;
    await updateMenuItem(itemId, parsed.data);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/menus/${menuId}`);
  return actionOk(null, "保存しました");
}

export async function deleteMenuItemAction(formData: FormData): Promise<void> {
  const menuId = String(formData.get("menuId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return;
  await deleteMenuItem(itemId);
  revalidatePath(`/menus/${menuId}`);
}

export async function moveMenuItemAction(formData: FormData): Promise<void> {
  const menuId = String(formData.get("menuId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const direction = formData.get("direction") === "up" ? "up" : "down";
  if (!itemId) return;
  await moveMenuItem(itemId, direction);
  revalidatePath(`/menus/${menuId}`);
}

// --- ドラッグ&ドロップによる並べ替え -------------------------------------

/**
 * ブロックの並べ替え（ドラッグ&ドロップ）。client は「現在表示している全ブロック ID の新順序」だけを送る。
 * 実際の整合（集合一致・重複なし・atomic）は repository 側で検証する。
 */
export async function reorderMenuBlocksAction(menuId: string, orderedBlockIds: string[]): Promise<void> {
  if (orderedBlockIds.length > 100) return;
  await reorderBlocks(menuId, orderedBlockIds);
  revalidatePath(`/menus/${menuId}`);
}

/**
 * 同一ブロック内の項目の並べ替え（ドラッグ&ドロップ）。RUNNING_V2 / LEGACY を問わず順序だけを変える。
 */
export async function reorderMenuItemsAction(menuId: string, blockId: string, orderedItemIds: string[]): Promise<void> {
  if (orderedItemIds.length > 1000) return;
  await reorderMenuItems(blockId, orderedItemIds);
  revalidatePath(`/menus/${menuId}`);
}
