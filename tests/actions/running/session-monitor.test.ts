import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { recordRepAction } from "@/actions/session-actions";
import { findForbiddenHealthKeys } from "@/domain/running/persistence/limits";
import { resetDb } from "../../helpers";
import { makeReadinessSession } from "../../repository/running/readiness-fixtures";
import { planAcc, planStride, planTi } from "../../repository/running/fixtures";
import * as repository from "@/infra/repositories/session-repository";
import { readRepLog } from "@/domain/running/persistence/repLog";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const yes = JSON.stringify({ schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false });
const no = JSON.stringify({ schemaVersion: 1, actions: ["CANCEL_HIGH_INTENSITY"], executionGate: "NO", swapRecommended: false });
const coach = JSON.stringify({ schemaVersion: 1, actions: ["REQUIRE_COACH_REVIEW"], executionGate: "REQUIRES_COACH_DECISION", swapRecommended: false });
const obs = (setIndex = 1, repIndex = 1, timeS: number | null = 4.5, timing = "HAND") => ({ setIndex, repIndex, timeS, timing });

async function setup(prescription = planAcc(), readinessActionsJson: string | null = yes, safetyOutcome: string | null = "NONE") {
  const made = await makeReadinessSession({ prescriptions: [prescription] });
  const item = made.items[0];
  await prisma.sessionItem.update({ where: { id: item.id }, data: { readinessActionsJson, safetyOutcome } });
  return { ...made, item };
}

