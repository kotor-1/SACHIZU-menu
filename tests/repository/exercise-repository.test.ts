import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { exerciseInputSchema, exerciseSearchSchema } from "@/domain/exercise/schema";
import {
  archiveExercise,
  createExercise,
  duplicateExercise,
  listExercisesForPicker,
  searchExercises,
  toggleExerciseFavorite,
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

    it("persists multiple purposes and events (1 Exercise : N Purpose/Event)", async () => {
      const created = await createExercise(
        exerciseInput({
          name: "ハードルドリル",
          purposes: ["GROUND_CONTACT", "RHYTHM", "HIP_JOINT"],
          events: ["HURDLE", "SPRINT"],
        }),
      );

      expect(created.purposes.map((p) => p.purpose).sort()).toEqual(
        ["GROUND_CONTACT", "HIP_JOINT", "RHYTHM"].sort(),
      );
      expect(created.events.map((e) => e.event).sort()).toEqual(["HURDLE", "SPRINT"].sort());
    });

    it("defaults isFavorite to false", async () => {
      const created = await createExercise(exerciseInput({ name: "新規種目" }));
      expect(created.isFavorite).toBe(false);
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

    it("fully replaces purposes and events rather than merging them", async () => {
      const created = await createExercise(
        exerciseInput({ purposes: ["ACCELERATION"], events: ["SPRINT"] }),
      );

      const updated = await updateExercise(
        created.id,
        exerciseInput({ purposes: ["GROUND_CONTACT", "POSTURE"], events: ["HURDLE"] }),
      );

      expect(updated.purposes.map((p) => p.purpose).sort()).toEqual(
        ["GROUND_CONTACT", "POSTURE"].sort(),
      );
      expect(updated.events.map((e) => e.event)).toEqual(["HURDLE"]);
    });

    it("clearing all purposes/events on update leaves none behind", async () => {
      const created = await createExercise(
        exerciseInput({ purposes: ["ACCELERATION"], events: ["SPRINT"] }),
      );

      const updated = await updateExercise(created.id, exerciseInput({ purposes: [], events: [] }));

      expect(updated.purposes).toEqual([]);
      expect(updated.events).toEqual([]);
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

  describe("favorite (ON/OFF toggle)", () => {
    it("toggles isFavorite from false to true and back", async () => {
      const created = await createExercise(exerciseInput({ name: "お気に入り確認" }));
      expect(created.isFavorite).toBe(false);

      const toggledOn = await toggleExerciseFavorite(created.id);
      expect(toggledOn.isFavorite).toBe(true);

      const toggledOff = await toggleExerciseFavorite(created.id);
      expect(toggledOff.isFavorite).toBe(false);
    });
  });

  describe("duplicateExercise (Aスキップ -> Aスキップ・ミニハードル のような複製)", () => {
    it("copies name (with a suffix), scalar fields, prescription, purposes/events, and tags", async () => {
      const source = await createExercise(
        exerciseInput({
          name: "Aスキップ",
          nameKana: "えーすきっぷ",
          description: "説明文",
          coachingPoint: "ポイント",
          commonMistake: "ありがちな失敗",
          category: "DRILL",
          metricType: "DISTANCE",
          difficulty: 4,
          defaultSets: "3",
          defaultDistanceMeters: "30",
          defaultRestSeconds: "60",
          targets: ["TECHNIQUE"],
          purposes: ["GROUND_CONTACT", "RHYTHM"],
          events: ["SPRINT"],
          generalTags: ["定番"],
          equipmentTags: ["ハードル"],
          videoUrl: "https://example.com/video",
        }),
      );

      const copy = await duplicateExercise(source.id);

      expect(copy.id).not.toBe(source.id);
      expect(copy.name).toBe("Aスキップ のコピー");
      expect(copy.nameKana).toBe("えーすきっぷ");
      expect(copy.description).toBe("説明文");
      expect(copy.coachingPoint).toBe("ポイント");
      expect(copy.commonMistake).toBe("ありがちな失敗");
      expect(copy.category).toBe("DRILL");
      expect(copy.metricType).toBe("DISTANCE");
      expect(copy.difficulty).toBe(4);
      expect(copy.defaultSets).toBe(3);
      expect(copy.defaultDistanceMeters).toBe(30);
      expect(copy.defaultRestSeconds).toBe(60);
      expect(copy.targets.map((t) => t.target)).toEqual(["TECHNIQUE"]);
      expect(copy.purposes.map((p) => p.purpose).sort()).toEqual(
        ["GROUND_CONTACT", "RHYTHM"].sort(),
      );
      expect(copy.events.map((e) => e.event)).toEqual(["SPRINT"]);
      expect(copy.tags.map((t) => t.tag.name).sort()).toEqual(["ハードル", "定番"].sort());
    });

    it("resets identity/review fields instead of copying them (new id, DRAFT, not favorited, no video)", async () => {
      const source = await createExercise(
        exerciseInput({ name: "元種目", status: "REVIEWED", videoUrl: "https://example.com/v" }),
      );
      await toggleExerciseFavorite(source.id); // お気に入りに設定しておく

      const copy = await duplicateExercise(source.id);

      expect(copy.status).toBe("DRAFT");
      expect(copy.isFavorite).toBe(false);
      expect(copy.videoUrl).toBeNull();
      expect(copy.source).toBe("MANUAL");
    });

    it("does not let editing the original affect the already-created duplicate (no shared reference)", async () => {
      const source = await createExercise(exerciseInput({ name: "元種目", difficulty: 2 }));
      const copy = await duplicateExercise(source.id);

      await updateExercise(
        source.id,
        exerciseInput({ name: "改名後", difficulty: 5, purposes: ["POWER"] }),
      );

      const reloadedCopy = await prisma.exercise.findUniqueOrThrow({
        where: { id: copy.id },
        include: { purposes: true },
      });
      expect(reloadedCopy.name).toBe("元種目 のコピー");
      expect(reloadedCopy.difficulty).toBe(2);
      expect(reloadedCopy.purposes).toEqual([]);
    });

    it("throws a clear error when the source exercise does not exist", async () => {
      await expect(duplicateExercise("does-not-exist")).rejects.toThrow(
        "複製元の種目が見つかりません",
      );
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
      await createExercise(
        exerciseInput({
          name: "ハードルドリル",
          category: "DRILL",
          purposes: ["GROUND_CONTACT"],
          events: ["HURDLE"],
        }),
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
      expect(result.total).toBe(4);
    });

    it("returns an empty result set (not an error) for a query matching nothing", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ q: "存在しない種目名" }));
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("filters by purpose (練習目的)", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ purpose: "GROUND_CONTACT" }));
      expect(result.items.map((e) => e.name)).toEqual(["ハードルドリル"]);
    });

    it("filters by event (対象競技)", async () => {
      const result = await searchExercises(exerciseSearchSchema.parse({ event: "HURDLE" }));
      expect(result.items.map((e) => e.name)).toEqual(["ハードルドリル"]);
    });

    it("combines event AND purpose, matching only exercises with both (Event=ハードル AND Purpose=接地)", async () => {
      // Aスキップにも同じ purpose だけ付けて、event 側で絞られることを確認する
      const aSkip = await prisma.exercise.findFirstOrThrow({ where: { name: "Aスキップ" } });
      await prisma.exercisePurpose.create({
        data: { exerciseId: aSkip.id, purpose: "GROUND_CONTACT" },
      });

      const result = await searchExercises(
        exerciseSearchSchema.parse({ event: "HURDLE", purpose: "GROUND_CONTACT" }),
      );
      expect(result.items.map((e) => e.name)).toEqual(["ハードルドリル"]);
    });

    it("filters by favorite only", async () => {
      const aSkip = await prisma.exercise.findFirstOrThrow({ where: { name: "Aスキップ" } });
      await toggleExerciseFavorite(aSkip.id);

      const favoritesOnly = await searchExercises(exerciseSearchSchema.parse({ favorite: "1" }));
      expect(favoritesOnly.items.map((e) => e.name)).toEqual(["Aスキップ"]);

      const everyone = await searchExercises(exerciseSearchSchema.parse({ favorite: "" }));
      expect(everyone.total).toBe(4);
    });
  });
});
