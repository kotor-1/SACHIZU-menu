import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { saveComposedMenu } from "@/actions/_menu-composition-save-service";
import { compositionSchema, type MenuComposition } from "@/domain/menu-composition/contracts";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { prisma } from "@/infra/db/prisma";
import { findMenu } from "@/infra/repositories/menu-repository";
import { createSessionFromMenu, findSession } from "@/infra/repositories/session-repository";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { parseUnprescribedRunning, UNPRESCRIBED_RUNNING_KIND } from "@/domain/menu-composition/unprescribed-running";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { verifyPrimarySemanticIntentV2 } from "@/application/running-menu/semantic-intent-v2";
import { verifyMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import { COMPOSITION_TEST_KEY, catalogFixture, catalogPlan, freeformPlan, interpretedFixture, runningPlan } from "../fixtures/menu-composition";
import { resetDb } from "../helpers";
import recorded from "../fixtures/running-menu-live-time-scope.json";
import type { MenuComposerInput } from "@/infra/menu-composition/openai-composer";
import type { RunningMenuPreviewActionResult } from "@/actions/running-menu-preview-actions";
import type { VerifiedRunningIntent } from "@/application/running-menu/intent";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
beforeEach(async () => { vi.stubEnv("MENU_PLANNER_ACCEPT_TOKEN_SECRET", COMPOSITION_TEST_KEY); await resetDb(); });
afterEach(() => vi.unstubAllEnvs());

const recordedById = Object.fromEntries(recorded.cases.map(row => [row.id, row]));

async function makeRecordedPendingDraft(caseId = "highschool_speed_endurance_90") {
  const row = recordedById[caseId as keyof typeof recordedById];
  if (!row) throw new Error(`Unknown recorded case: ${caseId}`);
  const verified = verifyPrimarySemanticIntentV2(row.requestText, row.interpretation, []);
  if (!verified.ok) throw new Error(`Recorded interpretation rejected: ${caseId}`);
  const running = createRunningMenuPreview(verified.engineIntent, {}, row.requestText);
  if (!running || running.status === "READY") throw new Error(`Expected an unprescribed hold: ${caseId}`);
  const exercise = await prisma.exercise.create({ data: { name: "プランク", category: "CORE", metricType: "TIME", status: "REVIEWED" } });
  const proposal: MenuComposition = compositionSchema.parse({ blocks: [{ name: "補強", items: [catalogPlan({ exerciseId: exercise.id })] }] });
  let composerInput: MenuComposerInput | null = null;
  const result = await generateComposedMenu({ requestText: row.requestText, context: {} }, {
    ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
    catalog: () => listComposerCatalog(DEFAULT_OWNER_ID),
    interpret: async () => ({ ok: true, intent: verified.engineIntent, running, exercises: [],
      unsupportedIntents: verified.interpretation.unsupportedIntents.map(item => item.meaning), persistable: false, previewToken: null }),
    compose: async input => { composerInput = input; return { ok: true, value: proposal }; },
  });
  if (!result.ok) throw new Error(`Expected draft: ${result.code}`);
  return { row, exercise, running, composerInput, preview: result.preview,
    saveInput: { previewToken: result.preview.previewToken, menuName: `仮メニュー ${caseId}`,
      composition: structuredClone(result.preview.composition), runningPrescription: null } };
}

function saveInput(draft: Awaited<ReturnType<typeof makeRecordedPendingDraft>>) {
  return { ...draft.saveInput, composition: structuredClone(draft.preview.composition) };
}

describe("unprescribed Running draft path (offline interpreter fixtures + fixture composer)", () => {
  it("keeps Engine-approved Running on its existing signed path", async () => {
    const interpreted = interpretedFixture(true);
    expect(interpreted.running?.status).toBe("READY");
    const compose = vi.fn(async () => ({ ok: true as const, value: compositionSchema.parse({ blocks: [{ name: "走と補強", items: [{ type: "RUNNING_POLICY" }, catalogPlan()] }] }) }));
    const result = await generateComposedMenu({ requestText: "中学生200m選手。メニューを作って。プランクと、壁に手をついて膝を入れ替える練習を入れたい", context: {} }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => [catalogFixture()],
      interpret: async () => interpreted, compose,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.preview.unprescribedRunning).toBeNull();
    expect(result.preview.composition.blocks.flatMap(block => block.items).filter(item => item.type === "RUNNING_POLICY")).toHaveLength(1);
  });

  it.each(recorded.cases)("saves the blank pending item with the original hold reason: $id", async row => {
    const draft = await makeRecordedPendingDraft(row.id);
    expect(draft.composerInput).toMatchObject({ runningPrescription: null, unprescribedRunning: {
      reasonCode: draft.running.reason, reasonMessage: draft.running.message,
    } });
    const pending = draft.preview.composition.blocks.flatMap(block => block.items).find(item => item.type === "UNPRESCRIBED_RUNNING");
    expect(pending).toMatchObject({ type: "UNPRESCRIBED_RUNNING", reasonCode: draft.running.reason, reasonMessage: draft.running.message,
      plannedSets: null, plannedReps: null, plannedDistanceMeters: null, plannedRestSeconds: null,
      plannedDurationSeconds: null, plannedIntensityPercent: null });
    const claims = verifyMenuCompositionToken(draft.preview.previewToken, COMPOSITION_TEST_KEY);
    expect(claims).toMatchObject({ unprescribedRunning: { reasonCode: draft.running.reason, reasonMessage: draft.running.message },
      runningPrescription: null, runningToken: null });
    expect(await saveComposedMenu(saveInput(draft))).toMatchObject({ ok: true });
    const saved = await findMenu(draft.preview.previewToken ? claims!.menuId : "");
    const runItem = saved?.blocks.flatMap(block => block.items).find(item => item.prescriptionKind === UNPRESCRIBED_RUNNING_KIND);
    expect(runItem).toMatchObject({ exerciseId: null, prescriptionKind: UNPRESCRIBED_RUNNING_KIND, sets: null, reps: null,
      distanceMeters: null, restSeconds: null, durationSeconds: null, intensityPercent: null });
    expect(parseUnprescribedRunning(runItem!.prescriptionKind, runItem!.prescriptionJson)).toEqual({ reasonCode: draft.running.reason, reasonMessage: draft.running.message });
    expect(runItem?.provenanceJson).toContain('"engineApproved":false');
    expect(saved?.blocks.flatMap(block => block.items).some(item => item.prescriptionKind === "RUNNING_POLICY")).toBe(false);
  });

  it("allows a person to edit pending numbers as user-only metadata", async () => {
    const draft = await makeRecordedPendingDraft();
    const input = saveInput(draft);
    const pending = input.composition.blocks.flatMap(block => block.items).find(item => item.type === "UNPRESCRIBED_RUNNING");
    if (!pending || pending.type !== "UNPRESCRIBED_RUNNING") throw new Error("Pending Running fixture missing");
    pending.plannedSets = 2; pending.plannedReps = 4; pending.plannedRestSeconds = 90; pending.plannedIntensityPercent = 60;
    const result = await saveComposedMenu(input);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const saved = await findMenu(result.menuId);
    const row = saved?.blocks.flatMap(block => block.items).find(item => item.prescriptionKind === UNPRESCRIBED_RUNNING_KIND);
    expect(row).toMatchObject({ sets: 2, reps: 4, restSeconds: 90, intensityPercent: 60, prescriptionKind: UNPRESCRIBED_RUNNING_KIND });
    expect(row?.provenanceJson).toContain('"doseAuthority":"USER_ONLY"');
    expect(row?.provenanceJson).toContain('"engineApproved":false');
    expect(saved?.blocks.flatMap(block => block.items).some(item => item.prescriptionKind === "RUNNING_POLICY")).toBe(false);
  });

  it("rejects reason tampering and conversion to an approved Running item", async () => {
    const draft = await makeRecordedPendingDraft();
    const original = saveInput(draft);
    const pending = original.composition.blocks.flatMap(block => block.items).find(item => item.type === "UNPRESCRIBED_RUNNING");
    if (!pending || pending.type !== "UNPRESCRIBED_RUNNING") throw new Error("Pending Running fixture missing");
    const alteredReason = structuredClone(original);
    const altered = alteredReason.composition.blocks.flatMap(block => block.items).find(item => item.type === "UNPRESCRIBED_RUNNING");
    if (!altered || altered.type !== "UNPRESCRIBED_RUNNING") throw new Error("Pending Running fixture missing");
    altered.reasonCode = "READY";
    expect(await saveComposedMenu(alteredReason)).toMatchObject({ ok: false, code: "RUNNING_AUTHORITY" });
    const substituted = structuredClone(original);
    const index = substituted.composition.blocks.findIndex(block => block.items.some(item => item.id === pending.id));
    const rowIndex = substituted.composition.blocks[index].items.findIndex(item => item.id === pending.id);
    substituted.composition.blocks[index].items[rowIndex] = { type: "RUNNING_POLICY", id: pending.id, plannedNote: "" };
    expect(await saveComposedMenu(substituted)).toMatchObject({ ok: false, code: "RUNNING_AUTHORITY" });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("turns an AI type-only Running marker into the server-owned blank pending item", async () => {
    const draft = await makeRecordedPendingDraft();
    const markerProposal: MenuComposition = compositionSchema.parse({ blocks: [{ name: "混合案", items: [runningPlan, catalogPlan({ exerciseId: draft.exercise.id })] }] });
    const verified = verifyPrimarySemanticIntentV2(draft.row.requestText, draft.row.interpretation, []);
    if (!verified.ok) throw new Error("Recorded interpretation rejected");
    const markerCompose = generateComposedMenu({ requestText: draft.row.requestText, context: {} }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: () => listComposerCatalog(DEFAULT_OWNER_ID),
      interpret: async () => ({ ok: true, intent: verified.engineIntent, running: draft.running, exercises: [],
        unsupportedIntents: verified.interpretation.unsupportedIntents.map(item => item.meaning), persistable: false, previewToken: null }),
      compose: async () => ({ ok: true, value: markerProposal }),
    });
    const result = await markerCompose;
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const items = result.preview.composition.blocks.flatMap(block => block.items);
    expect(items.filter(item => item.type === "UNPRESCRIBED_RUNNING")).toHaveLength(1);
    expect(items.filter(item => item.type === "RUNNING_POLICY")).toHaveLength(0);
    expect(items.find(item => item.type === "UNPRESCRIBED_RUNNING")).toMatchObject({ plannedSets: null, plannedReps: null,
      plannedDistanceMeters: null, plannedRestSeconds: null, plannedDurationSeconds: null, plannedIntensityPercent: null,
      reasonCode: draft.running.reason, reasonMessage: draft.running.message });
  });

  it("rejects numeric payloads on an AI Running marker", async () => {
    const row = recordedById.highschool_speed_endurance_90;
    const verified = verifyPrimarySemanticIntentV2(row.requestText, row.interpretation, []);
    if (!verified.ok) throw new Error("Recorded interpretation rejected");
    const running = createRunningMenuPreview(verified.engineIntent, {}, row.requestText);
    if (!running || running.status === "READY") throw new Error("Expected policy hold");
    const exercise = await prisma.exercise.create({ data: { name: "プランク", category: "CORE", metricType: "TIME", status: "REVIEWED" } });
    const malicious = { blocks: [{ name: "偽装", items: [{ type: "RUNNING_POLICY", plannedReps: 6 }, catalogPlan({ exerciseId: exercise.id })] }] } as unknown as MenuComposition;
    const result = await generateComposedMenu({ requestText: row.requestText, context: {} }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: () => listComposerCatalog(DEFAULT_OWNER_ID),
      interpret: async () => ({ ok: true, intent: verified.engineIntent, running, exercises: [],
        unsupportedIntents: verified.interpretation.unsupportedIntents.map(item => item.meaning), persistable: false, previewToken: null }),
      compose: async () => ({ ok: true, value: malicious }),
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_COMPOSITION" });
  });

  it("allows deleting the pending marker while saving the remaining catalog work", async () => {
    const draft = await makeRecordedPendingDraft();
    const input = saveInput(draft);
    for (const block of input.composition.blocks) block.items = block.items.filter(item => item.type !== "UNPRESCRIBED_RUNNING");
    const saved = await saveComposedMenu(input);
    expect(saved).toMatchObject({ ok: true });
    if (!saved.ok) return;
    const menu = await findMenu(saved.menuId);
    expect(menu?.blocks.flatMap(block => block.items).some(item => item.prescriptionKind === UNPRESCRIBED_RUNNING_KIND)).toBe(false);
    expect(menu?.blocks.flatMap(block => block.items).some(item => item.exerciseId === draft.exercise.id)).toBe(true);
  });

  it("rejects a newly forged pending item ID", async () => {
    const draft = await makeRecordedPendingDraft();
    const input = saveInput(draft);
    const pending = input.composition.blocks.flatMap(block => block.items).find(item => item.type === "UNPRESCRIBED_RUNNING");
    if (!pending || pending.type !== "UNPRESCRIBED_RUNNING") throw new Error("Pending Running fixture missing");
    pending.id = "forged-pending-id";
    expect(await saveComposedMenu(input)).toMatchObject({ ok: false, code: "RUNNING_AUTHORITY" });
  });

  it("preserves the unprescribed snapshot after Menu edits and permits manual replacement only by user action", async () => {
    const draft = await makeRecordedPendingDraft();
    const saved = await saveComposedMenu(saveInput(draft));
    if (!saved.ok) throw new Error("Pending Running save failed");
    const menu = (await findMenu(saved.menuId))!;
    const pending = menu.blocks.flatMap(block => block.items).find(item => item.prescriptionKind === UNPRESCRIBED_RUNNING_KIND)!;
    const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-10-09" }));
    const before = (await findSession(session.id))!;
    const snapshot = before.items.find(item => item.prescriptionKind === UNPRESCRIBED_RUNNING_KIND)!;
    expect(snapshot).toMatchObject({ plannedSets: null, plannedReps: null, plannedPrescriptionJson: pending.prescriptionJson,
      plannedProvenanceJson: pending.provenanceJson, prescriptionKind: UNPRESCRIBED_RUNNING_KIND });
    await prisma.menuItem.update({ where: { id: pending.id }, data: { sets: 3, reps: 6, restSeconds: 120, note: "ユーザー入力" } });
    const after = (await findSession(session.id))!;
    expect(after.items.find(item => item.id === snapshot.id)).toEqual(snapshot);
  });

  it("allows a generic catalog composition when event is missing but keeps the Running item unprescribed", async () => {
    const base = interpretedFixture(false);
    const intent: VerifiedRunningIntent = { ...base.intent, runningRequested: true, event: null,
      ageGroup: { value: "HIGH_SCHOOL", sourceText: "高校生", sourceType: "USER_TEXT" } };
    const running = createRunningMenuPreview(intent, {}, "高校生です。種目はまだ決まっていません。プランクを含む補強メニューを作ってください。");
    expect(running).toMatchObject({ status: "NEEDS_INPUT", reason: "EVENT_REQUIRED" });
    const exercise = await prisma.exercise.create({ data: { name: "プランク", category: "CORE", metricType: "TIME", status: "REVIEWED" } });
    const requestText = "高校生です。種目はまだ決まっていません。プランクを含む補強メニューを作ってください。";
    const compose = vi.fn(async (input: MenuComposerInput) => {
      expect(input.catalog.some(row => row.id === exercise.id)).toBe(true);
      expect(input.runningPrescription).toBeNull();
      return { ok: true as const, value: compositionSchema.parse({ blocks: [{ name: "補強", items: [catalogPlan({ exerciseId: exercise.id })] }] }) };
    });
    const result = await generateComposedMenu({ requestText, context: {} }, { ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
      catalog: () => listComposerCatalog(DEFAULT_OWNER_ID), interpret: async () => ({ ...base, intent, running }), compose });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.preview.composition.blocks.flatMap(block => block.items).some(item => item.type === "UNPRESCRIBED_RUNNING")).toBe(true);
  });

  it.each(["STRONG_OR_UNWELL", "MULTIPLE_EXPLICIT_DISTANCES"] as const)("does not draft safety or conflict holds: %s", async reason => {
    const base = interpretedFixture();
    const intent: VerifiedRunningIntent = reason === "STRONG_OR_UNWELL"
      ? { ...base.intent, fatigueState: { value: "STRONG_OR_UNWELL", sourceText: "強い不調", sourceType: "USER_TEXT" } }
      : { ...base.intent, explicitDistances: [
        { value: 100, sourceText: "100m", sourceType: "USER_TEXT" }, { value: 200, sourceText: "200m", sourceType: "USER_TEXT" },
      ] };
    const requestText = reason === "STRONG_OR_UNWELL" ? "強い不調があるので走メニューを作って" : "100mと200mの練習を作って";
    const running = createRunningMenuPreview(intent, {}, requestText);
    const compose = vi.fn();
    const interpreted: RunningMenuPreviewActionResult = { ...base, intent, running };
    const result = await generateComposedMenu({ requestText, context: {} }, { ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
      catalog: async () => [], interpret: async () => interpreted, compose });
    expect(result.ok).toBe(false);
    expect(compose).not.toHaveBeenCalled();
  });

  it("does not compose an invalid interpreter result", async () => {
    const compose = vi.fn();
    const result = await generateComposedMenu({ requestText: "不正な入力", context: {} }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => [],
      interpret: async () => ({ ok: false, message: "解釈を確認できませんでした。" }), compose,
    });
    expect(result).toMatchObject({ ok: false, code: "INTERPRETATION_INVALID" });
    expect(compose).not.toHaveBeenCalled();
  });

  it("saves a manual non-running menu without inventing a pending Running item", async () => {
    const { createManualComposedMenuAction } = await import("@/actions/menu-composition-actions");
    const manual = await createManualComposedMenuAction();
    if (!manual.ok) throw new Error(manual.code);
    manual.preview.composition.blocks[0].items.push({ ...freeformPlan(), id: "manual-item" });
    const result = await saveComposedMenu({ previewToken: manual.preview.previewToken, menuName: "手動", composition: manual.preview.composition, runningPrescription: null });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect((await findMenu(result.menuId))?.blocks.flatMap(block => block.items).every(item => item.prescriptionKind !== UNPRESCRIBED_RUNNING_KIND && item.prescriptionKind !== "RUNNING_POLICY")).toBe(true);
  });
});
