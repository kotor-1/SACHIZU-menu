import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { recordCompetitionParticipation } from "@/infra/repositories/competition-session-repository";
import { buildCompetitionPlanningSnapshot, readCompetitionLoadCategories } from "@/domain/running/persistence/sessionSnapshot";
import {
  addSessionItem,
  deleteSession,
  deleteSessionItem,
  setSessionStatus,
  toggleSessionItemDone,
  updateSession,
  updateSessionItemResult,
} from "@/infra/repositories/session-repository";
import { resetDb } from "../helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { recordCompetitionParticipationAction } = await import("@/actions/competition-actions");

const TODAY = "2026-09-20";
let extraClients: PrismaClient[] = [];

function actionForm(competitionId: string, categories: string[], date = TODAY) {
  const form = new FormData();
  form.set("competitionId", competitionId);
  form.set("date", date);
  for (const category of categories) form.append("loadCategories", category);
  return form;
}

function expectSafeParticipationValidation(result: unknown) {
  const raw = JSON.stringify(result);
  for (const fragment of ["Invalid enum", "Expected", "received", "union", "tuple", "literal", "RACE", "RELAY"]) {
    expect(raw).not.toContain(fragment);
  }
  expect(raw).toMatch(/[ぁ-んァ-ン一-龯]/);
}

async function competition(overrides: { date?: string; endDate?: string | null; ownerId?: string } = {}) {
  return prisma.competition.create({
    data: {
      name: "県選手権",
      date: new Date(overrides.date ?? "2026-09-19"),
      endDate: overrides.endDate ? new Date(overrides.endDate) : null,
      ownerId: overrides.ownerId ?? "default-coach",
    },
  });
}

