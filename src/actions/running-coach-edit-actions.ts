"use server";

import { revalidatePath } from "next/cache";
import {
  editRunningPolicyMenuItem,
  runningCoachEditActionInputSchema,
  type RunningCoachEditActionResult,
} from "./_running-coach-edit-service";

export async function editRunningPolicyMenuItemAction(input: unknown): Promise<RunningCoachEditActionResult> {
  const parsed = runningCoachEditActionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  const result = await editRunningPolicyMenuItem(parsed.data);
  if (result.ok) revalidatePath(`/menus/${parsed.data.menuId}`);
  return result;
}
