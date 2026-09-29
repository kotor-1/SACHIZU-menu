import { z } from "zod";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { RUNNING_MENU_PRESCRIPTION_KIND, finalRunningMenuPrescription, parseRunningMenuEnvelope, runningMenuEnvelopeSchema, runningPrescriptionFingerprint, serializeRunningMenuEnvelope, serializeRunningMenuEnvelopeV2 } from "@/application/running-menu/persistence";
import { applyRunningCoachEdit, runningCoachEditRequestSchema } from "@/application/running-menu/coach-edit";
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
  coachEdit: runningCoachEditRequestSchema.optional(),
  previewFinalFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  menuName: z.string().trim().min(1).max(120),
  manualBlocks: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    items: z.array(menuItemInputSchema).max(50),
  }).strict()).max(50),
}).strict();

export type SaveRunningMenuInput = z.infer<typeof saveRunningMenuInputSchema>;
export type SaveRunningMenuResult =
  | { ok: true; menuId: string; alreadySaved: boolean }
  | { ok: false; code: "STALE_PREVIEW" | "POLICY_MISMATCH" | "ENGINE_RECOMPUTE_MISMATCH" | "RUNNING_NOT_READY" | "COACH_EDIT_INVALID" | "EXERCISE_CHANGED" | "SAVE_FAILED" };

type SignedPreviewInput = Pick<SaveRunningMenuInput,
  "previewToken" | "previewPolicyVersion" | "previewPolicyHash" | "requestText" | "context" | "previewPrescription">;

export function runningSaveProvenance(claims: NonNullable<ReturnType<typeof verifyRunningMenuPreviewToken>>): string {
  return canonicalStringify({
    schemaVersion: 1, source: "SIGNED_RUNNING_PREVIEW",
    requestDigest: sha256Utf8Hex(claims.requestText), intent: claims.intent, context: claims.context,
  });
}

export function evaluateSignedRunningPreview(input: SignedPreviewInput):
  | { ok: true; claims: NonNullable<ReturnType<typeof verifyRunningMenuPreviewToken>>; prescription: NonNullable<ReturnType<typeof createRunningMenuPreview>> & { status: "READY" } }
  | Extract<SaveRunningMenuResult, { ok: false }> {
  let claims;
  try { claims = verifyRunningMenuPreviewToken(input.previewToken, runningMenuSigningKey()); }
  catch { return { ok: false, code: "STALE_PREVIEW" }; }
  if (claims === null || claims.ownerId !== DEFAULT_OWNER_ID) return { ok: false, code: "STALE_PREVIEW" };
  if (claims.policyVersion !== RUNNING_POLICY_VERSION || claims.policyHash !== RUNNING_POLICY_HASH ||
      input.previewPolicyVersion !== claims.policyVersion || input.previewPolicyHash !== claims.policyHash) return { ok: false, code: "POLICY_MISMATCH" };
  if (claims.requestText !== input.requestText || canonicalStringify(claims.context) !== canonicalStringify(input.context)) return { ok: false, code: "STALE_PREVIEW" };
  const running = createRunningMenuPreview(claims.intent, claims.context, claims.requestText);
  if (running?.status !== "READY") return { ok: false, code: "RUNNING_NOT_READY" };
  const serverFingerprint = runningPrescriptionFingerprint(running.prescription);
  let echoedFingerprint: string;
  try { echoedFingerprint = sha256Utf8Hex(canonicalStringify(input.previewPrescription)); }
  catch { return { ok: false, code: "ENGINE_RECOMPUTE_MISMATCH" }; }
  if (serverFingerprint !== claims.prescriptionFingerprint || echoedFingerprint !== serverFingerprint) return { ok: false, code: "ENGINE_RECOMPUTE_MISMATCH" };
  return { ok: true, claims, prescription: running };
}

/** Signed preview -> current policy re-evaluation -> one atomic Menu transaction. */
export async function saveRunningMenuPreview(input: SaveRunningMenuInput): Promise<SaveRunningMenuResult> {
  const evaluated = evaluateSignedRunningPreview(input);
  if (!evaluated.ok) return evaluated;
  const { claims } = evaluated;
  const running = evaluated.prescription;
  if ((input.coachEdit === undefined) !== (input.previewFinalFingerprint === undefined)) return { ok: false, code: "COACH_EDIT_INVALID" };
  const provenanceJson = runningSaveProvenance(claims);
  const baseEnvelope = runningMenuEnvelopeSchema.parse({
    kind: RUNNING_MENU_PRESCRIPTION_KIND, schemaVersion: 1,
    policyVersion: running.prescription.policyVersion, policyHash: running.prescription.policyHash,
    prescription: running.prescription,
  });
  const coachEdited = input.coachEdit === undefined ? null
    : applyRunningCoachEdit(baseEnvelope, provenanceJson, input.coachEdit, new Date().toISOString());
  if (coachEdited !== null && !coachEdited.ok) return { ok: false, code: "COACH_EDIT_INVALID" };
  const final = coachEdited?.ok ? coachEdited.envelope.finalPrescription : finalRunningMenuPrescription(baseEnvelope);
  if (input.previewFinalFingerprint !== undefined &&
      input.previewFinalFingerprint !== sha256Utf8Hex(canonicalStringify(final))) return { ok: false, code: "ENGINE_RECOMPUTE_MISMATCH" };
  const prescriptionJson = coachEdited?.ok
    ? serializeRunningMenuEnvelopeV2(coachEdited.envelope)
    : serializeRunningMenuEnvelope(running.prescription);

  try {
    return await runInAmbientTransaction(async () => {
      const prior = await prisma.menuTemplate.findUnique({ where: { id: claims.menuId }, include: { blocks: { include: { items: true } } } });
      if (prior !== null) {
        const saved = prior.blocks.flatMap((block) => block.items).find((item) => item.prescriptionKind === RUNNING_MENU_PRESCRIPTION_KIND);
        const savedEnvelope = saved ? parseRunningMenuEnvelope(saved.prescriptionKind, saved.prescriptionJson) : null;
        return prior.ownerId === DEFAULT_OWNER_ID && savedEnvelope !== null &&
          canonicalStringify(finalRunningMenuPrescription(savedEnvelope)) === canonicalStringify(final)
          ? { ok: true as const, menuId: claims.menuId, alreadySaved: true }
          : { ok: false as const, code: "STALE_PREVIEW" as const };
      }

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
        distanceMeters: final.distanceMeters,
        reps: final.totalReps,
        sets: final.sets,
        restSeconds: final.repRestSeconds,
        setRestSeconds: final.setRestSeconds,
        runningMethod: null,
        sessionTemplateId: null,
        ruleSetVersion: null,
        ruleSetContentHash: null,
        prescriptionJson,
        provenanceJson,
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
