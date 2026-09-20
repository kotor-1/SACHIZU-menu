import { describe, expect, it } from "vitest";
import {
  actualRepLogStateV1Schema,
  readRepLog,
  runtimeCoachReviewIdentityOf,
  sameRuntimeCoachReviewIdentity,
  serializeActualRepLogStateV1,
} from "@/domain/running/persistence/repLog";
import { readStartedExecutionState } from "@/domain/running/persistence/executionState";
import { stopPolicyIdSchema } from "@/domain/running/types/primitives";
import { validRepLog } from "../../repository/running/readiness-fixtures";

const readiness = JSON.stringify({ schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false });
const at = "2026-09-20T00:00:00.000Z";

describe("R11-B4B1 versioned actual rep-log state", () => {
  it("reads legacy arrays and v1 while failing closed for corrupt and future formats", () => {
    const rep = validRepLog();
    expect(readRepLog(JSON.stringify([rep]))).toMatchObject({ kind: "READY", format: "LEGACY_ARRAY", state: { reps: [rep], coachReviewAcknowledgements: [] } });
    const state = actualRepLogStateV1Schema.parse({ schemaVersion: 1, reps: [rep], coachReviewAcknowledgements: [] });
    expect(readRepLog(serializeActualRepLogStateV1(state))).toMatchObject({ kind: "READY", format: "V1", state });
    expect(readRepLog("{bad")).toEqual({ kind: "UNREADABLE" });
    expect(readRepLog(JSON.stringify({ schemaVersion: 99, reps: [rep], coachReviewAcknowledgements: [] }))).toEqual({ kind: "UNREADABLE" });
  });

  it("binds acknowledgement identity to stopPolicyId, setIndex, and repIndex", () => {
    const review = { ...validRepLog(), action: "COACH_REVIEW" as const };
    const identity = runtimeCoachReviewIdentityOf(review);
    expect(sameRuntimeCoachReviewIdentity(identity, { ...identity, repIndex: identity.repIndex + 1 })).toBe(false);
    expect(sameRuntimeCoachReviewIdentity(identity, { ...identity, setIndex: identity.setIndex + 1 })).toBe(false);
    expect(sameRuntimeCoachReviewIdentity(identity, { ...identity, stopPolicyId: stopPolicyIdSchema.parse("SP_STRIDE") })).toBe(false);
    expect(actualRepLogStateV1Schema.safeParse({ schemaVersion: 1, reps: [review], coachReviewAcknowledgements: [{ review: identity, acknowledgedAt: at }] }).success).toBe(true);
    expect(actualRepLogStateV1Schema.safeParse({ schemaVersion: 1, reps: [review], coachReviewAcknowledgements: [{ review: identity, acknowledgedAt: at }, { review: identity, acknowledgedAt: at }] }).success).toBe(false);
    expect(actualRepLogStateV1Schema.safeParse({ schemaVersion: 1, reps: [review], coachReviewAcknowledgements: [{ review: { ...identity, repIndex: 2 }, acknowledgedAt: at }] }).success).toBe(false);
    expect(actualRepLogStateV1Schema.safeParse({ schemaVersion: 1, reps: [validRepLog()], coachReviewAcknowledgements: [{ review: identity, acknowledgedAt: at }] }).success).toBe(false);
  });

  it("resolves only the exact review and rejects historical implicit acknowledgement", () => {
    const review = { ...validRepLog(), action: "COACH_REVIEW" as const };
    const next = { ...validRepLog(), repIndex: 2 };
    const acknowledged = JSON.stringify({ schemaVersion: 1, reps: [review, next], coachReviewAcknowledgements: [{ review: runtimeCoachReviewIdentityOf(review), acknowledgedAt: at }] });
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "NONE", actualRepLogJson: acknowledged, stopReason: null })).toMatchObject({ kind: "READY" });
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "NONE", actualRepLogJson: JSON.stringify([review, next]), stopReason: null })).toEqual({ kind: "UNREADABLE" });
    const secondReview = JSON.stringify({ schemaVersion: 1, reps: [review, { ...next, action: "COACH_REVIEW" }], coachReviewAcknowledgements: [{ review: runtimeCoachReviewIdentityOf(review), acknowledgedAt: at }] });
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "NONE", actualRepLogJson: secondReview, stopReason: null })).toMatchObject({
      kind: "COACH_REVIEW_ACK_REQUIRED",
      readinessState: { executionGate: "YES" },
      safetyOutcome: "NONE",
      logs: [{ repIndex: 1, action: "COACH_REVIEW" }, { repIndex: 2, action: "COACH_REVIEW" }],
    });
  });
});
