import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { editableCompositionSchema, exercisePlanNote, exercisePlanValues, validateComposition, type ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { parseConfirmedCompositionContext } from "@/domain/menu-composition/saved-context";
import { trainingAnnotationsSchema, trainingProposalSavedStateSchema } from "@/domain/training-proposal/contracts";
import { assessExerciseEligibility } from "@/domain/training-proposal/eligibility";
import { assessTrainingComposition } from "@/domain/training-proposal/quality";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { buildStructuredRunningPreview, runningSpaceRequirement } from "@/application/training-proposal/running";
import { applyRunningCoachEdit, runningCoachEditRequestSchema, type RunningCoachEditRequest } from "@/application/running-menu/coach-edit";
import { finalRunningMenuPrescription, runningMenuEnvelopeSchema, serializeRunningMenuEnvelope, serializeRunningMenuEnvelopeV2, type RunningMenuFinalPrescription } from "@/application/running-menu/persistence";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { verifyTrainingProposalToken, type TrainingProposalClaims } from "@/infra/training-proposal/preview-token";
import { HMAC_TOKEN_MAX_LENGTH } from "@/infra/security/hmac-token";

const failure = (code: string, message = "保存内容を確認できませんでした。条件と提案を確認してください。") => ({ ok: false as const, code, message });
const equal = (left: unknown, right: unknown) => left === right || (left !== undefined && right !== undefined && canonicalStringify(left) === canonicalStringify(right));
export const saveTrainingProposalSchema = z.object({
  previewToken: z.string().min(1).max(HMAC_TOKEN_MAX_LENGTH),
  menuName: z.string().trim().min(1).max(120), composition: editableCompositionSchema,
  selectedItemIds: z.array(z.string().min(1).max(80)).min(1).max(50), annotations: trainingAnnotationsSchema,
  runningPrescription: z.unknown(), coachEdit: runningCoachEditRequestSchema.optional(),
}).strict();
export type SaveTrainingProposalResult = { ok: true; menuId: string; alreadySaved: boolean } | ReturnType<typeof failure>;
export type TrainingRunningEditResult = {
  ok: true; base: RunningPrescription; finalPrescription: RunningMenuFinalPrescription;
  prescriptionJson: string; provenanceJson: string;
} | ReturnType<typeof failure>;

/** The signed Engine base stays immutable. Human changes use the existing audited envelope. */
export function evaluateTrainingRunningEdit(claims: TrainingProposalClaims, coachEdit?: RunningCoachEditRequest, at = new Date()): TrainingRunningEditResult {
  const current = buildStructuredRunningPreview(claims.conditions);
  if (current.running?.status !== "READY" || !claims.runningPrescription
    || !equal(current.running.prescription, claims.runningPrescription)) {
    return failure("RUNNING_AUTHORITY", "条件に対応する走処方を確認できません。条件から提案を作り直してください。");
  }
  const base = current.running.prescription;
  const provenanceJson = canonicalStringify({ schemaVersion: 1, source: "SIGNED_RUNNING_PREVIEW",
    requestDigest: sha256Utf8Hex(current.requestText), intent: current.intent, context: current.context });
  const envelope = runningMenuEnvelopeSchema.parse({ kind: "RUNNING_POLICY", schemaVersion: 1,
    policyVersion: base.policyVersion, policyHash: base.policyHash, prescription: base });
  if (coachEdit) {
    // The existing science editor allows explicit human overrides. This proposal flow
    // keeps the selected environmental/safety conditions authoritative as well.
    if (coachEdit.distanceMeters !== undefined && coachEdit.distanceMeters !== base.distanceMeters
      || coachEdit.totalReps !== undefined && coachEdit.totalReps > base.totalReps
      || coachEdit.repRestSeconds !== undefined && (base.repRestSeconds === null || coachEdit.repRestSeconds < base.repRestSeconds)
      || coachEdit.executionInstructionText !== undefined && coachEdit.executionInstructionText !== base.executionInstructionText
      || coachEdit.coachTargetTimeSeconds !== undefined && coachEdit.coachTargetTimeSeconds !== base.coachTargetTimeSeconds
      || coachEdit.coachTargetTimeRange !== undefined && !equal(coachEdit.coachTargetTimeRange, base.coachTargetTimeRange)
      || coachEdit.setReps !== undefined && !equal(coachEdit.setReps, base.setReps)
      || coachEdit.setRestSeconds !== undefined && (base.setRestSeconds === null || coachEdit.setRestSeconds === null || coachEdit.setRestSeconds < base.setRestSeconds)) {
      return failure("COACH_EDIT_SAFETY", "この提案では本数の削減と休息の延長だけを受け付けます。距離・強度・セット構造を変える場合は条件から確認してください。");
    }
  }
  const edited = coachEdit ? applyRunningCoachEdit(envelope, provenanceJson, coachEdit, at.toISOString()) : null;
  if (edited && !edited.ok) return failure(edited.code, "走の編集量が既存の処方条件に合いません。編集値を確認してください。");
  const finalPrescription = edited?.ok ? edited.envelope.finalPrescription : finalRunningMenuPrescription(envelope);
  if (claims.conditions.environment.straightMeters === null || runningSpaceRequirement({
    distanceMeters: finalPrescription.distanceMeters, science: base.science }).requiredMeters > claims.conditions.environment.straightMeters) {
    return failure("RUNNING_SPACE", "選択した直線距離では走処方と減速に必要な場所を確保できません。");
  }
  return { ok: true, base, finalPrescription, provenanceJson,
    prescriptionJson: edited?.ok ? serializeRunningMenuEnvelopeV2(edited.envelope) : serializeRunningMenuEnvelope(base) };
}

export async function saveTrainingProposal(rawInput: unknown, deps: {
  db: PrismaClient; ownerId: string; signingKey: string;
  catalog?: () => Promise<ComposerCatalogExercise[]>; now?: () => Date;
}): Promise<SaveTrainingProposalResult> {
  const parsed = saveTrainingProposalSchema.safeParse(rawInput);
  if (!parsed.success) return failure("INVALID_PLAN");
  const input = parsed.data;
  try {
    const at = deps.now?.() ?? new Date();
    const claims = verifyTrainingProposalToken(input.previewToken, deps.signingKey, at.getTime());
    if (!claims || claims.ownerId !== deps.ownerId) return failure("STALE_PREVIEW");
    const allItems = input.composition.blocks.flatMap(block => block.items);
    const ids = new Set(allItems.map(item => item.id));
    const allIds = input.composition.blocks.flatMap(block => [block.id, ...block.items.map(item => item.id)]);
    const selection = new Set(input.selectedItemIds);
    if (ids.size !== allItems.length || new Set(allIds).size !== allIds.length || allItems.length > 50 || selection.size !== input.selectedItemIds.length
      || input.selectedItemIds.some(id => !ids.has(id))) return failure("INVALID_SELECTION");
    const originals = new Map(claims.proposal.blocks.flatMap(block => block.items).map(item => [item.id, item]));
    for (const item of allItems) {
      const original = originals.get(item.id);
      if (item.type === "FREEFORM" || item.type === "UNPRESCRIBED_RUNNING"
        || original?.type === "RUNNING_POLICY" && item.type !== "RUNNING_POLICY"
        || item.type === "RUNNING_POLICY" && original?.type !== "RUNNING_POLICY") return failure("CANDIDATE_TAMPER");
      if (item.type === "CATALOG_EXERCISE" && !claims.allowedExerciseIds.includes(item.exerciseId)) return failure("INVALID_EXERCISE");
      if (item.type === "CATALOG_EXERCISE" && !input.annotations[item.id]) return failure("ANNOTATION_MISSING");
      if (item.type === "RUNNING_POLICY" && !equal(input.annotations[item.id], claims.annotations[item.id])) return failure("RUNNING_TAMPER");
    }
    if (Object.keys(input.annotations).some(id => !ids.has(id))) return failure("INVALID_ANNOTATION");
    const running = claims.runningPrescription ? evaluateTrainingRunningEdit(claims, input.coachEdit, at) : null;
    if (running && !running.ok) return running;
    if (!running && (input.coachEdit || input.runningPrescription !== null || allItems.some(item => item.type === "RUNNING_POLICY"))) return failure("RUNNING_AUTHORITY");
    // The UI always echoes the original Engine base; coachEdit is a separate audited request.
    const expectedEcho = running?.ok ? running.base : null;
    if (!equal(input.runningPrescription, expectedEcho)) return failure("RUNNING_TAMPER");
    const selectedComposition = { blocks: input.composition.blocks.map(block => ({ ...block,
      items: block.items.filter(item => selection.has(item.id)) })) };
    const adopted = { blocks: selectedComposition.blocks.filter(block => block.items.length > 0) };
    const current = buildStructuredRunningPreview(claims.conditions);
    const catalog = await (deps.catalog?.() ?? listComposerCatalog(deps.ownerId));
    const validation = validateComposition(adopted, { catalog, ownerId: deps.ownerId, requestText: current.requestText,
      edited: true, runningAvailable: running?.ok === true });
    if (!validation.ok) return failure(validation.code);
    for (const item of adopted.blocks.flatMap(block => block.items)) {
      if (item.type !== "CATALOG_EXERCISE") continue;
      const exercise = catalog.find(row => row.id === item.exerciseId);
      if (!exercise || !assessExerciseEligibility(exercise, claims.conditions).eligible) return failure("EXERCISE_INELIGIBLE");
    }
    const qualityIssues = assessTrainingComposition(selectedComposition, input.annotations, claims.conditions, catalog, { proposal: false });
    if (qualityIssues.length) return failure(qualityIssues[0], "採用する種目の実施量・目的・条件を確認してください。");
    const digest = sha256Utf8Hex(canonicalStringify({ name: input.menuName, conditions: claims.conditions,
      composition: input.composition, selectedItemIds: input.selectedItemIds, annotations: input.annotations,
      runningPrescription: input.runningPrescription, coachEdit: input.coachEdit }));
    const state = trainingProposalSavedStateSchema.parse({ version: 1, conditions: claims.conditions,
      composition: input.composition, selectedItemIds: input.selectedItemIds, annotations: input.annotations,
      runningPrescription: claims.runningPrescription, runningStatusReason: claims.runningStatusReason,
      messages: claims.messages, quality: claims.quality, revision: digest,
      ...(input.coachEdit ? { coachEdit: input.coachEdit } : {}) });
    const marker = { kind: "MENU_COMPOSITION", schemaVersion: 1, confirmedPlanDigest: digest, trainingProposal: state };
    const contextJson = canonicalStringify(marker);
    const data = adopted.blocks.map((block, sortOrder) => ({ name: block.name, sortOrder,
      items: { create: block.items.map((item, itemOrder): Prisma.MenuItemUncheckedCreateWithoutMenuBlockInput => {
        if (item.type === "RUNNING_POLICY" && running?.ok) {
          const p = running.finalPrescription;
          return { sortOrder: itemOrder, exerciseId: null, displayName: "走練習", prescriptionKind: "RUNNING_POLICY",
            prescriptionJson: running.prescriptionJson, provenanceJson: running.provenanceJson,
            distanceMeters: p.distanceMeters, reps: p.totalReps, sets: p.sets, restSeconds: p.repRestSeconds,
            setRestSeconds: p.setRestSeconds, note: item.plannedNote || null };
        }
        if (item.type !== "CATALOG_EXERCISE") throw new Error("UNSUPPORTED_ADOPTED_ITEM");
        const annotation = input.annotations[item.id];
        return { sortOrder: itemOrder, exerciseId: item.exerciseId, displayName: item.displayName,
          prescriptionKind: "LEGACY", ...exercisePlanValues(item),
          note: [exercisePlanNote(item), `強度：${annotation.intensity}`].filter(Boolean).join("\n"), rationale: item.reason || null,
          provenanceJson: canonicalStringify({ schemaVersion: 1, source: "CONFIRMED_TRAINING_PROPOSAL",
            candidateId: item.id, conditionsDigest: sha256Utf8Hex(canonicalStringify(claims.conditions)),
            aiProposal: originals.get(item.id), annotation }) };
      }) } }));
    return await deps.db.$transaction(async tx => {
      const selectedExerciseIds = adopted.blocks.flatMap(block => block.items).flatMap(item => item.type === "CATALOG_EXERCISE" ? [item.exerciseId] : []);
      const existing = await tx.exercise.findMany({ where: { id: { in: selectedExerciseIds }, ownerId: deps.ownerId, status: "REVIEWED" }, select: { id: true } });
      if (new Set(selectedExerciseIds).size !== existing.length) return failure("INVALID_EXERCISE");
      const prior = await tx.menuTemplate.findUnique({ where: { id: claims.menuId } });
      if (prior) {
        if (prior.ownerId !== deps.ownerId) return failure("STALE_PREVIEW");
        const priorContext = parseConfirmedCompositionContext(prior.runningContextJson);
        if (priorContext?.confirmedPlanDigest === digest) return { ok: true as const, menuId: prior.id, alreadySaved: true };
        if (!claims.revision || priorContext?.trainingProposal?.revision !== claims.revision) return failure("STALE_PREVIEW");
        const updated = await tx.menuTemplate.updateMany({ where: { id: prior.id, ownerId: deps.ownerId,
          runningContextJson: prior.runningContextJson, updatedAt: prior.updatedAt },
        data: { name: input.menuName, runningContextJson: contextJson, updatedAt: at } });
        if (updated.count !== 1) return failure("STALE_PREVIEW");
        // SessionItem snapshots are separate rows and are deliberately never updated.
        await tx.menuBlock.deleteMany({ where: { menuTemplateId: prior.id } });
        for (const block of data) await tx.menuBlock.create({ data: { ...block, menuTemplateId: prior.id } });
        return { ok: true as const, menuId: prior.id, alreadySaved: false };
      }
      if (claims.revision !== null) return failure("STALE_PREVIEW");
      await tx.menuTemplate.create({ data: { id: claims.menuId, ownerId: deps.ownerId, name: input.menuName,
        status: "DRAFT", runningContextJson: contextJson, blocks: { create: data } } });
      return { ok: true as const, menuId: claims.menuId, alreadySaved: false };
    }, { timeout: 60_000 });
  } catch { return failure("SAVE_FAILED", "保存できませんでした。保存済みの内容を確認してから、もう一度操作してください。"); }
}
