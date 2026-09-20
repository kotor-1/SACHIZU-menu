/** R11-B3: snapshot-only RepObservation -> monitor -> guarded execution persistence. */
import { z } from "zod";
import { monitorRunningPrescription } from "@/domain/running/monitoring";
import { monitorStateSchema, repObservationSchema, type RepLogEntry } from "@/domain/running/monitoring/schema";
import { worseSafetyOutcome } from "@/domain/running/monitoring/safety";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { findForbiddenHealthKeys } from "@/domain/running/persistence/limits";
import { actualRepLogStateV1Schema, readRepLog, serializeActualRepLogStateV1 } from "@/domain/running/persistence/repLog";
import { readStartedExecutionState, terminalSummaryFor } from "@/domain/running/persistence/executionState";
import { readReadinessExecutionState } from "@/domain/running/readiness/execution";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";
import type { SafetyOutcome } from "@/domain/running/types/readiness";
import { applySessionExecutionResult, findSessionItemForExecution } from "@/infra/repositories/session-repository";
import { presentMonitorDecision } from "@/presentation/running/execution";

export const sessionRepInputSchema = z.object({
  sessionItemId: z.string().min(1),
  repObservation: repObservationSchema,
}).strict();

export type SessionExecutionRejectionCode =
  | "INVALID_INPUT" | "SESSION_ITEM_NOT_FOUND" | "NOT_RUNNING_V2" | "SESSION_NOT_EXECUTABLE" | "SESSION_NOT_ACTIVE"
  | "SNAPSHOT_UNREADABLE" | "REP_LOG_UNREADABLE" | "EXECUTION_STATE_UNREADABLE"
  | "READINESS_REQUIRED" | "READINESS_REEVALUATION_REQUIRED" | "READINESS_BLOCKED" | "READINESS_COACH_DECISION_REQUIRED"
  | "COACH_REVIEW_ACK_REQUIRED" | "REP_ALREADY_RECORDED" | "REP_LOG_TOO_LARGE"
  | "EXECUTION_ALREADY_STOPPED" | "SET_ALREADY_ENDED" | "EXECUTION_STATE_STALE";

export class SessionExecutionError extends Error {
  constructor(readonly code: SessionExecutionRejectionCode) { super(code); this.name = "SessionExecutionError"; }
}
function reject(code: SessionExecutionRejectionCode): never { throw new SessionExecutionError(code); }

