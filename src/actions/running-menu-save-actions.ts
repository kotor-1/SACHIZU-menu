"use server";

import { revalidatePath } from "next/cache";
import { saveRunningMenuInputSchema, saveRunningMenuPreview, type SaveRunningMenuResult } from "./_running-menu-save-service";

export async function saveRunningMenuPreviewAction(input: unknown): Promise<SaveRunningMenuResult> {
  const parsed = saveRunningMenuInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "SAVE_FAILED" };
  if (process.env.AI_MENU_PLANNER_ENABLED !== "true") return { ok: false, code: "SAVE_FAILED" };
  const result = await saveRunningMenuPreview(parsed.data);
  if (result.ok) {
    revalidatePath("/menus");
    revalidatePath(`/menus/${result.menuId}`);
  }
  return result;
}