describe("R11-B6 competition participation action/repository", () => {
  beforeEach(resetDb);
  afterEach(async () => {
    await Promise.all(extraClients.map((client) => client.$disconnect()));
    extraClients = [];
  });

  it("itemless COMPLETED Competition Sessionを正しいsnapshot形で作る", async () => {
    const c = await competition();
    const result = await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RELAY", "RACE"] }, { today: TODAY });
    expect(result).toMatchObject({ kind: "RECORDED" });
    const row = await prisma.trainingSession.findFirstOrThrow({ include: { items: true } });
    expect(row).toMatchObject({
      ownerId: "default-coach", title: "県選手権", status: "COMPLETED", sessionKind: "COMPETITION",
      competitionId: c.id, sourceMenuTemplateId: null, sourceMenuNameSnapshot: null,
      groupName: null, location: null, weather: null, condition: null, coachNote: null,
    });
    expect(row.items).toEqual([]);
    expect(readCompetitionLoadCategories(row.planningSnapshotJson)).toEqual({ kind: "RESOLVED", source: "PLURAL", categories: ["RACE", "RELAY"] });
    expect(JSON.parse(row.planningSnapshotJson!)).not.toHaveProperty("competitionLoadCategory");
  });

  it.each([
    [[], "INVALID_INPUT"],
    [["RACE", "RACE"], "INVALID_INPUT"],
    [["WORLD"], "INVALID_INPUT"],
  ])("Actionが不正category %jをrejectしてwrite 0", async (categories, kind) => {
    const c = await competition();
    const result = await recordCompetitionParticipationAction(null, actionForm(c.id, categories));
    expect(result).toMatchObject({ ok: false, kind });
    expectSafeParticipationValidation(result);
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("invalid dateとunknown extra fieldをsafe validationでrejectしてwrite 0", async () => {
    const c = await competition();
    const invalidDate = await recordCompetitionParticipationAction(null, actionForm(c.id, ["RACE"], "2026-02-30"));
    expect(invalidDate).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expectSafeParticipationValidation(invalidDate);

    const extra = actionForm(c.id, ["RELAY"]);
    extra.set("sessionKind", "COMPETITION");
    const extraResult = await recordCompetitionParticipationAction(null, extra);
    expect(extraResult).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expectSafeParticipationValidation(extraResult);
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("owner/range/futureをserver authorityで拒否する", async () => {
    const c = await competition({ date: "2026-09-18", endDate: "2026-09-20" });
    expect(await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-17", loadCategories: ["RACE"] }, { today: TODAY }))
      .toEqual({ kind: "DATE_OUTSIDE_COMPETITION" });
    const future = await competition({ date: "2026-09-21" });
    expect(await recordCompetitionParticipation({ competitionId: future.id, date: "2026-09-21", loadCategories: ["RACE"] }, { today: TODAY }))
      .toEqual({ kind: "FUTURE_ACTUAL_RECORD" });
    const other = await competition({ ownerId: "other-coach" });
    expect(await recordCompetitionParticipation({ competitionId: other.id, date: "2026-09-19", loadCategories: ["RACE"] }, { today: TODAY }))
      .toEqual({ kind: "COMPETITION_NOT_FOUND" });
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("same keyはexact setならALREADY、different setならCONFLICTで1行を維持", async () => {
    const c = await competition();
    const input = { competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] as ["RACE"] };
    expect(await recordCompetitionParticipation(input, { today: TODAY })).toMatchObject({ kind: "RECORDED" });
    expect(await recordCompetitionParticipation(input, { today: TODAY })).toMatchObject({ kind: "ALREADY_RECORDED" });
    expect(await recordCompetitionParticipation({ ...input, loadCategories: ["RACE", "RELAY"] }, { today: TODAY })).toMatchObject({ kind: "CONFLICT_EXISTING_RECORD" });
    expect(await prisma.trainingSession.count()).toBe(1);
  });

  it("idempotency keyは時刻ではなくnormalized calendar dateで照合する", async () => {
    const c = await competition();
    const existing = await prisma.trainingSession.create({ data: {
      title: c.name,
      date: new Date("2026-09-19T12:00:00.000Z"),
      ownerId: "default-coach",
      competitionId: c.id,
      sessionKind: "COMPETITION",
      status: "COMPLETED",
      planningSnapshotJson: JSON.stringify(buildCompetitionPlanningSnapshot("2026-09-19", ["RACE"])),
    } });
    expect(await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] }, { today: TODAY }))
      .toEqual({ kind: "ALREADY_RECORDED", sessionId: existing.id });
    expect(await prisma.trainingSession.count()).toBe(1);
  });

  it("historical fallback/CANCELLED/duplicate historical rowsを一致証拠にせずCONFLICT", async () => {
    const c = await competition();
    await prisma.trainingSession.create({ data: { title: "old", date: new Date("2026-09-19"), competitionId: c.id, sessionKind: "COMPETITION", status: "CANCELLED" } });
    expect(await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] }, { today: TODAY })).toMatchObject({ kind: "CONFLICT_EXISTING_RECORD" });
    await prisma.trainingSession.create({ data: { title: "old2", date: new Date("2026-09-19"), competitionId: c.id, sessionKind: "COMPETITION", status: "COMPLETED" } });
    expect(await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] }, { today: TODAY })).toEqual({ kind: "CONFLICT_EXISTING_RECORD", sessionId: null });
  });

  it("Competition edit/delete後もSession snapshotを維持し、削除訂正後は再記録できる", async () => {
    const c = await competition();
    const first = await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] }, { today: TODAY });
    if (first.kind !== "RECORDED") throw new Error("fixture failed");
    await prisma.competition.update({ where: { id: c.id }, data: { name: "改名", date: new Date("2026-09-18"), endDate: new Date("2026-09-19"), priority: "PEAK" } });
    expect(await prisma.trainingSession.findUniqueOrThrow({ where: { id: first.sessionId } })).toMatchObject({ title: "県選手権", date: new Date("2026-09-19") });
    expect(await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] }, { today: TODAY })).toMatchObject({ kind: "ALREADY_RECORDED" });
    await prisma.trainingSession.delete({ where: { id: first.sessionId } });
    expect(await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE", "RELAY"] }, { today: TODAY })).toMatchObject({ kind: "RECORDED" });
    await prisma.competition.delete({ where: { id: c.id } });
    const remaining = await prisma.trainingSession.findFirstOrThrow();
    expect(remaining).toMatchObject({ competitionId: null, title: "改名", status: "COMPLETED" });
    expect(readCompetitionLoadCategories(remaining.planningSnapshotJson)).toMatchObject({ categories: ["RACE", "RELAY"] });
  });

  it("generic date/status/item mutationをserver-sideで拒否する", async () => {
    const c = await competition();
    const result = await recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] }, { today: TODAY });
    if (result.kind !== "RECORDED") throw new Error("fixture failed");
    const sessionInput = { title: "rewrite", date: "2026-09-18", groupName: null, location: null, weather: null, condition: null, status: "PLANNED" as const, coachNote: null };
    await expect(updateSession(result.sessionId, sessionInput)).rejects.toThrow(/大会実績/);
    await expect(setSessionStatus(result.sessionId, "IN_PROGRESS")).rejects.toThrow(/大会実績/);
    await expect(addSessionItem(result.sessionId, { exerciseNameSnapshot: "fake", blockNameSnapshot: "fake" })).rejects.toThrow(/大会実績/);
    expect(await prisma.sessionItem.count()).toBe(0);
  });

  it("大会実績の削除はowner scopedで、他owner rowを訂正対象にできない", async () => {
    const other = await prisma.trainingSession.create({ data: {
      title: "secret race", date: new Date("2026-09-19"), ownerId: "other-coach", sessionKind: "COMPETITION", status: "COMPLETED",
      planningSnapshotJson: JSON.stringify(buildCompetitionPlanningSnapshot("2026-09-19", ["RACE"])),
    } });
    expect(await deleteSession(other.id)).toBe(false);
    expect(await prisma.trainingSession.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it("historical Competition Session itemもgeneric result/toggle/delete経路を使えない", async () => {
    const session = await prisma.trainingSession.create({ data: {
      title: "historical", date: new Date("2026-09-19"), sessionKind: "COMPETITION", status: "COMPLETED",
      items: { create: { exerciseNameSnapshot: "legacy item", blockNameSnapshot: "old" } },
    }, include: { items: true } });
    const item = session.items[0];
    await expect(updateSessionItemResult(item.id, { actualSets: 1, actualReps: null, actualDistanceMeters: null, actualDurationSeconds: null, actualLoadKg: null, actualNote: null, done: true })).rejects.toThrow(/大会実績/);
    await expect(toggleSessionItemDone(item.id)).rejects.toThrow();
    await expect(deleteSessionItem(item.id)).rejects.toThrow(/大会実績/);
    expect(await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ done: false, actualSets: null });
  });

  it("独立Prisma接続の同一payload競合でも最大1 Session", async () => {
    const c = await competition();
    const one = new PrismaClient();
    const two = new PrismaClient();
    extraClients.push(one, two);
    const input = { competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] as ["RACE"] };
    const results = await Promise.all([
      recordCompetitionParticipation(input, { today: TODAY, client: one }),
      recordCompetitionParticipation(input, { today: TODAY, client: two }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["ALREADY_RECORDED", "RECORDED"]);
    expect(await prisma.trainingSession.count()).toBe(1);
    expect(results.some((result) => result.kind === "RECORDED")).toBe(true);
    expect(results.every((result) => ["RECORDED", "ALREADY_RECORDED", "SAVE_FAILED"].includes(result.kind))).toBe(true);
  }, 30_000);

  it("独立Prisma接続の異なるcategory競合でもwinning set 1件だけ", async () => {
    const c = await competition();
    const one = new PrismaClient();
    const two = new PrismaClient();
    extraClients.push(one, two);
    const results = await Promise.all([
      recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE"] }, { today: TODAY, client: one }),
      recordCompetitionParticipation({ competitionId: c.id, date: "2026-09-19", loadCategories: ["RACE", "RELAY"] }, { today: TODAY, client: two }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["CONFLICT_EXISTING_RECORD", "RECORDED"]);
    expect(await prisma.trainingSession.count()).toBe(1);
    expect(results.some((result) => result.kind === "RECORDED")).toBe(true);
    expect(results.every((result) => ["RECORDED", "CONFLICT_EXISTING_RECORD", "SAVE_FAILED"].includes(result.kind))).toBe(true);
    const saved = await prisma.trainingSession.findFirstOrThrow();
    const read = readCompetitionLoadCategories(saved.planningSnapshotJson);
    expect(read).toMatchObject({ kind: "RESOLVED", categories: results[0].kind === "RECORDED" ? ["RACE"] : ["RACE", "RELAY"] });
  }, 30_000);
});
