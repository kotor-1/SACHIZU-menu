import { describe, expect, it } from "vitest";
import { monitorRunningPrescription, type RepLogEntry } from "@/domain/running/monitoring";
import { findForbiddenHealthKeys } from "@/domain/running/persistence/limits";
import { actualRepLogStateV1Schema, runtimeCoachReviewIdentityOf } from "@/domain/running/persistence/repLog";
import {
  EXECUTION_CONFIDENCE_LABEL_JA,
  EXECUTION_DATA_SOURCE_LABEL_JA,
  EXECUTION_TIMING_LABEL_JA,
  SESSION_EXECUTION_LABEL_COVERAGE,
  presentRunningSessionExecution,
  type SessionExecutionItemInput,
} from "@/presentation/running/session-execution";
import { planAcc, planStride, planTi } from "../../repository/running/fixtures";

const yes = JSON.stringify({ schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false });
const no = JSON.stringify({ schemaVersion: 1, actions: ["CANCEL_HIGH_INTENSITY"], executionGate: "NO", swapRecommended: false });
const coach = JSON.stringify({ schemaVersion: 1, actions: ["REQUIRE_COACH_REVIEW"], executionGate: "REQUIRES_COACH_DECISION", swapRecommended: false });
const at = "2026-09-20T00:00:00.000Z";

function item(overrides: Partial<SessionExecutionItemInput> = {}): SessionExecutionItemInput {
  return {
    id: "item-1",
    exerciseNameSnapshot: "保存済み走処方",
    prescriptionKind: "RUNNING_V2",
    plannedPrescriptionJson: JSON.stringify(planStride()),
    plannedProvenanceJson: null,
    plannedRationale: "保存時の根拠",
    readinessActionsJson: yes,
    actualRepLogJson: null,
    actualHighSpeedExposureJson: null,
    stopReason: null,
    safetyOutcome: "NONE",
    ...overrides,
  };
}

function dto(overrides: Partial<SessionExecutionItemInput> = {}, sessionStatus = "IN_PROGRESS") {
  const result = presentRunningSessionExecution({ sessionStatus, item: item(overrides) });
  if (result === null) throw new Error("expected running DTO");
  return result;
}

function envelope(reps: RepLogEntry[], acknowledgements: { review: ReturnType<typeof runtimeCoachReviewIdentityOf>; acknowledgedAt: string }[] = []) {
  return JSON.stringify(actualRepLogStateV1Schema.parse({ schemaVersion: 1, reps, coachReviewAcknowledgements: acknowledgements }));
}

