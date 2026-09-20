import { Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import {
  competitionParticipationInputSchema,
  type CompetitionParticipationInput,
  type ParsedCompetitionParticipationInput,
} from "@/domain/running/persistence/competitionParticipation";
import {
  buildCompetitionPlanningSnapshot,
  readCompetitionLoadCategories,
} from "@/domain/running/persistence/sessionSnapshot";
import { isoDateSchema } from "@/domain/running/types/primitives";
import { prisma } from "@/infra/db/prisma";

export type RecordCompetitionParticipationResult =
  | { kind: "RECORDED"; sessionId: string }
  | { kind: "ALREADY_RECORDED"; sessionId: string }
  | { kind: "CONFLICT_EXISTING_RECORD"; sessionId: string | null }
  | { kind: "COMPETITION_NOT_FOUND" }
  | { kind: "DATE_OUTSIDE_COMPETITION" }
  | { kind: "FUTURE_ACTUAL_RECORD" }
  | { kind: "SAVE_FAILED" };
type CompetitionParticipationAttemptResult = Exclude<RecordCompetitionParticipationResult, { kind: "SAVE_FAILED" }>;

function isoDateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function sameCategories(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function attemptRecord(
  client: PrismaClient,
  input: ParsedCompetitionParticipationInput,
  today: string,
): Promise<Exclude<RecordCompetitionParticipationResult, { kind: "SAVE_FAILED" }>> {
  return client.$transaction<CompetitionParticipationAttemptResult>(async (tx: Prisma.TransactionClient) => {
    const competition = await tx.competition.findFirst({
      where: { id: input.competitionId, ownerId: DEFAULT_OWNER_ID },
      select: { id: true, name: true, date: true, endDate: true },
    });
    if (competition === null) return { kind: "COMPETITION_NOT_FOUND" };

    const date = new Date(input.date);
    const nextDate = new Date(date);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const existing = await tx.trainingSession.findMany({
      where: {
        ownerId: DEFAULT_OWNER_ID,
        competitionId: competition.id,
        sessionKind: "COMPETITION",
        date: { gte: date, lt: nextDate },
      },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { items: true } } },
    });
    if (existing.length > 1) return { kind: "CONFLICT_EXISTING_RECORD", sessionId: null };
    if (existing.length === 1) {
      const row = existing[0];
      const categories = readCompetitionLoadCategories(row.planningSnapshotJson);
      const normal = row.status === "COMPLETED" && row._count.items === 0;
      if (
        normal
        && categories.kind === "RESOLVED"
        && categories.source !== "HISTORICAL_FALLBACK"
        && sameCategories(categories.categories, input.loadCategories)
      ) {
        return { kind: "ALREADY_RECORDED", sessionId: row.id };
      }
      return { kind: "CONFLICT_EXISTING_RECORD", sessionId: row.id };
    }

    const start = isoDateOf(competition.date);
    const end = competition.endDate === null ? start : isoDateOf(competition.endDate);
    if (input.date < start || input.date > end) return { kind: "DATE_OUTSIDE_COMPETITION" };
    if (input.date > today) return { kind: "FUTURE_ACTUAL_RECORD" };

    const snapshot = buildCompetitionPlanningSnapshot(input.date, input.loadCategories);
    const created = await tx.trainingSession.create({
      data: {
        ownerId: DEFAULT_OWNER_ID,
        title: competition.name,
        date,
        status: "COMPLETED",
        sessionKind: "COMPETITION",
        competitionId: competition.id,
        planningSnapshotJson: JSON.stringify(snapshot),
        sourceMenuTemplateId: null,
        sourceMenuNameSnapshot: null,
        groupName: null,
        location: null,
        weather: null,
        condition: null,
        coachNote: null,
      },
    });
    return { kind: "RECORDED", sessionId: created.id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function isRetryableCompetitionWrite(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (["P1008", "P2028", "P2034"].includes(error.code)) return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /SQLITE_BUSY|database is locked|write conflict|deadlock/i.test(message);
}

/**
 * 1大会・1開催日を1実績にする Serializable transaction。
 * lock/write conflict のときだけ transaction 全体を1回再実行する。
 */
export async function recordCompetitionParticipation(
  rawInput: CompetitionParticipationInput,
  options: { today: string; client?: PrismaClient },
): Promise<RecordCompetitionParticipationResult> {
  const input = competitionParticipationInputSchema.parse(rawInput);
  const today = isoDateSchema.parse(options.today);
  const client = options.client ?? prisma;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await attemptRecord(client, input, today);
    } catch (error) {
      if (attempt === 0 && isRetryableCompetitionWrite(error)) continue;
      return { kind: "SAVE_FAILED" };
    }
  }
  return { kind: "SAVE_FAILED" };
}

export async function listCompetitionSessions(competitionId: string) {
  return prisma.trainingSession.findMany({
    where: { ownerId: DEFAULT_OWNER_ID, competitionId, sessionKind: "COMPETITION" },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, date: true, status: true, planningSnapshotJson: true },
  });
}
