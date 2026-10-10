import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { menuInputSchema, menuItemInputSchema } from "@/domain/menu/schema";
import { exerciseInputSchema } from "@/domain/exercise/schema";
import {
  addBlock,
  addMenuItem,
  createMenu,
  duplicateMenu,
  findMenu,
  moveBlock,
  moveMenuItem,
  reorderBlocks,
  reorderMenuItems,
  updateMenuItem,
} from "@/infra/repositories/menu-repository";
import { createExercise } from "@/infra/repositories/exercise-repository";
import { resetDb } from "../helpers";

function menuInput(overrides: Record<string, unknown> = {}) {
  return menuInputSchema.parse({ name: "テストメニュー", ...overrides });
}

function menuItemInput(overrides: Record<string, unknown> = {}) {
  return menuItemInputSchema.parse({ displayName: "自由入力項目", ...overrides });
}

async function makeExerciseRow(name: string) {
  return createExercise(
    exerciseInputSchema.parse({ name, category: "DRILL", metricType: "DISTANCE", difficulty: 3 }),
  );
}

async function createPendingRunningItem(menuBlockId: string) {
  return prisma.menuItem.create({ data: {
    menuBlockId, displayName: "走（Engine未処方）", prescriptionKind: "RUNNING_UNPRESCRIBED",
    sets: null, reps: null, distanceMeters: null, durationSeconds: null, restSeconds: null, intensityPercent: null,
    prescriptionJson: JSON.stringify({ kind: "UNPRESCRIBED_RUNNING", schemaVersion: 1, reasonCode: "NEEDS_POLICY", reasonMessage: "目的別処方は未承認です。" }),
    provenanceJson: JSON.stringify({ schemaVersion: 1, source: "UNPRESCRIBED_RUNNING_DRAFT", doseAuthority: "USER_ONLY", engineApproved: false }),
    rationale: "目的別処方は未承認です。",
  } });
}

