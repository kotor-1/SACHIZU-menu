import { z } from "zod";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { RUNNING_MENU_PRESCRIPTION_KIND, runningPrescriptionFingerprint, serializeRunningMenuEnvelope } from "@/application/running-menu/persistence";
import { runInAmbientTransaction, prisma } from "@/infra/db/prisma";
import { findExercisesForMenuPlanner } from "@/infra/repositories/exercise-repository";
import { HMAC_TOKEN_MAX_LENGTH } from "@/infra/security/hmac-token";
import { runningMenuSigningKey, verifyRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";

export const saveRunningMenuInputSchema = z.object({
  previewToken: z.string().min(1).max(HMAC_TOKEN_MAX_LENGTH),
  previewPolicyVersion: z.string().min(1).max(64),
  previewPolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  requestText: z.string().min(1).max(2000),
  context: z.object({
    event: z.string().max(32).optional(),
    ageGroup: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"]).optional(),
    availableTimeSeconds: z.number().int().positive().optional(),
  }).strict(),
  /** Echoed preview is compared to the signed server result. It is never a write source. */
  previewPrescription: z.unknown(),
  menuName: z.string().trim().min(1).max(120),
  manualBlocks: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    items: z.array(menuItemInputSchema).max(50),
  }).strict()).max(50),
}).strict();

export type SaveRunningMenuInput = z.infer<typeof saveRunningMenuInputSchema>;
export type SaveRunningMenuResult =
  | { ok: true; menuId: string; alreadySaved: boolean }
  | { ok: false; code: "STALE_PREVIEW" | "POLICY_MISMATCH" | "ENGINE_RECOMPUTE_MISMATCH" | "RUNNING_NOT_READY" | "EXERCISE_CHANGED" | "SAVE_FAILED" };

/** Signed preview -> current policy re-evaluation -> one atomic Menu transaction. */
export async function saveRunningMenuPreview(input: SaveRunningMenuInput): Promise<SaveRunningMenuResult> {
  let claims;
  try {
    claims = verifyRunningMenuPreviewToken(input.previewToken, runningMenuSigningKey());
  } catch {
    return { ok: false, code: "STALE_PREVIEW" };
  }
  if (claims === null || claims.ownerId !== DEFAULT_OWNER_ID) return { ok: false, code: "STALE_PREVIEW" };
  if (claims.policyVersion !== RUNNING_POLICY_VERSION || claims.policyHash !== RUNNING_POLICY_HASH ||
      input.previewPolicyVersion !== claims.policyVersion || input.previewPolicyHash !== claims.policyHash) {
    return { ok: false, code: "POLICY_MISMATCH" };
  }
  if (claims.requestText !== input.requestText || canonicalStringify(claims.context) !== canonicalStringify(input.context)) {
    return { ok: false, code: "STALE_PREVIEW" };
  }
  const running = createRunningMenuPreview(claims.intent, claims.context, claims.requestText);
  if (running?.status !== "READY") return { ok: false, code: "RUNNING_NOT_READY" };
  const serverFingerprint = runningPrescriptionFingerprint(running.prescription);
  let echoedFingerprint: string;
  try {
    echoedFingerprint = sha256Utf8Hex(canonicalStringify(input.previewPrescription));
  } catch {
    return { ok: false, code: "ENGINE_RECOMPUTE_MISMATCH" };
  }
  if (serverFingerprint !== claims.prescriptionFingerprint || echoedFingerprint !== serverFingerprint) {
    return { ok: false, code: "ENGINE_RECOMPUTE_MISMATCH" };
  }

  try {
    return await runInAmbientTransaction(async () => {
      const prior = await prisma.menuTemplate.findUnique({ where: { id: claims.menuId }, select: { ownerId: true } });
      if (prior !== null) return prior.ownerId === DEFAULT_OWNER_ID
        ? { ok: true as const, menuId: claims.menuId, alreadySaved: true }
        : { ok: false as const, code: "SAVE_FAILED" as const };

      const selected = await findExercisesForMenuPlanner(claims.intent.exerciseIds, DEFAULT_OWNER_ID);
      if (selected.length !== claims.intent.exerciseIds.length || selected.some((row) => row.status !== "REVIEWED")) {
        return { ok: false as const, code: "EXERCISE_CHANGED" as const };
      }
      const manualExerciseIds = [...new Set(input.manualBlocks.flatMap((block) => block.items.map((item) => item.exerciseId).filter((id): id is string => id !== null)))];
      const manualExercises = await findExercisesForMenuPlanner(manualExerciseIds, DEFAULT_OWNER_ID);
      if (manualExercises.length !== manualExerciseIds.length) return { ok: false as const, code: "EXERCISE_CHANGED" as const };

      await prisma.menuTemplate.create({ data: {
        id: claims.menuId,
        ownerId: DEFAULT_OWNER_ID,
        name: input.menuName,
        status: "DRAFT",
      } });
      const runningBlock = await prisma.menuBlock.create({ data: { menuTemplateId: claims.menuId, name: "走", sortOrder: 0 } });
      await prisma.menuItem.create({ data: {
        menuBlockId: runningBlock.id,
        sortOrder: 0,
        exerciseId: null,
        displayName: "走",
        prescriptionKind: RUNNING_MENU_PRESCRIPTION_KIND,
        distanceMeters: running.prescription.distanceMeters,
        reps: running.prescription.totalReps,
        sets: running.prescription.sets,
        restSeconds: running.prescription.repRestSeconds,
        setRestSeconds: running.prescription.setRestSeconds,
        runningMethod: null,
        sessionTemplateId: null,
        ruleSetVersion: null,
        ruleSetContentHash: null,
        prescriptionJson: serializeRunningMenuEnvelope(running.prescription),
        provenanceJson: canonicalStringify({
          schemaVersion: 1,
          source: "SIGNED_RUNNING_PREVIEW",
          requestDigest: sha256Utf8Hex(claims.requestText),
          intent: claims.intent,
          context: claims.context,
        }),
      } });
      let blockOrder = 1;
      if (claims.intent.exerciseIds.length > 0) {
        const exerciseBlock = await prisma.menuBlock.create({ data: { menuTemplateId: claims.menuId, name: "種目", sortOrder: blockOrder++ } });
        for (const [sortOrder, exerciseId] of claims.intent.exerciseIds.entries()) {
          const exercise = selected.find((row) => row.id === exerciseId)!;
          await prisma.menuItem.create({ data: { menuBlockId: exerciseBlock.id, sortOrder, exerciseId, displayName: exercise.name } });
        }
      }
      for (const block of input.manualBlocks) {
        if (block.items.length === 0) continue;
        const created = await prisma.menuBlock.create({ data: { menuTemplateId: claims.menuId, name: block.name, sortOrder: blockOrder++ } });
        for (const [sortOrder, item] of block.items.entries()) {
          await prisma.menuItem.create({ data: { ...item, menuBlockId: created.id, sortOrder } });
        }
      }
      return { ok: true as const, menuId: claims.menuId, alreadySaved: false };
    }, { timeoutMs: 60_000 });
  } catch {
    return { ok: false, code: "SAVE_FAILED" };
  }
}
