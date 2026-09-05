import type { Prisma } from "@prisma/client";
import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import {
  SESSION_PAGE_SIZE,
  type SessionFromMenuInput,
  type SessionInput,
  type SessionItemResultInput,
  type SessionSearch,
} from "@/domain/session/schema";

const sessionDetailInclude = {
  items: {
    orderBy: { sortOrder: "asc" },
    include: {
      exercise: { select: { id: true, name: true, category: true, status: true } },
    },
  },
  sourceMenuTemplate: { select: { id: true, name: true } },
} satisfies Prisma.TrainingSessionInclude;

export type SessionDetail = Prisma.TrainingSessionGetPayload<{
  include: typeof sessionDetailInclude;
}>;
export type SessionItemDetail = SessionDetail["items"][number];

function buildWhere(search: SessionSearch): Prisma.TrainingSessionWhereInput {
  const and: Prisma.TrainingSessionWhereInput[] = [{ ownerId: DEFAULT_OWNER_ID }];

  if (search.q) {
    and.push({
      OR: [
        { title: { contains: search.q } },
        { groupName: { contains: search.q } },
        { location: { contains: search.q } },
        { coachNote: { contains: search.q } },
      ],
    });
  }
  if (search.status) and.push({ status: search.status });
  if (search.from && !Number.isNaN(Date.parse(search.from))) {
    and.push({ date: { gte: new Date(search.from) } });
  }
  if (search.to && !Number.isNaN(Date.parse(search.to))) {
    // 終端は「その日いっぱい」を含めたいので翌日 0 時未満で比較する
    const to = new Date(search.to);
    to.setHours(23, 59, 59, 999);
    and.push({ date: { lte: to } });
  }

  return { AND: and };
}

export async function searchSessions(search: SessionSearch) {
  const where = buildWhere(search);
  const skip = (search.page - 1) * SESSION_PAGE_SIZE;

  const [items, total] = await Promise.all([
    prisma.trainingSession.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take: SESSION_PAGE_SIZE,
      include: {
        sourceMenuTemplate: { select: { id: true, name: true } },
        _count: { select: { items: true } },
        items: { select: { done: true } },
      },
    }),
    prisma.trainingSession.count({ where }),
  ]);

  return {
    items,
    total,
    page: search.page,
    pageSize: SESSION_PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE)),
  };
}

export type SessionListItem = Awaited<
  ReturnType<typeof searchSessions>
>["items"][number];

export async function findSession(id: string): Promise<SessionDetail | null> {
  return prisma.trainingSession.findUnique({
    where: { id },
    include: sessionDetailInclude,
  });
}

export async function listUpcomingSessions(limit = 5) {
  return prisma.trainingSession.findMany({
    where: { ownerId: DEFAULT_OWNER_ID, status: { in: ["PLANNED", "IN_PROGRESS"] } },
    orderBy: { date: "asc" },
    take: limit,
    include: { _count: { select: { items: true } } },
  });
}

export async function createSession(input: SessionInput) {
  return prisma.trainingSession.create({
    data: { ...input, date: new Date(input.date), ownerId: DEFAULT_OWNER_ID },
  });
}

export async function updateSession(id: string, input: SessionInput) {
  return prisma.trainingSession.update({
    where: { id },
    data: { ...input, date: new Date(input.date) },
  });
}

export async function deleteSession(id: string) {
  return prisma.trainingSession.delete({ where: { id } });
}

/**
 * ============================================================================
 * メニューテンプレート → セッション の展開（この層の中核）
 * ============================================================================
 *
 * ここが Menu と Session の責務分離を実際に成立させている処理。
 *
 * ブロック/アイテムを「参照」ではなく「コピー」して SessionItem を作る。
 * その結果:
 *   - 後からテンプレートを編集しても、過去のセッション記録は一切変わらない
 *   - 種目名が変わっても・種目が消えても、記録には当時の名前が残る
 *   - セッション側の順序変更や項目追加がテンプレートに逆流しない
 *
 * exerciseId は「後から辿れると便利」なので残すが、
 * 記録の正しさはこの参照に依存しない（onDelete: SetNull で切れても平気）。
 */
export async function createSessionFromMenu(input: SessionFromMenuInput) {
  const menu = await prisma.menuTemplate.findUnique({
    where: { id: input.menuTemplateId },
    include: {
      blocks: {
        orderBy: { sortOrder: "asc" },
        include: {
          items: {
            orderBy: { sortOrder: "asc" },
            include: { exercise: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!menu) throw new Error("メニューが見つかりません");

  // ブロックをまたいで通し番号を振り直す（セッションは 1 本のリストとして扱う）
  let sortOrder = 0;
  const items = menu.blocks.flatMap((block) =>
    block.items.map((item) => ({
      exerciseId: item.exerciseId,
      exerciseNameSnapshot:
        item.exercise?.name ?? item.displayName ?? "（名称未設定）",
      blockNameSnapshot: block.name,
      sortOrder: sortOrder++,
      plannedSets: item.sets,
      plannedReps: item.reps,
      plannedDistanceMeters: item.distanceMeters,
      plannedDurationSeconds: item.durationSeconds,
      plannedRestSeconds: item.restSeconds,
      plannedIntensityPercent: item.intensityPercent,
      plannedLoadKg: item.loadKg,
      plannedNote: item.note,
    })),
  );

  return prisma.trainingSession.create({
    data: {
      ownerId: DEFAULT_OWNER_ID,
      title: input.title ?? menu.name,
      date: new Date(input.date),
      sourceMenuTemplateId: menu.id,
      sourceMenuNameSnapshot: menu.name,
      groupName: input.groupName,
      location: input.location,
      status: "PLANNED",
      items: { create: items },
    },
  });
}

// --- 実施記録 ---------------------------------------------------------------

export async function updateSessionItemResult(
  id: string,
  input: SessionItemResultInput,
) {
  return prisma.sessionItem.update({ where: { id }, data: input });
}

/** チェックボックスだけの高速トグル（実施中の現場で一番使う操作）。 */
export async function toggleSessionItemDone(id: string) {
  const item = await prisma.sessionItem.findUnique({
    where: { id },
    select: { done: true, trainingSessionId: true },
  });
  if (!item) throw new Error("項目が見つかりません");

  const updated = await prisma.sessionItem.update({
    where: { id },
    data: { done: !item.done },
  });

  // 1 つでも実施済みになったら、セッションを「実施中」へ自動で進める
  if (updated.done) {
    await prisma.trainingSession.updateMany({
      where: { id: item.trainingSessionId, status: "PLANNED" },
      data: { status: "IN_PROGRESS" },
    });
  }
  return updated;
}

export async function deleteSessionItem(id: string) {
  return prisma.sessionItem.delete({ where: { id } });
}

/** セッションに、テンプレートに無かった項目を後から足す。 */
export async function addSessionItem(
  trainingSessionId: string,
  data: {
    exerciseId?: string | null;
    exerciseNameSnapshot: string;
    blockNameSnapshot: string;
  },
) {
  const max = await prisma.sessionItem.aggregate({
    where: { trainingSessionId },
    _max: { sortOrder: true },
  });
  return prisma.sessionItem.create({
    data: { ...data, trainingSessionId, sortOrder: (max._max.sortOrder ?? -1) + 1 },
  });
}