describe("R11-B3 recordRepAction", () => {
  it.each(["HAND", "PHOTO_CELL", "UNKNOWN"])("records %s from the snapshot and changes only execution columns", async (timing) => {
    const { session, item } = await setup();
    const before = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });
    const result = await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 1, timing === "UNKNOWN" ? null : 4.5, timing) });
    expect(result).toMatchObject({ ok: true, kind: "REP_RECORDED", data: { monitor: { completedRepCount: 1 } } });
    const after = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      if (!["actualRepLogJson", "actualHighSpeedExposureJson", "stopReason", "safetyOutcome"].includes(key)) expect(after[key]).toEqual(before[key]);
    }
    const read = readRepLog(after.actualRepLogJson);
    expect(read.kind).toBe("READY");
    if (read.kind === "READY") {
      expect(read.format).toBe("V1");
      expect(read.state.reps).toHaveLength(1);
    }
    expect((await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("IN_PROGRESS");
  });

  it.each([
    [null, null, "READINESS_REQUIRED"],
    [JSON.stringify(["NO_CHANGE"]), "NONE", "READINESS_REEVALUATION_REQUIRED"],
    [no, "NONE", "READINESS_BLOCKED"],
    [coach, "COACH_REVIEW", "READINESS_COACH_DECISION_REQUIRED"],
    ["{bad", "NONE", "EXECUTION_STATE_UNREADABLE"],
    [yes, "STOP", "EXECUTION_STATE_UNREADABLE"],
  ])("first-rep gate %# fails closed", async (readinessActionsJson, safetyOutcome, kind) => {
    const { item } = await setup(planAcc(), readinessActionsJson, safetyOutcome);
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs() })).toMatchObject({ ok: false, kind });
    expect((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson).toBeNull();
  });

  it("is append-only and treats the same rep as already recorded", async () => {
    const { item } = await setup();
    expect((await recordRepAction({ sessionItemId: item.id, repObservation: obs() })).ok).toBe(true);
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 1, 9.9) })).toMatchObject({ ok: false, kind: "REP_ALREADY_RECORDED" });
    const read = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson);
    expect(read.kind === "READY" ? read.state.reps : []).toHaveLength(1);
  });

  it("persists only aggregated athlete safety output and stops later reps", async () => {
    const { item } = await setup();
    const result = await recordRepAction({ sessionItemId: item.id, repObservation: { ...obs(1, 1, null), athleteReport: { painNow: true, painRegion: "HEEL", redFlags: ["LIMPING"], requestsStop: true }, coachJudgment: { technique: "UNSAFE", environmentUnsafe: true } } });
    expect(result).toMatchObject({ ok: true, data: { monitor: { action: "STOP_SAFETY" } } });
    const saved = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.stopReason).toBe("STOP_SAFETY");
    expect(saved.safetyOutcome).toBe("MEDICAL_EVALUATION_RECOMMENDED");
    const read = readRepLog(saved.actualRepLogJson);
    expect(read.kind).toBe("READY");
    if (read.kind !== "READY") throw new Error("expected readable execution log");
    expect(read.state.reps[0].reasons).toEqual(["SAFETY_STOP_ATHLETE", "SAFETY_STOP_TECHNIQUE_UNSAFE", "SAFETY_STOP_ENVIRONMENT"]);
    expect(findForbiddenHealthKeys(read.state)).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain("HEEL");
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 2) })).toMatchObject({ kind: "EXECUTION_ALREADY_STOPPED" });
  });

  it("persists COACH_REVIEW as a reload-stable pause without stopReason", async () => {
    const { item } = await setup(planStride());
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: { ...obs(1, 1, 13), coachJudgment: { effortBecameMaximal: true } } })).toMatchObject({ ok: true, data: { monitor: { action: "COACH_REVIEW" } } });
    expect(await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ stopReason: null, safetyOutcome: "NONE" });
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 2, 13) })).toMatchObject({ kind: "COACH_REVIEW_ACK_REQUIRED" });
  });

  it("persists monitor cumulative measured exposure without application re-derivation", async () => {
    const { item } = await setup();
    const measured = { lower: 12.5, upper: 13.5, unit: "m", source: "MEASURED", confidence: "HIGH" } as const;
    const result = await recordRepAction({ sessionItemId: item.id, repObservation: { ...obs(), actualHighSpeedExposureM: measured } });
    expect(result).toMatchObject({ ok: true, data: { monitor: { cumulativeHighSpeedExposureM: measured } } });
    expect(JSON.parse((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualHighSpeedExposureJson!)).toEqual(measured);
  });

  it("END_SET blocks the same set but permits the next set", async () => {
    const p = planTi();
    const { item } = await setup(p);
    const slow = p.intensity.target!.upper! + 1;
    expect((await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 1, slow) })).ok).toBe(true);
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 2, slow) })).toMatchObject({ ok: true, data: { monitor: { action: "END_SET" } } });
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 3, slow) })).toMatchObject({ kind: "SET_ALREADY_ENDED" });
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(2, 1, slow) })).toMatchObject({ ok: true });
  });

  it("rejects corrupt snapshot and prior log without replacing data", async () => {
    const { item } = await setup();
    await prisma.sessionItem.update({ where: { id: item.id }, data: { plannedPrescriptionJson: "{bad" } });
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs() })).toMatchObject({ kind: "SNAPSHOT_UNREADABLE" });
    await prisma.sessionItem.update({ where: { id: item.id }, data: { plannedPrescriptionJson: JSON.stringify(planAcc()), actualRepLogJson: "{bad" } });
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs() })).toMatchObject({ kind: "REP_LOG_UNREADABLE" });
    expect((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson).toBe("{bad");
  });

  it("re-reads first-rep readiness after a content-guard miss and never saves a stale YES", async () => {
    const { item } = await setup();
    const apply = repository.applySessionExecutionResult;
    vi.spyOn(repository, "applySessionExecutionResult").mockImplementationOnce(async (...args) => {
      await prisma.sessionItem.update({ where: { id: item.id }, data: { readinessActionsJson: no } });
      return apply(...args);
    });
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs() })).toMatchObject({ kind: "READINESS_BLOCKED" });
    expect((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson).toBeNull();
  });

  it("concurrent same-rep submissions append exactly once", async () => {
    const { item } = await setup();
    const results = await Promise.all([
      recordRepAction({ sessionItemId: item.id, repObservation: obs() }),
      recordRepAction({ sessionItemId: item.id, repObservation: obs() }),
    ]);
    expect(results.filter((result) => result.kind === "REP_RECORDED")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "REP_ALREADY_RECORDED")).toHaveLength(1);
    const read = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson);
    expect(read.kind === "READY" ? read.state.reps : []).toHaveLength(1);
  });
});
