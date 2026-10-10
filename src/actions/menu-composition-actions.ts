"use server";

import { revalidatePath } from "next/cache";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { composeMenuWithOpenAI } from "@/infra/menu-composition/openai-composer";
import { runningMenuSigningKey } from "@/infra/running-menu/preview-token";
import { generateRunningMenuPreviewAction } from "./running-menu-preview-actions";
import { saveComposedMenu } from "./_menu-composition-save-service";
import { issueMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import { menuCompositionContextSchema } from "@/domain/menu-composition/contracts";
import { randomUUID } from "node:crypto";
import type { ComposedMenuPreview } from "@/application/menu-composition/generate";

export async function generateComposedMenuAction(input: unknown) {
  if (process.env.AI_MENU_PLANNER_ENABLED !== "true") return { ok: false as const, code: "DISABLED", message: "AIメニュー生成は現在利用できません。" };
  return generateComposedMenu(input, { ownerId: DEFAULT_OWNER_ID, signingKey: runningMenuSigningKey(),
    catalog: () => listComposerCatalog(DEFAULT_OWNER_ID), interpret: generateRunningMenuPreviewAction, compose: composeMenuWithOpenAI });
}
export async function saveComposedMenuAction(input: unknown) {
  const result = await saveComposedMenu(input);
  if (result.ok) { revalidatePath("/menus"); revalidatePath(`/menus/${result.menuId}`); }
  return result;
}

export async function createManualComposedMenuAction(input: unknown = {}) {
  try {
    const context = menuCompositionContextSchema.parse(input);
    const requestedTimeSeconds = context.availableTimeSeconds ?? null;
    const composition = { blocks: [{ id: randomUUID(), name: "メニュー", items: [] }] };
    const requestText = "手動で作成";
    const catalog = await listComposerCatalog(DEFAULT_OWNER_ID);
    const previewToken = issueMenuCompositionToken({ ownerId: DEFAULT_OWNER_ID, proposal: composition, requestText, context, requestedTimeSeconds,
      allowedExerciseIds: catalog.map((row) => row.id), runningToken: null, runningPrescription: null, runningSourceTexts: [] }, runningMenuSigningKey());
    const preview: ComposedMenuPreview = { composition, previewToken, requestText, context, requestedTimeSeconds, runningToken: null, runningPrescription: null, unsupportedIntents: [] };
    return { ok: true as const, preview };
  } catch { return { ok: false as const, code: "UNAVAILABLE", message: "手動メニューを開始できませんでした。" }; }
}
