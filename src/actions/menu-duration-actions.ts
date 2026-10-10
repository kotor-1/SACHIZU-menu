"use server";

import { revalidatePath } from "next/cache";
import { saveMenuDuration } from "./_menu-duration-service";

export async function saveMenuDurationAction(input: unknown) {
  const result = await saveMenuDuration(input);
  if (result.ok) { revalidatePath(`/menus/${result.menuId}`); revalidatePath("/menus"); }
  return result;
}
