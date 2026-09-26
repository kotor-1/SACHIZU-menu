/**
 * [R12 unified composer] 統合メニュー Composer の保存 / 保存前 dry-run（server-only）。
 *
 * 1 つの ambient transaction の中で、次を順に実行する:
 *   1. materialize — AI 経由なら署名済み acceptToken を A3B（`saveAiMenuDraft`）で保存する。
 *      署名検証・TOCTOU 再計算・freshness gate・OPEN20 の判定はすべて既存経路のまま。
 *      手動のみなら空の MenuTemplate(DRAFT) を作る。
 *   2. coach edits — メニュー名・順序・削除・追加・差し替え・notes（`applyComposedMenuEdits`）。
 *   3. running edits — AI の RUNNING_V2 項目に対するコーチの処方調整を、既存の
 *      `editRunningItemAction` / `overrideRunningItemAction` にそのまま通す
 *      （coachEditable 範囲・hard blocker・Finding 確認・PlausibilityReview の検証は既存 domain / Action が行う）。
 *
 * COMMIT は全部成功したときだけ commit する。DRY_RUN は同じ処理を実行したうえで必ず rollback し、
 * RUNNING_V2 項目の表示 DTO（再計算後の処方）だけを返す。どちらも途中で失敗すれば何も残らない。
 *
 * AI の数値 authority は増えない: AI proposal は署名済み token から server が再計算したものだけを保存し、
 * コーチの数値調整は既存の running edit 検証を通った結果だけが残る。
 */
import { z } from "zod";

import { runInAmbientTransaction } from "@/infra/db/prisma";
import { saveSignedMenuDraftForComposer } from "@/infra/menu-planner/menu-planner-composition";
import { menuPlannerDraftItemId } from "@/infra/repositories/menu-planner-draft-repository";
import { applyComposedMenuEdits, createMenu, findMenu } from "@/infra/repositories/menu-repository";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { HMAC_TOKEN_MAX_LENGTH } from "@/infra/security/hmac-token";
import type { SaveAiMenuDraftError } from "@/application/menu-planner/save";
import { presentSavedRunningMenuItem, type SavedRunningItemPresentation } from "@/presentation/running/server";
import { editRunningItemAction, overrideRunningItemAction, type RunningActionFailure } from "./running-actions";

const composerItemSchema = z.union([
  z
    .object({
      kind: z.literal("AI"),
      previewIndex: z.number().int().nonnegative().max(49),
      /** undefined = AI のまま（note も触らない）。文字列 / null = コーチが notes を編集した。 */
      note: z.string().trim().max(1000).nullable().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("MANUAL"), values: menuItemInputSchema }).strict(),
]);

/** AI の RUNNING_V2 項目に対するコーチの処方調整 1 回分。FormData の中身は既存 Action がそのまま検証する。 */
const composerRunningOpSchema = z
  .object({
    aiBlockIndex: z.number().int().nonnegative().max(49),
    previewIndex: z.number().int().nonnegative().max(49),
    kind: z.enum(["EDIT", "OVERRIDE"]),
    entries: z.array(z.tuple([z.string().min(1).max(64), z.string().max(20000)])).max(60),
  })
  .strict();

export const composerDraftInputSchema = z
  .object({
    /** AI を介さない手動のみのときは null。AI 経由なら署名済み acceptToken。 */
    acceptToken: z.string().trim().min(1).max(HMAC_TOKEN_MAX_LENGTH).nullable(),
    /** AI 経由のとき、生成に使った running context（署名済み contextFingerprint と一致しなければ STALE）。 */
    runningContextJson: z.string().min(1).max(20000).nullable(),
    /** coach-editable metadata。token に署名された生成時の名前ではなく、保存時にコーチが入力した名前を使う。 */
    menuName: z.string().trim().min(1).max(120),
    blocks: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            aiBlockIndex: z.number().int().nonnegative().max(49).nullable(),
            items: z.array(composerItemSchema).max(50),
          })
          .strict(),
      )
      .max(50),
    runningOps: z.array(composerRunningOpSchema).max(50),
  })
  .strict()
  .superRefine((draft, context) => {
    if (draft.acceptToken !== null && draft.runningContextJson === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "running context is required with acceptToken", path: ["runningContextJson"] });
    }
    if (draft.acceptToken === null && (draft.runningOps.length > 0 || draft.blocks.some((b) => b.aiBlockIndex !== null))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "AI items require acceptToken", path: ["acceptToken"] });
    }
  });

export type ComposerDraftInput = z.infer<typeof composerDraftInputSchema>;
export type ComposerRunningOp = z.infer<typeof composerRunningOpSchema>;

export type ComposerRunningItemView = {
  aiBlockIndex: number;
  previewIndex: number;
  presentation: SavedRunningItemPresentation;
};

export type ComposerDraftFailure =
  | { ok: false; scope: "DRAFT"; error: SaveAiMenuDraftError }
  /** `opIndex` 番目の running 調整が既存 Action に拒否された（確認不足・review 必要・hard blocker 等）。 */
  | { ok: false; scope: "RUNNING_OP"; opIndex: number; failure: RunningActionFailure };

export type ComposerCommitOutcome = { ok: true; menuId: string; alreadySaved: boolean } | ComposerDraftFailure;
export type ComposerDryRunOutcome = { ok: true; running: ComposerRunningItemView[]; message: string | null } | ComposerDraftFailure;

