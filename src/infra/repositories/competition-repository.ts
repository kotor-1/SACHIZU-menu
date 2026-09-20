import type { Prisma } from "@prisma/client";
import { prisma, type PrismaDbClient } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { competitionInputSchema, type CompetitionInput } from "@/domain/running/persistence/competition";
import type { CompetitionRef } from "@/domain/running/competition/schema";

/**
 * 大会カレンダー（Competition）の CRUD primitive（§15.4・§16.1）。
 * 計画用のデータであり、エンジンの第4層ではない。Action / 画面は R10・R11。
 * 書込み前に `competitionInputSchema` で検証する（priority の列挙・date 必須・endDate >= date）。
 */

function toData(input: CompetitionInput) {
  const parsed = competitionInputSchema.parse(input);
  return {
    name: parsed.name,
    date: new Date(parsed.date),
    endDate: parsed.endDate === null ? null : new Date(parsed.endDate),
    priority: parsed.priority,
    note: parsed.note,
  };
}

export async function createCompetition(input: CompetitionInput) {
  return prisma.competition.create({ data: { ...toData(input), ownerId: DEFAULT_OWNER_ID } });
}

export async function updateCompetition(id: string, input: CompetitionInput) {
  const updated = await prisma.competition.updateMany({
    where: { id, ownerId: DEFAULT_OWNER_ID },
    data: toData(input),
  });
  if (updated.count === 0) return null;
  return findCompetition(id);
}

/** 削除しても練習記録は残る（TrainingSession.competitionId は onDelete: SetNull）。 */
export async function deleteCompetition(id: string) {
  const deleted = await prisma.competition.deleteMany({ where: { id, ownerId: DEFAULT_OWNER_ID } });
  return deleted.count === 1;
}

export async function findCompetition(id: string) {
  return prisma.competition.findFirst({ where: { id, ownerId: DEFAULT_OWNER_ID } });
}

/** 期間指定（from 以上・to 以下の date）で大会を日付順に返す。 */
export async function listCompetitions(
  range: { from?: Date; to?: Date } = {},
  ownerId = DEFAULT_OWNER_ID,
  db: PrismaDbClient = prisma,
) {
  const date: Prisma.DateTimeFilter = {};
  if (range.from) date.gte = range.from;
  if (range.to) date.lte = range.to;
  return db.competition.findMany({
    where: { ownerId, ...(range.from || range.to ? { date } : {}) },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
}

/** DB の DateTime（書込み時に `new Date("YYYY-MM-DD")` = UTC 0:00 で保存）を IsoDate に戻す。 */
function toIsoDate(value: Date): CompetitionRef["date"] {
  return value.toISOString().slice(0, 10) as CompetitionRef["date"];
}

/**
 * [R10-B2.1] Running v2 domain の `CompetitionRef[]` として全件返す（read-only）。
 * planner（R10-B1）と session 評価（R10-B2）が共有する唯一の adapter。開催期間の判定に必要な
 * `endDate` を落とさない（null は1日開催）。
 */
export async function listCompetitionRefs(ownerId = DEFAULT_OWNER_ID, db: PrismaDbClient = prisma): Promise<CompetitionRef[]> {
  const rows = await listCompetitions({}, ownerId, db);
  return rows.map((c) => ({
    id: c.id,
    date: toIsoDate(c.date),
    endDate: c.endDate === null ? null : toIsoDate(c.endDate),
    priority: c.priority as CompetitionRef["priority"],
  }));
}
