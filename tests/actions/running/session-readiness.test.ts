import fs from "node:fs";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { evaluateSessionReadinessAction } from "@/actions/session-actions";
import { resetDb } from "../../helpers";
import { makeReadinessSession, itemsOf, validRepLog } from "../../repository/running/readiness-fixtures";
import { planStride, planTe } from "../../repository/running/fixtures";
import { readinessReport } from "../../fixtures/running/readiness-execution";
import * as loader from "@/domain/running/rules/loader";
import * as planning from "@/domain/running/planning";
import * as weekly from "@/domain/running/weekly";
import * as historyRepo from "@/infra/repositories/load-history-repository";
import * as readiness from "@/domain/running/readiness";
import * as repository from "@/infra/repositories/session-repository";
import { readReadinessExecutionState } from "@/domain/running/readiness/execution";
import { findForbiddenHealthKeys } from "@/domain/running/persistence/limits";
import { isoDateTimeSchema } from "@/domain/running/types/primitives";
import { buildPlanningSnapshot } from "@/domain/running/persistence/sessionSnapshot";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
const call = (sessionId: string, report = readinessReport()) => evaluateSessionReadinessAction({ sessionId, readinessReport: report });
const notAsked = () => readinessReport({ pain: { status: "NOT_ASKED", regions: [], redFlags: [] } });
function fixedColumns<T extends { readinessActionsJson: string | null; safetyOutcome: string | null }>(row: T) {
  const { readinessActionsJson, safetyOutcome, ...rest } = row;
  expect(readinessActionsJson === null || typeof readinessActionsJson === "string").toBe(true);
  expect(safetyOutcome === null || typeof safetyOutcome === "string").toBe(true);
  return rest;
}

