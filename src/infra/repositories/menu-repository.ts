import type { Prisma } from "@prisma/client";
import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import {
  MENU_PAGE_SIZE,
  type MenuBlockInput,
  type MenuInput,
  type MenuItemInput,
  type MenuSearch,
} from "@/domain/menu/schema";
import { DEFAULT_BLOCK_NAMES } from "@/domain/menu/constants";
import { upsertTags } from "./tag-repository";

const menuDetailInclude = {
  tags: { include: { tag: true } },
  blocks: {
    orderBy: { sortOrder: "asc" },
    include: {
      items: {
        orderBy: { sortOrder: "asc" },
        include: {
          exercise: {
            select: {
              id: true,
              name: true,
              category: true,
              metricType: true,
              difficulty: true,
              status: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.MenuTemplateInclude;

export type MenuDetail = Prisma.MenuTemplateGetPayload<{
  include: typeof menuDetailInclude;
}>;
export type MenuBlockDetail = MenuDetail["blocks"][number];
export type MenuItemDetail = MenuBlockDetail["items"][number];

function buildWhere(search: MenuSearch): Prisma.MenuTemplateWhereInput {
  const and: Prisma.MenuTemplateWhereInput[] = [{ ownerId: DEFAULT_OWNER_ID }];

  if (search.q) {
    and.push({
      OR: [
        { name: { contains: search.q } },
        { description: { contains: search.q } },
        { purpose: { contains: search.q } },
        // メニュー内に含まれる種目名でも引っかかるようにする
        {
          blocks: {
            some: { items: { some: { exercise: { name: { contains: search.q } } } } },
          },
        },
      ],
    });
  }
  if (search.phase) and.push({ phase: search.phase });
  if (search.status) and.push({ status: search.status });
  for (const tagId of search.tag) and.push({ tags: { some: { tagId } } });

  return { AND: and };
}

export async function searchMenus(search: MenuSearch) {
  const where = buildWhere(search);
  const skip = (search.page - 1) * MENU_PAGE_SIZE;

  const orderBy: Prisma.MenuTemplateOrderByWithRelationInput[] =
    search.sort === "nameAsc"
      ? [{ name: "asc" }]
      : search.sort === "createdDesc"
        ? [{ createdAt: "desc" }]
        : [{ updatedAt: "desc" }];

  const [items, total] = await Promise.all([
    prisma.menuTemplate.findMany({
      where,
      orderBy,
      skip,
      take: MENU_PAGE_SIZE,
      include: {
        tags: { include: { tag: true } },
        blocks: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            name: true,
            _count: { select: { items: true } },
          },
        },
        _count: { select: { sessions: true } },
      },
    }),
    prisma.menuTemplate.count({ where }),
  ]);

  return {
    items,
    total,
    page: search.page,
    pageSize: MENU_PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / MENU_PAGE_SIZE)),
  };
}

export type MenuListItem = Awaited<ReturnType<typeof searchMenus>>["items"][number];

export async function findMenu(id: string): Promise<MenuDetail | null> {
  return prisma.menuTemplate.findUnique({ where: { id }, include: menuDetailInclude });
}

export async function listMenusForPicker() {
  return prisma.menuTemplate.findMany({
    where: { ownerId: DEFAULT_OWNER_ID, status: { not: "ARCHIVED" } },
    select: { id: true, name: true, phase: true, estimatedMinutes: true },
    orderBy: { updatedAt: "desc" },
  });
}

// --- メニュー本体 -----------------------------------------------------------

export async function createMenu(input: MenuInput, withDefaultBlocks = true) {
  const tagIds = await upsertTags(input.tags, "GENERAL");
  const { tags: _tags, ...scalar } = input;
  void _tags;

  return prisma.menuTemplate.create({
    data: {
      ...scalar,
      ownerId: DEFAULT_OWNER_ID,
      tags: { create: tagIds.map((tagId) => ({ tagId })) },
      blocks: withDefaultBlocks
        ? {
            create: DEFAULT_BLOCK_NAMES.map((name, i) => ({ name, sortOrder: i })),
          }
        : undefined,
    },
  });
}

export async function updateMenu(id: string, input: MenuInput) {
  const tagIds = await upsertTags(input.tags, "GENERAL");
  const { tags: _tags, ...scalar } = input;
  void _tags;

  return prisma.$transaction(async (tx) => {
    await tx.menuTag.deleteMany({ where: { menuTemplateId: id } });
    return tx.menuTemplate.update({
      where: { id },
      data: { ...scalar, tags: { create: tagIds.map((tagId) => ({ tagId })) } },
    });
  });
}

export async function deleteMenu(id: string) {
  return prisma.menuTemplate.delete({ where: { id } });
}

/**
 * メニューを複製する。
 * 「先週のメニューをベースに今週のを作る」が最頻の使い方なので基本機能として持つ。
 *
 * Running v2 の列も値のままコピーする（§15.3）。ruleSetVersion / contentHash / prescriptionJson /
 * provenanceJson / rationale は旧版のまま残し、現行ルールで再計算しない。
 */
export async function duplicateMenu(id: string) {
  const source = await findMenu(id);
  if (!source) throw new Error("複製元のメニューが見つかりません");

  return prisma.menuTemplate.create({
    data: {
      ownerId: source.ownerId,
      name: `${source.name} のコピー`,
      description: source.description,
      purpose: source.purpose,
      phase: source.phase,
      estimatedMinutes: source.estimatedMinutes,
      status: "DRAFT",
      runningContextJson: source.runningContextJson,
      tags: { create: source.tags.map((t) => ({ tagId: t.tagId })) },
      blocks: {
        create: source.blocks.map((block) => ({
          name: block.name,
          note: block.note,
          sortOrder: block.sortOrder,
          items: {
            create: block.items.map((item) => ({
              exerciseId: item.exerciseId,
              displayName: item.displayName,
              sortOrder: item.sortOrder,
              sets: item.sets,
              reps: item.reps,
              distanceMeters: item.distanceMeters,
              durationSeconds: item.durationSeconds,
              restSeconds: item.restSeconds,
              intensityPercent: item.intensityPercent,
              loadKg: item.loadKg,
              note: item.note,
              prescriptionKind: item.prescriptionKind,
              runningMethod: item.runningMethod,
              sessionTemplateId: item.sessionTemplateId,
              recoveryStructure: item.recoveryStructure,
              buildUpDistanceMeters: item.buildUpDistanceMeters,
              flyZoneDistanceMeters: item.flyZoneDistanceMeters,
              setRestSeconds: item.setRestSeconds,
              intraRepRestSeconds: item.intraRepRestSeconds,
              intensityReferenceKind: item.intensityReferenceKind,
              prescriptionConfidence: item.prescriptionConfidence,
              ruleSetVersion: item.ruleSetVersion,
              ruleSetContentHash: item.ruleSetContentHash,
              prescriptionJson: item.prescriptionJson,
              provenanceJson: item.provenanceJson,
              rationale: item.rationale,
            })),
          },
        })),
      },
    },
  });
}

// --- ブロック ---------------------------------------------------------------

export async function addBlock(menuTemplateId: string, input: MenuBlockInput) {
  const max = await prisma.menuBlock.aggregate({
    where: { menuTemplateId },
    _max: { sortOrder: true },
  });
  return prisma.menuBlock.create({
    data: { ...input, menuTemplateId, sortOrder: (max._max.sortOrder ?? -1) + 1 },
  });
}

export async function updateBlock(id: string, input: MenuBlockInput) {
  return prisma.menuBlock.update({ where: { id }, data: input });
}

export async function deleteBlock(id: string) {
  return prisma.menuBlock.delete({ where: { id } });
}

/** ブロックを 1 つ上/下へ動かす。sortOrder を隣と交換する。 */
export async function moveBlock(id: string, direction: "up" | "down") {
  const block = await prisma.menuBlock.findUnique({ where: { id } });
  if (!block) throw new Error("ブロックが見つかりません");

  const neighbor = await prisma.menuBlock.findFirst({
    where: {
      menuTemplateId: block.menuTemplateId,
      sortOrder: direction === "up" ? { lt: block.sortOrder } : { gt: block.sortOrder },
    },
    orderBy: { sortOrder: direction === "up" ? "desc" : "asc" },
  });
  if (!neighbor) return;

  await prisma.$transaction([
    prisma.menuBlock.update({ where: { id: block.id }, data: { sortOrder: neighbor.sortOrder } }),
    prisma.menuBlock.update({ where: { id: neighbor.id }, data: { sortOrder: block.sortOrder } }),
  ]);
}

// --- アイテム（処方）--------------------------------------------------------

export async function addMenuItem(menuBlockId: string, input: MenuItemInput) {
  const max = await prisma.menuItem.aggregate({
    where: { menuBlockId },
    _max: { sortOrder: true },
  });
  return prisma.menuItem.create({
    data: { ...input, menuBlockId, sortOrder: (max._max.sortOrder ?? -1) + 1 },
  });
}

export async function updateMenuItem(id: string, input: MenuItemInput) {
  return prisma.menuItem.update({ where: { id }, data: input });
}

export async function deleteMenuItem(id: string) {
  return prisma.menuItem.delete({ where: { id } });
}

export async function moveMenuItem(id: string, direction: "up" | "down") {
  const item = await prisma.menuItem.findUnique({ where: { id } });
  if (!item) throw new Error("項目が見つかりません");

  const neighbor = await prisma.menuItem.findFirst({
    where: {
      menuBlockId: item.menuBlockId,
      sortOrder: direction === "up" ? { lt: item.sortOrder } : { gt: item.sortOrder },
    },
    orderBy: { sortOrder: direction === "up" ? "desc" : "asc" },
  });
  if (!neighbor) return;

  await prisma.$transaction([
    prisma.menuItem.update({ where: { id: item.id }, data: { sortOrder: neighbor.sortOrder } }),
    prisma.menuItem.update({ where: { id: neighbor.id }, data: { sortOrder: item.sortOrder } }),
  ]);
}
