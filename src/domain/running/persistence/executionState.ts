/** R11-B3 persisted execution-state interpretation. Contains no monitoring policy. */
import { z } from "zod";
import { parseJsonColumn } from "./jsonColumn";
import { readRepLog, runtimeCoachReviewIdentityOf, sameRuntimeCoachReviewIdentity } from "./repLog";
import { readinessExecutionStateV1Schema, readinessJsonSizeIssue } from "../readiness/execution";
import { safetyOutcomeSchema, type SafetyOutcome } from "../types/readiness";
import type { MonitorAction } from "../types/monitoring";

export const terminalMonitorActionSchema = z.enum(["END_SESSION_QUALITY", "STOP_SAFETY"]);
export type TerminalMonitorAction = z.infer<typeof terminalMonitorActionSchema>;

export function terminalSummaryFor(action: MonitorAction): TerminalMonitorAction | null {
  return terminalMonitorActionSchema.safeParse(action).success ? action as TerminalMonitorAction : null;
}

export type StartedExecutionStateReadResult =
  | { kind: "UNREADABLE" }
  | { kind: "LEGACY_SAFETY_STOP" }
  | {
      kind: "TERMINAL";
      terminalAction: TerminalMonitorAction;
      readinessState: z.infer<typeof readinessExecutionStateV1Schema>;
      safetyOutcome: SafetyOutcome;
      logs: Exclude<ReturnType<typeof readRepLog>, { kind: "UNREADABLE" }>["state"]["reps"];
    }
  | {
      kind: "COACH_REVIEW_ACK_REQUIRED";
      readinessState: z.infer<typeof readinessExecutionStateV1Schema>;
      safetyOutcome: SafetyOutcome;
      logs: Exclude<ReturnType<typeof readRepLog>, { kind: "UNREADABLE" }>["state"]["reps"];
    }
  | {
      kind: "READY";
      readinessState: z.infer<typeof readinessExecutionStateV1Schema>;
      safetyOutcome: SafetyOutcome;
      logs: Exclude<ReturnType<typeof readRepLog>, { kind: "UNREADABLE" }>["state"]["reps"];
      latestAction: MonitorAction;
    };

/**
 * Started execution deliberately does not use the B2 readiness pair schema: the
 * lifecycle safety summary may legitimately be stronger than the initial gate.
 */
export function readStartedExecutionState(input: {
  readinessActionsJson: string | null;
  safetyOutcome: unknown;
  actualRepLogJson: string | null;
  stopReason: string | null;
}): StartedExecutionStateReadResult {
  const logsRead = readRepLog(input.actualRepLogJson);
  if (logsRead.kind === "UNREADABLE" || logsRead.state.reps.length === 0) return { kind: "UNREADABLE" };
  const logs = logsRead.state.reps;
  const acknowledgements = logsRead.state.coachReviewAcknowledgements;
  const isAcknowledged = (index: number) => acknowledgements.some((ack) =>
    sameRuntimeCoachReviewIdentity(ack.review, runtimeCoachReviewIdentityOf(logs[index])));

  if (input.readinessActionsJson === null || readinessJsonSizeIssue(input.readinessActionsJson)) return { kind: "UNREADABLE" };
  const readiness = parseJsonColumn(input.readinessActionsJson, readinessExecutionStateV1Schema, { rejectHealthKeys: true });
  const safety = safetyOutcomeSchema.safeParse(input.safetyOutcome);
  if (!readiness.ok || !safety.success) return { kind: "UNREADABLE" };
  if (safety.data === "STOP") return { kind: "LEGACY_SAFETY_STOP" };

  const summary = input.stopReason === null ? null : terminalMonitorActionSchema.safeParse(input.stopReason);
  if (summary !== null && !summary.success) return { kind: "UNREADABLE" };

  const terminalIndexes = logs
    .map((log, index) => terminalMonitorActionSchema.safeParse(log.action).success ? index : -1)
    .filter((index) => index >= 0);
  const lastIndex = logs.length - 1;
  if (terminalIndexes.some((index) => index !== lastIndex)) return { kind: "UNREADABLE" };
  for (let index = 0; index < lastIndex; index += 1) {
    const current = logs[index];
    const next = logs[index + 1];
    if (current.action === "COACH_REVIEW" && !isAcknowledged(index)) return { kind: "UNREADABLE" };
    if (current.action === "END_SET" && next.setIndex <= current.setIndex) return { kind: "UNREADABLE" };
  }
  const last = logs[lastIndex];
  const terminalLog = terminalMonitorActionSchema.safeParse(last.action);
  if (summary !== null && (!terminalLog.success || terminalLog.data !== summary.data)) return { kind: "UNREADABLE" };
  if (terminalLog.success) return {
    kind: "TERMINAL", terminalAction: terminalLog.data, readinessState: readiness.value, safetyOutcome: safety.data, logs,
  };
  if (last.action === "COACH_REVIEW" && !isAcknowledged(lastIndex)) return {
    kind: "COACH_REVIEW_ACK_REQUIRED", readinessState: readiness.value, safetyOutcome: safety.data, logs,
  };
  return {
    kind: "READY",
    readinessState: readiness.value,
    safetyOutcome: safety.data,
    logs,
    latestAction: last.action,
  };
}
