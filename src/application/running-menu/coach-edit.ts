import { z } from "zod";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import { planRunningPrescription } from "@/domain/running-policy/engine";
import { phaseAPolicyFor, RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import {
  coachEditFieldSchema,
  finalRunningMenuPrescription,
  runningMenuEnvelopeV2Schema,
  runningMenuFinalPrescriptionSchema,
  RUNNING_MENU_COACH_EDIT_SCHEMA_VERSION,
  RUNNING_MENU_PRESCRIPTION_KIND,
  type ParsedRunningMenuEnvelope,
  type RunningMenuEnvelopeV2,
  type RunningMenuFinalPrescription,
} from "./persistence";

export const runningCoachEditRequestSchema = z.object({
  distanceMeters: z.number().int().positive().optional(),
  totalReps: z.number().int().positive().optional(),
  repRestSeconds: z.number().int().positive().optional(),
  executionInstructionText: z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f-\u009f<>]*$/u).nullable().optional(),
  coachTargetTimeSeconds: z.number().finite().positive().nullable().optional(),
  coachTargetTimeRange: z.object({ minSeconds: z.number().finite().positive(), maxSeconds: z.number().finite().positive() }).strict().nullable().optional(),
  setReps: z.array(z.number().int().positive()).min(2).max(20).nullable().optional(),
  setRestSeconds: z.number().int().positive().max(2_147_483_647).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "empty edit");
export type RunningCoachEditRequest = z.infer<typeof runningCoachEditRequestSchema>;

const initialProvenanceSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal("SIGNED_RUNNING_PREVIEW"),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  intent: z.object({
    event: z.object({ value: z.enum(["100m", "200m"]) }).passthrough().nullable(),
    ageGroup: z.object({ value: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"]) }).passthrough().nullable(),
    loadReductionRequested: z.object({ value: z.literal(true) }).passthrough().nullable(),
    fatigueState: z.object({ value: z.enum(["REPORTED", "STRONG_OR_UNWELL"]) }).passthrough().nullable(),
    availableTimeSeconds: z.object({ value: z.number().int().positive() }).passthrough().nullable(),
  }).passthrough(),
  context: z.object({
    event: z.enum(["100m", "200m"]).optional(),
    ageGroup: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"]).optional(),
    availableTimeSeconds: z.number().int().positive().optional(),
  }).passthrough(),
}).strict();

export type RunningCoachEditFailure = "INVALID_ITEM" | "POLICY_MISMATCH" | "RANGE_OUTSIDE" |
  "DISTANCE_REVIEW_REQUIRED" | "TIME_ADJUSTMENT_REQUIRED" | "INVALID_EDIT" | "NO_CHANGE";
export type RunningCoachEditResult =
  | { ok: true; envelope: RunningMenuEnvelopeV2 }
  | { ok: false; code: RunningCoachEditFailure };

function finalFromBase(base: RunningPrescription): RunningMenuFinalPrescription {
  return runningMenuFinalPrescriptionSchema.parse({
    policyVersion: base.policyVersion, policyHash: base.policyHash, event: base.event,
    distanceMeters: base.distanceMeters, totalReps: base.totalReps,
    totalDistanceMeters: base.totalDistanceMeters, repRestSeconds: base.repRestSeconds,
    sets: base.sets, setReps: base.setReps, setRestSeconds: base.setRestSeconds,
    intensityPresentation: base.intensityPresentation,
    executionInstructionText: base.executionInstructionText,
    coachTargetTimeSeconds: base.coachTargetTimeSeconds,
    coachTargetTimeRange: base.coachTargetTimeRange,
    minimumKnownRestSeconds: base.minimumKnownRestSeconds,
    fullSessionTimeGuaranteed: base.fullSessionTimeGuaranteed,
  });
}

function knownRest(p: RunningMenuFinalPrescription): number {
  if (p.setReps === null) return (p.totalReps - 1) * (p.repRestSeconds ?? 0);
  return p.setReps.reduce((sum, count) => sum + (count - 1) * (p.repRestSeconds ?? 0), 0)
    + (p.setReps.length - 1) * (p.setRestSeconds ?? 0);
}

