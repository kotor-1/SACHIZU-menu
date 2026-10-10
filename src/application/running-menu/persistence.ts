import { z } from "zod";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { RUNNING_DECISION_REASONS, type RunningPrescription } from "@/domain/running-policy/contracts";
import { runningSciencePrescriptionSchema } from "@/domain/running-policy/science-contracts";

export const RUNNING_MENU_PRESCRIPTION_KIND = "RUNNING_POLICY" as const;
export const RUNNING_MENU_PERSISTENCE_SCHEMA_VERSION = 1 as const;
export const RUNNING_MENU_COACH_EDIT_SCHEMA_VERSION = 2 as const;

export const runningMenuPrescriptionSchema = z.object({
  policyVersion: z.string().min(1),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  event: z.enum(["100m", "200m", "GENERAL"]),
  science: runningSciencePrescriptionSchema.optional(),
  distanceMeters: z.number().int().positive().max(2_147_483_647),
  totalReps: z.number().int().positive().max(2_147_483_647),
  totalDistanceMeters: z.number().int().positive().max(2_147_483_647),
  repsPosition: z.enum(["DEFAULT", "MIN"]),
  repRestSeconds: z.number().int().positive().max(2_147_483_647).nullable(),
  sets: z.number().int().positive().max(2_147_483_647),
  setReps: z.array(z.number().int().positive().max(2_147_483_647)).min(2).max(20).nullable(),
  setRestSeconds: z.number().int().positive().max(2_147_483_647).nullable(),
  intensityPresentation: z.literal("PLAIN_LANGUAGE"),
  executionInstructionText: z.string().max(300).nullable(),
  coachTargetTimeSeconds: z.number().positive().nullable(),
  coachTargetTimeRange: z.object({ minSeconds: z.number().positive(), maxSeconds: z.number().positive() }).strict().nullable(),
  loadReductionRequested: z.boolean(),
  repsReductionApplied: z.boolean(),
  minimumKnownRestSeconds: z.number().int().nonnegative().max(2_147_483_647),
  fullSessionTimeGuaranteed: z.literal(false),
  decisionReasons: z.array(z.enum(RUNNING_DECISION_REASONS)),
}).strict().superRefine((value, context) => {
  if (value.totalDistanceMeters !== value.distanceMeters * value.totalReps) context.addIssue({ code: "custom", path: ["totalDistanceMeters"], message: "total distance mismatch" });
  if (value.totalReps === 1 && value.repRestSeconds !== null) context.addIssue({ code: "custom", path: ["repRestSeconds"], message: "one rep has no interval" });
  if (value.totalReps > 1 && value.repRestSeconds === null) context.addIssue({ code: "custom", path: ["repRestSeconds"], message: "rep interval required" });
  if (value.setReps === null) {
    if (value.sets !== 1 || value.setRestSeconds !== null) context.addIssue({ code: "custom", path: ["setReps"], message: "unsplit prescription invalid" });
  } else if (value.sets !== value.setReps.length || value.setReps.reduce((sum, count) => sum + count, 0) !== value.totalReps || value.setRestSeconds === null) {
    context.addIssue({ code: "custom", path: ["setReps"], message: "split prescription invalid" });
  }
  if (value.coachTargetTimeRange !== null && value.coachTargetTimeRange.minSeconds > value.coachTargetTimeRange.maxSeconds) context.addIssue({ code: "custom", path: ["coachTargetTimeRange"], message: "target time range invalid" });
});

export const runningMenuEnvelopeSchema = z.object({
  kind: z.literal(RUNNING_MENU_PRESCRIPTION_KIND),
  schemaVersion: z.literal(RUNNING_MENU_PERSISTENCE_SCHEMA_VERSION),
  policyVersion: z.string().min(1),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  prescription: runningMenuPrescriptionSchema,
}).strict().superRefine((value, context) => {
  if (value.policyVersion !== value.prescription.policyVersion || value.policyHash !== value.prescription.policyHash) {
    context.addIssue({ code: "custom", path: ["prescription"], message: "policy identity mismatch" });
  }
});

