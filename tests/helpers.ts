import { prisma } from "@/infra/db/prisma";

/**
 * テスト間でテーブルを空にする。
 * 子 → 親の順で消せば、cascade 設定に関わらず FK エラーにならない。
 */
export async function resetDb() {
  await prisma.sessionItem.deleteMany();
  await prisma.trainingSession.deleteMany();
  await prisma.competition.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.menuTag.deleteMany();
  await prisma.menuBlock.deleteMany();
  await prisma.menuTemplate.deleteMany();
  await prisma.exerciseDraft.deleteMany();
  await prisma.analysisJob.deleteMany();
  await prisma.videoAsset.deleteMany();
  await prisma.exerciseTarget.deleteMany();
  await prisma.exerciseTag.deleteMany();
  await prisma.exercise.deleteMany();
  await prisma.tag.deleteMany();
}

/** 最小限の値で種目を 1 件作る。個別のテストはここに必要な値だけ上書きする。 */
export async function makeExercise(overrides: Partial<{
  name: string;
  category: string;
  metricType: string;
  status: string;
  defaultSets: number | null;
  defaultDistanceMeters: number | null;
}> = {}) {
  return prisma.exercise.create({
    data: {
      name: overrides.name ?? "テスト用ドリル",
      category: overrides.category ?? "DRILL",
      metricType: overrides.metricType ?? "DISTANCE",
      status: overrides.status ?? "REVIEWED",
      defaultSets: overrides.defaultSets ?? 3,
      defaultDistanceMeters: overrides.defaultDistanceMeters ?? 30,
    },
  });
}

/** 1 ブロック・1 項目だけの最小メニューを作る。 */
export async function makeMenuWithItem(exerciseId: string, opts: {
  menuName?: string;
  blockName?: string;
  sets?: number;
  distanceMeters?: number;
} = {}) {
  return prisma.menuTemplate.create({
    data: {
      name: opts.menuName ?? "テスト用メニュー",
      blocks: {
        create: {
          name: opts.blockName ?? "主運動",
          sortOrder: 0,
          items: {
            create: {
              exerciseId,
              sortOrder: 0,
              sets: opts.sets ?? 3,
              distanceMeters: opts.distanceMeters ?? 60,
            },
          },
        },
      },
    },
    include: { blocks: { include: { items: true } } },
  });
}
