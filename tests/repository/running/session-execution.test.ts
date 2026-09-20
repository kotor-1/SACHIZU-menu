import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { applySessionExecutionResult } from "@/infra/repositories/session-repository";
import { resetDb } from "../../helpers";
import { makeReadinessSession, validRepLog } from "./readiness-fixtures";
import { planAcc } from "./fixtures";
import { readRepLog } from "@/domain/running/persistence/repLog";

const yes = JSON.stringify({ schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false });

describe("R11-B3 guarded execution repository", () => {
  beforeEach(resetDb);

  async function setup() {
    const made = await makeReadinessSession({ prescriptions: [planAcc()] });
    const item = made.items[0];
    await prisma.sessionItem.update({ where: { id: item.id }, data: { readinessActionsJson: yes, safetyOutcome: "NONE" } });
    return { made, item: await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } }) };
  }

  it("rejects a stale raw guard without changing any column", async () => {
    const { made, item } = await setup();
    await prisma.sessionItem.update({ where: { id: item.id }, data: { safetyOutcome: "COACH_REVIEW" } });
    const result = await applySessionExecutionResult({
      sessionItemId: item.id, trainingSessionId: made.session.id,
      expected: { sessionStatus: "PLANNED", prescriptionKind: item.prescriptionKind, plannedPrescriptionJson: item.plannedPrescriptionJson, actualRepLogJson: item.actualRepLogJson, readinessActionsJson: yes, safetyOutcome: "NONE", stopReason: null },
      next: { executionLogState: { schemaVersion: 1, reps: [validRepLog()], coachReviewAcknowledgements: [] }, cumulativeHighSpeedExposureM: { lower: 0, upper: 0, unit: "m", source: "PLANNED", confidence: "LOW" }, stopReason: null, safetyOutcome: "NONE" },
    });
    expect(result.kind).toBe("STALE");
    expect(await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ actualRepLogJson: null, actualHighSpeedExposureJson: null, safetyOutcome: "COACH_REVIEW" });
    expect((await prisma.trainingSession.findUniqueOrThrow({ where: { id: made.session.id } })).status).toBe("PLANNED");
  });

  it("enforces the 64KB log ceiling atomically", async () => {
    const { made, item } = await setup();
    const logs = Array.from({ length: 1200 }, (_, index) => ({ ...validRepLog(), setIndex: index + 1 }));
    await expect(applySessionExecutionResult({
      sessionItemId: item.id, trainingSessionId: made.session.id,
      expected: { sessionStatus: "PLANNED", prescriptionKind: item.prescriptionKind, plannedPrescriptionJson: item.plannedPrescriptionJson, actualRepLogJson: null, readinessActionsJson: yes, safetyOutcome: "NONE", stopReason: null },
      next: { executionLogState: { schemaVersion: 1, reps: logs, coachReviewAcknowledgements: [] }, cumulativeHighSpeedExposureM: { lower: 1, upper: 1, unit: "m", source: "MEASURED", confidence: "HIGH" }, stopReason: "STOP_SAFETY", safetyOutcome: "MEDICAL_EVALUATION_RECOMMENDED" },
    })).rejects.toThrow();
    expect(await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ actualRepLogJson: null, actualHighSpeedExposureJson: null, stopReason: null, safetyOutcome: "NONE" });
    expect((await prisma.trainingSession.findUniqueOrThrow({ where: { id: made.session.id } })).status).toBe("PLANNED");
  });

  it("does not lose a committed log when a different stale rep write arrives", async () => {
    const { made, item } = await setup();
    const first = validRepLog();
    const expected = { sessionStatus: "PLANNED", prescriptionKind: item.prescriptionKind, plannedPrescriptionJson: item.plannedPrescriptionJson, actualRepLogJson: null, readinessActionsJson: yes, safetyOutcome: "NONE", stopReason: null };
    expect(await applySessionExecutionResult({
      sessionItemId: item.id, trainingSessionId: made.session.id, expected,
      next: { executionLogState: { schemaVersion: 1, reps: [first], coachReviewAcknowledgements: [] }, cumulativeHighSpeedExposureM: { lower: 0, upper: 0, unit: "m", source: "PLANNED", confidence: "LOW" }, stopReason: null, safetyOutcome: "NONE" },
    })).toEqual({ kind: "APPLIED" });
    expect(await applySessionExecutionResult({
      sessionItemId: item.id, trainingSessionId: made.session.id, expected,
      next: { executionLogState: { schemaVersion: 1, reps: [{ ...first, repIndex: 2 }], coachReviewAcknowledgements: [] }, cumulativeHighSpeedExposureM: { lower: 1, upper: 1, unit: "m", source: "MEASURED", confidence: "HIGH" }, stopReason: null, safetyOutcome: "NONE" },
    })).toEqual({ kind: "STALE" });
    const saved = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });
    const read = readRepLog(saved.actualRepLogJson);
    expect(read.kind).toBe("READY");
    if (read.kind === "READY") expect(read.state.reps).toEqual([first]);
  });
});
