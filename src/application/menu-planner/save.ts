/**
 * R12-A3B — signed acceptToken から MenuTemplate(DRAFT) を atomic に作る server-only application path。
 *
 * cheap token validation、target id の duplicate check、authoritative replay、freshness gate、
 * MenuTemplate / MenuBlock / MenuItem の全writeを1 interactive transactionに閉じる。
 * provider / client payload / token内の過去doseはこのmoduleの保存authorityではない。
 */
import type { PrismaClient } from "@prisma/client";

import {
  revalidateVerifiedMenuPlannerAccept,
  verifyMenuPlannerAcceptToken,
  type MenuPlannerAcceptDependencies,
  type MenuPlannerAcceptError,
  type RevalidateMenuPlannerAcceptInput,
  type VerifiedMenuPlannerAccept,
} from "./accept";
import type { MenuPlannerDraftMaterialization } from "@/domain/menu-planner/draft";
import { provenanceSchema } from "@/domain/running/persistence/provenance";
import type { IsoDateTime } from "@/domain/running/types/primitives";
import { prisma } from "@/infra/db/prisma";
import {
  createMenuPlannerDraft,
  buildMenuPlannerDraftIdentityDigest,
  findMenuPlannerDraftTarget,
  findMenuPlannerDraftTargetHierarchy,
  isTargetConflict,
  savedMenuPlannerDraftIdentityDigest,
} from "@/infra/repositories/menu-planner-draft-repository";

export type SaveAiMenuDraftInput = RevalidateMenuPlannerAcceptInput;

export type SaveAiMenuDraftError = MenuPlannerAcceptError | {
  kind: "SAVE_FAILED";
  code: "SAVE_FAILED";
  message: string;
};

export type SaveAiMenuDraftResult =
  | { ok: true; menuId: string; status: "DRAFT" | string; alreadySaved: boolean }
  | { ok: false; error: SaveAiMenuDraftError };

export type SaveAiMenuDraftDependencies = MenuPlannerAcceptDependencies & {
  /** server composition / tests only。client inputから渡さない。 */
  database?: PrismaClient;
  /** [R12 unified composer] AI 項目の id を targetMenuId から決定的に採番する（server composition only）。 */
  deterministicItemIds?: boolean;
};

function saveFailed(): { ok: false; error: SaveAiMenuDraftError } {
  return {
    ok: false,
    error: {
      kind: "SAVE_FAILED",
      code: "SAVE_FAILED",
      message: "メニューを保存できませんでした。時間をおいてもう一度お試しください。",
    },
  };
}

function acceptedDraftOf(
  draft: MenuPlannerDraftMaterialization,
  acceptedAt: Date,
) {
  const acceptedAtIso = acceptedAt.toISOString() as IsoDateTime;
  return {
    ...draft,
    blocks: draft.blocks.map((block) => ({
      ...block,
      items: block.items.map((item) => ({
        ...item,
        runningPrescription:
          item.runningPrescription === null
            ? null
            : {
                ...item.runningPrescription,
                generatedBy: {
                  ...item.runningPrescription.generatedBy,
                  acceptedByCoachAt: acceptedAtIso,
                },
              },
        runningProvenance:
          item.runningProvenance === null
            ? null
            : provenanceSchema.parse({
                ...item.runningProvenance,
                generatedBy: {
                  ...item.runningProvenance.generatedBy,
                  acceptedByCoachAt: acceptedAtIso,
                },
              }),
      })),
    })),
  };
}

function resultForExistingTarget(targetMenuId: string, status: string): SaveAiMenuDraftResult {
  return { ok: true, menuId: targetMenuId, status, alreadySaved: true };
}

function existingTargetOwnerMismatch(): { ok: false; error: MenuPlannerAcceptError } {
  return {
    ok: false,
    error: {
      kind: "INVALID_INPUT",
      code: "ACCEPT_INPUT_INVALID",
      message: "プレビューの確認情報を検証できません。もう一度プレビューを作成してください。",
    },
  };
}

/**
 * Existing target は owner/status だけでは idempotent success にしない。
 * issue 時に server が作った signed savedDraftIdentityDigest と既存階層を比較する。
 * current authoritative context は、既にcommit済みの operation の retry identity には使わない。
 */
