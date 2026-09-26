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
  generateMenuDraftFromRunningContext,
  isMenuPlannerFeatureEnabled,
} from "@/infra/menu-planner/menu-planner-composition";
import { MENU_PLANNER_SCHEMA_VERSION } from "@/domain/menu-planner";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { HMAC_TOKEN_MAX_LENGTH } from "@/infra/security/hmac-token";
import type { GenerateMenuPlannerPreviewResult } from "@/application/menu-planner/generate";
import type { ReviseMenuPlannerPreviewResult } from "@/application/menu-planner/revise";
import type { SaveAiMenuDraftError, SaveAiMenuDraftResult } from "@/application/menu-planner/save";
import {
  commitComposedMenu,
  composerDraftInputSchema,
  dryRunComposedMenu,
  type ComposerDraftFailure,
  type ComposerRunningItemView,
} from "./_menu-composer-service";
import type { RunningActionFailure } from "./running-actions";

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

// --- [R12 unified composer] 参照メニューを介さない新規メニュー AI 生成 / 保存前編集 / 保存 ---

const generateDraftActionInputSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_SCHEMA_VERSION),
    menuName: z.string().trim().min(1).max(120),
    runningContextJson: z.string().min(1).max(20000),
    coachRequest: z.unknown(),
  })
  .strict();

export type GenerateMenuDraftActionResult = GenerateMenuPlannerPreviewResult | { ok: false; error: MenuPlannerActionError };

/**
 * 統合 Composer 用。参照メニューではなく、コーチが入力した running context で AI 生成する。
 * 何も保存しない（署名済み preview と acceptToken だけを返す）。
 */
export async function generateMenuDraftAction(input: unknown): Promise<GenerateMenuDraftActionResult> {
  const parsed = generateDraftActionInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  if (!isMenuPlannerFeatureEnabled()) return featureDisabled();

  try {
    return await generateMenuDraftFromRunningContext({
      menuName: parsed.data.menuName,
      runningContextJson: parsed.data.runningContextJson,
      coachRequest: parsed.data.coachRequest,
    });
  } catch {
    return unexpectedGenerateFailure();
  }
}

export type SaveMenuDraftActionResult =
  | { ok: true; menuId: string; alreadySaved: boolean }
  | { ok: false; error: MenuPlannerActionError | SaveAiMenuDraftError }
  | { ok: false; error: { kind: "RUNNING_EDIT_REJECTED"; code: "RUNNING_EDIT_REJECTED"; message: string }; opIndex: number; failure: RunningActionFailure };

function composerFailure(outcome: ComposerDraftFailure): SaveMenuDraftActionResult {
  if (outcome.scope === "DRAFT") return { ok: false, error: outcome.error };
  return {
    ok: false,
    error: { kind: "RUNNING_EDIT_REJECTED", code: "RUNNING_EDIT_REJECTED", message: outcome.failure.message },
    opIndex: outcome.opIndex,
    failure: outcome.failure,
  };
}

/**
 * 統合 Composer の保存。
 *
 * coach-editable: メニュー名（`MenuTemplate.name`）、ブロック内の順序、項目の削除・追加・種目差し替え、
 * notes、RUNNING_V2 の coachEditable 処方（既存 running edit Action の検証を通ったものだけ）。
 * AI proposal 自体は署名済み token から server が再計算したものだけを保存する（client の数値は使わない）。
 * materialize → 編集反映 → running 調整を 1 transaction で行い、どこかで失敗すれば何も保存しない。
 */
export async function saveMenuDraftAction(input: unknown): Promise<SaveMenuDraftActionResult> {
  const parsed = composerDraftInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  if (!isMenuPlannerFeatureEnabled()) return featureDisabled();

  try {
    const outcome = await commitComposedMenu(parsed.data);
    if (!outcome.ok) return composerFailure(outcome);
    revalidatePath("/menus");
    revalidatePath(`/menus/${outcome.menuId}`);
    return { ok: true, menuId: outcome.menuId, alreadySaved: outcome.alreadySaved };
  } catch {
    return unexpectedSaveFailure();
  }
}

export type PreviewMenuDraftRunningActionResult =
  | { ok: true; running: ComposerRunningItemView[]; message: string | null }
  | Extract<SaveMenuDraftActionResult, { ok: false }>;

/**
 * 保存前の RUNNING_V2 表示・調整。保存と同じ処理を 1 transaction で実行して必ず rollback する。
 * 何も保存しない。返すのは再計算後の RUNNING_V2 項目の表示 DTO（既存 RunningItemPanel と同じ形）だけ。
 */
export async function previewMenuDraftRunningAction(input: unknown): Promise<PreviewMenuDraftRunningActionResult> {
  const parsed = composerDraftInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  if (!isMenuPlannerFeatureEnabled()) return featureDisabled();
  if (parsed.data.acceptToken === null) return invalidInput();

  try {
    const outcome = await dryRunComposedMenu(parsed.data);
    if (!outcome.ok) return composerFailure(outcome) as Extract<SaveMenuDraftActionResult, { ok: false }>;
    return outcome;
  } catch {
    return unexpectedSaveFailure();
  }
}
