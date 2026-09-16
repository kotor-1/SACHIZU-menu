/**
 * R9 — TrainingSession / SessionItem → LoadEvent（§12.1・§12.2）。
 * repository は事実の変換だけを行い、48h / 72h・taper・phase・readiness の判定を持たない。
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infra/db/prisma";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { loadEventSchema, type WeeklyHistoryInput } from "@/domain/running/types/load";
import { evaluateWeeklyContext } from "@/domain/running/weekly";
import { getRuleSet } from "@/domain/running/rules/loader";
import type { IsoDateTime } from "@/domain/running/types/primitives";
import { addMenuItem } from "@/infra/repositories/menu-repository";
import { listLoadHistory } from "@/infra/repositories/load-history-repository";
import { createRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { createSessionFromMenu } from "@/infra/repositories/session-repository";
import { resetDb } from "../../helpers";
import { makeMenuWithBlock, persistInputFor, planAcc, planStride } from "./fixtures";

const AS_OF = new Date("2026-09-20T07:00:00.000Z");
const hoursBefore = (h: number, ms = 0) => new Date(AS_OF.getTime() - h * 3600 * 1000 - ms);

async function session(date: Date, items: Prisma.SessionItemCreateWithoutTrainingSessionInput[], o: { status?: string; sessionKind?: string } = {}) {
  return prisma.trainingSession.create({
    data: { title: "練習", date, status: o.status ?? "COMPLETED", sessionKind: o.sessionKind ?? "TRAINING", items: { create: items } },
  });
}

const ACC_JSON = JSON.stringify(planAcc());
const STRIDE_JSON = JSON.stringify(planStride());

/** createSessionFromMenu が作る v2 SessionItem と同じ形（計画 JSON + loadCategory スナップショット）。 */
const v2Item = (o: Partial<Prisma.SessionItemCreateWithoutTrainingSessionInput> = {}): Prisma.SessionItemCreateWithoutTrainingSessionInput => ({
  exerciseNameSnapshot: "ブロックスタート30m",
  blockNameSnapshot: "主運動",
  prescriptionKind: "RUNNING_V2",
  runningMethod: "ACCELERATION",
  sessionTemplateId: "ACC_BLOCK_30",
  plannedPrescriptionJson: ACC_JSON,
  loadCategory: "RUNNING_HIGH_INTENSITY",
  done: true,
  ...o,
});

const notSupplied = { status: "NOT_EVALUATED", reasons: ["PLANNING_EVALUATION_NOT_SUPPLIED"] };
const competitionSnapshot = (competitionLoadCategory?: "RACE" | "RELAY") =>
  JSON.stringify({ schemaVersion: 1, plannedDate: null, plannedAt: null, aggregation: notSupplied, weeklyContext: notSupplied, findings: [], ...(competitionLoadCategory ? { competitionLoadCategory } : {}) });

async function competitionSession(date: Date, planningSnapshotJson: string | null, status = "COMPLETED") {
  return prisma.trainingSession.create({ data: { title: "大会", date, status, sessionKind: "COMPETITION", planningSnapshotJson } });
}

async function legacyItem(category: string | null, o: Partial<Prisma.SessionItemCreateWithoutTrainingSessionInput> = {}) {
  const exercise = category === null ? null : await prisma.exercise.create({ data: { name: `種目 ${category}`, category, metricType: "REPS" } });
  return {
    exerciseNameSnapshot: exercise?.name ?? "自由入力",
    blockNameSnapshot: "主運動",
    done: true,
    ...(exercise ? { exercise: { connect: { id: exercise.id } } } : {}),
    ...o,
  } satisfies Prisma.SessionItemCreateWithoutTrainingSessionInput;
}

