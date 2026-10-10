import { z } from "zod";
import { durationPlanSchema, calculateMenuDuration } from "@/domain/menu-composition/duration";
import { parseConfirmedCompositionContext } from "@/domain/menu-composition/saved-context";
import { savedMenuDurationInput } from "@/application/menu-composition/saved-duration";
import { runningSessionSourceFingerprint } from "@/application/running-session/snapshot";
import { findMenu } from "@/infra/repositories/menu-repository";
import { prisma, runInAmbientTransaction } from "@/infra/db/prisma";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";

const inputSchema = z.object({ menuId: z.string().min(1).max(80), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  requestedSeconds: z.number().int().positive().max(604800).nullable(), plan: durationPlanSchema }).strict();

/** User-entered scheduling windows never change exercise or Running doses. */
export async function saveMenuDuration(input: unknown): Promise<{ ok: true; menuId: string } | { ok: false; code: string }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_DURATION_PLAN" };
  try {
    return await runInAmbientTransaction(async () => {
      const data = parsed.data;
      const menu = await findMenu(data.menuId);
      if (!menu || menu.ownerId !== DEFAULT_OWNER_ID || runningSessionSourceFingerprint(menu) !== data.sourceFingerprint) return { ok: false as const, code: "STALE_MENU" };
      const context = parseConfirmedCompositionContext(menu.runningContextJson);
      const source = savedMenuDurationInput(menu);
      if (!context || !source) return { ok: false as const, code: "INVALID_MENU" };
      const summary = calculateMenuDuration(source.composition, source.running, data.requestedSeconds, data.plan);
      if (summary.orphanPlanBlockIds.length) return { ok: false as const, code: "INVALID_DURATION_PLAN" };
      if (summary.blocks.some(block => block.underallocated)) return { ok: false as const, code: "DURATION_UNDERSIZED_SLOT" };
      await prisma.menuTemplate.update({ where: { id: menu.id }, data: { runningContextJson: canonicalStringify({ ...context,
        requestedTimeSeconds: data.requestedSeconds, durationPlan: data.plan,
        confirmedPlanDigest: sha256Utf8Hex(canonicalStringify({ priorDigest: context.confirmedPlanDigest, sourceFingerprint: data.sourceFingerprint, duration: data.plan, requestedSeconds: data.requestedSeconds })),
      }) } });
      return { ok: true as const, menuId: menu.id };
    });
  } catch { return { ok: false, code: "SAVE_FAILED" }; }
}