describe("R11-B2 Action + real persistence", () => {
  it("新plural Competition snapshot corruptionをhistory不明へ偽装せずReadiness write 0で停止", async () => {
    const { session } = await makeReadinessSession();
    const snapshot = buildPlanningSnapshot({ sessionDateInput: "2026-09-20", items: [] });
    await prisma.trainingSession.update({
      where: { id: session.id },
      data: { planningSnapshotJson: JSON.stringify({ ...snapshot, plannedAt: "2026-09-20T16:00:00+09:00" }) },
    });
    await prisma.trainingSession.create({
      data: {
        title: "壊れた大会実績",
        date: new Date("2026-09-19"),
        status: "COMPLETED",
        sessionKind: "COMPETITION",
        planningSnapshotJson: JSON.stringify({ schemaVersion: 1, competitionLoadCategories: [] }),
      },
    });
    expect(await call(session.id)).toMatchObject({ ok: false, kind: "READINESS_SAVE_FAILED" });
    expect((await itemsOf(session.id)).every((item) => item.readinessActionsJson === null && item.safetyOutcome === null)).toBe(true);
  });

  it("mixed LOW/HIGH_NEURAL/HIGH_METABOLIC + LEGACY: only two v2 columns change", async () => {
    const { session, items } = await makeReadinessSession({ legacy: true });
    const beforeSession = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    const result = await call(session.id, notAsked());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.kind);
    expect(result.data.items.map((i) => i.executionDirective.executionGate)).toEqual(["YES", "REQUIRES_COACH_DECISION", "REQUIRES_COACH_DECISION"]);
    const after = await itemsOf(session.id);
    for (const [i, row] of after.entries()) {
      expect(fixedColumns(row)).toEqual(fixedColumns(items[i])); // ALL other columns, not just selected planned fields.
      if (row.prescriptionKind === "LEGACY") expect(row).toEqual(items[i]);
      else expect(readReadinessExecutionState(row.readinessActionsJson, row.safetyOutcome)).toMatchObject({ kind: "READY_V1", executionDirective: result.data.items[i].executionDirective });
    }
    expect(await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(beforeSession);
  });

  it("same LOW SWAP report persists different item-local gates", async () => {
    const { session } = await makeReadinessSession({ prescriptions: [planStride(), planTe()] });
    const result = await call(session.id, readinessReport({ soreness: 4 }));
    expect(result).toMatchObject({ ok: true, data: { items: [
      { actions: ["SWAP_TO_LOWER_LOAD_METHOD"], executionDirective: { executionGate: "YES", swapRecommended: false } },
      { actions: ["SWAP_TO_LOWER_LOAD_METHOD"], executionDirective: { executionGate: "NO", swapRecommended: true } },
    ] } });
  });

  it("report and trigger data never reach persistent columns or raw ActionResult", async () => {
    const { session, items } = await makeReadinessSession();
    const report = readinessReport({ pain: { status: "PRESENT", regions: ["HEEL", "KNEE"], redFlags: ["SWELLING"] }, soreness: 4, fatigue: 5, sleepQuality: 1, reporter: "PARENT", reportedAt: isoDateTimeSchema.parse("2026-09-20T01:23:45Z") });
    const result = await call(session.id, report);
    expect(result.ok).toBe(true);
    expect(findForbiddenHealthKeys(result)).toEqual([]);
    const after = await itemsOf(session.id);
    for (const [i, row] of after.entries()) {
      expect(fixedColumns(row)).toEqual(fixedColumns(items[i]));
      const payload = JSON.parse(row.readinessActionsJson!);
      expect(findForbiddenHealthKeys(payload)).toEqual([]);
      expect(Object.keys(payload).sort()).toEqual(["actions", "executionGate", "schemaVersion", "swapRecommended"]);
      expect(row.safetyOutcome).toBe("MEDICAL_EVALUATION_RECOMMENDED");
    }
    const saved = JSON.stringify({ items: after, session: await prisma.trainingSession.findUnique({ where: { id: session.id } }) });
    for (const value of ["HEEL", "KNEE", "PARENT", report.reportedAt]) expect(saved).not.toContain(value);
    // Static monitoring safetyPolicy includes universal red-flag enum names before evaluation;
    // full-column equality above proves no selected observation was added to that policy snapshot.
  });

  it.each([{}, { sessionId: "x", readinessReport: { soreness: 99 } }, { sessionId: "x", readinessReport: readinessReport(), executionGate: "YES" }])("invalid/forged input %# writes nothing", async (input) => {
    const { session, items } = await makeReadinessSession();
    expect(await evaluateSessionReadinessAction(input)).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expect(await itemsOf(session.id)).toEqual(items);
  });

  it("not found / wrong owner / legacy-only are non-writing results", async () => {
    expect(await call("missing")).toMatchObject({ kind: "SESSION_NOT_FOUND" });
    const { session, items } = await makeReadinessSession({ prescriptions: [], legacy: true });
    expect(await call(session.id)).toMatchObject({ kind: "NO_RUNNING_V2_ITEMS" });
    expect(await itemsOf(session.id)).toEqual(items);
    await prisma.trainingSession.update({ where: { id: session.id }, data: { ownerId: "another-coach" } });
    expect(await call(session.id)).toMatchObject({ kind: "SESSION_NOT_FOUND" });
  });

  it.each(["plannedPrescriptionJson", "plannedProvenanceJson"] as const)("one corrupt %s prevents ALL writes", async (column) => {
    const { session, items } = await makeReadinessSession();
    await prisma.sessionItem.update({ where: { id: items[1].id }, data: { [column]: '{"secret":"not exposed"' } });
    const before = await itemsOf(session.id);
    const result = await call(session.id);
    expect(result).toMatchObject({ kind: "SNAPSHOT_UNREADABLE" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(await itemsOf(session.id)).toEqual(before);
  });

  it("old loadSnapshot absence is unavailable, not current-MethodMeta fallback", async () => {
    const { session, items } = await makeReadinessSession();
    const p = JSON.parse(items[0].plannedPrescriptionJson!);
    delete p.loadSnapshot;
    await prisma.sessionItem.update({ where: { id: items[0].id }, data: { plannedPrescriptionJson: JSON.stringify(p) } });
    expect(await call(session.id)).toMatchObject({ kind: "SNAPSHOT_UNREADABLE" });
    expect((await itemsOf(session.id)).every((i) => i.readinessActionsJson === null)).toBe(true);
  });

  it("snapshot context is independent of changed source Menu; UNKNOWN stays UNKNOWN", async () => {
    const { session, menu } = await makeReadinessSession({ ageBand: "UNKNOWN" });
    await prisma.menuTemplate.update({ where: { id: menu.id }, data: { runningContextJson: "broken" } });
    await prisma.menuItem.updateMany({ where: { menuBlock: { menuTemplateId: menu.id } }, data: { prescriptionJson: "broken", provenanceJson: "broken" } });
    const spy = vi.spyOn(readiness, "resolveReadinessAction");
    expect(await call(session.id, notAsked())).toMatchObject({ ok: true });
    expect(spy.mock.calls.map(([, ctx]) => [ctx.method, ctx.loadClass, ctx.ageBand])).toEqual([
      ["STRIDE", "LOW", "UNKNOWN"], ["MAX_VELOCITY", "HIGH_NEURAL", "UNKNOWN"], ["SPRINT_ENDURANCE_SHORT", "HIGH_METABOLIC", "UNKNOWN"],
    ]);
  });

  it.each(["ACTIVE", "DRAFT"] as const)("stored A stays immutable while session.date selects B (%s)", async (status) => {
    const { session, items } = await makeReadinessSession();
    const original = loader.getActiveRuleSet("2026-09-20");
    const ruleSet = { ...original.ruleSet, ruleSetVersion: "readiness-policy-B", status,
      readinessRules: original.ruleSet.readinessRules.map((r) => r.kind === "WELLNESS_SIGNAL" && r.id === "RDN_FATIGUE_HIGH" ? { ...r, threshold: 5 } : r) };
    const spy = vi.spyOn(loader, "getActiveRuleSet").mockReturnValue({ ruleSet, contentHash: "b".repeat(64), isDraftFallback: status === "DRAFT" });
    const exact = vi.spyOn(loader, "getRuleSetByIdentity");
    const plan = vi.spyOn(planning, "planRunningPrescription"), planExact = vi.spyOn(planning, "planRunningPrescriptionWithRuleSet");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-02-01T12:00:00Z"));
    try {
      const result = await call(session.id, readinessReport({ fatigue: 4 }));
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(result.kind);
      expect(result.data.items.every((i) => i.actions.join() === "NO_CHANGE")).toBe(true);
      expect(result.data.findings.some((f) => f.developerCode === "RULESET_DRAFT")).toBe(status === "DRAFT");
      expect(spy.mock.calls.every(([date]) => date === "2026-09-20")).toBe(true);
      expect(spy).toHaveBeenCalled();
      expect(exact).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled(); expect(planExact).not.toHaveBeenCalled();
      expect((await itemsOf(session.id)).map(fixedColumns)).toEqual(items.map(fixedColumns));
    } finally { vi.useRealTimers(); }
  });

  it("real production DRAFT succeeds; loader unavailable never falls back to plan", async () => {
    const { session } = await makeReadinessSession();
    expect(loader.getActiveRuleSet("2026-09-20").isDraftFallback).toBe(true);
    expect(await call(session.id)).toMatchObject({ ok: true });
    const before = await itemsOf(session.id);
    vi.spyOn(loader, "getActiveRuleSet").mockImplementation(() => { throw new Error("private detail"); });
    expect(await call(session.id)).toMatchObject({ kind: "READINESS_RULESET_UNAVAILABLE" });
    expect(await itemsOf(session.id)).toEqual(before);
  });

  it("latest state replaces array/v1 and safetyOutcome; [] is not started", async () => {
    const { session, items } = await makeReadinessSession();
    await prisma.sessionItem.updateMany({ where: { trainingSessionId: session.id }, data: { readinessActionsJson: '["NO_CHANGE"]', actualRepLogJson: "[]" } });
    expect(await call(session.id, readinessReport({ pain: { status: "PRESENT", regions: [], redFlags: [] } }))).toMatchObject({ ok: true });
    expect((await itemsOf(session.id)).every((i) => i.safetyOutcome === "COACH_REVIEW")).toBe(true);
    expect(await call(session.id)).toMatchObject({ ok: true });
    for (const row of await itemsOf(session.id)) {
      expect(JSON.parse(row.readinessActionsJson!)).toEqual({ schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false });
      expect(row.safetyOutcome).toBe("NONE");
    }
    await prisma.sessionItem.update({ where: { id: items[1].id }, data: { actualRepLogJson: JSON.stringify([validRepLog()]) } });
    const before = await itemsOf(session.id);
    expect(await call(session.id)).toMatchObject({ kind: "SESSION_ALREADY_IN_PROGRESS" });
    expect(await itemsOf(session.id)).toEqual(before);
  });

  it.each(["COMPLETED", "CANCELLED"])("closed Session %s does not write", async (status) => {
    const { session, items } = await makeReadinessSession();
    await prisma.trainingSession.update({ where: { id: session.id }, data: { status } });
    expect(await call(session.id)).toMatchObject({ kind: "SESSION_CLOSED" });
    expect(await itemsOf(session.id)).toEqual(items);
  });

  it("corrupt rep log fails closed", async () => {
    const { session, items } = await makeReadinessSession();
    await prisma.sessionItem.update({ where: { id: items[0].id }, data: { actualRepLogJson: "[{}]" } });
    const before = await itemsOf(session.id);
    expect(await call(session.id)).toMatchObject({ kind: "SNAPSHOT_UNREADABLE" });
    expect(await itemsOf(session.id)).toEqual(before);
  });
});

describe("current weekly readiness window", () => {
  it("date-only uses NOT_EVALUATED and never supplies midnight or now", async () => {
    const { session } = await makeReadinessSession();
    const history = vi.spyOn(historyRepo, "listLoadHistory");
    const spy = vi.spyOn(readiness, "resolveReadinessAction");
    expect(await call(session.id)).toMatchObject({ ok: true });
    expect(history).not.toHaveBeenCalled();
    expect(spy.mock.calls.every(([, c]) => c.readinessWindowState === "NOT_EVALUATED")).toBe(true);
  });

  it.each(["RACE", "RELAY"] as const)("explicit plannedAt, current %s mapper, stale snapshot ignored, self excluded", async (category) => {
    const { session } = await makeReadinessSession({ date: "2026-09-20T16:00:00+09:00" });
    // A Session date can be earlier than its explicit saved plannedAt: repository would return it.
    await prisma.trainingSession.update({ where: { id: session.id }, data: { date: new Date("2026-09-20T00:00:00Z") } });
    const weeklySpy = vi.spyOn(weekly, "evaluateWeeklyContext");
    const resolveSpy = vi.spyOn(readiness, "resolveReadinessAction");
    const report = readinessReport({ soreness: null, fatigue: null, sleepQuality: null });
    expect(await call(session.id, report)).toMatchObject({ ok: true });
    expect(weeklySpy.mock.calls.every(([h]) => h?.events.every((e) => e.sessionKey !== session.id))).toBe(true);
    expect(resolveSpy.mock.calls.every(([, c]) => c.readinessWindowState === "INACTIVE")).toBe(true);
    const planningSnapshotJson = JSON.stringify({ ...JSON.parse(session.planningSnapshotJson!), competitionLoadCategory: category });
    const race = await prisma.trainingSession.create({ data: { title: "大会履歴", date: new Date("2026-09-17T19:00:00Z"), sessionKind: "COMPETITION", planningSnapshotJson } });
    const mapped = await historyRepo.listLoadHistory({ asOf: new Date("2026-09-20T07:00:00Z"), windowHours: 672 });
    expect(mapped.events.some((e) => e.sessionKey === session.id)).toBe(true); // not auto-excluded merely because PLANNED
    expect(mapped.events.find((e) => e.sessionKey === race.id)?.category).toBe(category);
    weeklySpy.mockClear(); resolveSpy.mockClear();
    const result = await call(session.id, report);
    expect(result).toMatchObject({ ok: true });
    expect(resolveSpy.mock.calls.map(([, c]) => c.readinessWindowState)).toEqual(["INACTIVE", "ACTIVE", "ACTIVE"]);
    expect(weeklySpy.mock.calls.every(([h, c]) => c.evaluatedAt === "2026-09-20T16:00:00+09:00" && h?.events.every((e) => e.sessionKey !== session.id))).toBe(true);
    if (!result.ok) throw new Error(result.kind);
    expect(result.data.items[1].actions).toEqual(["USE_LOWER_BOUND"]);
  });

  it("date/time mismatch is not silently repaired", async () => {
    const { session } = await makeReadinessSession({ date: "2026-09-20T16:00:00+09:00" });
    await prisma.trainingSession.update({ where: { id: session.id }, data: { date: new Date("2026-09-21") } });
    expect(await call(session.id)).toMatchObject({ kind: "SNAPSHOT_UNREADABLE" });
  });
});

describe("application/write boundary", () => {
  it("a set change after evaluation rejects the complete result", async () => {
    const { session, items } = await makeReadinessSession();
    const apply = repository.applySessionReadinessResults;
    vi.spyOn(repository, "applySessionReadinessResults").mockImplementationOnce(async (...args) => {
      await prisma.sessionItem.update({ where: { id: items[1].id }, data: { prescriptionKind: "LEGACY" } });
      return apply(...args);
    });
    expect(await call(session.id)).toMatchObject({ kind: "SESSION_ITEMS_CHANGED" });
    expect((await itemsOf(session.id)).every((i) => i.readinessActionsJson === null)).toBe(true);
  });

  it("source guard: readiness never invokes plan or depends on feature flags/confirmation", () => {
    const source = fs.readFileSync("src/actions/_session-readiness-service.ts", "utf8");
    expect(source).not.toMatch(/planRunningPrescription|findingConfirmations|confirmationChallenge|RUNNING_V2_UI_ENABLED|getRuleSetByIdentity|findMenu/);
  });
});
