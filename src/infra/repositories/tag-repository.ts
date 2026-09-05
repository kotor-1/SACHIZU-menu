import { prisma } from "@/infra/db/prisma";
import type { TagKind } from "@/domain/exercise/constants";

/**
 * タグは「なければ作る」で扱う。
 * kind + name の複合ユニークなので、同名でも kind が違えば別タグになる。
 */
export async function upsertTags(
  names: string[],
  kind: TagKind,
): Promise<string[]> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const ids: string[] = [];
  for (const name of unique) {
    const tag = await prisma.tag.upsert({
      where: { kind_name: { kind, name } },
      update: {},
      create: { kind, name },
    });
    ids.push(tag.id);
  }
  return ids;
}

export async function listTags(kind?: TagKind) {
  return prisma.tag.findMany({
    where: kind ? { kind } : undefined,
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
}

/** 実際に種目へ付いているタグだけを、使用数つきで返す（検索フィルタ用）。 */
export async function listTagsInUse() {
  const tags = await prisma.tag.findMany({
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    include: { _count: { select: { exercises: true, menus: true } } },
  });
  return tags.filter((t) => t._count.exercises > 0 || t._count.menus > 0);
}

/** どこからも参照されなくなったタグを掃除する。 */
export async function pruneOrphanTags(): Promise<number> {
  const orphans = await prisma.tag.findMany({
    where: { exercises: { none: {} }, menus: { none: {} } },
    select: { id: true },
  });
  if (orphans.length === 0) return 0;
  const { count } = await prisma.tag.deleteMany({
    where: { id: { in: orphans.map((t) => t.id) } },
  });
  return count;
}
