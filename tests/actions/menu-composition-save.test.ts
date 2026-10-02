import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { saveComposedMenu } from "@/actions/_menu-composition-save-service";
import { compositionSchema, type MenuComposition } from "@/domain/menu-composition/contracts";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { prisma } from "@/infra/db/prisma";
import { findMenu } from "@/infra/repositories/menu-repository";
import { createSessionFromMenu, findSession } from "@/infra/repositories/session-repository";
import { runningSessionSourceFingerprint } from "@/application/running-session/snapshot";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { parseRunningMenuEnvelope, finalRunningMenuPrescription } from "@/application/running-menu/persistence";
import { menuItemEstimatedSeconds } from "@/presentation/menu-composition/planned-time";
import { isComposedMenuContext } from "@/domain/menu-composition/saved-context";
import { exerciseVideoGuidanceSchema } from "@/domain/exercise/video-guidance";
import { catalogPlan, freeformPlan, runningPlan, compositionRequest, interpretedFixture, COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";
import { resetDb } from "../helpers";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(async () => { vi.stubEnv("MENU_PLANNER_ACCEPT_TOKEN_SECRET", COMPOSITION_TEST_KEY); await resetDb(); });
afterEach(() => vi.unstubAllEnvs());

async function preview(options: { running?: boolean; freeformOnly?: boolean; unset?: boolean } = {}) {
  const withRunning = options.running ?? true;
  const exercise = await prisma.exercise.create({ data: { name: "プランク", category: "CORE", metricType: "TIME", status: "REVIEWED", defaultDurationSeconds: 40, defaultSets: 3 } });
  const proposal: MenuComposition = compositionSchema.parse({ blocks: [
    { name: "希望した動き", items: [...(options.freeformOnly ? [] : [catalogPlan({ exerciseId: exercise.id, ...(options.unset ? { plannedDurationSeconds: null, plannedSets: null, plannedRestSeconds: null } : {}) })]), freeformPlan()] },
    ...(withRunning ? [{ name: "走を入れる場所", items: [runningPlan] }] : []),
  ] });
  const result = await generateComposedMenu({ requestText: compositionRequest, context: {} }, { ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
    catalog: () => listComposerCatalog(DEFAULT_OWNER_ID), interpret: async () => interpretedFixture(withRunning), compose: async () => ({ ok: true, value: proposal }) });
  if (!result.ok) throw new Error(result.code);
  return { exercise, generated: result.preview, input: { previewToken: result.preview.previewToken, menuName: "自由な組み合わせ", composition: structuredClone(result.preview.composition), runningPrescription: result.preview.runningPrescription } };
}

describe("Signed composed menu save and immutable planned snapshot", () => {
  it("supplies cached guidance only for the currently owned, linked VideoAsset", async () => {
    const exercise = await prisma.exercise.create({ data: { name: "動画付き種目", category: "CORE", status: "REVIEWED" } });
    const guidance = exerciseVideoGuidanceSchema.parse({ executionSummary: "身体を保つ", movementPattern: "静止", countingUnit: "SECONDS", bilateralCounting: null, typicalStructure: null,
      equipment: [], setup: null, keyCues: [], commonErrors: [], doseObservations: [], sourceVideoId: "video-owned", analysisVersion: "v1", videoAnalysisStatus: "AI_ANALYZED", analyzedAt: new Date().toISOString(), coachReviewedAt: null });
    const store = { read: async () => guidance, write: async () => undefined };
    expect((await listComposerCatalog(DEFAULT_OWNER_ID, store))[0].videoGuidance).toBeNull();
    await prisma.videoAsset.create({ data: { id: "video-owned", ownerId: DEFAULT_OWNER_ID, exerciseId: exercise.id, storageKey: "uploads/videos/mock.mp4", filename: "mock.mp4" } });
    expect((await listComposerCatalog(DEFAULT_OWNER_ID, store))[0].videoGuidance?.sourceVideoId).toBe("video-owned");
    await prisma.videoAsset.update({ where: { id: "video-owned" }, data: { ownerId: "other-owner" } });
    expect((await listComposerCatalog(DEFAULT_OWNER_ID, store))[0].videoGuidance).toBeNull();
  });
  it("starts and saves a fully manual plan without either AI stage", async () => {
    const { createManualComposedMenuAction } = await import("@/actions/menu-composition-actions");
    const manual = await createManualComposedMenuAction();
    if (!manual.ok) throw new Error(manual.code);
    manual.preview.composition.blocks[0].items.push({ ...freeformPlan(), id: "manual-item" });
    const saved = await saveComposedMenu({ previewToken: manual.preview.previewToken, menuName: "手動", composition: manual.preview.composition, runningPrescription: null });
    expect(saved.ok).toBe(true); expect(await prisma.exercise.count()).toBe(0);
  });
  it("materializes AI Exercise dose and freeform instruction; persists composed order", async () => {
    const draft = await preview();
    const countBefore = await prisma.exercise.count();
    const saved = await saveComposedMenu(draft.input);
    expect(saved.ok).toBe(true); if (!saved.ok) return;
    const menu = await findMenu(saved.menuId);
    expect(menu?.blocks.map((block) => block.name)).toEqual(["希望した動き", "走を入れる場所"]);
    expect(menu?.blocks[0].items[0]).toMatchObject({ exerciseId: draft.exercise.id, sets: 2, durationSeconds: 30, restSeconds: 45, reps: null });
    const free = menu?.blocks[0].items[1];
    expect(free).toMatchObject({ exerciseId: null, displayName: "壁で膝を入れ替える", sets: 2, reps: 10 });
    expect(free?.note).toContain("元の希望：壁に手をついて膝を入れ替える練習");
    expect(await prisma.exercise.count()).toBe(countBefore);
    const run = menu!.blocks[1].items[0];
    expect(run).toMatchObject({ distanceMeters: 120, reps: 3, restSeconds: 900, sets: 1, runningMethod: null, sessionTemplateId: null });
    expect(menuItemEstimatedSeconds(run)).toBe(1800);
    expect(isComposedMenuContext(menu!.runningContextJson)).toBe(true);
  });
  it("saves human-edited dose, note, placement and deletion", async () => {
    const draft = await preview();
    const catalog = draft.input.composition.blocks[0].items[0];
    if (catalog.type !== "CATALOG_EXERCISE") throw new Error("fixture");
    catalog.plannedSets = 1; catalog.plannedDurationSeconds = 20; catalog.plannedNote = "調整したメモ";
    draft.input.composition.blocks[0].items = [catalog];
    draft.input.composition.blocks.reverse();
    const result = await saveComposedMenu(draft.input);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const menu = await findMenu(result.menuId);
    expect(menu?.blocks[0].items[0].prescriptionKind).toBe("RUNNING_POLICY");
    expect(menu?.blocks[1].items[0]).toMatchObject({ sets: 1, durationSeconds: 20 });
    expect(menu?.blocks[1].items[0].note).toContain("調整したメモ");
  });
  it.each([{ running: false }, { running: false, freeformOnly: true }, { running: false, unset: true }])("saves exercise-only, freeform-only and UNCONFIGURED plans %j", async (options) => {
    const draft = await preview(options);
    const result = await saveComposedMenu(draft.input);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const menu = await findMenu(result.menuId);
    expect(menu?.blocks.flatMap((block) => block.items).some((item) => item.prescriptionKind === "RUNNING_POLICY")).toBe(false);
    if (options.unset) expect(menu?.blocks[0].items[0]).toMatchObject({ sets: null, reps: null, durationSeconds: null, distanceMeters: null });
  });
  it("copies final dose/note into Session; future defaults and Menu edits never change its plan", async () => {
    const draft = await preview();
    const saved = await saveComposedMenu(draft.input);
    if (!saved.ok) throw new Error(saved.code);
    const menu = (await findMenu(saved.menuId))!;
    const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-10-02", runningSourceFingerprint: runningSessionSourceFingerprint(menu) }), undefined, runningSessionSourceFingerprint(menu));
    const before = (await findSession(session.id))!;
    expect(before.items[0]).toMatchObject({ plannedSets: 2, plannedDurationSeconds: 30, plannedRestSeconds: 45, exerciseNameSnapshot: "プランク", blockNameSnapshot: "希望した動き" });
    expect(before.items[1].plannedNote).toContain("元の希望：");
    expect(before.items[2]).toMatchObject({ plannedDistanceMeters: 120, plannedReps: 3, plannedRestSeconds: 900 });
    const plannedBefore = before.items.map((item) => [item.plannedSets, item.plannedReps, item.plannedDurationSeconds, item.plannedRestSeconds, item.plannedNote]);
    await prisma.exercise.update({ where: { id: draft.exercise.id }, data: { defaultDurationSeconds: 99 } });
    await prisma.menuItem.update({ where: { id: menu.blocks[0].items[0].id }, data: { durationSeconds: 70, note: "別のメモ" } });
    const after = (await findSession(session.id))!;
    expect(after.items.map((item) => [item.plannedSets, item.plannedReps, item.plannedDurationSeconds, item.plannedRestSeconds, item.plannedNote])).toEqual(plannedBefore);
  });
  it("rejects client Running numeric tampering, even when the token is valid", async () => {
    const draft = await preview();
    const result = await saveComposedMenu({ ...draft.input, runningPrescription: { ...draft.input.runningPrescription!, totalReps: 5 } });
    expect(result).toMatchObject({ ok: false, code: "RUNNING_TAMPER" }); expect(await prisma.menuTemplate.count()).toBe(0);
    expect((await saveComposedMenu({ ...draft.input, composition: { blocks: [{ id: "b", name: "走", items: [{ id: "i", type: "RUNNING_POLICY", plannedNote: "", plannedReps: 5 }] }] } })).ok).toBe(false);
  });
  it("allows only approved Coach Edit and preserves its v2 envelope", async () => {
    const draft = await preview();
    const base = draft.input.runningPrescription!;
    const { applyRunningCoachEdit } = await import("@/application/running-menu/coach-edit");
    const { evaluateSignedRunningPreview, runningSaveProvenance } = await import("@/actions/_running-menu-save-service");
    const verified = evaluateSignedRunningPreview({ previewToken: draft.generated.runningToken!, previewPolicyVersion: base.policyVersion, previewPolicyHash: base.policyHash, context: {}, requestText: compositionRequest, previewPrescription: base });
    if (!verified.ok) throw new Error(verified.code);
    const edit = { totalReps: 2 };
    const result = applyRunningCoachEdit({ kind: "RUNNING_POLICY", schemaVersion: 1, policyVersion: base.policyVersion, policyHash: base.policyHash, prescription: base }, runningSaveProvenance(verified.claims), edit, new Date().toISOString());
    if (!result.ok) throw new Error(result.code);
    const input = { ...draft.input, coachEdit: edit, runningPrescription: result.envelope.finalPrescription };
    const saved = await saveComposedMenu(input); expect(saved.ok).toBe(true); if (!saved.ok) return;
    const menu = (await findMenu(saved.menuId))!;
    const run = menu.blocks[1].items[0];
    const envelope = parseRunningMenuEnvelope(run.prescriptionKind, run.prescriptionJson)!;
    expect(envelope.schemaVersion).toBe(2); expect(finalRunningMenuPrescription(envelope).totalReps).toBe(2);
    expect(await saveComposedMenu(input)).toMatchObject({ ok: true, alreadySaved: true });
  });
  it("binds idempotence to the whole final plan, not only Running", async () => {
    const draft = await preview();
    expect((await saveComposedMenu(draft.input)).ok).toBe(true);
    expect(await saveComposedMenu(draft.input)).toMatchObject({ ok: true, alreadySaved: true });
    expect(await saveComposedMenu({ ...draft.input, menuName: "別のメニュー" })).toMatchObject({ ok: false, code: "STALE_PREVIEW" });
    expect(await prisma.menuTemplate.count()).toBe(1);
  });
  it("revalidates catalog status and rejects forged preview signatures", async () => {
    const draft = await preview();
    await prisma.exercise.update({ where: { id: draft.exercise.id }, data: { status: "ARCHIVED" } });
    expect((await saveComposedMenu(draft.input)).ok).toBe(false);
    expect(await saveComposedMenu({ ...draft.input, previewToken: `wrong${draft.input.previewToken}` })).toMatchObject({ ok: false, code: "STALE_PREVIEW" });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });
  it("allows deleting Running without executing a fallback prescription", async () => {
    const draft = await preview();
    draft.input.composition.blocks = [draft.input.composition.blocks[0]];
    const result = await saveComposedMenu(draft.input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect((await findMenu(result.menuId))!.blocks.flatMap((block) => block.items).every((item) => item.prescriptionKind === "LEGACY")).toBe(true);
  });
});
