import { z } from "zod";
import { calculateMenuDuration, durationPlanSchema } from "@/domain/menu-composition/duration";
import { parseConfirmedCompositionContext } from "@/domain/menu-composition/saved-context";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { editableCompositionSchema, exercisePlanNote, exercisePlanValues, validateComposition } from "@/domain/menu-composition/contracts";
import { runningCoachEditRequestSchema, applyRunningCoachEdit } from "@/application/running-menu/coach-edit";
import { RUNNING_MENU_PRESCRIPTION_KIND, runningMenuEnvelopeSchema, serializeRunningMenuEnvelope, serializeRunningMenuEnvelopeV2, finalRunningMenuPrescription } from "@/application/running-menu/persistence";
import { runInAmbientTransaction, prisma } from "@/infra/db/prisma";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { verifyMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import { runningMenuSigningKey } from "@/infra/running-menu/preview-token";
import { HMAC_TOKEN_MAX_LENGTH } from "@/infra/security/hmac-token";
import { evaluateSignedRunningPreview, runningSaveProvenance } from "./_running-menu-save-service";
import { UNPRESCRIBED_RUNNING_KIND } from "@/domain/menu-composition/unprescribed-running";

export const saveComposedMenuSchema = z.object({
  previewToken: z.string().min(1).max(HMAC_TOKEN_MAX_LENGTH), menuName: z.string().trim().min(1).max(120),
  composition: editableCompositionSchema, durationPlan: durationPlanSchema.optional(), runningPrescription: z.unknown(), coachEdit: runningCoachEditRequestSchema.optional(),
}).strict();
export type SaveComposedMenuInput = z.infer<typeof saveComposedMenuSchema>;
export type SaveComposedMenuResult = { ok: true; menuId: string; alreadySaved: boolean } | { ok: false; code: string };

export async function saveComposedMenu(rawInput: unknown): Promise<SaveComposedMenuResult> {
  const parsed = saveComposedMenuSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_PLAN" };
  const input = parsed.data;
  try {
    const claims = verifyMenuCompositionToken(input.previewToken, runningMenuSigningKey());
    if (!claims || claims.ownerId !== DEFAULT_OWNER_ID) return { ok: false, code: "STALE_PREVIEW" };
    const hasRunning = input.composition.blocks.some((block) => block.items.some((item) => item.type === "RUNNING_POLICY"));
    let finalRunningForDuration: ReturnType<typeof finalRunningMenuPrescription> | null = null;
    let runningData: { prescriptionJson: string; provenanceJson: string; distanceMeters: number; reps: number; sets: number; restSeconds: number | null; setRestSeconds: number | null } | null = null;
    if (claims.runningPrescription && claims.runningToken) {
      const verified = evaluateSignedRunningPreview({
        previewToken: claims.runningToken, previewPolicyVersion: claims.policyVersion, previewPolicyHash: claims.policyHash,
        requestText: claims.requestText, context: claims.context, previewPrescription: claims.runningPrescription,
      });
      if (!verified.ok) return verified;
      const base = verified.prescription.prescription;
      const provenanceJson = runningSaveProvenance(verified.claims);
      const baseEnvelope = runningMenuEnvelopeSchema.parse({ kind: RUNNING_MENU_PRESCRIPTION_KIND, schemaVersion: 1, policyVersion: base.policyVersion, policyHash: base.policyHash, prescription: base });
      const edited = input.coachEdit ? applyRunningCoachEdit(baseEnvelope, provenanceJson, input.coachEdit, new Date().toISOString()) : null;
      if (edited && !edited.ok) return { ok: false, code: "COACH_EDIT_INVALID" };
      const final = edited?.ok ? edited.envelope.finalPrescription : finalRunningMenuPrescription(baseEnvelope);
      finalRunningForDuration = final;
      // UI echo is checked, never used as an execution/write source.
      const expectedEcho = input.coachEdit ? final : base;
      if (canonicalStringify(input.runningPrescription) !== canonicalStringify(expectedEcho)) return { ok: false, code: "RUNNING_TAMPER" };
      runningData = { prescriptionJson: edited?.ok ? serializeRunningMenuEnvelopeV2(edited.envelope) : serializeRunningMenuEnvelope(base), provenanceJson,
        distanceMeters: final.distanceMeters, reps: final.totalReps, sets: final.sets, restSeconds: final.repRestSeconds, setRestSeconds: final.setRestSeconds };
    } else if (hasRunning || input.coachEdit || input.runningPrescription !== null) return { ok: false, code: "RUNNING_AUTHORITY" };
    return await runInAmbientTransaction(async () => {
      const catalog = await listComposerCatalog(DEFAULT_OWNER_ID);
      const validation = validateComposition(input.composition, { catalog, ownerId: DEFAULT_OWNER_ID, requestText: claims.requestText,
        edited: true, runningAvailable: runningData !== null, unprescribedRunningAvailable: !!claims.unprescribedRunning, runningSourceTexts: claims.runningSourceTexts });
      if (!validation.ok) return { ok: false as const, code: validation.code };
      const duration = calculateMenuDuration(input.composition, finalRunningForDuration,
        claims.requestedTimeSeconds ?? claims.context.availableTimeSeconds ?? null, input.durationPlan);
      if (duration.orphanPlanBlockIds.length) return { ok: false as const, code: "INVALID_DURATION_PLAN" };
      if (duration.blocks.some(block => block.underallocated)) return { ok: false as const, code: "DURATION_UNDERSIZED_SLOT" };
      const proposedItems = claims.proposal.blocks.flatMap((block) => block.items);
      for (const item of input.composition.blocks.flatMap((block) => block.items)) {
        if (item.type === "CATALOG_EXERCISE" && !claims.allowedExerciseIds.includes(item.exerciseId)) return { ok: false as const, code: "INVALID_EXERCISE" };
        const original = proposedItems.find((row) => row.id === item.id);
        if (item.type === "UNPRESCRIBED_RUNNING") {
          if (original?.type !== "UNPRESCRIBED_RUNNING" || !claims.unprescribedRunning ||
              item.reasonCode !== claims.unprescribedRunning.reasonCode || item.reasonMessage !== claims.unprescribedRunning.reasonMessage ||
              item.reasonCode !== original.reasonCode || item.reasonMessage !== original.reasonMessage) return { ok: false as const, code: "RUNNING_AUTHORITY" };
        } else if (original?.type === "UNPRESCRIBED_RUNNING") return { ok: false as const, code: "RUNNING_AUTHORITY" };
        if (original?.type === "FREEFORM" && item.type === "FREEFORM" && original.originalUserInstruction !== item.originalUserInstruction) return { ok: false as const, code: "USER_INSTRUCTION_CHANGED" };
      }
      const data = input.composition.blocks.map((block, sortOrder) => ({ name: block.name, sortOrder,
        items: block.items.map((item, itemOrder) => item.type === "RUNNING_POLICY" ? {
          sortOrder: itemOrder, exerciseId: null, displayName: "走", prescriptionKind: RUNNING_MENU_PRESCRIPTION_KIND,
          ...runningData!, note: item.plannedNote || null, rationale: null,
        } : item.type === "UNPRESCRIBED_RUNNING" ? {
          sortOrder: itemOrder, exerciseId: null, displayName: "走（Engine未処方）", prescriptionKind: UNPRESCRIBED_RUNNING_KIND,
          sets: item.plannedSets, reps: item.plannedReps, distanceMeters: item.plannedDistanceMeters,
          restSeconds: item.plannedRestSeconds, intensityPercent: item.plannedIntensityPercent, durationSeconds: item.plannedDurationSeconds,
          note: item.plannedNote || null, rationale: item.reasonMessage,
          prescriptionJson: canonicalStringify({ kind: "UNPRESCRIBED_RUNNING", schemaVersion: 1, reasonCode: item.reasonCode, reasonMessage: item.reasonMessage }),
          provenanceJson: canonicalStringify({ schemaVersion: 1, source: "UNPRESCRIBED_RUNNING_DRAFT", doseAuthority: "USER_ONLY", engineApproved: false }),
        } : {
          sortOrder: itemOrder, exerciseId: item.type === "CATALOG_EXERCISE" ? item.exerciseId : null,
          displayName: item.displayName, prescriptionKind: "LEGACY", ...exercisePlanValues(item),
          note: exercisePlanNote(item), rationale: item.reason || null,
          provenanceJson: canonicalStringify({ schemaVersion: 1, source: "CONFIRMED_MENU_COMPOSITION", itemType: item.type,
            requestDigest: sha256Utf8Hex(claims.requestText), aiProposal: proposedItems.find((row) => row.id === item.id) ?? null }),
        }),
      }));
      const digest = sha256Utf8Hex(canonicalStringify({ name: input.menuName, composition: input.composition, runningPrescription: input.runningPrescription, coachEdit: input.coachEdit, durationPlan: input.durationPlan }));
      const marker = { kind: "MENU_COMPOSITION" as const, schemaVersion: 1 as const, confirmedPlanDigest: digest, requestedTimeSeconds: claims.requestedTimeSeconds ?? claims.context.availableTimeSeconds ?? null,
        overview: claims.overview, athleteLabel: claims.athleteLabel };
      const prior = await prisma.menuTemplate.findUnique({ where: { id: claims.menuId } });
      if (prior) return prior.ownerId === DEFAULT_OWNER_ID && parseConfirmedCompositionContext(prior.runningContextJson)?.confirmedPlanDigest === digest
        ? { ok: true as const, menuId: prior.id, alreadySaved: true } : { ok: false as const, code: "STALE_PREVIEW" };
      const created = await prisma.menuTemplate.create({ data: { id: claims.menuId, ownerId: DEFAULT_OWNER_ID, name: input.menuName, status: "DRAFT", runningContextJson: canonicalStringify(marker),
        purpose: claims.overview?.objective, description: claims.overview?.approach,
        blocks: { create: data.map((block) => ({ ...block, items: { create: block.items } })) } }, include: { blocks: { orderBy: { sortOrder: "asc" } } } });
      if (input.durationPlan) {
        const persistedPlan = { ...input.durationPlan, blocks: input.durationPlan.blocks.map(row => ({ ...row,
          blockId: created.blocks[input.composition.blocks.findIndex(block => block.id === row.blockId)].id })) };
        await prisma.menuTemplate.update({ where: { id: created.id }, data: { runningContextJson: canonicalStringify({ ...marker, durationPlan: persistedPlan }) } });
      }
      return { ok: true as const, menuId: claims.menuId, alreadySaved: false };
    }, { timeoutMs: 60000 });
  } catch { return { ok: false, code: "SAVE_FAILED" }; }
}