export async function recordSessionRep(rawInput: unknown) {
  const parsedInput = sessionRepInputSchema.safeParse(rawInput);
  if (!parsedInput.success) reject("INVALID_INPUT");
  const { sessionItemId, repObservation } = parsedInput.data;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const item = await findSessionItemForExecution(sessionItemId);
    if (item === null) reject("SESSION_ITEM_NOT_FOUND");
    if (item.prescriptionKind !== "RUNNING_V2") reject("NOT_RUNNING_V2");
    if (item.trainingSession.sessionKind !== "TRAINING") reject("SESSION_NOT_EXECUTABLE");
    if (item.trainingSession.status !== "PLANNED" && item.trainingSession.status !== "IN_PROGRESS") reject("SESSION_NOT_ACTIVE");

    const prescriptionRead = parseJsonColumn(item.plannedPrescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
    if (!prescriptionRead.ok) reject("SNAPSHOT_UNREADABLE");
    const logsRead = readRepLog(item.actualRepLogJson);
    if (logsRead.kind === "UNREADABLE") reject("REP_LOG_UNREADABLE");
    const prescription = prescriptionRead.value;
    const priorLogs = logsRead.state.reps;
    if (!monitorStateSchema.safeParse({ prescription, priorLogs }).success) reject("REP_LOG_UNREADABLE");

    let existingSafetyOutcome: SafetyOutcome;
    if (priorLogs.length === 0) {
      if (item.stopReason !== null) reject("EXECUTION_STATE_UNREADABLE");
      const readiness = readReadinessExecutionState(item.readinessActionsJson, item.safetyOutcome);
      if (readiness.kind === "NOT_EVALUATED") reject("READINESS_REQUIRED");
      if (readiness.kind === "LEGACY_UNVERSIONED") reject("READINESS_REEVALUATION_REQUIRED");
      if (readiness.kind === "UNREADABLE") reject("EXECUTION_STATE_UNREADABLE");
      if (readiness.executionDirective.executionGate === "NO") reject("READINESS_BLOCKED");
      if (readiness.executionDirective.executionGate === "REQUIRES_COACH_DECISION") reject("READINESS_COACH_DECISION_REQUIRED");
      existingSafetyOutcome = readiness.safetyOutcome;
    } else {
      const execution = readStartedExecutionState({
        readinessActionsJson: item.readinessActionsJson,
        safetyOutcome: item.safetyOutcome,
        actualRepLogJson: item.actualRepLogJson,
        stopReason: item.stopReason,
      });
      if (execution.kind === "LEGACY_SAFETY_STOP" || execution.kind === "UNREADABLE") reject("EXECUTION_STATE_UNREADABLE");
      if (execution.kind === "TERMINAL") reject("EXECUTION_ALREADY_STOPPED");
      if (execution.kind === "COACH_REVIEW_ACK_REQUIRED") reject("COACH_REVIEW_ACK_REQUIRED");
      existingSafetyOutcome = execution.safetyOutcome;
      const latest = priorLogs[priorLogs.length - 1];
      if (latest.action === "END_SET" && repObservation.setIndex === latest.setIndex) reject("SET_ALREADY_ENDED");
    }

    if (priorLogs.some((log) => log.stopPolicyId === prescription.stopPolicyId
      && log.setIndex === repObservation.setIndex && log.repIndex === repObservation.repIndex)) {
      reject("REP_ALREADY_RECORDED");
    }

    let decision: ReturnType<typeof monitorRunningPrescription>;
    try {
      decision = monitorRunningPrescription({ prescription, priorLogs }, repObservation);
    } catch {
      reject("INVALID_INPUT");
    }
    const nextLogs: RepLogEntry[] = [...priorLogs, decision.logEntry];
    if (!monitorStateSchema.safeParse({ prescription, priorLogs: nextLogs }).success) reject("EXECUTION_STATE_UNREADABLE");
    const nextExecutionLogState = actualRepLogStateV1Schema.safeParse({
      schemaVersion: 1,
      reps: nextLogs,
      coachReviewAcknowledgements: logsRead.state.coachReviewAcknowledgements,
    });
    if (!nextExecutionLogState.success) reject("EXECUTION_STATE_UNREADABLE");
    try {
      serializeActualRepLogStateV1(nextExecutionLogState.data);
    } catch (error) {
      if (error instanceof Error && error.message === "Execution log is too large") reject("REP_LOG_TOO_LARGE");
      reject("EXECUTION_STATE_UNREADABLE");
    }
    if (findForbiddenHealthKeys(nextExecutionLogState.data).length > 0 || findForbiddenHealthKeys(decision.cumulativeHighSpeedExposureM).length > 0) {
      reject("EXECUTION_STATE_UNREADABLE");
    }

    const write = await applySessionExecutionResult({
      sessionItemId: item.id,
      trainingSessionId: item.trainingSessionId,
      expected: {
        sessionStatus: item.trainingSession.status,
        prescriptionKind: item.prescriptionKind,
        plannedPrescriptionJson: item.plannedPrescriptionJson,
        actualRepLogJson: item.actualRepLogJson,
        readinessActionsJson: item.readinessActionsJson,
        safetyOutcome: item.safetyOutcome,
        stopReason: item.stopReason,
      },
      next: {
        executionLogState: nextExecutionLogState.data,
        cumulativeHighSpeedExposureM: decision.cumulativeHighSpeedExposureM,
        stopReason: terminalSummaryFor(decision.action),
        safetyOutcome: worseSafetyOutcome(existingSafetyOutcome, decision.safetyOutcome),
      },
    });
    if (write.kind === "SESSION_NOT_EXECUTABLE") reject("SESSION_NOT_EXECUTABLE");
    if (write.kind === "SESSION_CLOSED") reject("SESSION_NOT_ACTIVE");
    if (write.kind === "STALE") {
      if (attempt === 0) continue;
      reject("EXECUTION_STATE_STALE");
    }
    return {
      sessionId: item.trainingSessionId,
      sessionItemId: item.id,
      monitor: presentMonitorDecision(decision),
    };
  }
  reject("EXECUTION_STATE_STALE");
}

export type SessionRepRecord = Awaited<ReturnType<typeof recordSessionRep>>;
