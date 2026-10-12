"use server";

import { revalidatePath } from "next/cache";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { generateTrainingProposal } from "@/application/training-proposal/generate";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { runningMenuSigningKey } from "@/infra/running-menu/preview-token";
import { composeTrainingWithLuna } from "@/infra/training-proposal/composer";
import { verifyTrainingProposalToken } from "@/infra/training-proposal/preview-token";
import { prisma } from "@/infra/db/prisma";
import { evaluateTrainingRunningEdit, saveTrainingProposal } from "./_training-proposal-save-service";
import { runningCoachEditRequestSchema } from "@/application/running-menu/coach-edit";

export async function generateTrainingProposalAction(input: unknown) {
  if (process.env.AI_MENU_PLANNER_ENABLED !== "true") return { ok: false as const, code: "DISABLED", message: "AIによる提案は現在利用できません。" };
  return generateTrainingProposal(input, { ownerId: DEFAULT_OWNER_ID, signingKey: runningMenuSigningKey(),
    catalog: () => listComposerCatalog(DEFAULT_OWNER_ID), compose: composeTrainingWithLuna });
}
export async function saveTrainingProposalAction(input: unknown) {
  const result = await saveTrainingProposal(input, { db: prisma, ownerId: DEFAULT_OWNER_ID, signingKey: runningMenuSigningKey(),
    catalog: () => listComposerCatalog(DEFAULT_OWNER_ID) });
  if (result.ok) { revalidatePath("/menus"); revalidatePath(`/menus/${result.menuId}`); }
  return result;
}
export async function previewTrainingRunningCoachEditAction(input: { previewToken: string; coachEdit: unknown }) {
  try {
    const claims = verifyTrainingProposalToken(input.previewToken, runningMenuSigningKey());
    if (!claims || claims.ownerId !== DEFAULT_OWNER_ID) return { ok: false as const, message: "提案の有効期限が切れています。保存済みメニューは再読込してください。" };
    const edit = runningCoachEditRequestSchema.safeParse(input.coachEdit);
    if (!edit.success) return { ok: false as const, message: "調整する数値を確認してください。" };
    const result = evaluateTrainingRunningEdit(claims, edit.data);
    return result.ok ? { ok: true as const, finalPrescription: result.finalPrescription }
      : { ok: false as const, message: "この調整は処方または環境の安全条件を満たしません。元の処方を確認してください。" };
  } catch { return { ok: false as const, message: "走の調整を確認できませんでした。" }; }
}