describe("load history: v2 / legacy の変換", () => {
  beforeEach(resetDb);

  it("v2 HIGH / LOW: category は SessionItem.loadCategory、intensityTag は plan 時点の loadSnapshot.loadClass（RuleSet に問い合わせない）", async () => {
    const s = await session(hoursBefore(24), [
      v2Item(),
      v2Item({ runningMethod: "STRIDE", sessionTemplateId: "ST_RELAXED", plannedPrescriptionJson: STRIDE_JSON, loadCategory: "RUNNING_LOW_INTENSITY", sortOrder: 1 }),
    ]);
    const { events, unresolved } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(unresolved).toEqual([]);
    expect(events).toEqual([
      {
        at: hoursBefore(24).toISOString(),
        category: "RUNNING_HIGH_INTENSITY",
        method: "ACCELERATION",
        templateId: "ACC_BLOCK_30",
        sessionKey: s.id,
        intensityTag: "HIGH",
        magnitude: {},
        source: "SESSION_RECORD",
        completion: "DONE",
      },
      expect.objectContaining({ category: "RUNNING_LOW_INTENSITY", method: "STRIDE", templateId: "ST_RELAXED", intensityTag: "LOW", sessionKey: s.id }),
    ]);
    for (const e of events) expect(loadEventSchema.safeParse(e).success).toBe(true);
  });

  it("createSessionFromMenu で作った v2 項目は loadSnapshot から分類される（未解決にならない）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const created = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-19" }));

    const { events, unresolved } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(unresolved).toEqual([]);
    expect(events).toEqual([
      {
        at: new Date("2026-09-19").toISOString(),
        category: "RUNNING_HIGH_INTENSITY",
        method: "ACCELERATION",
        templateId: "ACC_BLOCK_30",
        sessionKey: created.id,
        intensityTag: "HIGH",
        magnitude: {},
        source: "SESSION_RECORD",
        completion: "PLANNED_NOT_CONFIRMED",
      },
    ]);
  });

  it("v2 の計画 JSON が null / 壊れている / loadSnapshot の無い旧 snapshot なら intensityTag は UNKNOWN、category は loadCategory ?? OTHER（捏造しない）", async () => {
    const old = JSON.parse(ACC_JSON);
    delete old.loadSnapshot;
    await session(hoursBefore(24), [
      v2Item({ plannedPrescriptionJson: null, loadCategory: "RUNNING_HIGH_INTENSITY" }),
      v2Item({ plannedPrescriptionJson: "{broken", loadCategory: null, sortOrder: 1 }),
      v2Item({ plannedPrescriptionJson: JSON.stringify(old), loadCategory: null, sortOrder: 2 }),
      v2Item({ plannedPrescriptionJson: JSON.stringify(old), loadCategory: "RUNNING_HIGH_INTENSITY", sortOrder: 3 }),
    ]);
    const { events, unresolved } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(unresolved).toEqual([]);
    expect(events.map((e) => [e.category, e.intensityTag])).toEqual([
      ["RUNNING_HIGH_INTENSITY", "UNKNOWN"],
      ["OTHER", "UNKNOWN"],
      ["OTHER", "UNKNOWN"],
      ["RUNNING_HIGH_INTENSITY", "UNKNOWN"],
    ]);
  });

  it("LoadEvent の契約を満たせない行（method と template の不整合）は推測で直さず unresolved に返す", async () => {
    const s = await session(hoursBefore(24), [v2Item({ sessionTemplateId: "ST_RELAXED" })]);
    const [item] = await prisma.sessionItem.findMany({ where: { trainingSessionId: s.id } });
    const { events, unresolved } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(events).toEqual([]);
    expect(unresolved).toEqual([{ sessionKey: s.id, sessionItemId: item.id, at: hoursBefore(24).toISOString(), reason: "LOAD_EVENT_CONTRACT_INVALID" }]);
  });

  it("legacy: SPRINT / HURDLE / JUMP / STRENGTH の対応表、それ以外は OTHER。強度は常に UNKNOWN", async () => {
    const items = [];
    for (const [i, category] of ["SPRINT", "HURDLE", "JUMP", "STRENGTH", "CORE"].entries()) items.push(await legacyItem(category, { sortOrder: i }));
    await session(hoursBefore(30), items);
    const { events } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(events.map((e) => [e.category, e.intensityTag, e.method, e.templateId])).toEqual([
      ["RUNNING_HIGH_INTENSITY", "UNKNOWN", null, null],
      ["HURDLES", "UNKNOWN", null, null],
      ["PLYOMETRIC", "UNKNOWN", null, null],
      ["STRENGTH", "UNKNOWN", null, null],
      ["OTHER", "UNKNOWN", null, null],
    ]);
  });

  it("Exercise 削除済みの legacy 項目は SessionItem.loadCategory のスナップショット、無ければ OTHER", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const jump = await prisma.exercise.create({ data: { name: "バウンディング", category: "JUMP", metricType: "DISTANCE" } });
    await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: jump.id, sets: "3" }));
    await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "自由入力の補強" }));
    const created = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-19" }));
    await prisma.exercise.delete({ where: { id: jump.id } });

    const { events } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(events.map((e) => [e.category, e.intensityTag, e.sessionKey])).toEqual([
      ["PLYOMETRIC", "UNKNOWN", created.id],
      ["OTHER", "UNKNOWN", created.id],
    ]);
  });
});

