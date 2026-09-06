import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../helpers";

/**
 * Server Actions は next/cache・next/navigation の実行時コンテキスト
 * （リクエストスコープの AsyncLocalStorage）に依存しており、
 * vitest の素の Node 環境ではそのまま呼ぶと invariant エラーになる。
 * ここでは実際の副作用（DB の状態）だけを見たいので、
 * revalidatePath は no-op に、redirect は Next.js と同様に
 * 「特別な例外を投げて処理を打ち切る」動きだけを再現してモックする。
 */
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { createExerciseAction, deleteExerciseAction, duplicateExerciseAction, toggleExerciseFavoriteAction } =
  await import("@/actions/exercise-actions");

function exerciseFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  const base: Record<string, string> = {
    name: "テスト種目",
    category: "DRILL",
    metricType: "REPS",
    difficulty: "3",
    defaultSets: "",
    defaultReps: "",
    defaultDistanceMeters: "",
    defaultDurationSeconds: "",
    defaultRestSeconds: "",
    videoUrl: "",
    source: "MANUAL",
    status: "REVIEWED",
    generalTags: "",
    equipmentTags: "",
    bodyPartTags: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) fd.set(key, value);
  return fd;
}

describe("createExerciseAction", () => {
  beforeEach(resetDb);

  it("returns field errors and creates nothing when required input is missing", async () => {
    const fd = exerciseFormData({ name: "" });
    const result = await createExerciseAction(null, fd);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.name).toBeDefined();
    }
    expect(await prisma.exercise.count()).toBe(0);
  });

  it("creates the exercise and then redirects to its detail page", async () => {
    const fd = exerciseFormData({ name: "新規種目" });

    await expect(createExerciseAction(null, fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

    const created = await prisma.exercise.findFirstOrThrow();
    expect(created.name).toBe("新規種目");
  });

  describe("AI draft boundary: creating from a draft links it, never writes the raw draft straight into the catalog", () => {
    it("flips the draft to APPLIED and links appliedExerciseId when draftId is present", async () => {
      const draft = await prisma.exerciseDraft.create({
        data: {
          payload: JSON.stringify({ name: "AI下書き種目", category: "DRILL" }),
          status: "PENDING_REVIEW",
        },
      });

      const fd = exerciseFormData({ name: "AI下書き種目", source: "AI_DRAFT", status: "DRAFT" });
      fd.set("draftId", draft.id);

      await expect(createExerciseAction(null, fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

      const created = await prisma.exercise.findFirstOrThrow();
      const updatedDraft = await prisma.exerciseDraft.findUniqueOrThrow({ where: { id: draft.id } });

      expect(updatedDraft.status).toBe("APPLIED");
      expect(updatedDraft.appliedExerciseId).toBe(created.id);
      expect(created.source).toBe("AI_DRAFT");
      expect(created.status).toBe("DRAFT"); // AI 由来は下書きのまま入り、コーチが後で確認する
    });

    it("does not touch a draft that is already APPLIED (no double-linking)", async () => {
      const other = await prisma.exercise.create({ data: { name: "別種目", category: "DRILL" } });
      const draft = await prisma.exerciseDraft.create({
        data: {
          payload: JSON.stringify({ name: "既に確定済み" }),
          status: "APPLIED",
          appliedExerciseId: other.id,
        },
      });

      const fd = exerciseFormData({ name: "もう一度登録" });
      fd.set("draftId", draft.id);

      await expect(createExerciseAction(null, fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

      const unchanged = await prisma.exerciseDraft.findUniqueOrThrow({ where: { id: draft.id } });
      expect(unchanged.appliedExerciseId).toBe(other.id); // 元の紐付けのまま
    });
  });
});

describe("deleteExerciseAction: usage guard", () => {
  beforeEach(resetDb);

  it("hard-deletes an exercise that is not referenced by any menu", async () => {
    const exercise = await prisma.exercise.create({ data: { name: "未使用", category: "DRILL" } });
    const fd = new FormData();
    fd.set("id", exercise.id);

    await expect(deleteExerciseAction(fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

    expect(await prisma.exercise.findUnique({ where: { id: exercise.id } })).toBeNull();
  });

  it("archives instead of deleting an exercise that is used in a menu", async () => {
    const exercise = await prisma.exercise.create({ data: { name: "使用中", category: "DRILL" } });
    const menu = await prisma.menuTemplate.create({
      data: {
        name: "利用メニュー",
        blocks: {
          create: { name: "主運動", sortOrder: 0, items: { create: { exerciseId: exercise.id, sortOrder: 0 } } },
        },
      },
    });

    const fd = new FormData();
    fd.set("id", exercise.id);

    await expect(deleteExerciseAction(fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

    const survived = await prisma.exercise.findUnique({ where: { id: exercise.id } });
    expect(survived?.status).toBe("ARCHIVED");

    // メニュー側の項目もそのまま残る
    const menuItem = await prisma.menuItem.findFirst({ where: { menuBlock: { menuTemplateId: menu.id } } });
    expect(menuItem?.exerciseId).toBe(exercise.id);
  });
});

describe("duplicateExerciseAction", () => {
  beforeEach(resetDb);

  it("creates a copy and redirects to its edit page (so the coach reviews it before it's final)", async () => {
    const source = await prisma.exercise.create({
      data: { name: "Aスキップ", category: "DRILL", isFavorite: true, status: "REVIEWED" },
    });

    const fd = new FormData();
    fd.set("id", source.id);

    await expect(duplicateExerciseAction(fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

    expect(await prisma.exercise.count()).toBe(2);
    const copy = await prisma.exercise.findFirstOrThrow({ where: { id: { not: source.id } } });
    expect(copy.name).toBe("Aスキップ のコピー");
    expect(copy.isFavorite).toBe(false);
    expect(copy.status).toBe("DRAFT");
  });

  it("does nothing when id is missing", async () => {
    await duplicateExerciseAction(new FormData());
    expect(await prisma.exercise.count()).toBe(0);
  });
});

describe("toggleExerciseFavoriteAction", () => {
  beforeEach(resetDb);

  it("toggles isFavorite without redirecting (used inline on cards and the detail page)", async () => {
    const exercise = await prisma.exercise.create({ data: { name: "種目", category: "DRILL" } });
    const fd = new FormData();
    fd.set("id", exercise.id);

    await toggleExerciseFavoriteAction(fd);
    expect((await prisma.exercise.findUniqueOrThrow({ where: { id: exercise.id } })).isFavorite).toBe(
      true,
    );

    await toggleExerciseFavoriteAction(fd);
    expect((await prisma.exercise.findUniqueOrThrow({ where: { id: exercise.id } })).isFavorite).toBe(
      false,
    );
  });
});
