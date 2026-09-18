/**
 * R9 — Running v2 のスナップショット不変条件（§17・§20 T-SNAP-01〜05）と duplicateMenu（§15.3）。
 *
 * 既存の `tests/repository/snapshot-integrity.test.ts`（9件）は変更しない。ここは v2 の追加分だけ。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ZodError, type z } from "zod";
import type { SessionItem } from "@prisma/client";
import { prisma } from "@/infra/db/prisma";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { addMenuItem, duplicateMenu } from "@/infra/repositories/menu-repository";
import { createRunningMenuItem, saveMenuRunningContext, updateRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { createSessionFromMenu } from "@/infra/repositories/session-repository";
import { planningSnapshotSchema, weeklyContextResultSchema, type SessionPlanningEvaluationInput } from "@/domain/running/persistence/sessionSnapshot";
import { buildSourceMenuFingerprint, type FingerprintMenuItemInput } from "@/infra/repositories/session-fingerprint";
import * as aggregation from "@/domain/running/aggregation";
import * as weekly from "@/domain/running/weekly";
import type { WeeklyContextResult } from "@/domain/running/weekly";
import type { IsoDateTime } from "@/domain/running/types/primitives";
import { monitorRunningPrescription, type MonitorDecision, type RepLogEntry, type RepObservation } from "@/domain/running/monitoring";
import * as planning from "@/domain/running/planning";
import * as loader from "@/domain/running/rules/loader";
import { getRuleSet } from "@/domain/running/rules/loader";
import type { RuleSet } from "@/domain/running/rules/schema";
import { runningPrescriptionSchema, type RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { resetDb } from "../../helpers";
import {
  makeMenuWithBlock,
  makeRequest,
  persistInputFor,
  planAcc,
  planAssisted,
  planLsrIncomplete,
  planMvFly20,
  planStride,
  planTi,
  planWith,
} from "./fixtures";

const SESSION_DATE = "2026-09-20";

/** MenuItem 列 → SessionItem 列（§17.2）。 */
const V2_COPY_MAP = {
  prescriptionKind: "prescriptionKind",
  runningMethod: "runningMethod",
  sessionTemplateId: "sessionTemplateId",
  recoveryStructure: "recoveryStructure",
  buildUpDistanceMeters: "plannedBuildUpDistanceMeters",
  flyZoneDistanceMeters: "plannedFlyZoneDistanceMeters",
  setRestSeconds: "plannedSetRestSeconds",
  intraRepRestSeconds: "plannedIntraRepRestSeconds",
  intensityReferenceKind: "plannedIntensityReferenceKind",
  prescriptionConfidence: "plannedPrescriptionConfidence",
  ruleSetVersion: "ruleSetVersion",
  ruleSetContentHash: "ruleSetContentHash",
  prescriptionJson: "plannedPrescriptionJson",
  provenanceJson: "plannedProvenanceJson",
  rationale: "plannedRationale",
} as const;

const EXISTING_COPY_MAP = {
  sets: "plannedSets",
  reps: "plannedReps",
  distanceMeters: "plannedDistanceMeters",
  durationSeconds: "plannedDurationSeconds",
  restSeconds: "plannedRestSeconds",
  intensityPercent: "plannedIntensityPercent",
  loadKg: "plannedLoadKg",
  note: "plannedNote",
} as const;

async function sessionItemsOf(sessionId: string): Promise<SessionItem[]> {
  return prisma.sessionItem.findMany({ where: { trainingSessionId: sessionId }, orderBy: { sortOrder: "asc" } });
}

async function createSession(menuTemplateId: string, date = SESSION_DATE) {
  return createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId, date }));
}