/** Pure edit validation. The caller must supply only a DB-read envelope/provenance. */
export function applyRunningCoachEdit(
  envelope: ParsedRunningMenuEnvelope,
  provenanceJson: string | null,
  requested: unknown,
  editedAt: string,
): RunningCoachEditResult {
  const parsed = runningCoachEditRequestSchema.safeParse(requested);
  if (!parsed.success || !Number.isFinite(Date.parse(editedAt))) return { ok: false, code: "INVALID_EDIT" };
  if (envelope.policyVersion !== RUNNING_POLICY_VERSION || envelope.policyHash !== RUNNING_POLICY_HASH) return { ok: false, code: "POLICY_MISMATCH" };
  let provenance: z.infer<typeof initialProvenanceSchema>;
  try {
    provenance = initialProvenanceSchema.parse(JSON.parse(provenanceJson ?? "null"));
  } catch {
    return { ok: false, code: "INVALID_ITEM" };
  }
  const edit = parsed.data;
  const previous = finalRunningMenuPrescription(envelope);
  let base = envelope.schemaVersion === 1 ? envelope.prescription : envelope.basePrescription;
  let final = { ...previous };

  if (edit.distanceMeters !== undefined && edit.distanceMeters !== previous.distanceMeters) {
    const event = provenance.intent.event?.value ?? provenance.context.event;
    const ageGroup = provenance.intent.ageGroup?.value ?? provenance.context.ageGroup ?? "UNKNOWN";
    if (event !== previous.event || ageGroup === "UNKNOWN") return { ok: false, code: "INVALID_ITEM" };
    const planned = planRunningPrescription({
      event, ageGroup, humanExplicitDistances: [edit.distanceMeters],
      loadReductionRequested: provenance.intent.loadReductionRequested?.value ?? false,
      fatigueState: provenance.intent.fatigueState?.value ?? "NONE",
      availableTimeSeconds: provenance.intent.availableTimeSeconds?.value ?? provenance.context.availableTimeSeconds,
      similarDistanceHistoryStatus: "UNKNOWN", coachAgeGateApproval: false,
    });
    if (planned.status !== "READY") return { ok: false, code: planned.status === "NEEDS_TIME_ADJUSTMENT" ? "TIME_ADJUSTMENT_REQUIRED" : "DISTANCE_REVIEW_REQUIRED" };
    base = planned.prescription;
    final = finalFromBase(base);
    // A target for the former distance and its set organization cannot carry over.
    // Plain-language execution text may carry over unless the coach changes it.
    final.executionInstructionText = previous.executionInstructionText;
  }

  if (edit.totalReps !== undefined) final.totalReps = edit.totalReps;
  if (edit.repRestSeconds !== undefined) final.repRestSeconds = edit.repRestSeconds;
  if (edit.executionInstructionText !== undefined) final.executionInstructionText = edit.executionInstructionText;
  if (edit.coachTargetTimeSeconds !== undefined) {
    final.coachTargetTimeSeconds = edit.coachTargetTimeSeconds;
    if (edit.coachTargetTimeSeconds !== null) final.coachTargetTimeRange = null;
  }
  if (edit.coachTargetTimeRange !== undefined) {
    final.coachTargetTimeRange = edit.coachTargetTimeRange;
    if (edit.coachTargetTimeRange !== null) final.coachTargetTimeSeconds = null;
  }
  if (edit.setReps !== undefined) {
    final.setReps = edit.setReps;
    final.sets = edit.setReps?.length ?? 1;
    if (edit.setReps === null) final.setRestSeconds = null;
  }
  if (edit.setRestSeconds !== undefined) final.setRestSeconds = edit.setRestSeconds;
  if (final.totalReps === 1 && edit.repRestSeconds !== undefined) return { ok: false, code: "INVALID_EDIT" };
  if (final.totalReps === 1) final.repRestSeconds = null;
  if (final.totalReps > 1 && final.repRestSeconds === null) {
    const policy = phaseAPolicyFor(final.distanceMeters);
    final.repRestSeconds = policy?.defaultRepRestSeconds ?? null;
  }
  const policy = phaseAPolicyFor(final.distanceMeters);
  if (policy === null) return { ok: false, code: "DISTANCE_REVIEW_REQUIRED" };
  if (final.totalReps < policy.minReps || final.totalReps > policy.maxReps ||
      (final.totalReps > 1 && (final.repRestSeconds === null || final.repRestSeconds < policy.repRestMinSeconds || final.repRestSeconds > policy.repRestMaxSeconds))) {
    return { ok: false, code: "RANGE_OUTSIDE" };
  }
  final.totalDistanceMeters = final.distanceMeters * final.totalReps;
  final.minimumKnownRestSeconds = knownRest(final);
  const availableTimeSeconds = provenance.intent.availableTimeSeconds?.value ?? provenance.context.availableTimeSeconds;
  if (availableTimeSeconds !== undefined && availableTimeSeconds <= final.minimumKnownRestSeconds) return { ok: false, code: "TIME_ADJUSTMENT_REQUIRED" };
  const validFinal = runningMenuFinalPrescriptionSchema.safeParse(final);
  if (!validFinal.success) return { ok: false, code: "INVALID_EDIT" };

  const fields = coachEditFieldSchema.options;
  const changes = fields.filter((field) => canonicalStringify(previous[field]) !== canonicalStringify(validFinal.data[field]))
    .map((field) => ({
      field, before: previous[field], after: validFinal.data[field], at: editedAt, actorClass: "COACH" as const,
    }));
  if (changes.length === 0) return { ok: false, code: "NO_CHANGE" };
  const previousEdits = envelope.schemaVersion === 2 ? envelope.coachEditProvenance.edits : [];
  if (previousEdits.length + changes.length > 100) return { ok: false, code: "INVALID_EDIT" };
  const output = runningMenuEnvelopeV2Schema.safeParse({
    kind: RUNNING_MENU_PRESCRIPTION_KIND,
    schemaVersion: RUNNING_MENU_COACH_EDIT_SCHEMA_VERSION,
    policyVersion: RUNNING_POLICY_VERSION,
    policyHash: RUNNING_POLICY_HASH,
    basePrescription: base,
    finalPrescription: validFinal.data,
    coachEditProvenance: { edited: true, edits: [...previousEdits, ...changes] },
  });
  return output.success && canonicalStringify(output.data).length <= 24_000
    ? { ok: true, envelope: output.data } : { ok: false, code: "INVALID_EDIT" };
}
