import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeRuntimeCoachReviewAction,
  evaluateSessionReadinessAction,
  recordRepAction,
} from "@/actions/session-actions";
import { actualRepLogStateV1Schema, serializeActualRepLogStateV1 } from "@/domain/running/persistence/repLog";
import { readinessPersistedStateSchema } from "@/domain/running/readiness/execution";
import {
  applyRuntimeCoachReviewAcknowledgement,
  applySessionExecutionResult,
  applySessionReadinessResults,
} from "@/infra/repositories/session-repository";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../../helpers";
import { readinessReport } from "../../fixtures/running/readiness-execution";
import { makeReadinessSession, validRepLog } from "../../repository/running/readiness-fixtures";
import { planStride } from "../../repository/running/fixtures";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

beforeEach(resetDb);

const yes = JSON.stringify({ schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false });

describe("R11-B7A.1 Competition Session execution isolation", () => {
  it.each(["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const)(
    "historical %s Competition + RUNNING_V2 item rejects every execution Action with write 0",
    async (status) => {
      const prescription = planStride();
      const { session, items } = await makeReadinessSession({ prescriptions: [prescription] });
      const item = items[0];
      await prisma.trainingSession.update({
        where: { id: session.id },
        data: { sessionKind: "COMPETITION", status },
      });
      await prisma.sessionItem.update({
        where: { id: item.id },
        data: { readinessActionsJson: yes, safetyOutcome: "NONE" },
      });
      const beforeSession = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
      const beforeItem = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });

      expect(await evaluateSessionReadinessAction({ sessionId: session.id, readinessReport: readinessReport() }))
        .toMatchObject({ ok: false, kind: "SESSION_NOT_EXECUTABLE" });
      expect(await recordRepAction({
        sessionItemId: item.id,
        repObservation: { setIndex: 1, repIndex: 1, timeS: 13, timing: "HAND" },
      })).toMatchObject({ ok: false, kind: "SESSION_NOT_EXECUTABLE" });
      expect(await acknowledgeRuntimeCoachReviewAction({
        sessionItemId: item.id,
        reviewIdentity: { stopPolicyId: prescription.stopPolicyId, setIndex: 1, repIndex: 1 },
      })).toMatchObject({ ok: false, kind: "SESSION_NOT_EXECUTABLE" });

      expect(await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(beforeSession);
      expect(await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(beforeItem);
    },
  );

  it("repository readiness/rep/ack primitives independently reject a Competition Session", async () => {
    const prescription = planStride();
    const { session, items } = await makeReadinessSession({ prescriptions: [prescription] });
    const item = items[0];
    const executionLogState = actualRepLogStateV1Schema.parse({
      schemaVersion: 1,
      reps: [validRepLog()],
      coachReviewAcknowledgements: [],
    });
    const actualRepLogJson = serializeActualRepLogStateV1(executionLogState);
    await prisma.trainingSession.update({
      where: { id: session.id },
      data: { sessionKind: "COMPETITION", status: "IN_PROGRESS" },
    });
    await prisma.sessionItem.update({
      where: { id: item.id },
      data: { readinessActionsJson: yes, safetyOutcome: "NONE", actualRepLogJson },
    });
    const currentSession = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    const currentItem = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });
    const readinessState = readinessPersistedStateSchema.parse({
      readinessExecutionStateV1: { schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false },
      safetyOutcome: "NONE",
    });

    await expect(applySessionReadinessResults(
      session.id,
      [{ sessionItemId: item.id, state: readinessState }],
      currentSession,
    )).rejects.toMatchObject({ code: "SESSION_NOT_EXECUTABLE" });

    const executionWrite = await applySessionExecutionResult({
      sessionItemId: item.id,
      trainingSessionId: session.id,
      expected: {
        sessionStatus: currentSession.status,
        prescriptionKind: currentItem.prescriptionKind,
        plannedPrescriptionJson: currentItem.plannedPrescriptionJson,
        actualRepLogJson: currentItem.actualRepLogJson,
        readinessActionsJson: currentItem.readinessActionsJson,
        safetyOutcome: currentItem.safetyOutcome,
        stopReason: currentItem.stopReason,
      },
      next: {
        executionLogState,
        cumulativeHighSpeedExposureM: { lower: 0, upper: 0, unit: "m", source: "PLANNED", confidence: "LOW" },
        stopReason: null,
        safetyOutcome: "NONE",
      },
    });
    expect(executionWrite).toEqual({ kind: "SESSION_NOT_EXECUTABLE" });

    const ackWrite = await applyRuntimeCoachReviewAcknowledgement({
      sessionItemId: item.id,
      trainingSessionId: session.id,
      expected: {
        sessionStatus: "IN_PROGRESS",
        prescriptionKind: "RUNNING_V2",
        plannedPrescriptionJson: currentItem.plannedPrescriptionJson!,
        actualRepLogJson: currentItem.actualRepLogJson!,
        safetyOutcome: currentItem.safetyOutcome,
        stopReason: currentItem.stopReason,
      },
      nextExecutionLogState: executionLogState,
    });
    expect(ackWrite).toEqual({ kind: "SESSION_NOT_EXECUTABLE" });

    expect(await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(currentSession);
    expect(await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(currentItem);
  });
});