async function resolveExistingTarget(
  verified: VerifiedMenuPlannerAccept,
  input: SaveAiMenuDraftInput,
  db: PrismaClient,
): Promise<SaveAiMenuDraftResult | null> {
  const existing = await findMenuPlannerDraftTarget(verified.claims.targetMenuId, db);
  if (existing === null) return null;
  if (existing.ownerId !== input.ownerId) return existingTargetOwnerMismatch();

  const hierarchy = await findMenuPlannerDraftTargetHierarchy(verified.claims.targetMenuId, db);
  if (hierarchy === null) return saveFailed();

  const persistedIdentityDigest = savedMenuPlannerDraftIdentityDigest(hierarchy);
  if (persistedIdentityDigest === null || persistedIdentityDigest !== verified.claims.savedDraftIdentityDigest) {
    return saveFailed();
  }
  return resultForExistingTarget(verified.claims.targetMenuId, "DRAFT");
}

/**
 * explicit acceptの保存。A3Aのverified replayをtransaction clientへ接続する唯一の入口。
 */
export async function saveAiMenuDraft(
  input: SaveAiMenuDraftInput,
  deps: SaveAiMenuDraftDependencies,
): Promise<SaveAiMenuDraftResult> {
  const database = deps.database ?? prisma;

  try {
    const result = await database.$transaction(async (tx) => {
      // signature / claim schema / expiry / trusted owner はtransaction開始後にcheapに確認する。
      // 以降のtarget lookup・authoritative read・freshness・writeは同じtx clientを使う。
      const verified = verifyMenuPlannerAcceptToken(input, deps);
      if (!verified.ok) return verified;

      const existing = await findMenuPlannerDraftTarget(verified.verified.claims.targetMenuId, tx);
      if (existing !== null) {
        if (existing.ownerId !== input.ownerId) return existingTargetOwnerMismatch();

        const hierarchy = await findMenuPlannerDraftTargetHierarchy(verified.verified.claims.targetMenuId, tx);
        if (hierarchy === null) return saveFailed();

        const persistedIdentityDigest = savedMenuPlannerDraftIdentityDigest(hierarchy);
        if (persistedIdentityDigest === null || persistedIdentityDigest !== verified.verified.claims.savedDraftIdentityDigest) {
          return saveFailed();
        }
        return resultForExistingTarget(verified.verified.claims.targetMenuId, "DRAFT");
      }

      const revalidated = await revalidateVerifiedMenuPlannerAccept(verified.verified, {
        db: tx,
        ...(input.inlineRunningContextJson !== undefined ? { inlineRunningContextJson: input.inlineRunningContextJson } : {}),
      });
      if (!revalidated.ok) return revalidated;

      const acceptedAt = deps.now();
      if (!(acceptedAt instanceof Date) || Number.isNaN(acceptedAt.getTime())) throw new Error("SAVE_CLOCK_INVALID");
      const draft = acceptedDraftOf(revalidated.materialization.draft, acceptedAt);
      const savedDraftIdentityDigest = buildMenuPlannerDraftIdentityDigest({
        ...draft,
        ownerId: input.ownerId,
        targetMenuId: revalidated.materialization.targetMenuId,
      });
      if (savedDraftIdentityDigest !== verified.verified.claims.savedDraftIdentityDigest) {
        return saveFailed();
      }
      const saved = await createMenuPlannerDraft(
        {
          ...draft,
          ownerId: input.ownerId,
          targetMenuId: revalidated.materialization.targetMenuId,
        },
        tx,
        { deterministicItemIds: deps.deterministicItemIds === true },
      );
      return { ok: true as const, menuId: saved.menuId, status: saved.status, alreadySaved: false };
    });
    return result;
  } catch (error) {
    // Two concurrent first submissions can race on targetMenuId's primary key. The winner
    // is the saved result; the loser re-reads only that exact target and becomes idempotent.
    if (isTargetConflict(error)) {
      const verified = verifyMenuPlannerAcceptToken(input, deps);
      if (verified.ok) {
        const resolved = await resolveExistingTarget(verified.verified, input, database).catch(() => saveFailed());
        return resolved ?? saveFailed();
      }
    }
    return saveFailed();
  }
}
