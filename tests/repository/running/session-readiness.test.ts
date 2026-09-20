import { beforeEach, describe, it, expect, afterEach, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { applySessionReadinessResults, type SessionReadinessResultInput } from "@/infra/repositories/session-repository";
import { resetDb } from "../../helpers";
import { makeReadinessSession, itemsOf, validRepLog } from "./readiness-fixtures";
import * as loader from "@/domain/running/rules/loader";
import * as readiness from "@/domain/running/readiness";
import * as weekly from "@/domain/running/weekly";
import * as history from "@/infra/repositories/load-history-repository";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
const resultsFor = (items: { id: string; prescriptionKind: string }[], review = false): SessionReadinessResultInput[] => items
  .filter((i) => i.prescriptionKind === "RUNNING_V2")
  .map((i) => ({ sessionItemId: i.id, state: { readinessExecutionStateV1: {
    schemaVersion: 1, actions: [review ? "REQUIRE_COACH_REVIEW" : "NO_CHANGE"],
    executionGate: review ? "REQUIRES_COACH_DECISION" : "YES", swapRecommended: false,
  }, safetyOutcome: "NONE" } }));

describe("atomic readiness write primitive", () => {
  it("one transaction, only the two allowed v2 columns, no policy calls", async () => {
    const { session, items } = await makeReadinessSession({ legacy: true });
    const spies = [vi.spyOn(loader, "getActiveRuleSet"), vi.spyOn(readiness, "resolveReadinessAction"), vi.spyOn(weekly, "evaluateWeeklyContext"), vi.spyOn(history, "listLoadHistory")];
    const tx = vi.spyOn(prisma, "$transaction");
    const results = resultsFor(items);
    expect(await applySessionReadinessResults(session.id, results, session)).toEqual({ updated: 3 });
    expect(tx).toHaveBeenCalledTimes(1);
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    const after = await itemsOf(session.id);
    expect(after).toEqual(items.map((item) => item.prescriptionKind === "LEGACY" ? item : {
      ...item, readinessActionsJson: JSON.stringify(results.find((r) => r.sessionItemId === item.id)!.state.readinessExecutionStateV1), safetyOutcome: "NONE",
    }));
  });

  it.each(["delete", "add", "kind", "duplicate", "foreign"])("reject changed/invalid target set: %s", async (change) => {
    const { session, items } = await makeReadinessSession();
    let results = resultsFor(items);
    if (change === "delete") await prisma.sessionItem.delete({ where: { id: items[1].id } });
    if (change === "add") await prisma.sessionItem.create({ data: { trainingSessionId: session.id, sortOrder: 9, exerciseNameSnapshot: "追加", blockNameSnapshot: "追加", prescriptionKind: "RUNNING_V2" } });
    if (change === "kind") await prisma.sessionItem.update({ where: { id: items[1].id }, data: { prescriptionKind: "LEGACY" } });
    if (change === "duplicate") results = [results[0], results[0], results[2]];
    if (change === "foreign") {
      const other = await makeReadinessSession();
      results = [results[0], { ...results[1], sessionItemId: other.items[0].id }, results[2]];
    }
    const before = await itemsOf(session.id);
    await expect(applySessionReadinessResults(session.id, results, session)).rejects.toMatchObject({ code: "SESSION_ITEMS_CHANGED" });
    expect(await itemsOf(session.id)).toEqual(before);
    expect(await prisma.sessionItem.count({ where: { readinessActionsJson: { not: null } } })).toBe(0);
  });

  it.each(["COMPLETED", "CANCELLED", "IN_PROGRESS"])("rechecks status %s inside transaction", async (status) => {
    const { session, items } = await makeReadinessSession();
    await prisma.trainingSession.update({ where: { id: session.id }, data: { status } });
    await expect(applySessionReadinessResults(session.id, resultsFor(items), session)).rejects.toMatchObject({ code: status === "IN_PROGRESS" ? "SESSION_ITEMS_CHANGED" : "SESSION_CLOSED" });
    expect(await itemsOf(session.id)).toEqual(items);
  });

  it("rechecks rep start and rejects an old array without changing it", async () => {
    const { session, items } = await makeReadinessSession();
    await prisma.sessionItem.update({ where: { id: items[2].id }, data: { actualRepLogJson: JSON.stringify([validRepLog()]), readinessActionsJson: '["NO_CHANGE"]' } });
    const before = await itemsOf(session.id);
    await expect(applySessionReadinessResults(session.id, resultsFor(items), session)).rejects.toMatchObject({ code: "SESSION_ALREADY_IN_PROGRESS" });
    expect(await itemsOf(session.id)).toEqual(before);
  });

  it("second item write failure rolls back the first item", async () => {
    const { session, items } = await makeReadinessSession();
    // Failure injection in the disposable test DB only; no production schema/migration change.
    await prisma.$executeRawUnsafe("CREATE TRIGGER readiness_test_failure BEFORE UPDATE OF readinessActionsJson ON SessionItem WHEN NEW.sortOrder = 1 BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    try {
      await expect(applySessionReadinessResults(session.id, resultsFor(items), session)).rejects.toThrow();
      expect(await itemsOf(session.id)).toEqual(items);
    } finally { await prisma.$executeRawUnsafe("DROP TRIGGER readiness_test_failure"); }
  });

  it("concurrent submissions never leave partial evaluations", async () => {
    const { session, items } = await makeReadinessSession();
    const a = resultsFor(items), b = resultsFor(items, true);
    const completed = await Promise.allSettled([
      applySessionReadinessResults(session.id, a, session), applySessionReadinessResults(session.id, b, session),
    ]);
    expect(completed.some((r) => r.status === "fulfilled")).toBe(true);
    const states = (await itemsOf(session.id)).map((i) => i.readinessActionsJson);
    expect(new Set(states).size).toBe(1);
    expect([JSON.stringify(a[0].state.readinessExecutionStateV1), JSON.stringify(b[0].state.readinessExecutionStateV1)]).toContain(states[0]);
    await applySessionReadinessResults(session.id, b, session);
    expect((await itemsOf(session.id)).every((i) => i.readinessActionsJson === JSON.stringify(b[0].state.readinessExecutionStateV1))).toBe(true);
  });

  it("raw and malformed writer input fails before any write", async () => {
    const { session, items } = await makeReadinessSession();
    const results = resultsFor(items);
    const bad = { ...results[1], state: { ...results[1].state, readinessExecutionStateV1: { ...results[1].state.readinessExecutionStateV1, pain: "secret" } } };
    await expect(applySessionReadinessResults(session.id, [results[0], bad, results[2]], session)).rejects.toThrow();
    expect(await itemsOf(session.id)).toEqual(items);
  });
});