describe("menu repository", () => {
  beforeEach(resetDb);

  describe("createMenu", () => {
    it("creates the standard 5 blocks by default", async () => {
      const menu = await createMenu(menuInput());
      const detail = await findMenu(menu.id);
      expect(detail?.blocks.map((b) => b.name)).toEqual([
        "ウォームアップ",
        "ドリル",
        "主運動",
        "補強",
        "クールダウン",
      ]);
    });

    it("creates zero blocks when withDefaultBlocks is false", async () => {
      const menu = await createMenu(menuInput(), false);
      const detail = await findMenu(menu.id);
      expect(detail?.blocks).toEqual([]);
    });
  });

  describe("adding an exercise to a menu (Menu へ Exercise 追加)", () => {
    it("attaches a catalog exercise to a block with a prescription", async () => {
      const exercise = await makeExerciseRow("Aスキップ");
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "主運動", note: null });

      await addMenuItem(
        block.id,
        menuItemInput({ exerciseId: exercise.id, displayName: "", sets: "3", distanceMeters: "30" }),
      );

      const detail = await findMenu(menu.id);
      const item = detail!.blocks[0].items[0];
      expect(item.exercise?.name).toBe("Aスキップ");
      expect(item.sets).toBe(3);
      expect(item.distanceMeters).toBe(30);
    });

    it("allows a free-text item with no catalog exercise", async () => {
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "主運動", note: null });

      await addMenuItem(block.id, menuItemInput({ displayName: "3km ジョグ" }));

      const detail = await findMenu(menu.id);
      const item = detail!.blocks[0].items[0];
      expect(item.exercise).toBeNull();
      expect(item.displayName).toBe("3km ジョグ");
    });

    it("rejects an item with neither exerciseId nor displayName at the schema level", () => {
      expect(() => menuItemInputSchema.parse({})).toThrow();
    });
  });

  describe("changing a MenuItem's prescription (MenuItem ごとの処方値変更)", () => {
    it("updates only this menu's prescription without touching the Exercise's own defaults", async () => {
      const exercise = await makeExerciseRow("Aスキップ");
      await prisma.exercise.update({
        where: { id: exercise.id },
        data: { defaultSets: 2, defaultDistanceMeters: 30 },
      });

      const menuA = await createMenu(menuInput({ name: "メニューA" }), false);
      const blockA = await addBlock(menuA.id, { name: "主運動", note: null });
      const itemA = await addMenuItem(
        blockA.id,
        menuItemInput({ exerciseId: exercise.id, displayName: "", sets: "2", distanceMeters: "30" }),
      );

      // このメニューだけ負荷を上げる
      await updateMenuItem(
        itemA.id,
        menuItemInput({ exerciseId: exercise.id, displayName: "", sets: "5", distanceMeters: "60" }),
      );

      const updated = await prisma.menuItem.findUniqueOrThrow({ where: { id: itemA.id } });
      expect(updated.sets).toBe(5);
      expect(updated.distanceMeters).toBe(60);

      // Exercise 本体の推奨値は変わらない
      const untouchedExercise = await prisma.exercise.findUniqueOrThrow({
        where: { id: exercise.id },
      });
      expect(untouchedExercise.defaultSets).toBe(2);
      expect(untouchedExercise.defaultDistanceMeters).toBe(30);
    });

    it("allows user-only edits to an unprescribed Running row without changing its kind or provenance", async () => {
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "走（未処方）", note: null });
      const item = await createPendingRunningItem(block.id);
      const priorJson = item.prescriptionJson;
      const priorProvenance = item.provenanceJson;

      await updateMenuItem(item.id, menuItemInput({ displayName: "走（未処方）", sets: "2", reps: "4", restSeconds: "30", intensityPercent: "75", note: "手入力" }));

      const updated = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated).toMatchObject({ prescriptionKind: "RUNNING_UNPRESCRIBED", sets: 2, reps: 4, restSeconds: 30,
        intensityPercent: 75, note: "手入力", prescriptionJson: priorJson, provenanceJson: priorProvenance });
      expect(updated.prescriptionJson).toContain('"reasonCode":"NEEDS_POLICY"');
      expect(updated.provenanceJson).toContain('"doseAuthority":"USER_ONLY"');
      expect(updated.provenanceJson).toContain('"engineApproved":false');
    });

    it("does not allow an unprescribed Running row to become a catalog exercise", async () => {
      const exercise = await makeExerciseRow("Aスキップ");
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "走（未処方）", note: null });
      const item = await createPendingRunningItem(block.id);

      await expect(updateMenuItem(item.id, menuItemInput({ exerciseId: exercise.id, displayName: "", sets: "2", reps: "4" })))
        .rejects.toThrow("未処方の走項目は登録種目に変換できません");
      expect(await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
        prescriptionKind: "RUNNING_UNPRESCRIBED", exerciseId: null,
      });
    });

    it("rejects hand-entered unprescribed Running intensity above 100 percent", async () => {
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "走（未処方）", note: null });
      const item = await createPendingRunningItem(block.id);

      await expect(updateMenuItem(item.id, menuItemInput({ displayName: "走（未処方）", intensityPercent: "101" })))
        .rejects.toThrow("手入力の走強度は1〜100%の整数で入力してください");
      expect(await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
        prescriptionKind: "RUNNING_UNPRESCRIBED", intensityPercent: null,
      });
    });
  });

  describe("reordering (並び替え)", () => {
    it("swaps sortOrder when moving a menu item up", async () => {
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "ドリル", note: null });
      await addMenuItem(block.id, menuItemInput({ displayName: "1つ目" }));
      const second = await addMenuItem(block.id, menuItemInput({ displayName: "2つ目" }));

      await moveMenuItem(second.id, "up");

      const detail = await findMenu(menu.id);
      expect(detail!.blocks[0].items.map((i) => i.displayName)).toEqual(["2つ目", "1つ目"]);
    });

    it("is a no-op when moving the first item further up", async () => {
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "ドリル", note: null });
      const first = await addMenuItem(block.id, menuItemInput({ displayName: "1つ目" }));
      await addMenuItem(block.id, menuItemInput({ displayName: "2つ目" }));

      await moveMenuItem(first.id, "up");

      const detail = await findMenu(menu.id);
      expect(detail!.blocks[0].items.map((i) => i.displayName)).toEqual(["1つ目", "2つ目"]);
    });

    it("swaps sortOrder when moving a block down", async () => {
      const menu = await createMenu(menuInput(), false);
      const first = await addBlock(menu.id, { name: "ブロックA", note: null });
      await addBlock(menu.id, { name: "ブロックB", note: null });

      await moveBlock(first.id, "down");

      const detail = await findMenu(menu.id);
      expect(detail!.blocks.map((b) => b.name)).toEqual(["ブロックB", "ブロックA"]);
    });

    it("reorderMenuItems persists an arbitrary order and survives reload", async () => {
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "ドリル", note: null });
      const a = await addMenuItem(block.id, menuItemInput({ displayName: "A" }));
      const b = await addMenuItem(block.id, menuItemInput({ displayName: "B" }));
      const c = await addMenuItem(block.id, menuItemInput({ displayName: "C" }));

      await reorderMenuItems(block.id, [c.id, a.id, b.id]);

      const detail = await findMenu(menu.id);
      expect(detail!.blocks[0].items.map((i) => i.displayName)).toEqual(["C", "A", "B"]);
      expect(detail!.blocks[0].items.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
    });

    it("reorderMenuItems rejects a mismatched or duplicate ID list atomically", async () => {
      const menu = await createMenu(menuInput(), false);
      const block = await addBlock(menu.id, { name: "ドリル", note: null });
      const a = await addMenuItem(block.id, menuItemInput({ displayName: "A" }));
      const b = await addMenuItem(block.id, menuItemInput({ displayName: "B" }));

      // missing one item / foreign item
      await expect(reorderMenuItems(block.id, [a.id])).rejects.toThrow();
      await expect(reorderMenuItems(block.id, [a.id, b.id, "missing"])).rejects.toThrow();
      await expect(reorderMenuItems(block.id, [a.id, a.id])).rejects.toThrow();

      // original order unchanged after each rejected write
      const detail = await findMenu(menu.id);
      expect(detail!.blocks[0].items.map((i) => i.displayName)).toEqual(["A", "B"]);
    });

    it("reorderBlocks persists an arbitrary block order", async () => {
      const menu = await createMenu(menuInput(), false);
      const first = await addBlock(menu.id, { name: "A", note: null });
      const second = await addBlock(menu.id, { name: "B", note: null });
      const third = await addBlock(menu.id, { name: "C", note: null });

      await reorderBlocks(menu.id, [third.id, first.id, second.id]);

      const detail = await findMenu(menu.id);
      expect(detail!.blocks.map((b) => b.name)).toEqual(["C", "A", "B"]);
    });

    it("reorderBlocks rejects a mismatched block list atomically", async () => {
      const menu = await createMenu(menuInput(), false);
      const first = await addBlock(menu.id, { name: "A", note: null });
      await addBlock(menu.id, { name: "B", note: null });

      await expect(reorderBlocks(menu.id, [first.id])).rejects.toThrow();

      const detail = await findMenu(menu.id);
      expect(detail!.blocks.map((b) => b.name)).toEqual(["A", "B"]);
    });
  });

  describe("duplicateMenu (複製)", () => {
    it("copies header fields, tags, blocks, and items, and resets status to DRAFT", async () => {
      const exercise = await makeExerciseRow("Aスキップ");
      const source = await createMenu(
        menuInput({ name: "元メニュー", status: "REVIEWED", tags: ["短距離"] }),
        false,
      );
      const block = await addBlock(source.id, { name: "主運動", note: "メモ" });
      await addMenuItem(
        block.id,
        menuItemInput({ exerciseId: exercise.id, displayName: "", sets: "3", distanceMeters: "60" }),
      );

      const copy = await duplicateMenu(source.id);
      const copyDetail = await findMenu(copy.id);

      expect(copy.id).not.toBe(source.id);
      expect(copyDetail?.name).toBe("元メニュー のコピー");
      expect(copyDetail?.status).toBe("DRAFT");
      expect(copyDetail?.tags.map((t) => t.tag.name)).toEqual(["短距離"]);
      expect(copyDetail?.blocks[0].name).toBe("主運動");
      expect(copyDetail?.blocks[0].items[0].exercise?.name).toBe("Aスキップ");
      expect(copyDetail?.blocks[0].items[0].sets).toBe(3);
    });

    it("does not let edits to the copy affect the original", async () => {
      const source = await createMenu(menuInput({ name: "元メニュー" }), false);
      const block = await addBlock(source.id, { name: "主運動", note: null });
      await addMenuItem(block.id, menuItemInput({ displayName: "項目" }));

      const copy = await duplicateMenu(source.id);
      const copyDetail = await findMenu(copy.id);
      await updateMenuItem(
        copyDetail!.blocks[0].items[0].id,
        menuItemInput({ displayName: "コピー側だけ変更", sets: "9" }),
      );

      const originalDetail = await findMenu(source.id);
      expect(originalDetail?.blocks[0].items[0].displayName).toBe("項目");
      expect(originalDetail?.blocks[0].items[0].sets).toBeNull();
    });

    it("throws a clear error when the source menu does not exist", async () => {
      await expect(duplicateMenu("does-not-exist")).rejects.toThrow(
        "複製元のメニューが見つかりません",
      );
    });
  });
});