describe("load history: 実施状況・大会・時間窓", () => {
  beforeEach(resetDb);

  it("過去日付で PLANNED のままなら PLANNED_NOT_CONFIRMED（履歴に含める）。未チェックは未確認、中止理由ありは PARTIAL、CANCELLED は含めない", async () => {
    await session(hoursBefore(50), [v2Item({ done: false })], { status: "PLANNED" });
    await session(hoursBefore(40), [v2Item({ done: false }), v2Item({ done: true, stopReason: "END_SESSION_QUALITY", sortOrder: 1 })], { status: "IN_PROGRESS" });
    await session(hoursBefore(30), [v2Item()], { status: "CANCELLED" });
    const { events } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(events.map((e) => e.completion)).toEqual(["PLANNED_NOT_CONFIRMED", "PLANNED_NOT_CONFIRMED", "PARTIAL"]);
  });

  it("asOf 以降のセッション（未来の予定）は混ぜない。asOf ちょうども除外（窓は [asOf - windowHours, asOf)）", async () => {
    await session(new Date(AS_OF.getTime() - 1), [v2Item()], { status: "PLANNED" });
    await session(AS_OF, [v2Item()], { status: "PLANNED" });
    await session(new Date(AS_OF.getTime() + 24 * 3600 * 1000), [v2Item()], { status: "PLANNED" });
    const { events, asOf } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(asOf).toBe(AS_OF.toISOString());
    expect(events.map((e) => e.at)).toEqual([new Date(AS_OF.getTime() - 1).toISOString()]);
  });

  it("窓の下端はちょうどを含み、1ms 前は含まない。72h / 7日 / 28日を同じ関数で取得できる", async () => {
    await session(hoursBefore(72), [v2Item()]);
    await session(hoursBefore(72, 1), [v2Item()]);
    await session(hoursBefore(24 * 7), [v2Item()]);
    await session(hoursBefore(24 * 28), [v2Item()]);
    await session(hoursBefore(24 * 28, 1), [v2Item()]);

    const h72 = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(h72.windowStart).toBe(hoursBefore(72).toISOString());
    expect(h72.events.map((e) => e.at)).toEqual([hoursBefore(72).toISOString()]);
    expect((await listLoadHistory({ asOf: AS_OF, windowHours: 24 * 7 })).events).toHaveLength(3);
    expect((await listLoadHistory({ asOf: AS_OF, windowHours: 24 * 28 })).events).toHaveLength(4);
  });

  it("大会: 明示 RACE → RACE / HIGH、明示 RELAY → RELAY / HIGH、種別なし → RACE（generic fallback）/ HIGH", async () => {
    const race = await competitionSession(hoursBefore(30), competitionSnapshot("RACE"));
    const relay = await competitionSession(hoursBefore(28), competitionSnapshot("RELAY"));
    const missingInSnapshot = await competitionSession(hoursBefore(26), competitionSnapshot());
    const noSnapshot = await competitionSession(hoursBefore(24), null, "PLANNED");
    const { events, unresolved } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    expect(unresolved).toEqual([]);
    expect(events.map((e) => [e.sessionKey, e.category, e.intensityTag, e.source, e.completion, e.method, e.templateId])).toEqual([
      [race.id, "RACE", "HIGH", "COMPETITION_RECORD", "DONE", null, null],
      [relay.id, "RELAY", "HIGH", "COMPETITION_RECORD", "DONE", null, null],
      [missingInSnapshot.id, "RACE", "HIGH", "COMPETITION_RECORD", "DONE", null, null],
      [noSnapshot.id, "RACE", "HIGH", "COMPETITION_RECORD", "PLANNED_NOT_CONFIRMED", null, null],
    ]);
  });

  it("大会の距離・露出は推測しない: 種別不明でも明示でも unknown 区間（0 にしない・リレー区間距離を作らない）", async () => {
    await competitionSession(hoursBefore(30), competitionSnapshot("RELAY"));
    await competitionSession(hoursBefore(24), null);
    const { events } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    const unknown = { lower: null, upper: null, unit: "m", source: "UNKNOWN", confidence: "NONE" };
    for (const e of events) {
      expect(e.magnitude).toEqual({ distanceM: unknown, highSpeedExposureM: unknown });
      expect(e.magnitude.contacts).toBeUndefined();
      expect(e.magnitude.attempts).toBeUndefined();
    }
  });

  it.each([["RACE"], ["RELAY"], ["fallback"]] as const)("大会（%s）は R7 の 48h ガードで HIGH イベントとして機能する", async (kind) => {
    await competitionSession(hoursBefore(24), kind === "fallback" ? null : competitionSnapshot(kind));
    const { events } = await listLoadHistory({ asOf: AS_OF, windowHours: 72 });
    const history: WeeklyHistoryInput = { events, coverage72h: "COMPLETE", coverage7d: "PARTIAL", coverage28d: "PARTIAL", dailyActivity7d: [] };
    const result = evaluateWeeklyContext(history, {
      ruleSet: getRuleSet("rs-2026.09.0")!,
      evaluatedAt: AS_OF.toISOString() as IsoDateTime,
      method: "MAX_VELOCITY",
      loadClass: "HIGH_NEURAL",
      ageBand: "ADULT",
      hasExistingReadinessDecision: false,
    });
    expect(result.events48h).toHaveLength(1);
    expect(result.findings.filter((f) => f.code === "WEEKLY_HIGH_WITHIN_48H").map((f) => f.severity)).toEqual(["BLOCK_AUTOGEN", "REQUIRE_COACH_REVIEW"]);
    expect(result.autogenBlockedMethods).toContain("MAX_VELOCITY");
    expect(result.highSessions7d).toBe(1);
  });

  it("不正な asOf / windowHours は拒否する", async () => {
    await expect(listLoadHistory({ asOf: new Date("invalid"), windowHours: 72 })).rejects.toThrow(/asOf/);
    await expect(listLoadHistory({ asOf: AS_OF, windowHours: 0 })).rejects.toThrow(/windowHours/);
    await expect(listLoadHistory({ asOf: AS_OF, windowHours: Number.NaN })).rejects.toThrow(/windowHours/);
  });

  it("repository に判定ポリシー（48h / 72h・taper・phase・readiness・pain・recovery・閾値）を持たない（コメントを除くソース監査）", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/infra/repositories/load-history-repository.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(48|72)\b/);
    expect(code).not.toMatch(/taper|phase|readiness|pain|recovery|threshold|getRuleSet|getActiveRuleSet/i);
    // v2 の強度を category から推定しない（loadSnapshot.loadClass だけ）
    expect(code).not.toMatch(/RUNNING_HIGH_INTENSITY|RUNNING_LOW_INTENSITY/);
  });
});
