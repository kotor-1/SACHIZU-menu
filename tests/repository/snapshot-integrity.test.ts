import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { exerciseInputSchema } from "@/domain/exercise/schema";
import { menuInputSchema, menuItemInputSchema } from "@/domain/menu/schema";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { createExercise, archiveExercise } from "@/infra/repositories/exercise-repository";
import {
  addBlock,
  addMenuItem,
  createMenu,
  deleteMenu,
  updateMenuItem,
} from "@/infra/repositories/menu-repository";
import {
  createSessionFromMenu,
  findSession,
  toggleSessionItemDone,
} from "@/infra/repositories/session-repository";
import { resetDb } from "../helpers";

/**
 * ============================================================================
 * スナップショット不変条件（最重要）
 * ============================================================================
 *
 * Menu からセッションを生成した後、そのセッション記録は
 * 「生成した瞬間の内容」で凍結される、というのがこのアプリの中核設計。
 *
 * これが崩れる = コーチが後から見返す過去の練習記録が、
 * 元データの編集につられて書き換わってしまうということなので、
 * このファイルのテストは他のどれよりも優先して壊れていないか確認する。
 *
 * scripts/verify-snapshot.ts の手動スクリプトと同じ不変条件を、
 * CI で毎回自動チェックできる形に落とし込んだもの。scripts 側は引き続き維持する。
 * ============================================================================
 */

async function setupMenuWithExercise() {
  const exercise = await createExercise(
    exerciseInputSchema.parse({
      name: "検証用ドリル",
      category: "DRILL",
      metricType: "DISTANCE",
      difficulty: 3,
    }),
  );

  const menu = await createMenu(menuInputSchema.parse({ name: "検証用メニュー" }), false);
  const block = await addBlock(menu.id, { name: "主運動", note: null });
  const item = await addMenuItem(
    block.id,
    menuItemInputSchema.parse({ exerciseId: exercise.id, sets: "3", distanceMeters: "60" }),
  );

  return { exercise, menu, block, item };
}

describe("snapshot integrity: Menu -> Session generation", () => {
  beforeEach(resetDb);

  it("copies the current prescription values into the session at creation time", async () => {
    const { menu } = await setupMenuWithExercise();

    const session = await createSessionFromMenu(
      sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-01-10" }),
    );

    const detail = await findSession(session.id);
    expect(detail?.items[0].plannedSets).toBe(3);
    expect(detail?.items[0].plannedDistanceMeters).toBe(60);
    expect(detail?.items[0].exerciseNameSnapshot).toBe("検証用ドリル");
    expect(detail?.items[0].blockNameSnapshot).toBe("主運動");
  });

  it("does NOT change an existing session's planned values when the MenuItem is edited later", async () => {
    const { menu, item, exercise } = await setupMenuWithExercise();

    const session = await createSessionFromMenu(
      sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-01-10" }),
    );

    // メニュー側の処方を大きく変える
    await updateMenuItem(
      item.id,
      menuItemInputSchema.parse({ exerciseId: exercise.id, sets: "8", distanceMeters: "150" }),
    );

    const detail = await findSession(session.id);
    expect(detail?.items[0].plannedSets).toBe(3); // 変わっていない
    expect(detail?.items[0].plannedDistanceMeters).toBe(60); // 変わっていない
  });

  it("does NOT change the session item's exercise-name snapshot when the Exercise is renamed later", async () => {
    const { menu, exercise } = await setupMenuWithExercise();

    const session = await createSessionFromMenu(
      sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-01-10" }),
    );

    await prisma.exercise.update({ where: { id: exercise.id }, data: { name: "改名後の種目名" } });

    const detail = await findSession(session.id);
    expect(detail?.items[0].exerciseNameSnapshot).toBe("検証用ドリル");
  });

  it("keeps the SessionItem (with its name snapshot) when the Exercise is archived", async () => {
    const { menu, exercise } = await setupMenuWithExercise();

    const session = await createSessionFromMenu(
      sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-01-10" }),
    );

    await archiveExercise(exercise.id);

    const detail = await findSession(session.id);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0].exerciseNameSnapshot).toBe("検証用ドリル");
    // 参照そのものは残る（アーカイブは削除ではないため null にはならない）
    expect(detail?.items[0].exerciseId).toBe(exercise.id);
  });

  it("keeps the SessionItem, with its reference nulled out, when the Exercise is hard-deleted", async () => {
    const { menu, exercise } = await setupMenuWithExercise();

    const session = await createSessionFromMenu(
      sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-01-10" }),
    );

    await prisma.exercise.delete({ where: { id: exercise.id } });

    const detail = await findSession(session.id);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0].exerciseNameSnapshot).toBe("検証用ドリル");
    expect(detail?.items[0].exerciseId).toBeNull();
  });

  it("keeps the Session (with a name snapshot of the menu) when the Menu is deleted", async () => {
    const { menu } = await setupMenuWithExercise();

    const session = await createSessionFromMenu(
      sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-01-10" }),
    );

    await deleteMenu(menu.id);

    const detail = await findSession(session.id);
    expect(detail).not.toBeNull();
    expect(detail?.items).toHaveLength(1);
    expect(detail?.sourceMenuTemplate).toBeNull();
  });

  it("keeps the underlying MenuItem when the referenced Exercise is deleted (reference set to null, row survives)", async () => {
    const { menu, item, exercise } = await setupMenuWithExercise();
    await prisma.exercise.delete({ where: { id: exercise.id } });

    const survivingItem = await prisma.menuItem.findUnique({ where: { id: item.id } });
    expect(survivingItem).not.toBeNull();
    expect(survivingItem?.exerciseId).toBeNull();
    void menu;
  });

  it("auto-advances session status from PLANNED to IN_PROGRESS on the first completed item", async () => {
    const { menu } = await setupMenuWithExercise();
    const session = await createSessionFromMenu(
      sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-01-10" }),
    );

    const before = await findSession(session.id);
    expect(before?.status).toBe("PLANNED");

    await toggleSessionItemDone(before!.items[0].id);

    const after = await findSession(session.id);
    expect(after?.status).toBe("IN_PROGRESS");
  });

  it("assigns a single running sort order across blocks, not per-block", async () => {
    const exercise = await createExercise(
      exerciseInputSchema.parse({ name: "種目1", category: "DRILL", metricType: "REPS", difficulty: 3 }),
    );
    const menu = await createMenu(menuInputSchema.parse({ name: "複数ブロックメニュー" }), false);
    const blockA = await addBlock(menu.id, { name: "ブロックA", note: null });
    const blockB = await addBlock(menu.id, { name: "ブロックB", note: null });
    await addMenuItem(blockA.id, menuItemInputSchema.parse({ exerciseId: exercise.id, reps: "10" }));
    await addMenuItem(blockB.id, menuItemInputSchema.parse({ displayName: "自由入力" }));

    const session = await createSessionFromMenu(
      sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-01-10" }),
    );

    const detail = await findSession(session.id);
    expect(detail?.items.map((i) => i.sortOrder)).toEqual([0, 1]);
    expect(detail?.items.map((i) => i.blockNameSnapshot)).toEqual(["ブロックA", "ブロックB"]);
  });
});
