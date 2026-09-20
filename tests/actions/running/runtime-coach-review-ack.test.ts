import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeRuntimeCoachReviewAction, recordRepAction } from "@/actions/session-actions";
import { readRepLog, runtimeCoachReviewIdentityOf } from "@/domain/running/persistence/repLog";
import { findForbiddenHealthKeys } from "@/domain/running/persistence/limits";
import { prisma } from "@/infra/db/prisma";
import * as repository from "@/infra/repositories/session-repository";
import { resetDb } from "../../helpers";
import { makeReadinessSession } from "../../repository/running/readiness-fixtures";
import { planAcc, planStride } from "../../repository/running/fixtures";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const yes = JSON.stringify({ schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false });
const obs = (setIndex: number, repIndex: number, effortBecameMaximal = false) => ({
  setIndex,
  repIndex,
  timeS: 13,
  timing: "HAND",
  ...(effortBecameMaximal ? { coachJudgment: { effortBecameMaximal: true } } : {}),
});

async function setup(prescription = planStride()) {
  const made = await makeReadinessSession({ prescriptions: [prescription] });
  const item = made.items[0];
  await prisma.sessionItem.update({ where: { id: item.id }, data: { readinessActionsJson: yes, safetyOutcome: "NONE" } });
  return { ...made, item };
}

async function recordReview(itemId: string, repIndex = 1) {
  expect(await recordRepAction({ sessionItemId: itemId, repObservation: obs(1, repIndex, true) }))
    .toMatchObject({ ok: true, data: { monitor: { action: "COACH_REVIEW" } } });
  const saved = await prisma.sessionItem.findUniqueOrThrow({ where: { id: itemId } });
  const read = readRepLog(saved.actualRepLogJson);
  if (read.kind !== "READY") throw new Error("expected readable execution log");
  return { saved, state: read.state, identity: runtimeCoachReviewIdentityOf(read.state.reps.at(-1)!) };
}

