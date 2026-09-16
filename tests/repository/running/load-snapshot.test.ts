/**
 * R9 — 処方の loadSnapshot（plan 時点の MethodMeta.loadClass / weeklyLoadCategory のコピー）と、
 * MenuItem → SessionItem.loadCategory → LoadEvent（category / intensityTag）の一貫性（§12.2・§17.2）。
 *
 * RuleSet loader は plan のときだけ使う。セッション作成と履歴変換の間は呼ばれないことを spy で確認する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { listLoadHistory } from "@/infra/repositories/load-history-repository";
import { RunningPersistenceError, createRunningMenuItem, findRunningMenuItem, updateRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { createSessionFromMenu } from "@/infra/repositories/session-repository";
import { planningSnapshotSchema } from "@/domain/running/persistence/sessionSnapshot";
import * as planning from "@/domain/running/planning";
import * as loader from "@/domain/running/rules/loader";
import { getRuleSet } from "@/domain/running/rules/loader";
import type { LoadClass, RuleSet } from "@/domain/running/rules/schema";
import { RUNNING_TRAINING_METHODS } from "@/domain/running/types/method";
import { runningPrescriptionSchema, type RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { resetDb } from "../../helpers";
import {
  makeMenuWithBlock,
  persistInputFor,
  planAcc,
  planAssisted,
  planEa,
  planLsrIncomplete,
  planMvFly20,
  planRs,
  planSes,
  planStride,
  planTe,
  planTi,
  planWith,
} from "./fixtures";

const production = getRuleSet("rs-2026.09.0")!;
const AS_OF = new Date("2026-09-20T07:00:00.000Z");

/** テストの期待値（§12.2 の v2 行）。 */
const EXPECTED_TAG: Record<LoadClass, string> = { HIGH_NEURAL: "HIGH", HIGH_METABOLIC: "HIGH", MODERATE: "MODERATE", LOW: "LOW" };

function metaOf(ruleSet: RuleSet, method: string) {
  const meta = ruleSet.methods.find((m) => m.method === method);
  if (!meta) throw new Error(`MethodMeta missing: ${method}`);
  return meta;
}

function spyRuleAccess() {
  const spies = [
    vi.spyOn(loader, "getRuleSet"),
    vi.spyOn(loader, "getActiveRuleSet"),
    vi.spyOn(loader, "selectActiveRuleSet"),
    vi.spyOn(planning, "planRunningPrescription"),
    vi.spyOn(planning, "planRunningPrescriptionWithRuleSet"),
  ];
  return { totalCalls: () => spies.reduce((n, s) => n + s.mock.calls.length, 0), restore: () => spies.forEach((s) => s.mockRestore()) };
}

const ALL_METHOD_PLANS: [string, () => RunningPrescriptionValue][] = [
  ["ACCELERATION", planAcc],
  ["MAX_VELOCITY", planMvFly20],
  ["SPRINT_ENDURANCE_SHORT", planSes],
  ["LONG_SPRINT_RACE_SPECIFIC", planLsrIncomplete],
  ["TEMPO_EXTENSIVE", planTe],
  ["TEMPO_INTENSIVE", planTi],
  ["RESISTED_SPRINT", planRs],
  ["ASSISTED_SPRINT", planAssisted],
  ["EVENT_APPROACH_SPEED", planEa],
  ["STRIDE", planStride],
];

describe("loadSnapshot の契約", () => {
  it("全10 Method: plan の成功結果は loadSnapshot を必ず持ち、plan に使った RuleSet の MethodMeta と一致する", () => {
    expect(ALL_METHOD_PLANS.map(([m]) => m).sort()).toEqual([...RUNNING_TRAINING_METHODS].sort());
    for (const [method, plan] of ALL_METHOD_PLANS) {
      const p = plan();
      const meta = metaOf(production, method);
      expect(p.method).toBe(method);
      expect(p.loadSnapshot, method).toEqual({ loadClass: meta.loadClass, weeklyLoadCategory: meta.weeklyLoadCategory });
    }
  });

  it("backward compatible: loadSnapshot の無い schemaVersion=1 の処方 JSON（R8 まで）も読める。loadSnapshot 自体は strict", () => {
    const old = JSON.parse(JSON.stringify(planAcc()));
    delete old.loadSnapshot;
    expect(old.schemaVersion).toBe(1);
    const parsed = runningPrescriptionSchema.safeParse(old);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.loadSnapshot).toBeUndefined();

    const withSnapshot = JSON.parse(JSON.stringify(planAcc()));
    expect(runningPrescriptionSchema.safeParse({ ...withSnapshot, loadSnapshot: { loadClass: "EXTREME", weeklyLoadCategory: "RUNNING_HIGH_INTENSITY" } }).success).toBe(false);
    expect(runningPrescriptionSchema.safeParse({ ...withSnapshot, loadSnapshot: { loadClass: "LOW", weeklyLoadCategory: "WALKING" } }).success).toBe(false);
    expect(runningPrescriptionSchema.safeParse({ ...withSnapshot, loadSnapshot: { loadClass: "LOW", weeklyLoadCategory: "OTHER", method: "STRIDE" } }).success).toBe(false);
  });
});

