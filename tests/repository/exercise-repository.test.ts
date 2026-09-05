import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { exerciseInputSchema, exerciseSearchSchema } from "@/domain/exercise/schema";
import {
  archiveExercise,
  createExercise,
  listExercisesForPicker,
  searchExercises,
  updateExercise,
} from "@/infra/repositories/exercise-repository";
import { resetDb } from "../helpers";

/** exerciseInputSchema を通して、フォーム入力と同じ形の値を作る。 */
function exerciseInput(overrides: Record<string, unknown> = {}) {
  return exerciseInputSchema.parse({
    name: "テスト種目",
    category: "DRILL",
    metricType: "REPS",
    difficulty: 3,
    ...overrides,
  });
}

describe("exercise repository", () => {
  beforeEach(resetDb);

  describe("createExercise", () => {
    it("persists scalar fields, targets, and kind-separated tags", async () => {
      const created = await createExercise(
        exerciseInput({
          name: "Aスキップ",
          category: "DRILL",
          metricType: "DISTANCE",
          difficulty: 2,
          defaultSets: "2",
          defaultDistanceMeters: "30",
          targets: ["TECHNIQUE", "COORDINATION"],
          generalTags: ["定番"],
          equipmentTags: ["ハードル"],
        }),
      );

      expect(created.name).toBe("Aスキップ");
      expect(created.defaultSets).toBe(2);
      expect(created.defaultDistanceMeters).toBe(30);
      expect(created.targets.map((t) => t.target).sort()).toEqual(
        ["COORDINATION", "TECHNIQUE"].sort(),
      );

      const tagNames = created.tags.map((t) => t.tag.name).sort();
      expect(tagNames).toEqual(["ハードル", "定番"]);

      const equipmentTag = created.tags.find((t) => t.tag.name === "ハードル");
      expect(equipmentTag?.tag.kind).toBe("EQUIPMENT");
    });

    it("reuses an existing tag with the same kind+name instead of duplicating it", async () => {
      await createExercise(exerciseInput({ name: "種目A", generalTags: ["短距離"] }));
      await createExercise(exerciseInput({ name: "種目B", generalTags: ["短距離"] }));

      const tags = await prisma.tag.findMany({ where: { name: "短距離" } });
      expect(tags).toHaveLength(1);
    });

    it("defaults to REVIEWED status and MANUAL source when not specified", async () => {
      const created = await createExercise(exerciseInput({ name: "既定値確認" }));
      expect(created.status).toBe("REVIEWED");
      expect(created.source).toBe("MANUAL");
    });
  });

  describe("updateExercise", () => {
    it("overwrites scalar fields", async () => {
      const created = await createExercise(exerciseInput({ name: "旧名称", difficulty: 1 }));

      const updated = await updateExercise(
        created.id,
        exerciseInput({ name: "新名称", difficulty: 5 }),
      );

      expect(updated.name).toBe("新名称");
      expect(updated.difficulty).toBe(5);
    });

    it("fully replaces targets and tags rather than merging them", async () => {
      const created = await createExercise(
        exerciseInput({ targets: ["ACCELERATION"], generalTags: ["旧タグ"] }),
      );

      const updated = await updateExercise(
        created.id,
        exerciseInput({ targets: ["ENDURANCE"], generalTags: ["新タグ"] }),
      );

      expect(updated.targets.map((t) => t.target)).toEqual(["ENDURANCE"]);
      expect(updated.tags.map((t) => t.tag.name)).toEqual(["新タグ"]);
    });

    it("clearing all targets/tags on update leaves none behind", async () => {
      const created = await createExercise(
        exerciseInput({ targets: ["ACCELERATION"], generalTags: ["タグ"] }),
      );

      const updated = await updateExercise(created.id, exerciseInput({ targets: [], generalTags: [] }));

      expect(updated.targets).toEqual([]);
      expect(updated.tags).toEqual([]);
    });
  });

  describe("archiveExercise", () => {
    it("sets status to ARCHIVED without deleting the row", async () => {
      const created = await createExercise(exerciseInput({ name: "引退予定" }));
      await archiveExercise(created.id);

      const found = await prisma.exercise.findUnique({ where: { id: created.id } });
      expect(found?.status).toBe("ARCHIVED");
    });

    it("excludes archived exercises from the menu-building picker", async () => {
      const created = await createExercise(exerciseInput({ name: "引退予定2" }));
      await archiveExercise(created.id);

      const picker = await listExercisesForPicker();
      expect(picker.some((e) => e.id === created.id)).toBe(false);
    });
  });

  describe("searchExercises", () => {
    beforeEach(async () => {
      await createExercise(
        exerciseInput({
          name: "Aスキップ",
          category: "DRILL",
          difficulty: 2,
          targets: ["TECHNIQUE"],
          generalTags: ["短距離"],
        }),
      );
      await createExercise(
        exerciseInput({
          name: "バックスクワット",
          category: "STRENGTH",
          difficulty: 4,
          targets: ["STRENGTH"],
          equipmentTags: ["バーベル"],
        }),
      );
      await createExercise(
        exerciseInput({ name: "アーカイブ済み種目", category: "DRILL", status: "ARCHIVED" }),
      );
    });

    it("filters by category", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ category: "STRENGTH" }));
      expect(result.items.map((e) => e.name)).toEqual(["バックスクワット"]);
    });

    it("filters by target (対象能力)", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ target: "STRENGTH" }));
      expect(result.items.map((e) => e.name)).toEqual(["バックスクワット"]);
    });

    it("filters by difficulty", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ difficulty: "4" }));
      expect(result.items.map((e) => e.name)).toEqual(["バックスクワット"]);
    });

    it("filters by status", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ status: "ARCHIVED" }));
      expect(result.items.map((e) => e.name)).toEqual(["アーカイブ済み種目"]);
    });

    it("filters by tag id", async () => {
      const tag = await prisma.tag.findFirstOrThrow({ where: { name: "短距離" } });
      const result = await searchExercises(exerciseSearchSchema.parse({ tag: [tag.id] }));
      expect(result.items.map((e) => e.name)).toEqual(["Aスキップ"]);
    });

    it("free-text search matches name substrings", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ q: "スキップ" }));
      expect(result.items.map((e) => e.name)).toEqual(["Aスキップ"]);
    });

    it("returns all non-deleted exercises with no filters, including archived ones", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({}));
      expect(result.total).toBe(3);
    });

    it("returns an empty result set (not an error) for a query matching nothing", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ q: "存在しない種目名" }));
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });
  });
});
