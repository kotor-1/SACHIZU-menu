import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { savedMenuDurationInput } from "@/application/menu-composition/saved-duration";
import { saveComposedMenu } from "@/actions/_menu-composition-save-service";
import { saveMenuDuration } from "@/actions/_menu-duration-service";
import { calculateMenuDuration, type DurationPlan } from "@/domain/menu-composition/duration";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { prisma } from "@/infra/db/prisma";
import { findMenu } from "@/infra/repositories/menu-repository";
import { compositionRequest, freeformPlan, interpretedFixture, runningPlan, COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";
import { issueRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";
import { verifyMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import { parseConfirmedCompositionContext } from "@/domain/menu-composition/saved-context";
import { resetDb } from "../helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
beforeEach(async () => { vi.stubEnv("MENU_PLANNER_ACCEPT_TOKEN_SECRET", COMPOSITION_TEST_KEY); await resetDb(); });
afterEach(() => vi.unstubAllEnvs());

async function draft(requestedSeconds = 1200) {
  const result = await generateComposedMenu({ requestText: compositionRequest, context: { availableTimeSeconds: requestedSeconds } }, {
    ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
    catalog: () => listComposerCatalog(DEFAULT_OWNER_ID),
    interpret: async () => interpretedFixture(false),
    compose: async () => ({ ok: true, value: { blocks: [{ name: "自由メニュー", items: [freeformPlan()] }] } }),
  });
  if (!result.ok) throw new Error(result.code);
  return result.preview;
}

function planFor(blockIds: string[], allocation: number, transitionSeconds = 0): DurationPlan {
  return { blocks: blockIds.map((blockId, index) => ({ blockId, phase: index ? "COOL_DOWN" as const : "DRILLS_STRENGTH" as const, allocatedSeconds: allocation })), transitionSeconds };
}

describe("menu duration plan persistence", () => {
  it("generates, signs, saves, and reloads overview, athlete label, and Engine-bounded duration allocations", async () => {
    const overview = { title: "100m 基礎練習", objective: "走りの土台づくり", approach: "希望した動きと走を組み合わせます" };
    const result = await generateComposedMenu({ requestText: compositionRequest,
      context: { ageGroup: "JUNIOR_HIGH", event: "200m", availableTimeSeconds: 1200 } }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
      catalog: () => listComposerCatalog(DEFAULT_OWNER_ID), interpret: async () => interpretedFixture(false),
      compose: async () => ({ ok: true, value: { overview, transitionSeconds: 30, blocks: [{ name: "動きづくり",
        phase: "DRILLS_STRENGTH", allocatedSeconds: 60,
        items: [freeformPlan({ plannedReps: null, plannedDurationSeconds: 30, plannedRestSeconds: 45 })] }] } }),
    });
    if (!result.ok) throw new Error(result.code);
    const preview = result.preview;
    const claims = verifyMenuCompositionToken(preview.previewToken, COMPOSITION_TEST_KEY);
    expect(preview.overview).toEqual(overview);
    expect(preview.athleteLabel).toBe("中学生・200m");
    expect(preview.durationPlan?.blocks).toHaveLength(preview.composition.blocks.length);
    expect(preview.durationPlan?.blocks[0]).toMatchObject({ blockId: preview.composition.blocks[0].id,
      phase: "DRILLS_STRENGTH", allocatedSeconds: 120 }); // known 105s work/rest minimum rounded up to a minute
    expect(claims).toMatchObject({ overview, athleteLabel: "中学生・200m", requestedTimeSeconds: 1200 });
    expect(claims?.proposal.blocks.map(block => block.id)).toEqual(preview.composition.blocks.map(block => block.id));

    const saved = await saveComposedMenu({ previewToken: preview.previewToken, menuName: "メタデータ保存確認",
      composition: preview.composition, durationPlan: preview.durationPlan, runningPrescription: preview.runningPrescription });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const reloaded = await findMenu(saved.menuId);
    expect(reloaded).not.toBeNull();
    const context = parseConfirmedCompositionContext(reloaded!.runningContextJson);
    expect(context).toMatchObject({ overview, athleteLabel: "中学生・200m", requestedTimeSeconds: 1200,
      durationPlan: { transitionSeconds: 30 } });
    expect(context?.durationPlan?.blocks).toEqual([{ ...preview.durationPlan!.blocks[0], blockId: reloaded!.blocks[0].id }]);
    expect(reloaded!.blocks).toHaveLength(1);
  });

  it("keeps estimate basis through save/reload and marks it stale when item doses change", async () => {
    const result = await generateComposedMenu({ requestText: compositionRequest, context: { availableTimeSeconds: 180 } }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
      catalog: () => listComposerCatalog(DEFAULT_OWNER_ID), interpret: async () => interpretedFixture(false),
      compose: async () => ({ ok: true, value: { transitionSeconds: 30, transitionDescription: "場所の移動と準備30秒の計画", blocks: [{
        name: "動きづくり", phase: "DRILLS_STRENGTH", allocatedSeconds: 150,
        allocationBasis: { itemEstimatesSeconds: [120], preparationSeconds: 30,
          explanation: "30秒を2セット、間の休息60秒で120秒。開始前の準備30秒。",
          preparationDescription: "開始前の場所確認30秒" },
        items: [freeformPlan({ plannedSets: 2, plannedReps: null, plannedDurationSeconds: 30, plannedRestSeconds: 60 })],
      }] } }),
    });
    if (!result.ok) throw new Error(result.code);
    const preview = result.preview;
    expect(calculateMenuDuration(preview.composition, null, 180, preview.durationPlan).planningStatus).toBe("ACCOUNTED_FOR");
    const saved = await saveComposedMenu({ previewToken: preview.previewToken, menuName: "配分根拠の保存",
      composition: preview.composition, durationPlan: preview.durationPlan, runningPrescription: null });
    if (!saved.ok) throw new Error(saved.code);
    const reload = (await findMenu(saved.menuId))!;
    const input = savedMenuDurationInput(reload)!;
    expect(input.plan.transitionDescription).toBe("場所の移動と準備30秒の計画");
    expect(input.plan.blocks[0].allocationBasis).toEqual(preview.durationPlan!.blocks[0].allocationBasis);
    expect(calculateMenuDuration(input.composition, input.running, 180, input.plan).planningStatus).toBe("ACCOUNTED_FOR");
    await prisma.menuItem.update({ where: { id: reload.blocks[0].items[0].id }, data: { durationSeconds: 40 } });
    const changed = savedMenuDurationInput((await findMenu(saved.menuId))!)!;
    expect(calculateMenuDuration(changed.composition, changed.running, 180, changed.plan).planningStatus).toBe("NEEDS_REVIEW");
    await prisma.menuItem.update({ where: { id: reload.blocks[0].items[0].id }, data: { durationSeconds: 30, note: "片側30秒ずつ保持する" } });
    const changedText = savedMenuDurationInput((await findMenu(saved.menuId))!)!;
    expect(calculateMenuDuration(changedText.composition, changedText.running, 180, changedText.plan).planIssues)
      .toContainEqual(expect.objectContaining({ code: "STALE_BASIS" }));
  });

  it("saves the manual allocation against persisted block IDs and reloads its summary", async () => {
    const { createManualComposedMenuAction } = await import("@/actions/menu-composition-actions");
    const manual = await createManualComposedMenuAction({ availableTimeSeconds: 1200 });
    if (!manual.ok) throw new Error(manual.code);
    const preview = manual.preview;
    // A manual planning window may differ from the requested target; it never edits the item dose.
    preview.composition.blocks[0].items.push({ ...freeformPlan({ plannedReps: null, plannedSets: null, plannedDurationSeconds: 30 }), id: "manual-duration-item" });
    const plan = planFor(preview.composition.blocks.map(block => block.id), 900, 60);
    const result = await saveComposedMenu({ previewToken: preview.previewToken, menuName: "時間配分テスト",
      composition: preview.composition, durationPlan: plan, runningPrescription: null });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const menu = await findMenu(result.menuId);
    expect(menu).not.toBeNull();
    const savedInput = savedMenuDurationInput(menu!);
    expect(savedInput?.requestedSeconds).toBe(1200);
    expect(savedInput?.plan).toEqual({ blocks: plan.blocks.map((row, index) => ({ ...row, blockId: menu!.blocks[index].id })), transitionSeconds: 60 });
    expect(savedInput?.plan.blocks.every(row => menu!.blocks.some(block => block.id === row.blockId))).toBe(true);
    const summary = calculateMenuDuration(savedInput!.composition, savedInput!.running, savedInput!.requestedSeconds, savedInput!.plan);
    expect(summary.plannedTotalSeconds).toBe(960);
    expect(summary.budgetDifferenceSeconds).toBe(-240);
    expect(summary.status).toBe("UNDERALLOCATED");
  });

  it("retains requested time signed into the preview when saving a Running plan", async () => {
    const interpreted = interpretedFixture(true);
    interpreted.intent.availableTimeSeconds = { value: 2400, sourceText: "40分", sourceType: "USER_CONTEXT" };
    if (!interpreted.running || interpreted.running.status !== "READY") throw new Error("running fixture");
    interpreted.previewToken = issueRunningMenuPreviewToken({ ownerId: DEFAULT_OWNER_ID, requestText: compositionRequest,
      context: { availableTimeSeconds: 2400 }, intent: interpreted.intent, prescription: interpreted.running.prescription }, COMPOSITION_TEST_KEY);
    const result = await generateComposedMenu({ requestText: compositionRequest, context: { availableTimeSeconds: 2400 } }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
      catalog: () => listComposerCatalog(DEFAULT_OWNER_ID), interpret: async () => interpreted,
      compose: async () => ({ ok: true, value: { blocks: [{ name: "走", items: [runningPlan] }] } }),
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.preview.requestedTimeSeconds).toBe(2400);
    const plan = planFor(result.preview.composition.blocks.map(block => block.id), 2400);
    const saved = await saveComposedMenu({ previewToken: result.preview.previewToken, menuName: "希望時間保持",
      composition: result.preview.composition, durationPlan: plan, runningPrescription: result.preview.runningPrescription });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(savedMenuDurationInput((await findMenu(saved.menuId))!)?.requestedSeconds).toBe(2400);
  });

  it("rejects an allocation below known work/rest minimum without writing menu rows", async () => {
    const preview = await draft(1200);
    const block = preview.composition.blocks[0];
    const item = block.items[0];
    if (item.type === "RUNNING_POLICY") throw new Error("expected exercise item");
    item.plannedReps = null;
    item.plannedDurationSeconds = 60;
    item.plannedSets = 2;
    item.plannedRestSeconds = 30;
    const tooShort = planFor([block.id], 80);
    const result = await saveComposedMenu({ previewToken: preview.previewToken, menuName: "不足枠",
      composition: preview.composition, durationPlan: tooShort, runningPrescription: null });
    expect(result).toEqual({ ok: false, code: "DURATION_UNDERSIZED_SLOT" });
    expect(await prisma.menuTemplate.count()).toBe(0);
    expect(await prisma.menuBlock.count()).toBe(0);
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it("updates saved duration without changing item doses and rejects a stale source fingerprint", async () => {
    const preview = await draft(1200);
    const item = preview.composition.blocks[0].items[0];
    if (item.type === "RUNNING_POLICY") throw new Error("expected exercise item");
    item.plannedReps = null;
    item.plannedDurationSeconds = 30;
    item.plannedSets = 2;
    item.plannedRestSeconds = 15;
    const saved = await saveComposedMenu({ previewToken: preview.previewToken, menuName: "既存時間更新",
      composition: preview.composition, durationPlan: planFor(preview.composition.blocks.map(block => block.id), 90), runningPrescription: null });
    if (!saved.ok) throw new Error(saved.code);
    const menu = (await findMenu(saved.menuId))!;
    const { runningSessionSourceFingerprint } = await import("@/application/running-session/snapshot");
    const fingerprint = runningSessionSourceFingerprint(menu);
    const persistedItem = menu.blocks[0].items[0];
    const beforeDose = { sets: persistedItem.sets, reps: persistedItem.reps, durationSeconds: persistedItem.durationSeconds, restSeconds: persistedItem.restSeconds };
    const replacementPlan = planFor(menu.blocks.map(block => block.id), 120, 0);
    expect(await saveMenuDuration({ menuId: menu.id, sourceFingerprint: "0".repeat(64), requestedSeconds: 180, plan: replacementPlan }))
      .toEqual({ ok: false, code: "STALE_MENU" });
    expect(await saveMenuDuration({ menuId: menu.id, sourceFingerprint: fingerprint, requestedSeconds: 180, plan: replacementPlan }))
      .toEqual({ ok: true, menuId: menu.id });
    const reloaded = (await findMenu(menu.id))!;
    expect(reloaded.blocks[0].items[0]).toMatchObject(beforeDose);
    expect(savedMenuDurationInput(reloaded)?.requestedSeconds).toBe(180);
    expect(savedMenuDurationInput(reloaded)?.plan.blocks[0].allocatedSeconds).toBe(120);
  });

  it("reports positive and negative target deltas without changing prescribed doses", async () => {
    const preview = await draft(1200);
    const item = preview.composition.blocks[0].items[0];
    if (item.type === "RUNNING_POLICY") throw new Error("expected exercise item");
    item.plannedReps = null; item.plannedDurationSeconds = 30; item.plannedSets = 2; item.plannedRestSeconds = 15;
    const plan = planFor([preview.composition.blocks[0].id], 120);
    const before = { sets: item.plannedSets, reps: item.plannedReps, duration: item.plannedDurationSeconds, rest: item.plannedRestSeconds };
    expect(calculateMenuDuration(preview.composition, null, 90, plan).budgetDifferenceSeconds).toBe(30);
    expect(calculateMenuDuration(preview.composition, null, 180, plan).budgetDifferenceSeconds).toBe(-60);
    expect({ sets: item.plannedSets, reps: item.plannedReps, duration: item.plannedDurationSeconds, rest: item.plannedRestSeconds }).toEqual(before);
  });
});