describe("全10 Method: plan → MenuItem → SessionItem → LoadEvent", () => {
  beforeEach(resetDb);
  let spies: ReturnType<typeof spyRuleAccess> | null = null;
  afterEach(() => spies?.restore());

  it("MenuItem の loadSnapshot・SessionItem.loadCategory・LoadEvent の category / intensityTag が MethodMeta と一致（loader は plan 時だけ）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const prescriptions = ALL_METHOD_PLANS.map(([, plan]) => plan());
    for (const p of prescriptions) await createRunningMenuItem(block.id, persistInputFor(p));

    spies = spyRuleAccess();
    const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-19" }));
    const { events, unresolved } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(spies.totalCalls()).toBe(0);

    const menuItems = await prisma.menuItem.findMany({ where: { menuBlockId: block.id }, orderBy: { sortOrder: "asc" } });
    const sessionItems = await prisma.sessionItem.findMany({ where: { trainingSessionId: session.id }, orderBy: { sortOrder: "asc" } });
    expect(unresolved).toEqual([]);
    expect(events).toHaveLength(10);
    for (const [i, p] of prescriptions.entries()) {
      const meta = metaOf(production, p.method);
      expect(JSON.parse(menuItems[i].prescriptionJson!).loadSnapshot, p.method).toEqual({ loadClass: meta.loadClass, weeklyLoadCategory: meta.weeklyLoadCategory });
      expect(sessionItems[i].loadCategory, p.method).toBe(meta.weeklyLoadCategory);
      expect(events[i], p.method).toMatchObject({
        method: p.method,
        templateId: p.templateId,
        category: meta.weeklyLoadCategory,
        intensityTag: EXPECTED_TAG[meta.loadClass],
      });
    }
    expect(planningSnapshotSchema.parse(JSON.parse(session.planningSnapshotJson!)).findings).toEqual([]);
  });

  it("TEMPO_INTENSIVE（loadClass=MODERATE）: loadCategory は MethodMeta.weeklyLoadCategory、LoadEvent は MODERATE で HIGH にならない", async () => {
    const meta = metaOf(production, "TEMPO_INTENSIVE");
    expect(meta.loadClass).toBe("MODERATE");
    expect(meta.weeklyLoadCategory).toBe("RUNNING_HIGH_INTENSITY"); // category だけから強度を推定すると HIGH になってしまう組み合わせ

    const { menu, block } = await makeMenuWithBlock();
    await createRunningMenuItem(block.id, persistInputFor(planTi()));
    const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-19" }));
    const [item] = await prisma.sessionItem.findMany({ where: { trainingSessionId: session.id } });
    expect(item.loadCategory).toBe(meta.weeklyLoadCategory);

    const { events } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("RUNNING_HIGH_INTENSITY");
    expect(events[0].intensityTag).toBe("MODERATE");
    expect(events[0].intensityTag).not.toBe("HIGH");
  });
});

