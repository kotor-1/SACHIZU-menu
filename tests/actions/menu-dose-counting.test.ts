import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { catalogFixture } from "../fixtures/menu-composition";
import { resetDb } from "../helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/infra/menu-composition/catalog-repository", () => ({ listComposerCatalog: vi.fn() }));
const { listComposerCatalog } = await import("@/infra/menu-composition/catalog-repository");
const { addMenuItemAction, updateMenuItemAction } = await import("@/actions/menu-actions");

function form(exerciseId: string, reps: string, note: string) {
  const value = new FormData();
  for (const [key, entry] of Object.entries({ exerciseId, reps, note, sets: "1" })) value.set(key, entry);
  return value;
}

async function fixture(countingUnit: "PER_SIDE" | "TOTAL_REPS" = "PER_SIDE") {
  const exercise = await prisma.exercise.create({ data: { id: "side-count-exercise", ownerId: DEFAULT_OWNER_ID,
    name: "対角膝肘引きつけ", category: "CORE", metricType: "REPS", status: "REVIEWED" } });
  vi.mocked(listComposerCatalog).mockResolvedValue([catalogFixture({ id: exercise.id, name: exercise.name, videoGuidance: {
    executionSummary: "膝と肘を寄せて戻す。", movementPattern: "体幹", countingUnit,
    bilateralCounting: "片側を終えてから反対側。", typicalStructure: null, equipment: [], setup: null, keyCues: [], commonErrors: [], doseObservations: [],
    videoAnalysisStatus: "COACH_REVIEWED", sourceVideoId: "video-fixture", analysisVersion: "offline-fixture",
    analyzedAt: "2026-10-12T00:00:00.000Z", coachReviewedAt: "2026-10-12T00:00:00.000Z",
  } })]);
  const menu = await prisma.menuTemplate.create({ data: { name: "左右の回数編集", ownerId: DEFAULT_OWNER_ID,
    blocks: { create: { name: "体幹", sortOrder: 0, items: { create: { exerciseId: exercise.id, sortOrder: 0,
      reps: 10, sets: 1, note: "左右10回ずつ行う。" } } } } }, include: { blocks: { include: { items: true } } } });
  return { exercise, menu, block: menu.blocks[0], item: menu.blocks[0].items[0] };
}

describe("saved menu per-side dose edits (isolated database)", () => {
  beforeEach(async () => { await resetDb(); vi.clearAllMocks(); });

  it("rejects twenty against ten per side before any saved data changes, then accepts consistent eight", async () => {
    const { exercise, menu, item } = await fixture();
    const before = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(await updateMenuItemAction(menu.id, item.id, null, form(exercise.id, "20", item.note!)))
      .toMatchObject({ ok: false, fieldErrors: { reps: [expect.any(String)] } });
    expect(await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(before);
    expect(await updateMenuItemAction(menu.id, item.id, null, form(exercise.id, "8", "左右8回ずつ行う。")))
      .toMatchObject({ ok: true });
    expect(await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } }))
      .toMatchObject({ reps: 8, sets: 1, note: "左右8回ずつ行う。" });
  });

  it("rejects contradictory additions without inserting a row", async () => {
    const { exercise, menu, block } = await fixture();
    const before = await prisma.menuItem.count();
    expect(await addMenuItemAction(menu.id, block.id, null, form(exercise.id, "20", "左右10回ずつ行う。")))
      .toMatchObject({ ok: false });
    expect(await prisma.menuItem.count()).toBe(before);
    expect(await addMenuItemAction(menu.id, block.id, null, form(exercise.id, "10", "左右10回ずつ行う。")))
      .toMatchObject({ ok: true });
    expect(await prisma.menuItem.count()).toBe(before + 1);
  });

  it("keeps an approved total-count field at twenty when prose specifies ten per side", async () => {
    const { exercise, menu, item } = await fixture("TOTAL_REPS");
    expect(await updateMenuItemAction(menu.id, item.id, null, form(exercise.id, "20", "左右10回ずつ行う。")))
      .toMatchObject({ ok: true });
    expect(await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ reps: 20 });
  });

  it.each(["RUNNING_POLICY", "RUNNING_V2"])("keeps %s generic-edit rejection ahead of the dose check", async prescriptionKind => {
    const { exercise, menu, item } = await fixture();
    await prisma.menuItem.update({ where: { id: item.id }, data: { prescriptionKind } });
    expect(await updateMenuItemAction(menu.id, item.id, null, form(exercise.id, "20", "左右10回ずつ行う。")))
      .toMatchObject({ ok: false });
    expect(listComposerCatalog).not.toHaveBeenCalled();
    expect(await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ prescriptionKind, reps: 10 });
  });
});