describe("R11-B4B2 Session execution DTO", () => {
  it.each([
    [null, null, "NOT_EVALUATED", true, false],
    [yes, "NONE", "READY", true, true],
    [no, "NONE", "BLOCKED", true, false],
    [coach, "COACH_REVIEW", "COACH_DECISION_REQUIRED", true, false],
    [JSON.stringify(["NO_CHANGE"]), "NONE", "REEVALUATION_REQUIRED", true, false],
    ["{bad", "NONE", "UNREADABLE", false, false],
  ])("presents not-started readiness %# without changing its gate", (readinessActionsJson, safetyOutcome, state, canSubmitReadiness, canRecordRep) => {
    const result = dto({ readinessActionsJson, safetyOutcome });
    expect(result.readiness.state).toBe(state);
    expect(result.execution.state).toBe("NOT_STARTED");
    expect(result.capabilities).toEqual({ canSubmitReadiness, canRecordRep, canAcknowledgeCoachReview: false });
  });

  it.each([
    ["{bad", "NONE"],
    [JSON.stringify({ schemaVersion: 2, actions: [], executionGate: "YES", swapRecommended: false }), "NONE"],
    [JSON.stringify({ schemaVersion: 1, actions: ["UNKNOWN"], executionGate: "YES", swapRecommended: false }), "NONE"],
    [yes, "COACH_REVIEW"],
  ])("fails closed for unreadable readiness %#", (readinessActionsJson, safetyOutcome) => {
    const result = dto({ readinessActionsJson, safetyOutcome });
    expect(result.readiness.state).toBe("UNREADABLE");
    expect(result.capabilities).toEqual({ canSubmitReadiness: false, canRecordRep: false, canAcknowledgeCoachReview: false });
  });

  it("presents started execution with progress, latest monitor, exposure, and cumulative safety", () => {
    const p = planAcc();
    const decision = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 4.5, timing: "HAND", restTakenS: 90 });
    const exposure = { lower: 12, upper: 13, unit: "m", source: "MEASURED", confidence: "HIGH" } as const;
    const result = dto({
      plannedPrescriptionJson: JSON.stringify(p),
      actualRepLogJson: envelope([decision.logEntry]),
      actualHighSpeedExposureJson: JSON.stringify(exposure),
      safetyOutcome: "COACH_REVIEW",
    });
    expect(result.execution.state).toBe("READY_FOR_NEXT_REP");
    expect(result.readiness.state).toBe("READY");
    expect(result.progress).toMatchObject({ completedRepCount: 1, plannedRepCount: p.sets.value * p.repsPerSet.value });
    expect(result.latestMonitor).toMatchObject({ setIndex: 1, repIndex: 1, timingLabel: "手動計時", nextRepRestS: null });
    expect(result.exposure).toMatchObject({ state: "READY", sourceLabel: "実測", confidenceLabel: "信頼度 高" });
    expect(result.safety).toMatchObject({ state: "READY", outcomeInternal: "COACH_REVIEW" });
    expect(result.capabilities).toMatchObject({ canSubmitReadiness: false, canRecordRep: true });
  });

  it("distinguishes END_SET from item terminal", () => {
    const p = planTi();
    const slow = p.intensity.target!.upper! + 1;
    const first = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: slow, timing: "HAND" }).logEntry;
    const second = monitorRunningPrescription({ prescription: p, priorLogs: [first] }, { setIndex: 1, repIndex: 2, timeS: slow, timing: "HAND" }).logEntry;
    expect(second.action).toBe("END_SET");
    const result = dto({ plannedPrescriptionJson: JSON.stringify(p), actualRepLogJson: envelope([first, second]) });
    expect(result.execution).toMatchObject({ state: "END_SET", terminalKindInternal: null });
    expect(result.capabilities.canRecordRep).toBe(true);
  });

  it("exposes only the latest unresolved review and removes it after exact acknowledgement", () => {
    const p = planStride();
    const first = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 13, timing: "HAND", coachJudgment: { effortBecameMaximal: true } }).logEntry;
    const firstIdentity = runtimeCoachReviewIdentityOf(first);
    let result = dto({ actualRepLogJson: envelope([first]) });
    expect(result.execution.state).toBe("COACH_REVIEW_ACK_REQUIRED");
    expect(result.pendingCoachReview).toMatchObject({ reviewIdentity: firstIdentity, occurredAtRep: { setIndex: 1, repIndex: 1 } });
    expect(result.capabilities).toMatchObject({ canRecordRep: false, canAcknowledgeCoachReview: true });

    result = dto({ actualRepLogJson: envelope([first], [{ review: firstIdentity, acknowledgedAt: at }]) });
    expect(result.execution.state).toBe("READY_FOR_NEXT_REP");
    expect(result.pendingCoachReview).toBeNull();
    expect(result.capabilities.canRecordRep).toBe(true);

    const second = monitorRunningPrescription({ prescription: p, priorLogs: [first] }, { setIndex: 1, repIndex: 2, timeS: 13, timing: "HAND", coachJudgment: { effortBecameMaximal: true } }).logEntry;
    result = dto({ actualRepLogJson: envelope([first, second], [{ review: firstIdentity, acknowledgedAt: at }]) });
    expect(result.pendingCoachReview?.reviewIdentity).toEqual(runtimeCoachReviewIdentityOf(second));
    expect(result.capabilities).toMatchObject({ canRecordRep: false, canAcknowledgeCoachReview: true });
  });

  it.each(["END_SESSION_QUALITY", "STOP_SAFETY"] as const)("presents %s as terminal without raw enum text", (action) => {
    const p = planStride();
    const base = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 13, timing: "HAND" }).logEntry;
    const terminal = { ...base, action };
    const result = dto({ actualRepLogJson: envelope([terminal]), stopReason: action });
    expect(result.execution).toMatchObject({ state: "TERMINAL", terminalKindInternal: action });
    expect(result.execution.message).not.toContain(action);
    expect(result.capabilities).toEqual({ canSubmitReadiness: false, canRecordRep: false, canAcknowledgeCoachReview: false });
  });

  it.each([
    ["{bad", null],
    [JSON.stringify({ schemaVersion: 99 }), null],
    [null, "STOP_SAFETY"],
  ])("fails closed for corrupt or inconsistent execution state %#", (actualRepLogJson, stopReason) => {
    const overrides: Partial<SessionExecutionItemInput> = actualRepLogJson === null
      ? { plannedPrescriptionJson: "{bad", actualRepLogJson, stopReason }
      : { actualRepLogJson, stopReason };
    const result = dto(overrides);
    expect(result.execution.state).toBe("UNREADABLE");
    expect(result.capabilities).toEqual({ canSubmitReadiness: false, canRecordRep: false, canAcknowledgeCoachReview: false });
  });

  it("fails closed for a terminal summary/log conflict", () => {
    const p = planStride();
    const rep = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 13, timing: "HAND" }).logEntry;
    expect(dto({ actualRepLogJson: envelope([rep]), stopReason: "STOP_SAFETY" }).execution.state).toBe("UNREADABLE");
  });

  it("is JSON-safe and excludes raw columns and health keys", () => {
    const result = dto();
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(findForbiddenHealthKeys(result)).toEqual([]);
    const raw = JSON.stringify(result);
    for (const key of [
      "plannedPrescriptionJson", "plannedProvenanceJson", "actualRepLogJson", "readinessActionsJson",
      "athleteReport", "readinessReport", "pain", "painRegion", "redFlag", "soreness", "fatigue",
      "sleep", "reporter", "reportedAt",
    ]) {
      expect(raw).not.toContain(`\"${key}\"`);
    }
  });

  it("returns null for legacy items and disables every capability for inactive sessions", () => {
    expect(presentRunningSessionExecution({ sessionStatus: "IN_PROGRESS", item: item({ prescriptionKind: "LEGACY" }) })).toBeNull();
    expect(dto({}, "COMPLETED").capabilities).toEqual({ canSubmitReadiness: false, canRecordRep: false, canAcknowledgeCoachReview: false });
    expect(dto({}, "CANCELLED").capabilities).toEqual({ canSubmitReadiness: false, canRecordRep: false, canAcknowledgeCoachReview: false });
  });

  it("covers timing, source, and confidence labels without raw-code labels", () => {
    for (const code of SESSION_EXECUTION_LABEL_COVERAGE.timingMethods) expect(EXECUTION_TIMING_LABEL_JA[code]).not.toBe(code);
    for (const code of SESSION_EXECUTION_LABEL_COVERAGE.dataSources) expect(EXECUTION_DATA_SOURCE_LABEL_JA[code]).not.toBe(code);
    for (const code of SESSION_EXECUTION_LABEL_COVERAGE.confidences) expect(EXECUTION_CONFIDENCE_LABEL_JA[code]).not.toBe(code);
  });
});
