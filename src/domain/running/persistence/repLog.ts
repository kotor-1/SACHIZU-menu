/** Read-only execution-start guard; does not record or modify rep logs. */
import { z } from "zod";
import { repLogEntrySchema } from "../monitoring/schema";
import { isoDateTimeSchema, stopPolicyIdSchema } from "../types/primitives";
import { parseJsonColumn } from "./jsonColumn";
import { actualRepLogJsonByteLimitIssue, findForbiddenHealthKeys } from "./limits";

const positiveIndexSchema = z.number().int().min(1);

export const runtimeCoachReviewIdentitySchema = z.object({
  stopPolicyId: stopPolicyIdSchema,
  setIndex: positiveIndexSchema,
  repIndex: positiveIndexSchema,
}).strict();
export type RuntimeCoachReviewIdentity = z.infer<typeof runtimeCoachReviewIdentitySchema>;

export const runtimeCoachReviewAcknowledgementSchema = z.object({
  review: runtimeCoachReviewIdentitySchema,
  acknowledgedAt: isoDateTimeSchema,
}).strict();
export type RuntimeCoachReviewAcknowledgement = z.infer<typeof runtimeCoachReviewAcknowledgementSchema>;

const identityKey = (identity: RuntimeCoachReviewIdentity) => `${identity.stopPolicyId}\u0000${identity.setIndex}\u0000${identity.repIndex}`;
export function runtimeCoachReviewIdentityOf(rep: z.infer<typeof repLogEntrySchema>): RuntimeCoachReviewIdentity {
  return { stopPolicyId: rep.stopPolicyId, setIndex: rep.setIndex, repIndex: rep.repIndex };
}
export function sameRuntimeCoachReviewIdentity(a: RuntimeCoachReviewIdentity, b: RuntimeCoachReviewIdentity): boolean {
  return identityKey(a) === identityKey(b);
}

export const actualRepLogStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  reps: z.array(repLogEntrySchema),
  coachReviewAcknowledgements: z.array(runtimeCoachReviewAcknowledgementSchema),
}).strict().superRefine((state, ctx) => {
  const repKeys = new Map<string, z.infer<typeof repLogEntrySchema>>();
  state.reps.forEach((rep, index) => {
    const key = identityKey(runtimeCoachReviewIdentityOf(rep));
    if (repKeys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reps", index], message: "rep identity must be unique" });
    repKeys.set(key, rep);
    const previous = state.reps[index - 1];
    if (previous && (previous.setIndex > rep.setIndex || (previous.setIndex === rep.setIndex && previous.repIndex >= rep.repIndex))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reps", index], message: "reps must be ordered" });
    }
  });
  const ackKeys = new Set<string>();
  state.coachReviewAcknowledgements.forEach((ack, index) => {
    const key = identityKey(ack.review);
    if (ackKeys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coachReviewAcknowledgements", index], message: "ack identity must be unique" });
    ackKeys.add(key);
    const target = repKeys.get(key);
    if (!target || target.action !== "COACH_REVIEW") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coachReviewAcknowledgements", index, "review"], message: "ack must reference a COACH_REVIEW rep" });
    }
  });
});
export type ActualRepLogStateV1 = z.infer<typeof actualRepLogStateV1Schema>;

export type RepLogReadResult =
  | { kind: "READY"; format: "LEGACY_ARRAY" | "V1"; state: ActualRepLogStateV1 }
  | { kind: "UNREADABLE" };

/** Raw persisted log reader. Never replaces corrupt history with an empty array. */
export function readRepLog(raw: string | null): RepLogReadResult {
  if (raw === null) return { kind: "READY", format: "LEGACY_ARRAY", state: { schemaVersion: 1, reps: [], coachReviewAcknowledgements: [] } };
  if (actualRepLogJsonByteLimitIssue(raw)) return { kind: "UNREADABLE" };
  const parsed = parseJsonColumn(raw, z.union([z.array(repLogEntrySchema), actualRepLogStateV1Schema]), { rejectHealthKeys: true });
  if (!parsed.ok) return { kind: "UNREADABLE" };
  if (Array.isArray(parsed.value)) {
    return { kind: "READY", format: "LEGACY_ARRAY", state: { schemaVersion: 1, reps: parsed.value, coachReviewAcknowledgements: [] } };
  }
  return { kind: "READY", format: "V1", state: parsed.value };
}

/** Canonical B4 writer. Every successful write uses the v1 envelope. */
export function serializeActualRepLogStateV1(state: ActualRepLogStateV1): string {
  const parsed = actualRepLogStateV1Schema.parse(state);
  if (findForbiddenHealthKeys(parsed).length > 0) throw new Error("Execution log contains health data");
  const raw = JSON.stringify(parsed);
  if (actualRepLogJsonByteLimitIssue(raw)) throw new Error("Execution log is too large");
  return raw;
}

export function readRepLogStartState(raw: string | null): "NOT_STARTED" | "STARTED" | "UNREADABLE" {
  const read = readRepLog(raw);
  return read.kind === "UNREADABLE" ? "UNREADABLE" : read.state.reps.length > 0 ? "STARTED" : "NOT_STARTED";
}