export type RunningMenuEnvelope = z.infer<typeof runningMenuEnvelopeSchema>;

// v2 deliberately separates the Engine decision from the executable values.
// In particular, repsPosition and decisionReasons describe only the base.
export const runningMenuFinalPrescriptionSchema = z.object({
  policyVersion: z.string().min(1),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  event: z.enum(["100m", "200m", "GENERAL"]),
  science: runningSciencePrescriptionSchema.optional(),
  /** Original science metadata remains immutable; this marks edited executable values. */
  scienceManualEdited: z.boolean().optional(),
  distanceMeters: z.number().int().positive().max(2_147_483_647),
  totalReps: z.number().int().positive().max(2_147_483_647),
  totalDistanceMeters: z.number().int().positive().max(2_147_483_647),
  repRestSeconds: z.number().int().positive().max(2_147_483_647).nullable(),
  sets: z.number().int().positive().max(2_147_483_647),
  setReps: z.array(z.number().int().positive()).min(2).max(20).nullable(),
  setRestSeconds: z.number().int().positive().max(2_147_483_647).nullable(),
  intensityPresentation: z.literal("PLAIN_LANGUAGE"),
  executionInstructionText: z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f-\u009f<>]*$/u).nullable(),
  coachTargetTimeSeconds: z.number().finite().positive().nullable(),
  coachTargetTimeRange: z.object({ minSeconds: z.number().finite().positive(), maxSeconds: z.number().finite().positive() }).strict().nullable(),
  minimumKnownRestSeconds: z.number().int().nonnegative().max(2_147_483_647),
  fullSessionTimeGuaranteed: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.totalDistanceMeters !== value.distanceMeters * value.totalReps) context.addIssue({ code: "custom", path: ["totalDistanceMeters"], message: "total distance mismatch" });
  if ((value.totalReps === 1) !== (value.repRestSeconds === null)) context.addIssue({ code: "custom", path: ["repRestSeconds"], message: "rep interval mismatch" });
  if (value.setReps === null) {
    if (value.sets !== 1 || value.setRestSeconds !== null) context.addIssue({ code: "custom", path: ["setReps"], message: "unsplit prescription invalid" });
  } else if (value.sets !== value.setReps.length || value.setReps.reduce((sum, count) => sum + count, 0) !== value.totalReps || value.setRestSeconds === null) {
    context.addIssue({ code: "custom", path: ["setReps"], message: "split prescription invalid" });
  }
  if (value.coachTargetTimeSeconds !== null && value.coachTargetTimeRange !== null) context.addIssue({ code: "custom", path: ["coachTargetTimeRange"], message: "target time conflict" });
  if (value.coachTargetTimeRange !== null && value.coachTargetTimeRange.minSeconds > value.coachTargetTimeRange.maxSeconds) context.addIssue({ code: "custom", path: ["coachTargetTimeRange"], message: "target time range invalid" });
  const expectedRest = value.setReps === null
    ? (value.totalReps - 1) * (value.repRestSeconds ?? 0)
    : value.setReps.reduce((sum, reps) => sum + (reps - 1) * (value.repRestSeconds ?? 0), 0)
      + (value.setReps.length - 1) * (value.setRestSeconds ?? 0);
  if (value.minimumKnownRestSeconds !== expectedRest) context.addIssue({ code: "custom", path: ["minimumKnownRestSeconds"], message: "known rest mismatch" });
});

