/** R11-B4B1: explicit, persistent acknowledgement of one runtime COACH_REVIEW. */
import { z } from "zod";
import { monitorStateSchema } from "@/domain/running/monitoring/schema";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { readStartedExecutionState } from "@/domain/running/persistence/executionState";
import {
  actualRepLogStateV1Schema,
  readRepLog,
  runtimeCoachReviewIdentityOf,
  runtimeCoachReviewIdentitySchema,
  sameRuntimeCoachReviewIdentity,
  serializeActualRepLogStateV1,
  type RuntimeCoachReviewIdentity,
} from "@/domain/running/persistence/repLog";
import { isoDateTimeSchema } from "@/domain/running/types/primitives";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";
import {
  applyRuntimeCoachReviewAcknowledgement,
  findSessionItemForExecution,
} from "@/infra/repositories/session-repository";

export const runtimeCoachReviewAckInputSchema = z.object({
  sessionItemId: z.string().min(1),
  reviewIdentity: runtimeCoachReviewIdentitySchema,
}).strict();

export type RuntimeCoachReviewAckRejectionCode =
  | "INVALID_INPUT"
  | "SESSION_ITEM_NOT_FOUND"
  | "NOT_RUNNING_V2"
  | "SESSION_NOT_EXECUTABLE"
  | "SESSION_NOT_ACTIVE"
  | "SNAPSHOT_UNREADABLE"
  | "EXECUTION_STATE_UNREADABLE"
  | "NO_COACH_REVIEW_PENDING"
  | "ACK_STATE_STALE"
  | "ACK_PAYLOAD_TOO_LARGE"
  | "EXECUTION_ALREADY_STOPPED";

export class RuntimeCoachReviewAckError extends Error {
  constructor(readonly code: RuntimeCoachReviewAckRejectionCode) {
    super(code);
    this.name = "RuntimeCoachReviewAckError";
  }
}

function reject(code: RuntimeCoachReviewAckRejectionCode): never {
  throw new RuntimeCoachReviewAckError(code);
}

export type RuntimeCoachReviewAckRecord = {
  sessionId: string;
  sessionItemId: string;
  reviewIdentity: RuntimeCoachReviewIdentity;
  acknowledgedAt: z.infer<typeof isoDateTimeSchema>;
};

export type RuntimeCoachReviewAckResult = {
  kind: "ACKNOWLEDGED" | "ALREADY_ACKNOWLEDGED";
  data: RuntimeCoachReviewAckRecord;
};

export async function acknowledgeRuntimeCoachReview(rawInput: unknown): Promise<RuntimeCoachReviewAckResult> {
  const parsedInput = runtimeCoachReviewAckInputSchema.safeParse(rawInput);
  if (!parsedInput.success) reject("INVALID_INPUT");
  const { sessionItemId, reviewIdentity } = parsedInput.data;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const item = await findSessionItemForExecution(sessionItemId);
    if (item === null) reject("SESSION_ITEM_NOT_FOUND");
    if (item.prescriptionKind !== "RUNNING_V2") reject("NOT_RUNNING_V2");
    if (item.trainingSession.sessionKind !== "TRAINING") reject("SESSION_NOT_EXECUTABLE");
    if (item.trainingSession.status !== "IN_PROGRESS") reject("SESSION_NOT_ACTIVE");
    if (item.plannedPrescriptionJson === null) reject("SNAPSHOT_UNREADABLE");

    const prescriptionRead = parseJsonColumn(item.plannedPrescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
    if (!prescriptionRead.ok) reject("SNAPSHOT_UNREADABLE");
    const logRead = readRepLog(item.actualRepLogJson);
    if (logRead.kind === "UNREADABLE" || logRead.state.reps.length === 0) reject("EXECUTION_STATE_UNREADABLE");
    if (!monitorStateSchema.safeParse({ prescription: prescriptionRead.value, priorLogs: logRead.state.reps }).success) {
      reject("EXECUTION_STATE_UNREADABLE");
    }

    const execution = readStartedExecutionState({
      readinessActionsJson: item.readinessActionsJson,
      safetyOutcome: item.safetyOutcome,
      actualRepLogJson: item.actualRepLogJson,
      stopReason: item.stopReason,
    });
    if (execution.kind === "TERMINAL") reject("EXECUTION_ALREADY_STOPPED");
    if (execution.kind === "UNREADABLE" || execution.kind === "LEGACY_SAFETY_STOP") reject("EXECUTION_STATE_UNREADABLE");

    const latest = logRead.state.reps[logRead.state.reps.length - 1];
    if (latest.action !== "COACH_REVIEW") reject("NO_COACH_REVIEW_PENDING");
    const latestIdentity = runtimeCoachReviewIdentityOf(latest);
    if (!sameRuntimeCoachReviewIdentity(reviewIdentity, latestIdentity)) reject("ACK_STATE_STALE");

    const existing = logRead.state.coachReviewAcknowledgements.find((ack) =>
      sameRuntimeCoachReviewIdentity(ack.review, latestIdentity));
    if (existing !== undefined) {
      return {
        kind: "ALREADY_ACKNOWLEDGED",
        data: {
          sessionId: item.trainingSessionId,
          sessionItemId: item.id,
          reviewIdentity: latestIdentity,
          acknowledgedAt: existing.acknowledgedAt,
        },
      };
    }
    if (execution.kind !== "COACH_REVIEW_ACK_REQUIRED") reject("EXECUTION_STATE_UNREADABLE");

    const acknowledgedAt = isoDateTimeSchema.parse(new Date().toISOString());
    const nextState = actualRepLogStateV1Schema.safeParse({
      schemaVersion: 1,
      reps: logRead.state.reps,
      coachReviewAcknowledgements: [
        ...logRead.state.coachReviewAcknowledgements,
        { review: latestIdentity, acknowledgedAt },
      ],
    });
    if (!nextState.success) reject("EXECUTION_STATE_UNREADABLE");
    try {
      serializeActualRepLogStateV1(nextState.data);
    } catch (error) {
      if (error instanceof Error && error.message === "Execution log is too large") reject("ACK_PAYLOAD_TOO_LARGE");
      reject("EXECUTION_STATE_UNREADABLE");
    }

    const write = await applyRuntimeCoachReviewAcknowledgement({
      sessionItemId: item.id,
      trainingSessionId: item.trainingSessionId,
      expected: {
        sessionStatus: "IN_PROGRESS",
        prescriptionKind: "RUNNING_V2",
        plannedPrescriptionJson: item.plannedPrescriptionJson,
        actualRepLogJson: item.actualRepLogJson!,
        safetyOutcome: item.safetyOutcome,
        stopReason: item.stopReason,
      },
      nextExecutionLogState: nextState.data,
    });
    if (write.kind === "SESSION_NOT_EXECUTABLE") reject("SESSION_NOT_EXECUTABLE");
    if (write.kind === "SESSION_CLOSED") reject("SESSION_NOT_ACTIVE");
    if (write.kind === "STALE") {
      if (attempt === 0) continue;
      reject("ACK_STATE_STALE");
    }
    return {
      kind: "ACKNOWLEDGED",
      data: { sessionId: item.trainingSessionId, sessionItemId: item.id, reviewIdentity: latestIdentity, acknowledgedAt },
    };
  }
  reject("ACK_STATE_STALE");
}
