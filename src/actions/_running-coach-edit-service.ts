import { z } from "zod";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { applyRunningCoachEdit, runningCoachEditRequestSchema } from "@/application/running-menu/coach-edit";
import { parseRunningMenuEnvelope, serializeRunningMenuEnvelopeV2 } from "@/application/running-menu/persistence";
import { snapshotSavedRunningMenuItem } from "@/application/running-session/snapshot";
import { prisma, runInAmbientTransaction } from "@/infra/db/prisma";

export const runningCoachEditActionInputSchema = z.object({
  menuId: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  edit: runningCoachEditRequestSchema,
}).strict();
export type RunningCoachEditActionInput = z.infer<typeof runningCoachEditActionInputSchema>;
export type RunningCoachEditActionResult =
  | { ok: true; fingerprint: string }
  | { ok: false; code: "INVALID_INPUT" | "NOT_FOUND" | "INVALID_ITEM" | "STALE_ITEM" | "POLICY_MISMATCH" |
      "RANGE_OUTSIDE" | "DISTANCE_REVIEW_REQUIRED" | "TIME_ADJUSTMENT_REQUIRED" | "INVALID_EDIT" | "NO_CHANGE" | "SAVE_FAILED" };

type FingerprintItem = {
  id: string; menuBlockId: string; prescriptionKind: string;
  sortOrder: number; displayName: string | null; note: string | null; exerciseId: string | null;
  prescriptionJson: string | null; provenanceJson: string | null;
  distanceMeters: number | null; reps: number | null; sets: number | null;
  restSeconds: number | null; setRestSeconds: number | null;
};

export function runningCoachEditSourceFingerprint(item: FingerprintItem): string {
  return sha256Utf8Hex(canonicalStringify({
    id: item.id, menuBlockId: item.menuBlockId, prescriptionKind: item.prescriptionKind,
    sortOrder: item.sortOrder, displayName: item.displayName, note: item.note, exerciseId: item.exerciseId,
    prescriptionJson: item.prescriptionJson, provenanceJson: item.provenanceJson,
    distanceMeters: item.distanceMeters, reps: item.reps, sets: item.sets,
    restSeconds: item.restSeconds, setRestSeconds: item.setRestSeconds,
  }));
}

/** One owned DB-read, validated edit, compare-and-swap write, and provenance update. */
export async function editRunningPolicyMenuItem(input: RunningCoachEditActionInput): Promise<RunningCoachEditActionResult> {
  try {
    return await runInAmbientTransaction(async () => {
      const item = await prisma.menuItem.findUnique({
        where: { id: input.itemId },
        include: { menuBlock: { include: { menuTemplate: { select: { id: true, ownerId: true } } } } },
      });
      if (item === null || item.menuBlock.menuTemplate.id !== input.menuId ||
          item.menuBlock.menuTemplate.ownerId !== DEFAULT_OWNER_ID) return { ok: false as const, code: "NOT_FOUND" as const };
      if (runningCoachEditSourceFingerprint(item) !== input.expectedFingerprint) return { ok: false as const, code: "STALE_ITEM" as const };
      const envelope = parseRunningMenuEnvelope(item.prescriptionKind, item.prescriptionJson);
      if (envelope === null) return { ok: false as const, code: "INVALID_ITEM" as const };
      try { snapshotSavedRunningMenuItem(item); } catch { return { ok: false as const, code: "INVALID_ITEM" as const }; }
      const result = applyRunningCoachEdit(envelope, item.provenanceJson, input.edit, new Date().toISOString());
      if (!result.ok) return result;
      const p = result.envelope.finalPrescription;
      const prescriptionJson = serializeRunningMenuEnvelopeV2(result.envelope);
      const updated = await prisma.menuItem.updateMany({
        where: {
          id: item.id, menuBlockId: item.menuBlockId,
          sortOrder: item.sortOrder, displayName: item.displayName, note: item.note, exerciseId: item.exerciseId,
          prescriptionJson: item.prescriptionJson, provenanceJson: item.provenanceJson,
          distanceMeters: item.distanceMeters, reps: item.reps, sets: item.sets,
          restSeconds: item.restSeconds, setRestSeconds: item.setRestSeconds,
        },
        data: {
          prescriptionJson, distanceMeters: p.distanceMeters, reps: p.totalReps,
          sets: p.sets, restSeconds: p.repRestSeconds, setRestSeconds: p.setRestSeconds,
        },
      });
      if (updated.count !== 1) return { ok: false as const, code: "STALE_ITEM" as const };
      await prisma.menuTemplate.update({ where: { id: input.menuId }, data: { updatedAt: new Date() } });
      return { ok: true as const, fingerprint: runningCoachEditSourceFingerprint({
        ...item, prescriptionJson, distanceMeters: p.distanceMeters, reps: p.totalReps,
        sets: p.sets, restSeconds: p.repRestSeconds, setRestSeconds: p.setRestSeconds,
      }) };
    });
  } catch {
    return { ok: false, code: "SAVE_FAILED" };
  }
}