describe("R11-B4B1 runtime COACH_REVIEW acknowledgement", () => {
  it("persists an exact acknowledgement and allows the next rep after reload", async () => {
    const { item } = await setup();
    const review = await recordReview(item.id);
    const before = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });

    const acknowledged = await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: review.identity });
    expect(acknowledged).toMatchObject({ ok: true, kind: "ACKNOWLEDGED", data: { reviewIdentity: review.identity } });

    const after = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });
    const read = readRepLog(after.actualRepLogJson);
    expect(read.kind).toBe("READY");
    if (read.kind !== "READY") throw new Error("expected readable execution log");
    expect(read.format).toBe("V1");
    expect(read.state.reps).toEqual(review.state.reps);
    expect(read.state.coachReviewAcknowledgements).toHaveLength(1);
    expect(findForbiddenHealthKeys(read.state)).toEqual([]);
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      if (key !== "actualRepLogJson") expect(after[key]).toEqual(before[key]);
    }
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 2) }))
      .toMatchObject({ ok: true, kind: "REP_RECORDED" });
  });

  it("requires a distinct acknowledgement for a later COACH_REVIEW", async () => {
    const { item } = await setup();
    const first = await recordReview(item.id);
    expect((await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: first.identity })).ok).toBe(true);
    const second = await recordReview(item.id, 2);
    expect(second.identity).not.toEqual(first.identity);
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: first.identity }))
      .toMatchObject({ ok: false, kind: "ACK_STATE_STALE" });
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 3) }))
      .toMatchObject({ ok: false, kind: "COACH_REVIEW_ACK_REQUIRED" });
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: second.identity }))
      .toMatchObject({ ok: true, kind: "ACKNOWLEDGED" });
  });

  it("is idempotent for sequential and concurrent double acknowledgement", async () => {
    const { item } = await setup();
    const review = await recordReview(item.id);
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: review.identity }))
      .toMatchObject({ ok: true, kind: "ACKNOWLEDGED" });
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: review.identity }))
      .toMatchObject({ ok: true, kind: "ALREADY_ACKNOWLEDGED" });
    let read = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson);
    expect(read.kind === "READY" ? read.state.coachReviewAcknowledgements : []).toHaveLength(1);

    const other = await setup();
    const otherReview = await recordReview(other.item.id);
    const results = await Promise.all([
      acknowledgeRuntimeCoachReviewAction({ sessionItemId: other.item.id, reviewIdentity: otherReview.identity }),
      acknowledgeRuntimeCoachReviewAction({ sessionItemId: other.item.id, reviewIdentity: otherReview.identity }),
    ]);
    expect(results.filter((result) => result.kind === "ACKNOWLEDGED")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "ALREADY_ACKNOWLEDGED")).toHaveLength(1);
    read = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: other.item.id } })).actualRepLogJson);
    expect(read.kind === "READY" ? read.state.coachReviewAcknowledgements : []).toHaveLength(1);
  });

  it("rejects absent, non-review, stale, corrupt, unknown-version, and terminal states", async () => {
    const normal = await setup(planAcc());
    expect((await recordRepAction({ sessionItemId: normal.item.id, repObservation: { setIndex: 1, repIndex: 1, timeS: 4.5, timing: "HAND" } })).ok).toBe(true);
    const normalRead = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: normal.item.id } })).actualRepLogJson);
    if (normalRead.kind !== "READY") throw new Error("expected readable execution log");
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: normal.item.id, reviewIdentity: runtimeCoachReviewIdentityOf(normalRead.state.reps[0]) }))
      .toMatchObject({ ok: false, kind: "NO_COACH_REVIEW_PENDING" });

    const pending = await setup();
    const pendingReview = await recordReview(pending.item.id);
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: pending.item.id, reviewIdentity: { ...pendingReview.identity, repIndex: 2 } }))
      .toMatchObject({ ok: false, kind: "ACK_STATE_STALE" });

    for (const actualRepLogJson of ["{bad", JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ schemaVersion: 1, reps: [], coachReviewAcknowledgements: [] })]) {
      const corrupt = await setup();
      await prisma.trainingSession.update({ where: { id: corrupt.session.id }, data: { status: "IN_PROGRESS" } });
      await prisma.sessionItem.update({ where: { id: corrupt.item.id }, data: { actualRepLogJson } });
      expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: corrupt.item.id, reviewIdentity: pendingReview.identity }))
        .toMatchObject({ ok: false, kind: "EXECUTION_STATE_UNREADABLE" });
    }

    const terminal = await setup(planAcc());
    expect(await recordRepAction({ sessionItemId: terminal.item.id, repObservation: { setIndex: 1, repIndex: 1, timeS: null, timing: "UNKNOWN", athleteReport: { painNow: true, painRegion: "HEEL", redFlags: [], requestsStop: true } } }))
      .toMatchObject({ ok: true, data: { monitor: { action: "STOP_SAFETY" } } });
    const terminalRead = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: terminal.item.id } })).actualRepLogJson);
    if (terminalRead.kind !== "READY") throw new Error("expected readable execution log");
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: terminal.item.id, reviewIdentity: runtimeCoachReviewIdentityOf(terminalRead.state.reps[0]) }))
      .toMatchObject({ ok: false, kind: "EXECUTION_ALREADY_STOPPED" });
  });

  it("acknowledges a legacy-array review and converts it to v1 only on write", async () => {
    const { item } = await setup();
    const review = await recordReview(item.id);
    const legacyRaw = JSON.stringify(review.state.reps);
    await prisma.sessionItem.update({ where: { id: item.id }, data: { actualRepLogJson: legacyRaw } });
    expect(readRepLog(legacyRaw)).toMatchObject({ kind: "READY", format: "LEGACY_ARRAY" });
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: review.identity }))
      .toMatchObject({ ok: true, kind: "ACKNOWLEDGED" });
    expect(readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson))
      .toMatchObject({ kind: "READY", format: "V1", state: { coachReviewAcknowledgements: [{ review: review.identity }] } });
  });

  it("converts a legacy normal log to v1 on the next rep and retains acknowledgements thereafter", async () => {
    const { item } = await setup();
    const review = await recordReview(item.id);
    expect((await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: review.identity })).ok).toBe(true);
    const state = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson);
    if (state.kind !== "READY") throw new Error("expected readable execution log");
    expect((await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 2) })).ok).toBe(true);
    const after = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson);
    expect(after.kind === "READY" ? after.state.coachReviewAcknowledgements : []).toEqual(state.state.coachReviewAcknowledgements);

    const normal = await setup(planAcc());
    expect((await recordRepAction({ sessionItemId: normal.item.id, repObservation: { setIndex: 1, repIndex: 1, timeS: 4.5, timing: "HAND" } })).ok).toBe(true);
    const normalState = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: normal.item.id } })).actualRepLogJson);
    if (normalState.kind !== "READY") throw new Error("expected readable execution log");
    await prisma.sessionItem.update({ where: { id: normal.item.id }, data: { actualRepLogJson: JSON.stringify(normalState.state.reps) } });
    expect((await recordRepAction({ sessionItemId: normal.item.id, repObservation: { setIndex: 1, repIndex: 2, timeS: 4.5, timing: "HAND" } })).ok).toBe(true);
    expect(readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: normal.item.id } })).actualRepLogJson))
      .toMatchObject({ kind: "READY", format: "V1", state: { reps: [{ repIndex: 1 }, { repIndex: 2 }] } });
  });

  it("fails atomically when acknowledgement metadata would exceed 64KB", async () => {
    const { item } = await setup();
    const review = await recordReview(item.id);
    const rep = structuredClone(review.state.reps[0]);
    while (Buffer.byteLength(JSON.stringify([rep]), "utf8") < 65_510) rep.reasons.push("TIMING_NOT_RECORDED");
    while (Buffer.byteLength(JSON.stringify([rep]), "utf8") > 65_535) rep.reasons.pop();
    const raw = JSON.stringify([rep]);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(65_536);
    await prisma.sessionItem.update({ where: { id: item.id }, data: { actualRepLogJson: raw } });
    const before = await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: review.identity }))
      .toMatchObject({ ok: false, kind: "ACK_PAYLOAD_TOO_LARGE" });
    expect(await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(before);
  });

  it("re-reads after a CAS miss and rejects an acknowledgement for a newly changed review", async () => {
    const { item } = await setup();
    const review = await recordReview(item.id);
    const apply = repository.applyRuntimeCoachReviewAcknowledgement;
    vi.spyOn(repository, "applyRuntimeCoachReviewAcknowledgement").mockImplementationOnce(async (...args) => {
      const second = { ...review.state.reps[0], repIndex: 2 };
      await prisma.sessionItem.update({
        where: { id: item.id },
        data: {
          actualRepLogJson: JSON.stringify({
            schemaVersion: 1,
            reps: [review.state.reps[0], second],
            coachReviewAcknowledgements: [{ review: review.identity, acknowledgedAt: "2026-09-20T00:00:00.000Z" }],
          }),
        },
      });
      return apply(...args);
    });
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: review.identity }))
      .toMatchObject({ ok: false, kind: "ACK_STATE_STALE" });
    const read = readRepLog((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).actualRepLogJson);
    expect(read.kind === "READY" ? read.state.coachReviewAcknowledgements : []).toHaveLength(1);
  });

  it("does not treat a concurrent next-rep submission as acknowledgement", async () => {
    const { item } = await setup();
    const review = await recordReview(item.id);
    const apply = repository.applyRuntimeCoachReviewAcknowledgement;
    vi.spyOn(repository, "applyRuntimeCoachReviewAcknowledgement").mockImplementationOnce(async (...args) => {
      expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 2) }))
        .toMatchObject({ ok: false, kind: "COACH_REVIEW_ACK_REQUIRED" });
      return apply(...args);
    });
    expect(await acknowledgeRuntimeCoachReviewAction({ sessionItemId: item.id, reviewIdentity: review.identity }))
      .toMatchObject({ ok: true, kind: "ACKNOWLEDGED" });
    expect(await recordRepAction({ sessionItemId: item.id, repObservation: obs(1, 2) }))
      .toMatchObject({ ok: true, kind: "REP_RECORDED" });
  });
});
