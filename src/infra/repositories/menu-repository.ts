import type { Prisma } from "@prisma/client";
import { prisma, type PrismaDbClient } from "@/infra/db/prisma";
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

/**
 * MenuPlanner の server authority 用 read path。
 * ownerId を where に閉じ込め、Application 層の後付け filter に依存しない。
 */
export async function findMenuForOwner(id: string, ownerId: string, db: PrismaDbClient = prisma): Promise<MenuDetail | null> {
  return db.menuTemplate.findFirst({
    where: { id, ownerId, status: { not: "ARCHIVED" } },
    include: menuDetailInclude,
  });
}

/** [R10-B1] MenuItem から親の MenuTemplate.id を辿る（running-plan-service が「この項目のメニュー」を読むため）。 */
export async function findMenuIdForItem(itemId: string): Promise<string | null> {
  const row = await prisma.menuItem.findUnique({
    where: { id: itemId },
    select: { menuBlock: { select: { menuTemplateId: true } } },
  });
  return row?.menuBlock.menuTemplateId ?? null;
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

/**
 * メニュー内のブロックを指定された順序に並べ替える（sortOrder = 配列 index）。
 * 対象ブロックがメニューに属し、ID の集合が一致・重複なしであることを検証してから atomic に更新する。
 */
export async function reorderBlocks(menuId: string, orderedBlockIds: readonly string[]) {
  return prisma.$transaction(async (tx) => {
    const blocks = await tx.menuBlock.findMany({ where: { menuTemplateId: menuId }, select: { id: true } });
    const current = blocks.map((block) => block.id).sort();
    const requested = [...orderedBlockIds].sort();
    if (current.length !== requested.length || current.some((id, index) => id !== requested[index])) {
      throw new Error("並び順の対象ブロックが一致しません");
    }
    if (new Set(orderedBlockIds).size !== orderedBlockIds.length) {
      throw new Error("並び順に重複したブロックがあります");
    }
    for (let index = 0; index < orderedBlockIds.length; index++) {
      await tx.menuBlock.update({ where: { id: orderedBlockIds[index]! }, data: { sortOrder: index } });
    }
  });
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

/** [R10-B1 §37] Action 層の事前ガード用。項目が無ければ null。 */
export async function findMenuItemPrescriptionKind(id: string): Promise<string | null> {
  const row = await prisma.menuItem.findUnique({ where: { id }, select: { prescriptionKind: true } });
  return row?.prescriptionKind ?? null;
}

/**
 * [R10-B1 §37] RUNNING_V2 の行はこの汎用 update では編集できない（専用の running-item-repository /
 * running-actions を使う）。ここでの guard は Action 層のガード（menu-actions.ts）とは独立した
 * 二重の守り ―― repository を直接呼ぶ経路（テスト・将来の別 Action）でも同じ保護を保証する。
 */
export async function updateMenuItem(id: string, input: MenuItemInput) {
  const current = await prisma.menuItem.findUnique({ where: { id }, select: { prescriptionKind: true } });
  if (current?.prescriptionKind === "RUNNING_V2") {
    throw new Error("この項目は RUNNING_V2 の処方です。専用の編集操作を使用してください。");
  }
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

/**
 * 同じブロック内の項目を指定された順序に並べ替える（sortOrder = 配列 index）。
 * 対象項目がブロックに属し、ID の集合が一致・重複なしであることを検証してから atomic に更新する。
 * RUNNING_V2 / LEGACY を問わず順序だけを変える（処方・snapshot には触れない）。
 */
export async function reorderMenuItems(blockId: string, orderedItemIds: readonly string[]) {
  return prisma.$transaction(async (tx) => {
    const items = await tx.menuItem.findMany({ where: { menuBlockId: blockId }, select: { id: true } });
    const current = items.map((item) => item.id).sort();
    const requested = [...orderedItemIds].sort();
    if (current.length !== requested.length || current.some((id, index) => id !== requested[index])) {
      throw new Error("並び順の対象項目が一致しません");
    }
    if (new Set(orderedItemIds).size !== orderedItemIds.length) {
      throw new Error("並び順に重複した項目があります");
    }
    for (let index = 0; index < orderedItemIds.length; index++) {
      await tx.menuItem.update({ where: { id: orderedItemIds[index]! }, data: { sortOrder: index } });
    }
  });
}

// --- 統合 Composer の保存（編集結果の reconcile） -----------------------------

/**
 * 統合 Composer の draft 編集結果。
 * AI 由来の項目は「materialize 済み AI ブロックの index + preview 順 index」で参照し、
 * 手動・種目差し替え・LEGACY 編集後の項目は `MenuItemInput`（menuItemInputSchema 検証済み）で新規作成する。
 */
export type ComposedBlockEditItem =
  | { kind: "AI"; previewIndex: number; note?: string | null }
  | { kind: "MANUAL"; values: MenuItemInput };

export type ComposedBlockEdit = {
  name: string;
  /** AI ブロックなら materialize 済みブロックの index（sortOrder 順）。コーチが足したブロックは null。 */
  aiBlockIndex: number | null;
  items: ComposedBlockEditItem[];
};

/**
 * 統合 Composer の保存：materialize 済み（または空）のメニューへ、コーチの編集結果を反映する。
 * `prisma.$transaction` なので、ambient transaction の中で呼ばれれば materialize と同じ transaction に合流する。
 *
 * コーチが変えてよいのは「メニュー名・ブロック内の順序・項目の削除 / 追加 / 差し替え・notes」。
 * AI 項目の処方（RUNNING_V2 / LEGACY の数値・provenance）はここでは書き換えない
 * （RUNNING_V2 の数値調整は既存の running edit Action が別途、domain の再検証付きで行う）。
 * - AI 項目は保持し、`note` が指定されていれば note だけ更新する。
 * - 参照されなかった AI 項目は削除する。ブロック内の sortOrder は送られた順に振り直す。
 */
export async function applyComposedMenuEdits(
  menuId: string,
  blocks: readonly ComposedBlockEdit[],
  menuName: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.menuTemplate.update({ where: { id: menuId }, data: { name: menuName } });

    const existing = await tx.menuBlock.findMany({
      where: { menuTemplateId: menuId },
      include: { items: { orderBy: { sortOrder: "asc" } } },
      orderBy: { sortOrder: "asc" },
    });
    const usedAiBlocks = new Set<number>();

    for (const [blockIndex, composed] of blocks.entries()) {
      let blockId: string;
      let existingItems: (typeof existing)[number]["items"] = [];
      if (composed.aiBlockIndex !== null) {
        const source = existing[composed.aiBlockIndex];
        if (source === undefined || usedAiBlocks.has(composed.aiBlockIndex)) throw new Error("COMPOSED_BLOCK_INVALID");
        usedAiBlocks.add(composed.aiBlockIndex);
        blockId = source.id;
        existingItems = source.items;
        await tx.menuBlock.update({ where: { id: blockId }, data: { sortOrder: blockIndex } });
      } else {
        const created = await tx.menuBlock.create({
          data: { menuTemplateId: menuId, name: composed.name, note: null, sortOrder: blockIndex },
          select: { id: true },
        });
        blockId = created.id;
      }

      const keptIds: string[] = [];
      for (const item of composed.items) {
        if (item.kind === "AI") {
          const existingItem = existingItems[item.previewIndex];
          if (existingItem === undefined || keptIds.includes(existingItem.id)) throw new Error("COMPOSED_ITEM_INVALID");
          if (item.note !== undefined) {
            await tx.menuItem.update({ where: { id: existingItem.id }, data: { note: item.note } });
          }
          keptIds.push(existingItem.id);
        } else {
          const created = await tx.menuItem.create({
            data: { ...item.values, menuBlockId: blockId, sortOrder: keptIds.length },
            select: { id: true },
          });
          keptIds.push(created.id);
        }
      }

      await tx.menuItem.deleteMany({ where: { menuBlockId: blockId, id: { notIn: keptIds } } });
      for (const [index, id] of keptIds.entries()) {
        await tx.menuItem.update({ where: { id }, data: { sortOrder: index } });
      }
    }

    // コーチが Composer から丸ごと消した AI ブロック（通常 UI では起きないが、送られなかったものは残さない）。
    const droppedBlockIds = existing.filter((_, index) => !usedAiBlocks.has(index)).map((block) => block.id);
    if (droppedBlockIds.length > 0) await tx.menuBlock.deleteMany({ where: { id: { in: droppedBlockIds } } });
  });
}
