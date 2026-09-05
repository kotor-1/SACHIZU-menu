import type { Prisma } from "@prisma/client";
import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import {
  EXERCISE_PAGE_SIZE,
  type ExerciseInput,
  type ExerciseSearch,
} from "@/domain/exercise/schema";
import { upsertTags } from "./tag-repository";

const withRelations = {
  targets: true,
  tags: { include: { tag: true } },
} satisfies Prisma.ExerciseInclude;

export type ExerciseWithRelations = Prisma.ExerciseGetPayload<{
  include: typeof withRelations;
}>;

/**
 * 検索条件 → Prisma where。
 *
 * 注意: SQLite provider は `mode: "insensitive"` を持たない。
 * LIKE は ASCII のみ大文字小文字を無視するが、
 * 日本語主体の本アプリでは実用上問題にならないためそのまま contains を使う。
 */
function buildWhere(search: ExerciseSearch): Prisma.ExerciseWhereInput {
  const and: Prisma.ExerciseWhereInput[] = [{ ownerId: DEFAULT_OWNER_ID }];

  if (search.q) {
    and.push({
      OR: [
        { name: { contains: search.q } },
        { nameKana: { contains: search.q } },
        { description: { contains: search.q } },
        { coachingPoint: { contains: search.q } },
      ],
    });
  }
  if (search.category) and.push({ category: search.category });
  if (search.status) and.push({ status: search.status });
  if (search.difficulty !== "" && search.difficulty !== undefined) {
    and.push({ difficulty: search.difficulty });
  }
  if (search.target) and.push({ targets: { some: { target: search.target } } });

  // タグは AND 条件（「ハードル」かつ「初心者向け」で絞りたいため）
  for (const tagId of search.tag) {
    and.push({ tags: { some: { tagId } } });
  }

  return { AND: and };
}

function buildOrderBy(
  sort: ExerciseSearch["sort"],
): Prisma.ExerciseOrderByWithRelationInput[] {
  switch (sort) {
    case "nameAsc":
      return [{ nameKana: "asc" }, { name: "asc" }];
    case "difficultyAsc":
      return [{ difficulty: "asc" }, { name: "asc" }];
    case "createdDesc":
      return [{ createdAt: "desc" }];
    case "updatedDesc":
    default:
      return [{ updatedAt: "desc" }];
  }
}

export async function searchExercises(search: ExerciseSearch) {
  const where = buildWhere(search);
  const skip = (search.page - 1) * EXERCISE_PAGE_SIZE;

  const [items, total] = await Promise.all([
    prisma.exercise.findMany({
      where,
      include: withRelations,
      orderBy: buildOrderBy(search.sort),
      skip,
      take: EXERCISE_PAGE_SIZE,
    }),
    prisma.exercise.count({ where }),
  ]);

  return {
    items,
    total,
    page: search.page,
    pageSize: EXERCISE_PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / EXERCISE_PAGE_SIZE)),
  };
}

export async function findExercise(id: string) {
  return prisma.exercise.findUnique({
    where: { id },
    include: {
      ...withRelations,
      videoAssets: true,
      // どのメニューで使われているかを詳細画面で見せる（削除時の影響確認にも使う）
      menuItems: {
        include: {
          menuBlock: { include: { menuTemplate: { select: { id: true, name: true } } } },
        },
        take: 50,
      },
    },
  });
}

/** 名前だけの軽量リスト。メニュー編集の種目ピッカー用。 */
export async function listExercisesForPicker() {
  return prisma.exercise.findMany({
    where: { ownerId: DEFAULT_OWNER_ID, status: { not: "ARCHIVED" } },
    select: {
      id: true,
      name: true,
      category: true,
      metricType: true,
      difficulty: true,
      defaultSets: true,
      defaultReps: true,
      defaultDistanceMeters: true,
      defaultDurationSeconds: true,
      defaultRestSeconds: true,
    },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
}

export type ExercisePickerItem = Awaited<
  ReturnType<typeof listExercisesForPicker>
>[number];

/** 入力から、タグ / 対象能力を除いたスカラー部分だけ取り出す。 */
function scalarFields(input: ExerciseInput) {
  const {
    targets: _t,
    generalTags: _g,
    equipmentTags: _e,
    bodyPartTags: _b,
    ...scalar
  } = input;
  void _t;
  void _g;
  void _e;
  void _b;
  return scalar;
}

async function resolveTagIds(input: ExerciseInput): Promise<string[]> {
  const [general, equipment, bodyPart] = await Promise.all([
    upsertTags(input.generalTags, "GENERAL"),
    upsertTags(input.equipmentTags, "EQUIPMENT"),
    upsertTags(input.bodyPartTags, "BODY_PART"),
  ]);
  return [...general, ...equipment, ...bodyPart];
}

export async function createExercise(input: ExerciseInput) {
  const tagIds = await resolveTagIds(input);

  return prisma.exercise.create({
    data: {
      ...scalarFields(input),
      ownerId: DEFAULT_OWNER_ID,
      targets: { create: input.targets.map((target) => ({ target })) },
      tags: { create: tagIds.map((tagId) => ({ tagId })) },
    },
    include: withRelations,
  });
}

export async function updateExercise(id: string, input: ExerciseInput) {
  const tagIds = await resolveTagIds(input);

  // 中間テーブルは総入れ替えする（差分計算するほどの件数ではない）
  return prisma.$transaction(async (tx) => {
    await tx.exerciseTarget.deleteMany({ where: { exerciseId: id } });
    await tx.exerciseTag.deleteMany({ where: { exerciseId: id } });
    return tx.exercise.update({
      where: { id },
      data: {
        ...scalarFields(input),
        targets: { create: input.targets.map((target) => ({ target })) },
        tags: { create: tagIds.map((tagId) => ({ tagId })) },
      },
      include: withRelations,
    });
  });
}

export async function deleteExercise(id: string) {
  return prisma.exercise.delete({ where: { id } });
}

/** 種目を消さずに一覧から隠す。過去のメニュー・記録を壊さない安全な引退方法。 */
export async function archiveExercise(id: string) {
  return prisma.exercise.update({ where: { id }, data: { status: "ARCHIVED" } });
}

/** 一覧ヘッダに出すカテゴリ別件数。 */
export async function countExercisesByCategory() {
  const rows = await prisma.exercise.groupBy({
    by: ["category"],
    where: { ownerId: DEFAULT_OWNER_ID },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.category, r._count._all]));
}
