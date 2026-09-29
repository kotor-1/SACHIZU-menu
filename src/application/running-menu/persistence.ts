import { z } from "zod";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { RUNNING_DECISION_REASONS, type RunningPrescription } from "@/domain/running-policy/contracts";

export const RUNNING_MENU_PRESCRIPTION_KIND = "RUNNING_POLICY" as const;
export const RUNNING_MENU_PERSISTENCE_SCHEMA_VERSION = 1 as const;

export const runningMenuPrescriptionSchema = z.object({
  policyVersion: z.string().min(1),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  event: z.enum(["100m", "200m"]),
  distanceMeters: z.number().int().positive(),
  totalReps: z.number().int().positive(),
  totalDistanceMeters: z.number().int().positive(),
  repsPosition: z.enum(["DEFAULT", "MIN"]),
  repRestSeconds: z.number().int().positive().nullable(),
  sets: z.number().int().positive(),
  setReps: z.array(z.number().int().positive()).min(2).nullable(),
  setRestSeconds: z.number().int().positive().nullable(),
  intensityPresentation: z.literal("PLAIN_LANGUAGE"),
  executionInstructionText: z.string().max(300).nullable(),
  coachTargetTimeSeconds: z.number().positive().nullable(),
  coachTargetTimeRange: z.object({ minSeconds: z.number().positive(), maxSeconds: z.number().positive() }).strict().nullable(),
  loadReductionRequested: z.boolean(),
  repsReductionApplied: z.boolean(),
  minimumKnownRestSeconds: z.number().int().nonnegative(),
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

export function parseRunningMenuEnvelope(kind: string, json: string | null): RunningMenuEnvelope | null {
  if (kind !== RUNNING_MENU_PRESCRIPTION_KIND || json === null || json.length > 32_768) return null;
  try {
    const parsed = runningMenuEnvelopeSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function presentRunningMenuSnapshot(kind: string, json: string | null):
  | { status: "NOT_RUNNING_POLICY" }
  | { status: "UNREADABLE"; title: string }
  | { status: "OK"; title: string; restText: string | null; instruction: string | null } {
  if (kind !== RUNNING_MENU_PRESCRIPTION_KIND) return { status: "NOT_RUNNING_POLICY" };
  const snapshot = parseRunningMenuEnvelope(kind, json);
  if (snapshot === null) return { status: "UNREADABLE", title: "走る練習の処方を読み込めません" };
  const p = snapshot.prescription;
  return {
    status: "OK",
    title: `${p.distanceMeters}m × ${p.totalReps}本`,
    restText: p.repRestSeconds === null ? null : `1本ごとの休憩 ${p.repRestSeconds / 60}分`,
    instruction: p.executionInstructionText,
  };
}