export const coachEditFieldSchema = z.enum([
  "distanceMeters", "totalReps", "repRestSeconds", "executionInstructionText",
  "coachTargetTimeSeconds", "coachTargetTimeRange", "setReps", "setRestSeconds",
]);
const editValueSchema = z.union([
  z.number().finite(), z.string().max(300), z.array(z.number().int().positive()).max(20),
  z.object({ minSeconds: z.number().finite().positive(), maxSeconds: z.number().finite().positive() }).strict(), z.null(),
]);
export const coachEditRecordSchema = z.object({
  field: coachEditFieldSchema,
  before: editValueSchema,
  after: editValueSchema,
  at: z.string().datetime(),
  actorClass: z.literal("COACH"),
}).strict();
export const runningMenuEnvelopeV2Schema = z.object({
  kind: z.literal(RUNNING_MENU_PRESCRIPTION_KIND),
  schemaVersion: z.literal(RUNNING_MENU_COACH_EDIT_SCHEMA_VERSION),
  policyVersion: z.string().min(1),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  basePrescription: runningMenuPrescriptionSchema,
  finalPrescription: runningMenuFinalPrescriptionSchema,
  coachEditProvenance: z.object({ edited: z.literal(true), edits: z.array(coachEditRecordSchema).min(1).max(100) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.policyVersion !== value.basePrescription.policyVersion || value.policyHash !== value.basePrescription.policyHash ||
      value.policyVersion !== value.finalPrescription.policyVersion || value.policyHash !== value.finalPrescription.policyHash ||
      value.basePrescription.event !== value.finalPrescription.event) {
    context.addIssue({ code: "custom", path: ["finalPrescription"], message: "base/final identity mismatch" });
  }
  if (canonicalStringify(value.basePrescription.science ?? null) !== canonicalStringify(value.finalPrescription.science ?? null)) {
    context.addIssue({ code: "custom", path: ["finalPrescription", "science"], message: "science default metadata is immutable" });
  }
  if (value.basePrescription.science !== undefined && value.finalPrescription.scienceManualEdited !== true) {
    context.addIssue({ code: "custom", path: ["finalPrescription", "scienceManualEdited"], message: "science coach edits must be marked" });
  }
  if (value.basePrescription.science === undefined && value.finalPrescription.scienceManualEdited === true) {
    context.addIssue({ code: "custom", path: ["finalPrescription", "scienceManualEdited"], message: "science edit marker requires science metadata" });
  }
  if (value.basePrescription.distanceMeters !== value.finalPrescription.distanceMeters
    && !value.coachEditProvenance.edits.some((edit) => edit.field === "distanceMeters")) {
    context.addIssue({ code: "custom", path: ["coachEditProvenance"], message: "distance change requires coach audit" });
  }
  if (value.basePrescription.science?.flyMeters && value.basePrescription.distanceMeters !== value.finalPrescription.distanceMeters
    && !value.coachEditProvenance.edits.some((edit) => edit.field === "executionInstructionText")) {
    context.addIssue({ code: "custom", path: ["coachEditProvenance"], message: "science distance change requires instruction audit" });
  }
  // Historical v2 readers must not compare against a future current Policy.
  // Range authorization happens at the server Coach Edit write boundary.
  for (const field of coachEditFieldSchema.options) {
    const edits = value.coachEditProvenance.edits.filter((entry) => entry.field === field);
    const base = value.basePrescription[field];
    const final = value.finalPrescription[field];
    let prior: unknown = base;
    for (const edit of edits) {
      if (value.basePrescription.science !== undefined && canonicalStringify(edit.before) !== canonicalStringify(prior)) {
        context.addIssue({ code: "custom", path: ["coachEditProvenance"], message: "science edit history is discontinuous" });
        break;
      }
      prior = edit.after;
    }
    if (edits.length > 0 && canonicalStringify(prior) !== canonicalStringify(final)) {
      context.addIssue({ code: "custom", path: ["coachEditProvenance"], message: "edit history does not match final value" });
    }
    if (edits.length === 0 && canonicalStringify(base) !== canonicalStringify(final)) {
      context.addIssue({ code: "custom", path: ["coachEditProvenance"], message: "unattributed final change" });
    }
  }
});
export type RunningMenuEnvelopeV2 = z.infer<typeof runningMenuEnvelopeV2Schema>;
export type RunningMenuFinalPrescription = z.infer<typeof runningMenuFinalPrescriptionSchema>;
export type ParsedRunningMenuEnvelope = RunningMenuEnvelope | (RunningMenuEnvelopeV2 & { prescription?: RunningMenuFinalPrescription });

export function finalRunningMenuPrescription(envelope: ParsedRunningMenuEnvelope): RunningMenuFinalPrescription {
  if (envelope.schemaVersion === 2) return envelope.finalPrescription;
  const p = envelope.prescription;
  return runningMenuFinalPrescriptionSchema.parse({
    policyVersion: p.policyVersion, policyHash: p.policyHash, event: p.event,
    ...(p.science ? { science: p.science } : {}),
    distanceMeters: p.distanceMeters, totalReps: p.totalReps,
    totalDistanceMeters: p.totalDistanceMeters, repRestSeconds: p.repRestSeconds,
    sets: p.sets, setReps: p.setReps, setRestSeconds: p.setRestSeconds,
    intensityPresentation: p.intensityPresentation,
    executionInstructionText: p.executionInstructionText,
    coachTargetTimeSeconds: p.coachTargetTimeSeconds,
    coachTargetTimeRange: p.coachTargetTimeRange,
    minimumKnownRestSeconds: p.minimumKnownRestSeconds,
    fullSessionTimeGuaranteed: p.fullSessionTimeGuaranteed,
  });
}

export function serializeRunningMenuEnvelopeV2(envelope: RunningMenuEnvelopeV2): string {
  return canonicalStringify(runningMenuEnvelopeV2Schema.parse(envelope));
}

export function runningPrescriptionFingerprint(prescription: RunningPrescription): string {
  return sha256Utf8Hex(canonicalStringify(prescription));
}

export function serializeRunningMenuEnvelope(prescription: RunningPrescription): string {
  const envelope = runningMenuEnvelopeSchema.parse({
    kind: RUNNING_MENU_PRESCRIPTION_KIND,
    schemaVersion: RUNNING_MENU_PERSISTENCE_SCHEMA_VERSION,
    policyVersion: prescription.policyVersion,
    policyHash: prescription.policyHash,
    prescription,
  });
  return canonicalStringify(envelope);
}

export function parseRunningMenuEnvelope(kind: string, json: string | null): ParsedRunningMenuEnvelope | null {
  if (kind !== RUNNING_MENU_PRESCRIPTION_KIND || json === null || json.length > 32_768) return null;
  try {
    const raw: unknown = JSON.parse(json);
    const v1 = runningMenuEnvelopeSchema.safeParse(raw);
    if (v1.success) return v1.data;
    const v2 = runningMenuEnvelopeV2Schema.safeParse(raw);
    return v2.success ? { ...v2.data, prescription: v2.data.finalPrescription } : null;
  } catch {
    return null;
  }
}

export function presentRunningMenuSnapshot(kind: string, json: string | null):
  | { status: "NOT_RUNNING_POLICY" }
  | { status: "UNREADABLE"; title: string }
  | { status: "OK"; title: string; restText: string | null; instruction: string | null; coachEdited: boolean; targetTimeText: string | null; setText: string | null;
      science: RunningMenuFinalPrescription["science"] | null; scienceManualEdited: boolean } {
  if (kind !== RUNNING_MENU_PRESCRIPTION_KIND) return { status: "NOT_RUNNING_POLICY" };
  const snapshot = parseRunningMenuEnvelope(kind, json);
  if (snapshot === null) return { status: "UNREADABLE", title: "走る練習の処方を読み込めません" };
  const p = finalRunningMenuPrescription(snapshot);
  return {
    status: "OK",
    title: `${p.distanceMeters}m × ${p.totalReps}本`,
    restText: p.repRestSeconds === null ? null : `1本ごとの休憩 ${p.repRestSeconds / 60}分`,
    instruction: p.executionInstructionText,
    coachEdited: snapshot.schemaVersion === 2,
    science: p.science ?? null,
    scienceManualEdited: p.scienceManualEdited ?? false,
    targetTimeText: p.coachTargetTimeRange !== null
      ? `目標タイム ${p.coachTargetTimeRange.minSeconds}〜${p.coachTargetTimeRange.maxSeconds}秒`
      : p.coachTargetTimeSeconds !== null ? `目標タイム ${p.coachTargetTimeSeconds}秒` : null,
    setText: p.setReps === null ? null : `${p.setReps.join("本 + ")}本／セット間休憩 ${p.setRestSeconds! / 60}分`,
  };
}
