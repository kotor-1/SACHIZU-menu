import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const {
  createCompetitionAction,
  deleteCompetitionAction,
  updateCompetitionAction,
} = await import("@/actions/competition-actions");

function form(overrides: Record<string, string> = {}) {
  const data = new FormData();
  const values = {
    name: "県選手権",
    date: "2026-10-10",
    endDate: "",
    priority: "NORMAL",
    note: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function expectSafeValidation(result: unknown) {
  const raw = JSON.stringify(result);
  for (const fragment of ["Invalid enum", "Expected", "received", "union", "tuple", "literal", "TRAINING_MEET", "NORMAL", "IMPORTANT", "PEAK"]) {
    expect(raw).not.toContain(fragment);
  }
  expect(raw).toMatch(/[ぁ-んァ-ン一-龯]/);
}

describe("R11-B5 competition actions", () => {
  beforeEach(resetDb);

  it("大会を作成し、空の endDate/note を null で保存する", async () => {
    const result = await createCompetitionAction(null, form());
    expect(result).toMatchObject({ ok: true, kind: "CREATED" });
    expect(await prisma.competition.findFirst()).toMatchObject({
      name: "県選手権", endDate: null, note: null, priority: "NORMAL", ownerId: "default-coach",
    });
  });

  it.each([
    ["name", ""],
    ["date", "2026-02-30"],
    ["endDate", "2026-10-09"],
    ["priority", "WORLD"],
  ])("invalid %s を拒否してwrite 0", async (key, value) => {
    const result = await createCompetitionAction(null, form({ [key]: value }));
    expect(result).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expectSafeValidation(result);
    expect(await prisma.competition.count()).toBe(0);
  });

  it("不要なclient-derived fieldをstrictに拒否する", async () => {
    const input = form();
    input.set("ownerId", "other-coach");
    input.set("loadCategory", "RACE");
    const result = await createCompetitionAction(null, input);
    expect(result).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expectSafeValidation(result);
    expect(await prisma.competition.count()).toBe(0);
  });

  it("大会を更新する", async () => {
    const created = await prisma.competition.create({ data: { name: "before", date: new Date("2026-10-10") } });
    const result = await updateCompetitionAction(created.id, null, form({
      name: "after", endDate: "2026-10-11", priority: "PEAK", note: "標準記録狙い",
    }));
    expect(result).toMatchObject({ ok: true, kind: "UPDATED" });
    expect(await prisma.competition.findUnique({ where: { id: created.id } })).toMatchObject({ name: "after", priority: "PEAK", note: "標準記録狙い" });
  });

  it("更新でも同じschemaで不正な日程と長すぎるnoteを拒否する", async () => {
    const created = await prisma.competition.create({ data: { name: "before", date: new Date("2026-10-10") } });
    const before = await prisma.competition.findUniqueOrThrow({ where: { id: created.id } });
    expect(await updateCompetitionAction(created.id, null, form({ endDate: "2026-10-09" }))).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expect(await updateCompetitionAction(created.id, null, form({ note: "x".repeat(1001) }))).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expect(await prisma.competition.findUniqueOrThrow({ where: { id: created.id } })).toEqual(before);
  });

  it("存在しないIDと他ownerはNOT_FOUNDで情報を漏らさない", async () => {
    expect(await updateCompetitionAction("missing", null, form())).toMatchObject({ ok: false, kind: "NOT_FOUND" });
    const other = await prisma.competition.create({ data: { name: "secret", date: new Date("2026-10-10"), ownerId: "other-coach" } });
    const update = await updateCompetitionAction(other.id, null, form({ name: "overwrite" }));
    expect(update).toMatchObject({ ok: false, kind: "NOT_FOUND" });
    expect(JSON.stringify(update)).not.toContain("secret");
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: other.id } })).name).toBe("secret");
  });

  it("大会を削除してもTrainingSessionは残りcompetitionIdだけnullになる", async () => {
    const competition = await prisma.competition.create({ data: { name: "race", date: new Date("2026-10-10") } });
    const session = await prisma.trainingSession.create({
      data: { title: "race session", date: new Date("2026-10-10"), competitionId: competition.id, sessionKind: "COMPETITION" },
    });
    const input = new FormData();
    input.set("competitionId", competition.id);
    expect(await deleteCompetitionAction(null, input)).toMatchObject({ ok: true, kind: "DELETED" });
    expect(await prisma.competition.findUnique({ where: { id: competition.id } })).toBeNull();
    expect(await prisma.trainingSession.findUnique({ where: { id: session.id } })).toMatchObject({ competitionId: null });
  });

  it("削除対象のmissing/他ownerをNOT_FOUNDにする", async () => {
    const input = new FormData();
    input.set("competitionId", "missing");
    expect(await deleteCompetitionAction(null, input)).toMatchObject({ ok: false, kind: "NOT_FOUND" });
    const other = await prisma.competition.create({ data: { name: "other", date: new Date("2026-10-10"), ownerId: "other-coach" } });
    input.set("competitionId", other.id);
    expect(await deleteCompetitionAction(null, input)).toMatchObject({ ok: false, kind: "NOT_FOUND" });
    expect(await prisma.competition.findUnique({ where: { id: other.id } })).not.toBeNull();
  });
});