/** transaction を rollback させつつ結果を外へ運ぶ。 */
class ComposerTransactionExit extends Error {
  constructor(readonly outcome: ComposerCommitOutcome | ComposerDryRunOutcome) {
    super("composer transaction exit");
  }
}

function exit(outcome: ComposerCommitOutcome | ComposerDryRunOutcome): never {
  throw new ComposerTransactionExit(outcome);
}

function saveFailed(message = "メニューを保存できませんでした。内容を確認して再度お試しください。"): ComposerDraftFailure {
  return { ok: false, scope: "DRAFT", error: { kind: "SAVE_FAILED", code: "SAVE_FAILED", message } };
}

function formDataOf(entries: readonly (readonly [string, string])[], itemId: string): FormData {
  const form = new FormData();
  for (const [key, value] of entries) {
    if (key !== "itemId") form.append(key, value);
  }
  // 対象項目は client の値ではなく、この transaction で materialize した AI 項目の id に固定する
  // （他メニューの項目を指す itemId を送られても、そちらには触れない）。
  form.set("itemId", itemId);
  return form;
}

async function materialize(draft: ComposerDraftInput): Promise<{ menuId: string; alreadySaved: boolean }> {
  if (draft.acceptToken === null) {
    const created = await createMenu(
      { name: draft.menuName, description: null, purpose: null, phase: null, estimatedMinutes: null, status: "DRAFT", tags: [] },
      false,
    );
    return { menuId: created.id, alreadySaved: false };
  }
  const saved = await saveSignedMenuDraftForComposer({ token: draft.acceptToken, inlineRunningContextJson: draft.runningContextJson });
  if (!saved.ok) exit({ ok: false, scope: "DRAFT", error: saved.error });
  return { menuId: saved.menuId, alreadySaved: saved.alreadySaved };
}

async function applyRunningOps(menuId: string, ops: readonly ComposerRunningOp[]): Promise<string | null> {
  let lastMessage: string | null = null;
  const menu = await findMenu(menuId);
  const itemIds = new Set(menu?.blocks.flatMap((block) => block.items.map((item) => item.id)) ?? []);
  for (const [opIndex, op] of ops.entries()) {
    const itemId = menuPlannerDraftItemId(menuId, op.aiBlockIndex, op.previewIndex);
    if (!itemIds.has(itemId)) {
      exit({ ok: false, scope: "RUNNING_OP", opIndex, failure: { ok: false, kind: "REJECTED", message: "項目が見つかりません。" } });
    }
    const form = formDataOf(op.entries, itemId);
    const result = op.kind === "EDIT" ? await editRunningItemAction(menuId, null, form) : await overrideRunningItemAction(menuId, null, form);
    if (!result.ok) exit({ ok: false, scope: "RUNNING_OP", opIndex, failure: result });
    lastMessage = result.message ?? null;
  }
  return lastMessage;
}

async function presentRunningItems(menuId: string, draft: ComposerDraftInput): Promise<ComposerRunningItemView[]> {
  const menu = await findMenu(menuId);
  const byId = new Map(menu?.blocks.flatMap((block) => block.items.map((item) => [item.id, item] as const)) ?? []);
  const views: ComposerRunningItemView[] = [];
  for (const block of draft.blocks) {
    if (block.aiBlockIndex === null) continue;
    for (const item of block.items) {
      if (item.kind !== "AI") continue;
      const row = byId.get(menuPlannerDraftItemId(menuId, block.aiBlockIndex, item.previewIndex));
      if (row === undefined || row.prescriptionKind !== "RUNNING_V2") continue;
      views.push({ aiBlockIndex: block.aiBlockIndex, previewIndex: item.previewIndex, presentation: presentSavedRunningMenuItem(row) });
    }
  }
  return views;
}

async function runComposerTransaction(
  draft: ComposerDraftInput,
  mode: "COMMIT" | "DRY_RUN",
): Promise<ComposerCommitOutcome | ComposerDryRunOutcome> {
  try {
    return await runInAmbientTransaction(async () => {
      const { menuId, alreadySaved } = await materialize(draft);
      // 同じ token の二重送信（先に commit 済み）。コーチの編集を二度適用しない。
      if (alreadySaved) {
        return mode === "COMMIT" ? exit({ ok: true, menuId, alreadySaved: true }) : exit(saveFailed("このメニューはすでに保存されています。"));
      }
      await applyComposedMenuEdits(menuId, draft.blocks, draft.menuName);
      const message = await applyRunningOps(menuId, draft.runningOps);
      if (mode === "DRY_RUN") exit({ ok: true, running: await presentRunningItems(menuId, draft), message });
      return { ok: true as const, menuId, alreadySaved: false };
    }, { timeoutMs: 60_000 });
  } catch (error) {
    if (error instanceof ComposerTransactionExit) return error.outcome;
    return saveFailed();
  }
}

/** 保存。全段階が成功したときだけ commit する。 */
export async function commitComposedMenu(draft: ComposerDraftInput): Promise<ComposerCommitOutcome> {
  return (await runComposerTransaction(draft, "COMMIT")) as ComposerCommitOutcome;
}

/** 保存前の検証・再計算。同じ処理を実行して必ず rollback する（DB には何も残らない）。 */
export async function dryRunComposedMenu(draft: ComposerDraftInput): Promise<ComposerDryRunOutcome> {
  return (await runComposerTransaction(draft, "DRY_RUN")) as ComposerDryRunOutcome;
}
