import type { Prisma } from "@prisma/client";
import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { competitionInputSchema, type CompetitionInput } from "@/domain/running/persistence/competition";

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
  return prisma.competition.update({ where: { id }, data: toData(input) });
}

/** 削除しても練習記録は残る（TrainingSession.competitionId は onDelete: SetNull）。 */
export async function deleteCompetition(id: string) {
  return prisma.competition.delete({ where: { id } });
}

export async function findCompetition(id: string) {
  return prisma.competition.findUnique({ where: { id } });
}

/** 期間指定（from 以上・to 以下の date）で大会を日付順に返す。 */
export async function listCompetitions(range: { from?: Date; to?: Date } = {}) {
  const date: Prisma.DateTimeFilter = {};
  if (range.from) date.gte = range.from;
  if (range.to) date.lte = range.to;
  return prisma.competition.findMany({
    where: { ownerId: DEFAULT_OWNER_ID, ...(range.from || range.to ? { date } : {}) },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
}