describe("旧 snapshot / 壊れた snapshot の扱い", () => {
  beforeEach(resetDb);

  it("新規保存（WRITE）では loadSnapshot 必須。repository は RuleSet から補完しない", async () => {
    const { block } = await makeMenuWithBlock();
    const p = planAcc();
    const old = JSON.parse(JSON.stringify(p));
    delete old.loadSnapshot;
    const error = await createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: JSON.stringify(old) })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunningPersistenceError);
    expect((error as RunningPersistenceError).issues.join()).toMatch(/loadSnapshot がありません/);
    const invalid = { ...JSON.parse(JSON.stringify(p)), loadSnapshot: { loadClass: "HIGH_NEURAL" } };
    const invalidError = await createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: JSON.stringify(invalid) })).catch((e: unknown) => e);
    expect((invalidError as RunningPersistenceError).issues.join()).toMatch(/SCHEMA_INVALID: schema 不一致: loadSnapshot/);
    expect(await prisma.menuItem.count()).toBe(0);

    const saved = await createRunningMenuItem(block.id, persistInputFor(p));
    const stale = await updateRunningMenuItem(saved.id, persistInputFor(p, { prescriptionJson: JSON.stringify(old) })).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(RunningPersistenceError);
  });

  it("保存済みの旧 snapshot（loadSnapshot 無し）は読込で許し、セッション作成では loadCategory = null + SNAPSHOT_LOAD_CATEGORY_UNRESOLVED（REQUIRE_COACH_REVIEW）、履歴では OTHER / UNKNOWN", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const p = planTi();
    const saved = await createRunningMenuItem(block.id, persistInputFor(p));
    const old = JSON.parse(saved.prescriptionJson!);
    delete old.loadSnapshot;
    // R8 までに作られた（R9 の新規保存経路を通っていない）snapshot を模す
    await prisma.menuItem.update({ where: { id: saved.id }, data: { prescriptionJson: JSON.stringify(old) } });
    expect((await findRunningMenuItem(saved.id))?.status).toBe("VALID");

    const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-19" }));
    const [item] = await prisma.sessionItem.findMany({ where: { trainingSessionId: session.id } });
    expect(item.loadCategory).toBeNull();
    const snapshot = planningSnapshotSchema.parse(JSON.parse(session.planningSnapshotJson!));
    expect(snapshot.findings).toEqual([{ code: "SNAPSHOT_LOAD_CATEGORY_UNRESOLVED", severity: "REQUIRE_COACH_REVIEW", scope: "ITEM", metric: "sortOrder=0", evidenceIds: [] }]);

    const { events } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(events.map((e) => [e.category, e.intensityTag])).toEqual([["OTHER", "UNKNOWN"]]);
  });
});

describe("RuleSet A/B の load 分類変更（snapshot は plan 時点のまま）", () => {
  beforeEach(resetDb);
  let spies: ReturnType<typeof spyRuleAccess> | null = null;
  afterEach(() => spies?.restore());

  it("A で計画したセッション / LoadEvent は A の分類、B で再計画した新しいセッションは B の分類。後から RuleSet を読まない", async () => {
    const rsA: RuleSet = { ...structuredClone(production), ruleSetVersion: "rs-test-load-a" };
    const rsB: RuleSet = { ...structuredClone(production), ruleSetVersion: "rs-test-load-b" };
    const strideB = metaOf(rsB, "STRIDE");
    strideB.loadClass = "MODERATE";
    strideB.weeklyLoadCategory = "RUNNING_HIGH_INTENSITY";

    const pA = planWith({ ruleSet: rsA, contentHash: "hash-load-a", isDraftFallback: true }, "STRIDE", "ST_RELAXED");
    expect(pA.loadSnapshot).toEqual({ loadClass: "LOW", weeklyLoadCategory: "RUNNING_LOW_INTENSITY" });
    const { menu, block } = await makeMenuWithBlock();
    const item = await createRunningMenuItem(block.id, persistInputFor(pA));

    spies = spyRuleAccess();
    const sessionA = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-18" }));
    expect(spies.totalCalls()).toBe(0);
    spies.restore();
    spies = null;

    const pB = planWith({ ruleSet: rsB, contentHash: "hash-load-b", isDraftFallback: true }, "STRIDE", "ST_RELAXED");
    expect(pB.loadSnapshot).toEqual({ loadClass: "MODERATE", weeklyLoadCategory: "RUNNING_HIGH_INTENSITY" });
    await updateRunningMenuItem(item.id, persistInputFor(pB));

    spies = spyRuleAccess();
    const sessionB = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-19" }));
    const { events } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(spies.totalCalls()).toBe(0);

    const [itemA] = await prisma.sessionItem.findMany({ where: { trainingSessionId: sessionA.id } });
    const [itemB] = await prisma.sessionItem.findMany({ where: { trainingSessionId: sessionB.id } });
    expect([itemA.loadCategory, itemA.ruleSetVersion]).toEqual(["RUNNING_LOW_INTENSITY", "rs-test-load-a"]);
    expect([itemB.loadCategory, itemB.ruleSetVersion]).toEqual(["RUNNING_HIGH_INTENSITY", "rs-test-load-b"]);
    expect(events.map((e) => [e.sessionKey, e.category, e.intensityTag])).toEqual([
      [sessionA.id, "RUNNING_LOW_INTENSITY", "LOW"],
      [sessionB.id, "RUNNING_HIGH_INTENSITY", "MODERATE"],
    ]);

    // production RuleSet は変わっていない
    expect(metaOf(getRuleSet("rs-2026.09.0")!, "STRIDE")).toMatchObject({ loadClass: "LOW", weeklyLoadCategory: "RUNNING_LOW_INTENSITY" });
  });
});