/** RuleSet loader・planner の呼び出しを数える（createSessionFromMenu / duplicateMenu の実行中だけ）。 */
function spyRuleAccess() {
  const spies = [
    vi.spyOn(loader, "getRuleSet"),
    vi.spyOn(loader, "getActiveRuleSet"),
    vi.spyOn(loader, "selectActiveRuleSet"),
    vi.spyOn(loader, "parseProductionRuleSet"),
    vi.spyOn(loader, "listRuleSetVersions"),
    vi.spyOn(planning, "planRunningPrescription"),
    vi.spyOn(planning, "planRunningPrescriptionWithRuleSet"),
    // RuleSet を必要とする domain policy の評価も repository の中では呼ばない
    vi.spyOn(aggregation, "evaluateSessionAggregation"),
    vi.spyOn(weekly, "evaluateWeeklyContext"),
  ];
  return {
    totalCalls: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

// ---------------------------------------------------------------------------
// T-SNAP-01
// ---------------------------------------------------------------------------

describe("T-SNAP-01: v2 列のコピー（全列一致・JSON と rationale は文字列同一）", () => {
  beforeEach(resetDb);

  it("MenuItem の v2 列と既存 planned 列が SessionItem へそのままコピーされる", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const prescriptions = [planAcc(), planMvFly20(), planLsrIncomplete(), planTi(), planAssisted()];
    for (const [i, p] of prescriptions.entries()) {
      // 整形済み JSON（再直列化されていたら文字列が変わる）
      await createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: JSON.stringify(p, null, i % 2 === 0 ? 2 : 0), note: i === 0 ? "坂の手前で集合" : null }));
    }
    const sprint = await prisma.exercise.create({ data: { name: "旧スプリント", category: "SPRINT", metricType: "DISTANCE" } });
    await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: sprint.id, sets: "3", distanceMeters: "60" }));

    const menuItems = await prisma.menuItem.findMany({ where: { menuBlockId: block.id }, orderBy: { sortOrder: "asc" } });
    const session = await createSession(menu.id);
    const sessionItems = await sessionItemsOf(session.id);
    expect(sessionItems).toHaveLength(menuItems.length);

    for (const [i, menuItem] of menuItems.entries()) {
      const sessionItem = sessionItems[i];
      for (const [from, to] of [...Object.entries(V2_COPY_MAP), ...Object.entries(EXISTING_COPY_MAP)]) {
        expect(sessionItem[to as keyof SessionItem], `${menuItem.sessionTemplateId ?? "legacy"} ${from} -> ${to}`).toStrictEqual(menuItem[from as keyof typeof menuItem]);
      }
      expect(sessionItem.blockNameSnapshot).toBe("主運動");
      expect(sessionItem.sortOrder).toBe(i);
      if (menuItem.prescriptionKind === "RUNNING_V2") {
        // 文字列として完全同一（=== ）。parse / stringify / レンダラ再実行をしていない
        expect(sessionItem.plannedPrescriptionJson === menuItem.prescriptionJson).toBe(true);
        expect(sessionItem.plannedProvenanceJson === menuItem.provenanceJson).toBe(true);
        expect(sessionItem.plannedRationale === menuItem.rationale).toBe(true);
        // exerciseId = null のため既存規則 `exercise?.name ?? displayName` により displayName になる
        expect(sessionItem.exerciseId).toBeNull();
        expect(sessionItem.exerciseNameSnapshot).toBe(menuItem.displayName);
      }
    }
    // 既存の copy behavior（legacy）は変わらない
    const legacy = sessionItems[sessionItems.length - 1];
    expect(legacy).toMatchObject({ prescriptionKind: "LEGACY", exerciseId: sprint.id, exerciseNameSnapshot: "旧スプリント", plannedSets: 3, plannedDistanceMeters: 60, plannedPrescriptionJson: null });
  });

  it("loadCategory: v2 は処方 JSON の loadSnapshot.weeklyLoadCategory、legacy は Exercise.category の対応表（RuleSet を読まない）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const acc = planAcc();
    expect(acc.loadSnapshot).toEqual({ loadClass: "HIGH_NEURAL", weeklyLoadCategory: "RUNNING_HIGH_INTENSITY" });
    await createRunningMenuItem(block.id, persistInputFor(acc));
    const categories = ["SPRINT", "HURDLE", "JUMP", "STRENGTH", "DRILL"];
    for (const category of categories) {
      const ex = await prisma.exercise.create({ data: { name: `種目 ${category}`, category, metricType: "REPS" } });
      await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: ex.id }));
    }
    await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "自由入力" }));

    const session = await createSession(menu.id);
    const items = await sessionItemsOf(session.id);
    const expected = [acc.loadSnapshot!.weeklyLoadCategory, "RUNNING_HIGH_INTENSITY", "HURDLES", "PLYOMETRIC", "STRENGTH", "OTHER", null];
    expect(items.map((i) => i.loadCategory)).toEqual(expected);

    // Exercise を削除してもスナップショットは残る
    await prisma.exercise.deleteMany();
    expect((await sessionItemsOf(session.id)).map((i) => i.loadCategory)).toEqual(expected);

    // R9 以降の新規 v2 項目は loadCategory が未解決にならない
    const snapshot = planningSnapshotSchema.parse(JSON.parse((await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).planningSnapshotJson!));
    expect(snapshot.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-SNAP-02
// ---------------------------------------------------------------------------

describe("T-SNAP-02: セッション作成後に MenuItem を編集しても SessionItem は不変", () => {
  beforeEach(resetDb);

  it("repository による再計画でも、直接の列・JSON 書き換えでも、SessionItem の全列が変わらない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const item = await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const session = await createSession(menu.id);
    const before = await sessionItemsOf(session.id);

    await updateRunningMenuItem(item.id, persistInputFor(planMvFly20(), { note: "変更後" }));
    await prisma.menuItem.update({
      where: { id: item.id },
      data: { prescriptionJson: '{"edited":true}', provenanceJson: "{}", rationale: "書き換えた理由文", ruleSetVersion: "rs-edited", sets: 9, restSeconds: 1 },
    });
    await prisma.menuBlock.update({ where: { id: block.id }, data: { name: "変更後ブロック" } });

    expect(await sessionItemsOf(session.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// T-SNAP-03
// ---------------------------------------------------------------------------

function runSequence(p: RunningPrescriptionValue, times: number[]): MonitorDecision[] {
  const logs: RepLogEntry[] = [];
  const decisions: MonitorDecision[] = [];
  for (const timeS of times) {
    const obs = { setIndex: 1, repIndex: logs.length + 1, timeS, timing: "HAND" } as RepObservation;
    const d = monitorRunningPrescription({ prescription: p, priorLogs: logs }, obs);
    decisions.push(d);
    logs.push(d.logEntry);
  }
  return decisions;
}

describe("T-SNAP-03: 旧 RuleSet の session snapshot は再計画後も変わらず、monitor も旧版の基準で判定する", () => {
  beforeEach(resetDb);

  it("RuleSet A で計画 → 保存 → セッション作成 → B で再計画（MenuItem = B）→ SessionItem は A のまま・A の tolerance / stop policy で判定", async () => {
    const production = getRuleSet("rs-2026.09.0")!;
    const rsA: RuleSet = { ...structuredClone(production), ruleSetVersion: "rs-test-snap-a" };
    const rsB: RuleSet = { ...structuredClone(production), ruleSetVersion: "rs-test-snap-b" };
    for (const t of rsB.timingTolerances) if (t.toleranceS !== null) t.toleranceS = 9.99;
    const spB = rsB.stopPolicies.find((sp) => sp.id === "SP_ACC")!;
    spB.consecutiveFailuresToStop = 9;
    spB.runtime.consecutiveFailureAction = "COACH_REVIEW";

    const pA = planWith({ ruleSet: rsA, contentHash: "hash-a", isDraftFallback: true }, "ACCELERATION", "ACC_BLOCK_30");
    const { menu, block } = await makeMenuWithBlock();
    const item = await createRunningMenuItem(block.id, persistInputFor(pA));
    const session = await createSession(menu.id);
    const [snapshotBefore] = await sessionItemsOf(session.id);

    // 「現行ルールで再計算」: B で計画し直して MenuItem を更新
    const pB = planWith({ ruleSet: rsB, contentHash: "hash-b", isDraftFallback: true }, "ACCELERATION", "ACC_BLOCK_30");
    const inputB = persistInputFor(pB);
    await updateRunningMenuItem(item.id, inputB);

    const menuItemAfter = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(menuItemAfter).toMatchObject({ ruleSetVersion: "rs-test-snap-b", ruleSetContentHash: "hash-b", prescriptionJson: inputB.prescriptionJson });

    const [snapshotAfter] = await sessionItemsOf(session.id);
    expect(snapshotAfter).toEqual(snapshotBefore);
    expect(snapshotAfter).toMatchObject({ ruleSetVersion: "rs-test-snap-a", ruleSetContentHash: "hash-a" });
    expect(snapshotAfter.plannedPrescriptionJson).toBe(persistInputFor(pA).prescriptionJson);
    expect(snapshotAfter.plannedRationale).toBe(persistInputFor(pA).rationale);

    // SessionItem の A snapshot で monitor（B を読まない）
    const fromSession = runningPrescriptionSchema.parse(JSON.parse(snapshotAfter.plannedPrescriptionJson!));
    expect(fromSession.monitoringSnapshot.stopPolicy.consecutiveFailuresToStop).not.toBe(9);
    const aDecisions = runSequence(fromSession, [4.5, 4.8, 4.8]);
    expect(aDecisions.map((d) => d.action)).toEqual(["CONTINUE", "EXTEND_REST", "END_SESSION_QUALITY"]);
    expect(aDecisions[1].logEntry.toleranceS).toBe(0.25);

    // 対照: MenuItem の B では同じ観測が FAIL にならない
    const fromMenu = runningPrescriptionSchema.parse(JSON.parse(menuItemAfter.prescriptionJson!));
    expect(runSequence(fromMenu, [4.5, 4.8, 4.8]).map((d) => d.action)).toEqual(["CONTINUE", "CONTINUE", "CONTINUE"]);
  });
});

// ---------------------------------------------------------------------------
// T-SNAP-04
// ---------------------------------------------------------------------------

describe("T-SNAP-04: 壊れた JSON でもコピーは止めない", () => {
  beforeEach(resetDb);
  let spies: ReturnType<typeof spyRuleAccess> | null = null;
  afterEach(() => spies?.restore());

  it("壊れた prescriptionJson / provenanceJson はそのままコピーし、planningSnapshotJson に SNAPSHOT_JSON_INVALID（REQUIRE_COACH_REVIEW）を記録する", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const broken = await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const badProvenance = await createRunningMenuItem(block.id, persistInputFor(planTi()));
    const healthy = await createRunningMenuItem(block.id, persistInputFor(planMvFly20()));
    const BROKEN = '{"schemaVersion":1,"method":"ACCELERATION", <<truncated';
    await prisma.menuItem.update({ where: { id: broken.id }, data: { prescriptionJson: BROKEN } });
    const PROVENANCE_WITH_HEALTH = JSON.stringify({ schemaVersion: 1, soreness: 4 });
    await prisma.menuItem.update({ where: { id: badProvenance.id }, data: { provenanceJson: PROVENANCE_WITH_HEALTH } });
    const menuItems = await prisma.menuItem.findMany({ where: { menuBlockId: block.id }, orderBy: { sortOrder: "asc" } });

    spies = spyRuleAccess();
    const session = await createSession(menu.id);
    expect(spies.totalCalls()).toBe(0);

    const items = await sessionItemsOf(session.id);
    expect(items).toHaveLength(3);
    expect(items[0].plannedPrescriptionJson).toBe(BROKEN);
    expect(items[1].plannedProvenanceJson).toBe(PROVENANCE_WITH_HEALTH);
    for (const [i, menuItem] of menuItems.entries()) {
      for (const [from, to] of [...Object.entries(V2_COPY_MAP), ...Object.entries(EXISTING_COPY_MAP)]) {
        expect(items[i][to as keyof SessionItem]).toStrictEqual(menuItem[from as keyof typeof menuItem]);
      }
    }

    const stored = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    const snapshot = planningSnapshotSchema.parse(JSON.parse(stored.planningSnapshotJson!));
    const invalid = snapshot.findings.filter((f) => f.code === "SNAPSHOT_JSON_INVALID");
    expect(invalid).toEqual([
      { code: "SNAPSHOT_JSON_INVALID", severity: "REQUIRE_COACH_REVIEW", scope: "ITEM", metric: "sortOrder=0,column=plannedPrescriptionJson,reason=JSON_SYNTAX_ERROR", evidenceIds: [] },
      { code: "SNAPSHOT_JSON_INVALID", severity: "REQUIRE_COACH_REVIEW", scope: "ITEM", metric: "sortOrder=1,column=plannedProvenanceJson,reason=HEALTH_DATA_PRESENT", evidenceIds: [] },
    ]);
    // loadSnapshot を読めない（壊れた処方 JSON）項目だけ loadCategory = null + 未解決（REQUIRE_COACH_REVIEW）
    expect(items.map((i) => i.loadCategory)).toEqual([null, planTi().loadSnapshot!.weeklyLoadCategory, planMvFly20().loadSnapshot!.weeklyLoadCategory]);
    expect(snapshot.findings.filter((f) => f.code === "SNAPSHOT_LOAD_CATEGORY_UNRESOLVED")).toEqual([
      { code: "SNAPSHOT_LOAD_CATEGORY_UNRESOLVED", severity: "REQUIRE_COACH_REVIEW", scope: "ITEM", metric: "sortOrder=0", evidenceIds: [] },
    ]);
    // 健康情報や JSON の中身を finding に埋め込まない
    expect(stored.planningSnapshotJson).not.toMatch(/soreness|truncated/);
    expect(items[2].plannedPrescriptionJson).toBe(healthy.prescriptionJson);
  });
});

// ---------------------------------------------------------------------------
// T-SNAP-05
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // npm package / node builtin
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`import を解決できません: ${spec}（${path.relative(ROOT, fromFile)}）`);
}

/** 静的 import / export-from（type-only を含む）をたどった到達可能ファイル集合（リポジトリ相対パス）。 */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [path.join(ROOT, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const rel = path.relative(ROOT, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.tsx?$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?\s*$/gm)) {
      const resolved = resolveImport(file, m[1]);
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}

const RULE_ACCESS_FILES = [
  "src/domain/running/rules/loader.ts",
  "src/domain/running/rules/manifest.json",
  "src/domain/running/rules/sets/rs-2026.09.0.json",
  "src/domain/running/planning/index.ts",
  "src/domain/running/planning/build.ts",
  "src/domain/running/index.ts",
];

/** RuleSet を必要とする domain policy の評価（repository に置かない）。 */
const POLICY_EVALUATION_FILES = ["src/domain/running/aggregation/index.ts", "src/domain/running/weekly/index.ts", "src/domain/running/competition/index.ts"];

describe("T-SNAP-05: createSessionFromMenu はルールを読まない", () => {
  beforeEach(resetDb);
  let spies: ReturnType<typeof spyRuleAccess> | null = null;
  afterEach(() => spies?.restore());

  it("実行中に RuleSet loader / planner が一度も呼ばれない（spy）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    await createRunningMenuItem(block.id, persistInputFor(planLsrIncomplete()));

    spies = spyRuleAccess();
    const session = await createSession(menu.id, "2026-09-20T16:00:00+09:00");
    expect(spies.totalCalls()).toBe(0);
    expect(await prisma.sessionItem.count({ where: { trainingSessionId: session.id } })).toBe(2);

    // 対照: spy が実際に呼び出しを捕捉できること（plan は planner と loader の両方を通る）
    planning.planRunningPrescription(makeRequest("STRIDE", "ST_RELAXED"));
    expect(spies.totalCalls()).toBeGreaterThanOrEqual(2);
  });

  it("import graph: session-repository から RuleSet loader・manifest・production JSON・planner に到達しない", () => {
    const graph = importGraph("src/infra/repositories/session-repository.ts");
    expect(graph.has("src/domain/running/persistence/sessionSnapshot.ts")).toBe(true); // 監査が実際に辿れていること
    for (const file of RULE_ACCESS_FILES) expect(graph.has(file), file).toBe(false);
    for (const file of POLICY_EVALUATION_FILES) expect(graph.has(file), file).toBe(false);
    // 対照: planner からは loader / production JSON に到達する（監査が到達を検出できること）
    const plannerGraph = importGraph("src/domain/running/planning/index.ts");
    expect(plannerGraph.has("src/domain/running/rules/loader.ts")).toBe(true);
    expect(plannerGraph.has("src/domain/running/rules/sets/rs-2026.09.0.json")).toBe(true);
  });

  it("import graph: menu-repository（duplicateMenu）もルールを読まず、R9 の repository は AI 層に依存しない", () => {
    for (const file of RULE_ACCESS_FILES) expect(importGraph("src/infra/repositories/menu-repository.ts").has(file), file).toBe(false);
    for (const entry of [
      "src/infra/repositories/session-repository.ts",
      "src/infra/repositories/menu-repository.ts",
      "src/infra/repositories/running-item-repository.ts",
      "src/infra/repositories/load-history-repository.ts",
      "src/infra/repositories/competition-repository.ts",
    ]) {
      const graph = importGraph(entry);
      for (const file of RULE_ACCESS_FILES) expect(graph.has(file), `${entry} -> ${file}`).toBe(false);
      expect([...graph].filter((f) => f.startsWith("src/domain/ai/") || f.startsWith("src/infra/ai/")), entry).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// planningSnapshotJson
// ---------------------------------------------------------------------------

describe("planningSnapshotJson（作成前の読み取り専用評価）", () => {
  beforeEach(resetDb);

  it("評価が渡されなければ集計・週次とも NOT_EVALUATED（PLANNING_EVALUATION_NOT_SUPPLIED）。日付だけの入力では plannedAt を補わない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const session = await createSession(menu.id, "2026-09-20");
    const snapshot = planningSnapshotSchema.parse(JSON.parse(session.planningSnapshotJson!));
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      plannedDate: "2026-09-20",
      plannedAt: null,
      aggregation: { status: "NOT_EVALUATED", reasons: ["PLANNING_EVALUATION_NOT_SUPPLIED"] },
      weeklyContext: { status: "NOT_EVALUATED", reasons: ["PLANNING_EVALUATION_NOT_SUPPLIED"] },
      findings: [],
    });
    expect(snapshot.competitionLoadCategory).toBeUndefined();
  });

  it("タイムゾーン付きの日時入力なら plannedAt を記録する。RuleSet object・Evidence・健康情報は含めない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await createRunningMenuItem(block.id, persistInputFor(planMvFly20()));
    const session = await createSession(menu.id, "2026-09-20T16:00:00+09:00");
    const snapshot = planningSnapshotSchema.parse(JSON.parse(session.planningSnapshotJson!));
    expect(snapshot.plannedAt).toBe("2026-09-20T16:00:00+09:00");
    expect(snapshot.plannedDate).toBe("2026-09-20");
    expect(snapshot.weeklyContext).toEqual({ status: "NOT_EVALUATED", reasons: ["PLANNING_EVALUATION_NOT_SUPPLIED"] });
    expect(session.planningSnapshotJson).not.toMatch(/envelopes|evidence"|ruleSetVersion|pain|soreness|birthDate/i);
  });

  it("legacy だけのメニューでも作成でき、findings は空", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "ドリル", reps: "10" }));
    const session = await createSession(menu.id);
    expect(planningSnapshotSchema.parse(JSON.parse(session.planningSnapshotJson!)).findings).toEqual([]);
    expect(session.sessionKind).toBe("TRAINING");
    expect(session.competitionId).toBeNull();
  });
});

describe("SessionPlanningEvaluationInput（R10 application layer → repository の seam）", () => {
  beforeEach(resetDb);
  let spies: ReturnType<typeof spyRuleAccess> | null = null;
  afterEach(() => spies?.restore());

  it("WeeklyContextResult の保存用 schema は domain の型と一致する", () => {
    expectTypeOf<z.output<typeof weeklyContextResultSchema>>().toEqualTypeOf<WeeklyContextResult>();
  });

  /** [R10-B2] `createSessionFromMenu` が実際にコピーする直前の menu と同じ形・同じ計算で指紋を作る（テスト側の模擬）。 */
  async function fingerprintOfMenu(menuId: string): Promise<string> {
    const menu = await prisma.menuTemplate.findUnique({
      where: { id: menuId },
      include: { blocks: { orderBy: { sortOrder: "asc" }, include: { items: { orderBy: { sortOrder: "asc" }, include: { exercise: { select: { category: true } } } } } } },
    });
    if (!menu) throw new Error("menu not found");
    const items: FingerprintMenuItemInput[] = menu.blocks.flatMap((block) =>
      block.items.map((item) => ({
        id: item.id,
        sortOrder: item.sortOrder,
        prescriptionKind: item.prescriptionKind,
        ruleSetVersion: item.ruleSetVersion,
        ruleSetContentHash: item.ruleSetContentHash,
        prescriptionJson: item.prescriptionJson,
        sets: item.sets,
        reps: item.reps,
        distanceMeters: item.distanceMeters,
        durationSeconds: item.durationSeconds,
        restSeconds: item.restSeconds,
        intensityPercent: item.intensityPercent,
        loadKg: item.loadKg,
        exerciseCategory: item.exercise?.category ?? null,
      })),
    );
    return buildSourceMenuFingerprint(items);
  }

  /** application layer（R10）の模擬: 保存済み ruleSetVersion の RuleSet を明示的に読み、domain で評価する（テスト側で実行）。 */
  async function evaluateLikeApplicationLayer(menuId: string, entries: { menuItemId: string; prescription: RunningPrescriptionValue }[]) {
    const [first] = entries;
    const ruleSet = getRuleSet(first.prescription.ruleSet.version)!;
    const ref = { version: first.prescription.ruleSet.version, contentHash: first.prescription.ruleSet.contentHash };
    const aggregate = aggregation.evaluateSessionAggregation(
      entries.map((e) => ({ kind: "RUNNING_V2" as const, prescription: e.prescription })),
      { ruleSet, tier: first.prescription.tier, availableMinutes: 90, competitionDay: "NOT_EVALUATED", mode: "PLANNING" },
    );
    const items = entries.map((e) => ({
      menuItemId: e.menuItemId,
      result: weekly.evaluateWeeklyContext(null, {
        ruleSet,
        evaluatedAt: "2026-09-20T16:00:00+09:00" as IsoDateTime,
        method: e.prescription.method,
        loadClass: e.prescription.loadSnapshot!.loadClass,
        ageBand: "ADULT",
        hasExistingReadinessDecision: false,
      }),
    }));
    const evaluation: SessionPlanningEvaluationInput = {
      aggregation: { status: "EVALUATED", ruleSet: ref, result: aggregate },
      weeklyContext: { status: "EVALUATED", ruleSet: ref, items },
      findings: aggregate.findings,
      sourceMenuFingerprint: await fingerprintOfMenu(menuId),
    };
    return { evaluation, ref, aggregate, items };
  }

  it("渡された評価を versioned に保存し、週次は項目ごとに SessionItem の sortOrder を付ける。repository 内で評価・ルール読込をしない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const acc = planAcc();
    const mv = planMvFly20();
    const itemA = await createRunningMenuItem(block.id, persistInputFor(acc));
    await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "補強", reps: "10" }));
    const itemB = await createRunningMenuItem(block.id, persistInputFor(mv));
    const { evaluation, ref, aggregate, items } = await evaluateLikeApplicationLayer(menu.id, [
      { menuItemId: itemA.id, prescription: acc },
      { menuItemId: itemB.id, prescription: mv },
    ]);

    spies = spyRuleAccess();
    const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-20T16:00:00+09:00" }), evaluation);
    expect(spies.totalCalls()).toBe(0);

    const snapshot = planningSnapshotSchema.parse(JSON.parse(session.planningSnapshotJson!));
    const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    expect(snapshot.aggregation).toEqual(roundTrip({ status: "EVALUATED", ruleSet: ref, result: aggregate }));
    expect(snapshot.weeklyContext).toEqual(
      roundTrip({
        status: "EVALUATED",
        ruleSet: ref,
        items: [
          { menuItemId: itemA.id, sortOrder: 0, result: items[0].result },
          { menuItemId: itemB.id, sortOrder: 2, result: items[1].result },
        ],
      }),
    );
    expect(snapshot.findings).toEqual(roundTrip(aggregate.findings));
    expect(snapshot.plannedAt).toBe("2026-09-20T16:00:00+09:00");
  });

  it("保存済みの ruleSetVersion + contentHash と一致しない評価・メニュー外の項目・不正な形は保存しない（セッションを作らない）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const acc = planAcc();
    const itemA = await createRunningMenuItem(block.id, persistInputFor(acc));
    const legacy = await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "補強", reps: "10" }));
    const { evaluation, ref } = await evaluateLikeApplicationLayer(menu.id, [{ menuItemId: itemA.id, prescription: acc }]);
    const input = sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-20" });
    const weeklyItems = evaluation.weeklyContext.status === "EVALUATED" ? evaluation.weeklyContext.items : [];

    const upgraded = { ...evaluation, aggregation: { ...evaluation.aggregation, ruleSet: { ...ref, contentHash: "silently-upgraded" } } } as SessionPlanningEvaluationInput;
    await expect(createSessionFromMenu(input, upgraded)).rejects.toThrow(/aggregation の RuleSet/);
    const otherVersion = { ...evaluation, weeklyContext: { status: "EVALUATED", ruleSet: { ...ref, version: "rs-2099.01.0" }, items: weeklyItems } } as SessionPlanningEvaluationInput;
    await expect(createSessionFromMenu(input, otherVersion)).rejects.toThrow(/weeklyContext の RuleSet/);
    const foreignItem = { ...evaluation, weeklyContext: { status: "EVALUATED", ruleSet: ref, items: [{ ...weeklyItems[0], menuItemId: "not-in-this-menu" }] } } as SessionPlanningEvaluationInput;
    await expect(createSessionFromMenu(input, foreignItem)).rejects.toThrow(/RUNNING_V2 項目ではありません/);
    const legacyItem = { ...evaluation, weeklyContext: { status: "EVALUATED", ruleSet: ref, items: [{ ...weeklyItems[0], menuItemId: legacy.id }] } } as SessionPlanningEvaluationInput;
    await expect(createSessionFromMenu(input, legacyItem)).rejects.toThrow(/RUNNING_V2 項目ではありません/);
    const malformed = { ...evaluation, aggregation: { status: "DONE" } } as unknown as SessionPlanningEvaluationInput;
    await expect(createSessionFromMenu(input, malformed)).rejects.toBeInstanceOf(ZodError);
    const noReasons = { ...evaluation, weeklyContext: { status: "NOT_EVALUATED", reasons: [] } } as unknown as SessionPlanningEvaluationInput;
    await expect(createSessionFromMenu(input, noReasons)).rejects.toBeInstanceOf(ZodError);

    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("RUNNING_V2 項目の版が混在するメニューは、1版に統一した EVALUATED を保存できず、MIXED_RULESET_VERSIONS の NOT_EVALUATED なら保存できる", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const acc = planAcc();
    const olderStride = planWith({ ruleSet: { ...structuredClone(getRuleSet("rs-2026.09.0")!), ruleSetVersion: "rs-2026.03.0" }, contentHash: "older-hash", isDraftFallback: true }, "STRIDE", "ST_RELAXED");
    const itemA = await createRunningMenuItem(block.id, persistInputFor(acc));
    await createRunningMenuItem(block.id, persistInputFor(olderStride));
    const input = sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-20" });

    const { evaluation } = await evaluateLikeApplicationLayer(menu.id, [{ menuItemId: itemA.id, prescription: acc }]);
    await expect(createSessionFromMenu(input, { ...evaluation, weeklyContext: { status: "NOT_EVALUATED", reasons: ["MIXED_RULESET_VERSIONS"] } })).rejects.toThrow(
      /aggregation の RuleSet/,
    );

    const mixed: SessionPlanningEvaluationInput = {
      aggregation: { status: "NOT_EVALUATED", reasons: ["MIXED_RULESET_VERSIONS"] },
      weeklyContext: { status: "NOT_EVALUATED", reasons: ["MIXED_RULESET_VERSIONS"] },
      findings: [{ code: "MIXED_RULESET_VERSIONS", severity: "REQUIRE_COACH_REVIEW", scope: "SESSION", evidenceIds: [] }],
      sourceMenuFingerprint: await fingerprintOfMenu(menu.id),
    };
    const session = await createSessionFromMenu(input, mixed);
    const snapshot = planningSnapshotSchema.parse(JSON.parse(session.planningSnapshotJson!));
    expect(snapshot).toMatchObject({ aggregation: mixed.aggregation, weeklyContext: mixed.weeklyContext, findings: mixed.findings });
    expect((await sessionItemsOf(session.id)).map((i) => [i.ruleSetVersion, i.ruleSetContentHash])).toEqual([
      [acc.ruleSet.version, acc.ruleSet.contentHash],
      ["rs-2026.03.0", "older-hash"],
    ]);
  });

  it("competitionLoadCategory は optional（RACE / RELAY のみ）", () => {
    const base = {
      schemaVersion: 1,
      plannedDate: null,
      plannedAt: null,
      aggregation: { status: "NOT_EVALUATED", reasons: ["PLANNING_EVALUATION_NOT_SUPPLIED"] },
      weeklyContext: { status: "NOT_EVALUATED", reasons: ["PLANNING_EVALUATION_NOT_SUPPLIED"] },
      findings: [],
    };
    expect(planningSnapshotSchema.safeParse(base).success).toBe(true);
    expect(planningSnapshotSchema.safeParse({ ...base, competitionLoadCategory: "RACE" }).success).toBe(true);
    expect(planningSnapshotSchema.safeParse({ ...base, competitionLoadCategory: "RELAY" }).success).toBe(true);
    expect(planningSnapshotSchema.safeParse({ ...base, competitionLoadCategory: "OTHER" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// duplicateMenu
// ---------------------------------------------------------------------------

describe("duplicateMenu: v2 列と runningContextJson を値のままコピーする（再計算しない）", () => {
  beforeEach(resetDb);
  let spies: ReturnType<typeof spyRuleAccess> | null = null;
  afterEach(() => spies?.restore());

  it("旧 RuleSet 版の項目も ruleSetVersion / hash / JSON / provenance / rationale を変えずに複製し、ルールを読まない", async () => {
    const { menu, block } = await makeMenuWithBlock("複製元");
    const contextJson = JSON.stringify(
      {
        schemaVersion: 1,
        subject: { kind: "GROUP", label: "高校短距離", members: [], allowAdvancedMethods: false },
        plannedDate: null,
        plannedAt: null,
        availableMinutes: 120,
      },
      null,
      2,
    );
    await saveMenuRunningContext(menu.id, contextJson);
    // 旧版（テスト用に MethodMeta の load 分類だけ変えた版）。production RuleSet は変更しない
    const oldRuleSet = { ...structuredClone(getRuleSet("rs-2026.09.0")!), ruleSetVersion: "rs-2026.03.0" };
    const oldStrideMeta = oldRuleSet.methods.find((m) => m.method === "STRIDE")!;
    oldStrideMeta.loadClass = "MODERATE";
    oldStrideMeta.weeklyLoadCategory = "OTHER";
    const old = planWith({ ruleSet: oldRuleSet, contentHash: "old-hash", isDraftFallback: true }, "STRIDE", "ST_RELAXED");
    expect(old.loadSnapshot).toEqual({ loadClass: "MODERATE", weeklyLoadCategory: "OTHER" });
    expect(planStride().loadSnapshot).toEqual({ loadClass: "LOW", weeklyLoadCategory: "RUNNING_LOW_INTENSITY" });
    await createRunningMenuItem(block.id, persistInputFor(old, { prescriptionJson: JSON.stringify(old, null, 2), note: "旧版のまま" }));
    await createRunningMenuItem(block.id, persistInputFor(planLsrIncomplete()));
    await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "補強", reps: "20" }));
    const sourceItems = await prisma.menuItem.findMany({ where: { menuBlockId: block.id }, orderBy: { sortOrder: "asc" } });

    spies = spyRuleAccess();
    const copy = await duplicateMenu(menu.id);
    expect(spies.totalCalls()).toBe(0);

    expect(copy.runningContextJson).toBe(contextJson);
    const copiedItems = await prisma.menuItem.findMany({ where: { menuBlock: { menuTemplateId: copy.id } }, orderBy: { sortOrder: "asc" } });
    expect(copiedItems).toHaveLength(sourceItems.length);
    const omitIdentity = ({ id: _id, menuBlockId: _block, ...rest }: (typeof sourceItems)[number]) => {
      void _id;
      void _block;
      return rest;
    };
    for (const [i, source] of sourceItems.entries()) {
      expect(omitIdentity(copiedItems[i])).toStrictEqual(omitIdentity(source));
    }
    expect(copiedItems[0]).toMatchObject({ ruleSetVersion: "rs-2026.03.0", ruleSetContentHash: "old-hash" });
    expect(copiedItems[0].prescriptionJson === sourceItems[0].prescriptionJson).toBe(true);
    expect(copiedItems[0].provenanceJson === sourceItems[0].provenanceJson).toBe(true);
    expect(copiedItems[0].rationale === sourceItems[0].rationale).toBe(true);
    // loadSnapshot も旧版のまま（current RuleSet から作り直さない）
    expect(JSON.parse(copiedItems[0].prescriptionJson!).loadSnapshot).toEqual({ loadClass: "MODERATE", weeklyLoadCategory: "OTHER" });
    expect(JSON.parse(copiedItems[1].prescriptionJson!).loadSnapshot).toEqual(JSON.parse(sourceItems[1].prescriptionJson!).loadSnapshot);
  });
});
