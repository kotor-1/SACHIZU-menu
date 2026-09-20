import { describe, expect, it } from "vitest";
import { worseSafetyOutcome } from "@/domain/running/monitoring/safety";
import { readStartedExecutionState, terminalSummaryFor } from "@/domain/running/persistence/executionState";
import { validRepLog } from "../../repository/running/readiness-fixtures";
import { SAFETY_OUTCOMES, type SafetyOutcome } from "@/domain/running/types/readiness";

const readiness = JSON.stringify({ schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false });
const rawLog = (action: ReturnType<typeof validRepLog>["action"]) => JSON.stringify([{ ...validRepLog(), action }]);

describe("R11-B3 execution persistence semantics", () => {
  it("uses SR-A terminal MonitorAction summaries only", () => {
    expect(["CONTINUE", "EXTEND_REST", "END_SET", "COACH_REVIEW"].map((a) => terminalSummaryFor(a as never))).toEqual([null, null, null, null]);
    expect(terminalSummaryFor("END_SESSION_QUALITY")).toBe("END_SESSION_QUALITY");
    expect(terminalSummaryFor("STOP_SAFETY")).toBe("STOP_SAFETY");
  });

  it("implements all 16 SO-B monotonic merge combinations", () => {
    const rank: Record<SafetyOutcome, number> = { NONE: 0, COACH_REVIEW: 1, STOP: 2, MEDICAL_EVALUATION_RECOMMENDED: 3 };
    for (const existing of SAFETY_OUTCOMES) for (const incoming of SAFETY_OUTCOMES) {
      const expected = rank[incoming] > rank[existing] ? incoming : existing;
      expect(worseSafetyOutcome(existing, incoming), `${existing} + ${incoming}`).toBe(expected);
    }
  });

  it("reconstructs terminal, pause, and valid started execution independently of the B2 pair", () => {
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "COACH_REVIEW", actualRepLogJson: rawLog("CONTINUE"), stopReason: null })).toMatchObject({ kind: "READY", safetyOutcome: "COACH_REVIEW" });
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "NONE", actualRepLogJson: rawLog("COACH_REVIEW"), stopReason: null })).toMatchObject({
      kind: "COACH_REVIEW_ACK_REQUIRED", readinessState: { executionGate: "YES" }, safetyOutcome: "NONE", logs: [{ action: "COACH_REVIEW" }],
    });
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "NONE", actualRepLogJson: rawLog("END_SESSION_QUALITY"), stopReason: null })).toMatchObject({
      kind: "TERMINAL", terminalAction: "END_SESSION_QUALITY", readinessState: { executionGate: "YES" }, safetyOutcome: "NONE", logs: [{ action: "END_SESSION_QUALITY" }],
    });
  });

  it("fails closed for legacy STOP, unknown summaries, and summary/log conflicts", () => {
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "STOP", actualRepLogJson: rawLog("CONTINUE"), stopReason: null }).kind).toBe("LEGACY_SAFETY_STOP");
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "NONE", actualRepLogJson: rawLog("CONTINUE"), stopReason: "TIMING_FAIL" }).kind).toBe("UNREADABLE");
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "NONE", actualRepLogJson: rawLog("CONTINUE"), stopReason: "STOP_SAFETY" }).kind).toBe("UNREADABLE");
    const endedSet = validRepLog();
    const illegalSameSet = { ...validRepLog(), repIndex: 2 };
    expect(readStartedExecutionState({ readinessActionsJson: readiness, safetyOutcome: "NONE", actualRepLogJson: JSON.stringify([{ ...endedSet, action: "END_SET" }, illegalSameSet]), stopReason: null }).kind).toBe("UNREADABLE");
  });
});
