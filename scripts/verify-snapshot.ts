/**
 * 責務分離の検証:
 *   テンプレートを後から編集しても、作成済みセッションが変わらないこと。
 *   種目を削除しても、セッション記録に名前が残ること。
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const ok = (label: string, cond: boolean, detail = "") =>
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);

async function main() {
  // 準備
  const ex = await prisma.exercise.create({
    data: { name: "検証用ドリル", category: "DRILL", metricType: "DISTANCE" },
  });

  const menu = await prisma.menuTemplate.create({
    data: {
      name: "検証用メニュー",
      blocks: {
        create: {
          name: "主運動",
          sortOrder: 0,
          items: { create: { exerciseId: ex.id, sortOrder: 0, sets: 3, distanceMeters: 60 } },
        },
      },
    },
    include: { blocks: { include: { items: true } } },
  });
  const item = menu.blocks[0].items[0];

  // セッションを展開（本番と同じロジックを写す）
  const src = await prisma.menuTemplate.findUniqueOrThrow({
    where: { id: menu.id },
    include: {
      blocks: {
        orderBy: { sortOrder: "asc" },
        include: { items: { orderBy: { sortOrder: "asc" }, include: { exercise: true } } },
      },
    },
  });
  let n = 0;
  const session = await prisma.trainingSession.create({
    data: {
      title: "検証セッション",
      date: new Date(),
      sourceMenuTemplateId: src.id,
      sourceMenuNameSnapshot: src.name,
      items: {
        create: src.blocks.flatMap((b) =>
          b.items.map((it) => ({
            exerciseId: it.exerciseId,
            exerciseNameSnapshot: it.exercise?.name ?? "(未設定)",
            blockNameSnapshot: b.name,
            sortOrder: n++,
            plannedSets: it.sets,
            plannedDistanceMeters: it.distanceMeters,
          })),
        ),
      },
    },
    include: { items: true },
  });

  ok("展開時に計画値がコピーされる",
     session.items[0].plannedSets === 3 && session.items[0].plannedDistanceMeters === 60,
     `sets=${session.items[0].plannedSets}, dist=${session.items[0].plannedDistanceMeters}`);

  // --- テンプレートを後から変更する ---
  await prisma.menuItem.update({ where: { id: item.id }, data: { sets: 8, distanceMeters: 150 } });
  await prisma.exercise.update({ where: { id: ex.id }, data: { name: "名前を変えたドリル" } });
  await prisma.menuBlock.update({ where: { id: menu.blocks[0].id }, data: { name: "変更後ブロック" } });

  const after = await prisma.trainingSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { items: true },
  });

  ok("テンプレートの負荷変更がセッションに波及しない",
     after.items[0].plannedSets === 3 && after.items[0].plannedDistanceMeters === 60,
     `sets=${after.items[0].plannedSets}, dist=${after.items[0].plannedDistanceMeters}`);
  ok("種目名の変更がセッション記録に波及しない",
     after.items[0].exerciseNameSnapshot === "検証用ドリル",
     after.items[0].exerciseNameSnapshot);
  ok("ブロック名の変更がセッション記録に波及しない",
     after.items[0].blockNameSnapshot === "主運動",
     after.items[0].blockNameSnapshot);

  // --- 種目を削除する ---
  await prisma.exercise.delete({ where: { id: ex.id } });
  const afterDelete = await prisma.trainingSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { items: true },
  });
  ok("種目を削除しても記録は残る（参照だけ null になる）",
     afterDelete.items.length === 1 &&
       afterDelete.items[0].exerciseId === null &&
       afterDelete.items[0].exerciseNameSnapshot === "検証用ドリル");

  const menuAfterDelete = await prisma.menuTemplate.findUniqueOrThrow({
    where: { id: menu.id },
    include: { blocks: { include: { items: true } } },
  });
  ok("種目を削除してもメニューの項目自体は残る",
     menuAfterDelete.blocks[0].items.length === 1 &&
       menuAfterDelete.blocks[0].items[0].exerciseId === null);

  // --- メニューを削除する ---
  await prisma.menuTemplate.delete({ where: { id: menu.id } });
  const afterMenuDelete = await prisma.trainingSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { items: true },
  });
  ok("メニューを削除しても練習記録は消えない",
     afterMenuDelete.items.length === 1 &&
       afterMenuDelete.sourceMenuTemplateId === null &&
       afterMenuDelete.sourceMenuNameSnapshot === "検証用メニュー");

  // 後片付け
  await prisma.trainingSession.delete({ where: { id: session.id } });
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
