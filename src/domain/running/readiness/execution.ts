/** R11-B2: versioned item-local execution state, not a snapshot of the R5 assessment. */
import { z } from "zod";
import { parseJsonColumn } from "../persistence/jsonColumn";
import { jsonByteLimitIssue, PRESCRIPTION_JSON_MAX_BYTES } from "../persistence/limits";
import type { RuleSet } from "../rules/schema";
import { READINESS_ACTION_CODES, readinessActionCodeSchema, safetyOutcomeSchema } from "../types/readiness";
import { normalizeReadinessActions, readinessDecisionSchema, type ReadinessDecision } from "./schema";
import { resolveReadinessApplication } from "./application";

export const readinessExecutionGateSchema = z.enum(["YES", "NO", "REQUIRES_COACH_DECISION"]);
export type ReadinessExecutionGate = z.infer<typeof readinessExecutionGateSchema>;
// STOP is a legacy enum, not an outcome produced by R5.
export const readinessSafetyOutcomeSchema = safetyOutcomeSchema.exclude(["STOP"]);
const actionsSchema = z.array(readinessActionCodeSchema).min(1).max(READINESS_ACTION_CODES.length).refine(
  (actions) => JSON.stringify(actions) === JSON.stringify(normalizeReadinessActions(actions)),
  "Readiness actions must be canonical",
);

export const readinessExecutionStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  actions: actionsSchema,
  executionGate: readinessExecutionGateSchema,
  swapRecommended: z.boolean(),
}).strict().superRefine((state, ctx) => {
  if (state.swapRecommended && (!state.actions.includes("SWAP_TO_LOWER_LOAD_METHOD") || state.executionGate !== "NO")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent swap directive" });
  }
  if (state.actions.includes("REQUIRE_COACH_REVIEW") && state.executionGate === "YES") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Review cannot be bypassed" });
  }
});
export type ReadinessExecutionStateV1 = z.infer<typeof readinessExecutionStateV1Schema>;

export const readinessPersistedStateSchema = z.object({
  readinessExecutionStateV1: readinessExecutionStateV1Schema,
  safetyOutcome: readinessSafetyOutcomeSchema,
}).strict().refine(
  (state) => state.safetyOutcome === "NONE" || state.readinessExecutionStateV1.executionGate !== "YES",
  "Safety outcome cannot be bypassed",
);

/** Evaluation only. Shared planning applicability/priority/KEEP_CURRENT logic; no override. */
export function projectReadinessExecutionState(decision: ReadinessDecision, ruleSet: RuleSet): ReadinessExecutionStateV1 {
  const readiness = readinessDecisionSchema.parse(decision);
  const application = resolveReadinessApplication({
    readiness, ruleSet, ...readiness.evaluatedFor, isCoach: true, canOverrideCancel: false,
  });
  const needsReview = application.reviewRequired || application.remaining.has("REQUIRE_COACH_REVIEW") || readiness.safetyOutcome !== "NONE";
  return readinessExecutionStateV1Schema.parse({
    schemaVersion: 1,
    actions: readiness.actions,
    executionGate: application.kind !== "PROCEED" ? "NO" : needsReview ? "REQUIRES_COACH_DECISION" : "YES",
    swapRecommended: application.swapRecommended,
  });
}

/** No loader and no method inference: reload uses only the persisted pair. */
export function deriveReadinessExecutionDirective(state: z.infer<typeof readinessPersistedStateSchema>) {
  const { readinessExecutionStateV1: value, safetyOutcome } = readinessPersistedStateSchema.parse(state);
  return {
    executionGate: value.executionGate,
    swapRecommended: value.swapRecommended,
    useLowerBound: value.actions.includes("USE_LOWER_BOUND"),
    increaseRest: value.actions.includes("INCREASE_REST"),
    coachReviewRequired: value.executionGate === "REQUIRES_COACH_DECISION" || value.actions.includes("REQUIRE_COACH_REVIEW") || safetyOutcome !== "NONE",
  };
}
export type ReadinessExecutionDirective = ReturnType<typeof deriveReadinessExecutionDirective>;

/** Uses the existing prescription JSON ceiling (UTF-8); strict v1 is much smaller. */
export function readinessJsonSizeIssue(raw: string): string | null {
  return jsonByteLimitIssue("readinessActionsJson", raw, PRESCRIPTION_JSON_MAX_BYTES);
}

export function readReadinessExecutionState(raw: string | null, safetyOutcome: unknown) {
  if (raw === null) return { kind: "NOT_EVALUATED" } as const;
  if (readinessJsonSizeIssue(raw)) return { kind: "UNREADABLE" } as const;
  const parsed = parseJsonColumn(raw, z.union([readinessExecutionStateV1Schema, actionsSchema]), { rejectHealthKeys: true });
  if (!parsed.ok || !readinessSafetyOutcomeSchema.safeParse(safetyOutcome).success) return { kind: "UNREADABLE" } as const;
  if (Array.isArray(parsed.value)) return { kind: "LEGACY_UNVERSIONED", actions: parsed.value } as const;
  const pair = readinessPersistedStateSchema.safeParse({ readinessExecutionStateV1: parsed.value, safetyOutcome });
  if (!pair.success) return { kind: "UNREADABLE" } as const;
  return { kind: "READY_V1", ...pair.data, executionDirective: deriveReadinessExecutionDirective(pair.data) } as const;
}
export type ReadinessExecutionReadResult = ReturnType<typeof readReadinessExecutionState>;
