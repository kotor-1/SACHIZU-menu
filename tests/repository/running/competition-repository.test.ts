/**
 * R9 — Competition の CRUD primitive と入力検証（§16.1・§19.1）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import {
  createCompetition,
  deleteCompetition,
  findCompetition,
  listCompetitions,
  updateCompetition,
} from "@/infra/repositories/competition-repository";
import { resetDb } from "../../helpers";

const base = { name: "県選手権", date: "2026-10-10", endDate: null, note: null };

describe("competition repository", () => {
  beforeEach(resetDb);

  it("作成・取得・更新・削除。priority の既定は NORMAL、owner は既定コーチ", async () => {
    const created = await createCompetition(base);
    expect(created).toMatchObject({ name: "県選手権", priority: "NORMAL", ownerId: DEFAULT_OWNER_ID, endDate: null, note: null });
    expect(created.date.toISOString()).toBe("2026-10-10T00:00:00.000Z");

    const updated = await updateCompetition(created.id, { ...base, name: "県選手権（2日目まで）", endDate: "2026-10-11", priority: "PEAK", note: "標準記録狙い" });
    expect(updated).toMatchObject({ priority: "PEAK", note: "標準記録狙い" });
    expect(updated?.endDate?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(await findCompetition(created.id)).toMatchObject({ name: "県選手権（2日目まで）" });

    await deleteCompetition(created.id);
    expect(await findCompetition(created.id)).toBeNull();
  });

  it.each(["TRAINING_MEET", "NORMAL", "IMPORTANT", "PEAK"])("priority %s を受け付ける", async (priority) => {
    expect((await createCompetition({ ...base, priority: priority as "PEAK" })).priority).toBe(priority);
  });

  it("priority の列挙外・date 欠落・実在しない日付・endDate < date を拒否する（書き込まない）", async () => {
    const invalid: unknown[] = [
      { ...base, priority: "WORLD" },
      { ...base, date: "" },
      { name: "日付なし", endDate: null, note: null },
      { ...base, date: "2026-02-30" },
      { ...base, date: "2026/10/10" },
      { ...base, endDate: "2026-10-09" },
      { ...base, name: "   " },
      { ...base, unknownKey: 1 },
    ];
    for (const input of invalid) {
      await expect(createCompetition(input as never)).rejects.toBeInstanceOf(ZodError);
    }
    expect(await prisma.competition.count()).toBe(0);
    // endDate == date は許可
    await expect(createCompetition({ ...base, endDate: base.date })).resolves.toMatchObject({ name: "県選手権" });
  });

  it("更新でも同じ検証を行う", async () => {
    const created = await createCompetition(base);
    await expect(updateCompetition(created.id, { ...base, endDate: "2026-10-01" })).rejects.toBeInstanceOf(ZodError);
    expect((await findCompetition(created.id))?.endDate).toBeNull();
  });

  it("一覧は owner で絞り、日付順。期間（from 以上・to 以下）で絞れる", async () => {
    await createCompetition({ ...base, name: "C", date: "2026-11-01" });
    await createCompetition({ ...base, name: "A", date: "2026-09-01" });
    await createCompetition({ ...base, name: "B", date: "2026-10-01" });
    await prisma.competition.create({ data: { name: "他コーチ", date: new Date("2026-10-01"), ownerId: "other-coach" } });

    expect((await listCompetitions()).map((c) => c.name)).toEqual(["A", "B", "C"]);
    expect((await listCompetitions({ from: new Date("2026-10-01"), to: new Date("2026-11-01") })).map((c) => c.name)).toEqual(["B", "C"]);
  });

  it("取得・更新・削除は既定 owner の大会だけを対象にする", async () => {
    const other = await prisma.competition.create({
      data: { name: "他コーチ大会", date: new Date("2026-10-10"), ownerId: "other-coach" },
    });
    expect(await findCompetition(other.id)).toBeNull();
    expect(await updateCompetition(other.id, base)).toBeNull();
    expect(await deleteCompetition(other.id)).toBe(false);
    expect(await prisma.competition.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it("大会を削除しても練習記録は残り、competitionId だけ null になる（onDelete: SetNull）", async () => {
    const competition = await createCompetition({ ...base, priority: "IMPORTANT" });
    const session = await prisma.trainingSession.create({
      data: { title: "県選手権", date: new Date("2026-10-10"), sessionKind: "COMPETITION", competitionId: competition.id },
    });
    await deleteCompetition(competition.id);
    expect(await prisma.trainingSession.findUnique({ where: { id: session.id } })).toMatchObject({ sessionKind: "COMPETITION", competitionId: null });
  });
});
