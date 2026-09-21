"use server";

/**
 * R12-A3G — MenuPlanner Server Actions。
 *
 * These functions are intentionally a thin transport boundary. All
 * authoritative context, OpenAI configuration, A2 preview generation, A3A
 * token handling, and A3B persistence remain in server-owned composition and
 * application modules.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  createMenuPlannerProductionComposition,
  isMenuPlannerFeatureEnabled,
} from "@/infra/menu-planner/menu-planner-composition";
import { MENU_PLANNER_SCHEMA_VERSION } from "@/domain/menu-planner";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { HMAC_TOKEN_MAX_LENGTH } from "@/infra/security/hmac-token";
import type { GenerateMenuPlannerPreviewResult } from "@/application/menu-planner/generate";
import type { ReviseMenuPlannerPreviewResult } from "@/application/menu-planner/revise";
import type { SaveAiMenuDraftResult } from "@/application/menu-planner/save";

const generateActionInputSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_SCHEMA_VERSION),
    contextMenuTemplateId: z.string().trim().min(1).max(64),
    menuName: z.string().trim().min(1).max(120),
    coachRequest: z.unknown(),
  })
  .strict();

const reviseActionInputSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_SCHEMA_VERSION),
    acceptToken: z.string().trim().min(1).max(HMAC_TOKEN_MAX_LENGTH),
    revisionText: z.string().trim().min(1).max(2_000),
  })
  .strict();

const saveActionInputSchema = z
  .object({
    acceptToken: z.string().trim().min(1).max(HMAC_TOKEN_MAX_LENGTH),
  })
  .strict();

type MenuPlannerActionErrorKind =
  | "FEATURE_DISABLED"
  | "INVALID_INPUT"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_FAILED"
  | "AI_OUTPUT_INVALID"
  | "STALE_PREVIEW"
  | "PLANNING_REJECTED"
  | "SAVE_FAILED";

export type MenuPlannerActionError = {
  kind: MenuPlannerActionErrorKind;
  code: string;
  message: string;
};

export type GenerateMenuPlannerActionResult = GenerateMenuPlannerPreviewResult | { ok: false; error: MenuPlannerActionError };
export type ReviseMenuPlannerActionResult = ReviseMenuPlannerPreviewResult | { ok: false; error: MenuPlannerActionError };
export type SaveMenuPlannerActionResult = SaveAiMenuDraftResult | { ok: false; error: MenuPlannerActionError };

function featureDisabled(): { ok: false; error: MenuPlannerActionError } {
  return {
    ok: false,
    error: {
      kind: "FEATURE_DISABLED",
      code: "FEATURE_DISABLED",
      message: "この機能はまだ有効になっていません。",
    },
  };
}

function invalidInput(): { ok: false; error: MenuPlannerActionError } {
  return {
    ok: false,
    error: {
      kind: "INVALID_INPUT",
      code: "ACTION_INPUT_INVALID",
      message: "入力内容を確認してください。",
    },
  };
}

function unexpectedGenerateFailure(): { ok: false; error: MenuPlannerActionError } {
  return {
    ok: false,
    error: {
      kind: "PLANNING_REJECTED",
      code: "PRODUCTION_COMPOSITION_FAILED",
      message: "メニューを生成できませんでした。",
    },
  };
}

function unexpectedSaveFailure(): { ok: false; error: MenuPlannerActionError } {
  return {
    ok: false,
    error: {
      kind: "SAVE_FAILED",
      code: "SAVE_FAILED",
      message: "メニューを保存できませんでした。時間をおいてもう一度お試しください。",
    },
  };
}

/** Generate: client supplies only the existing A3D request contract. */
export async function generateMenuPlannerAction(input: unknown): Promise<GenerateMenuPlannerActionResult> {
  const parsed = generateActionInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  if (!isMenuPlannerFeatureEnabled()) return featureDisabled();

  try {
    return await createMenuPlannerProductionComposition().generate({
      ...parsed.data,
      ownerId: DEFAULT_OWNER_ID,
    });
  } catch {
    return unexpectedGenerateFailure();
  }
}

/** Revise: the signed prior token is the only source of prior state. */
export async function reviseMenuPlannerAction(input: unknown): Promise<ReviseMenuPlannerActionResult> {
  const parsed = reviseActionInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  if (!isMenuPlannerFeatureEnabled()) return featureDisabled();

  try {
    return await createMenuPlannerProductionComposition().revise({
      ...parsed.data,
      ownerId: DEFAULT_OWNER_ID,
    });
  } catch {
    return unexpectedGenerateFailure();
  }
}

/** Save: only the opaque acceptToken crosses the client boundary; owner binding is server-owned. */
export async function saveMenuPlannerAction(input: unknown): Promise<SaveMenuPlannerActionResult> {
  const parsed = saveActionInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  if (!isMenuPlannerFeatureEnabled()) return featureDisabled();

  try {
    const result = await createMenuPlannerProductionComposition().save({
      ownerId: DEFAULT_OWNER_ID,
      token: parsed.data.acceptToken,
    });
    if (result.ok) {
      revalidatePath("/menus");
      revalidatePath(`/menus/${result.menuId}`);
    }
    return result;
  } catch {
    return unexpectedSaveFailure();
  }
}
