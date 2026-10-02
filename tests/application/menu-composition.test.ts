import { describe, expect, it, vi } from "vitest";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { COMPOSER_CATALOG_CHARACTER_LIMIT, COMPOSER_CATALOG_LIMIT, selectComposerCatalog } from "@/application/menu-composition/catalog";
import { validateComposition, exerciseDoseState, exercisePlanNote, editableComposition, compositionSchema, type MenuComposition } from "@/domain/menu-composition/contracts";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { verifyMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import type { MenuComposerInput } from "@/infra/menu-composition/openai-composer";
import { catalogFixture, catalogPlan, freeformPlan, runningPlan, compositionRequest, interpretedFixture, COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";

const proposal = (items: unknown[]) => ({ blocks: [{ name: "希望の組み合わせ", items }] });
const validate = (items: unknown[], options = {}) => validateComposition(proposal(items), { ownerId: DEFAULT_OWNER_ID, catalog: [catalogFixture()], requestText: compositionRequest, runningAvailable: false, ...options });

describe("Freeform menu composition authority contract", () => {
  it.each([
    ["Running only", [runningPlan], true],
    ["Running + catalog", [runningPlan, catalogPlan()], true],
    ["Running + multiple catalog", [catalogPlan(), runningPlan, catalogPlan()], true],
    ["Exercise only", [catalogPlan()], false],
    ["Freeform only", [freeformPlan()], false],
    ["catalog + freeform", [catalogPlan(), freeformPlan()], false],
  ])("accepts %s without manufacturing Running numbers", (_name, items, runningAvailable) => {
    expect(validate(items as unknown[], { runningAvailable }).ok).toBe(true);
  });
  it("uses proposed dose, not automatic Exercise defaults", () => {
    const item = catalogPlan();
    expect(item.plannedDurationSeconds).toBe(30);
    expect(catalogFixture().defaultDurationSeconds).toBe(40);
    expect(validate([item]).ok).toBe(true);
  });
  it("keeps an unconfigured technical item and its original instruction", () => {
    const item = freeformPlan({ plannedReps: null, plannedSets: null });
    expect(validate([item]).ok).toBe(true);
    expect(exerciseDoseState(item)).toBe("UNCONFIGURED");
    expect(exercisePlanNote(item)).toContain("元の希望：壁に手をついて膝を入れ替える練習");
  });
  it.each([
    { type: "RUNNING_POLICY", plannedReps: 5 },
    { type: "RUNNING_POLICY", distanceMeters: 120 },
    { type: "RUNNING_POLICY", plannedRestSeconds: 180 },
    { type: "RUNNING_POLICY", sets: 2, targetTime: 15 },
  ])("rejects any AI Running numeric payload %j", (item) => {
    expect(validate([item], { runningAvailable: true }).ok).toBe(false);
  });
  it("rejects omitted, duplicate or unsolicited Running items", () => {
    expect(validate([catalogPlan()], { runningAvailable: true }).ok).toBe(false);
    expect(validate([runningPlan, runningPlan], { runningAvailable: true }).ok).toBe(false);
    expect(validate([runningPlan]).ok).toBe(false);
  });
  it("rejects Running disguised as catalog or freeform with an existing Running category", () => {
    expect(validate([catalogPlan()], { catalog: [catalogFixture({ category: "SPRINT" })] })).toMatchObject({ ok: false, code: "RUNNING_AUTHORITY" });
    expect(validate([freeformPlan({ category: "SPRINT" } as Partial<ReturnType<typeof freeformPlan>>)])).toMatchObject({ ok: false, code: "RUNNING_AUTHORITY" });
  });
  it("does not recycle an Engine-bound training clause as a freeform plan", () => {
    const item = freeformPlan({ originalUserInstruction: "120mを走る" } as Partial<ReturnType<typeof freeformPlan>>);
    expect(validate([runningPlan, item], { runningAvailable: true, requestText: "120mを走る", runningSourceTexts: ["120m"] })).toMatchObject({ ok: false, code: "RUNNING_AUTHORITY" });
  });
  it.each([
    { exerciseId: "unknown" }, { displayName: "似た別の練習" }, { plannedSets: 0 }, { plannedReps: Number.NaN },
    { plannedDistanceMeters: Number.POSITIVE_INFINITY }, { plannedDurationSeconds: -1 },
    { plannedDurationSeconds: 86401 }, { plannedDurationSeconds: 30, plannedReps: 10 },
  ])("rejects invalid catalog/dose %j", (patch) => expect(validate([catalogPlan(patch)]).ok).toBe(false));
  it.each([{ status: "DRAFT" }, { ownerId: "other-owner" }])("rejects unreviewed/foreign catalog %j", (patch) => expect(validate([catalogPlan()], { catalog: [catalogFixture(patch)] }).ok).toBe(false));
  it("rejects freeform catalog references and paraphrased source quotes", () => {
    expect(validate([{ ...freeformPlan(), exerciseId: "exercise-a" }]).ok).toBe(false);
    expect(validate([freeformPlan({ originalUserInstruction: "別の希望" } as Partial<ReturnType<typeof freeformPlan>>)]).ok).toBe(false);
  });
  it("allows human dose/note edits and validates IDs and units again", () => {
    let index = 0;
    const edited = editableComposition(compositionSchema.parse(proposal([catalogPlan(), freeformPlan()])), () => `item-${++index}`);
    const item = edited.blocks[0].items[0];
    if (item.type === "RUNNING_POLICY") throw new Error("fixture");
    item.plannedSets = 1; item.plannedDurationSeconds = 20; item.plannedNote = "自分のメモ";
    expect(validateComposition(edited, { ownerId: DEFAULT_OWNER_ID, catalog: [catalogFixture()], requestText: compositionRequest, runningAvailable: false, edited: true }).ok).toBe(true);
    edited.blocks[0].items[1].id = item.id;
    expect(validateComposition(edited, { ownerId: DEFAULT_OWNER_ID, catalog: [catalogFixture()], requestText: compositionRequest, runningAvailable: false, edited: true }).ok).toBe(false);
  });
});

describe("Separated menu composition orchestration", () => {
  it.each([true, false])("uses one interpreter stage + one composer stage; Running=%s", async (withRunning) => {
    const interpret = vi.fn(async () => interpretedFixture(withRunning));
    const compose = vi.fn<(input: MenuComposerInput) => Promise<{ ok: true; value: MenuComposition }>>().mockResolvedValue({ ok: true, value: compositionSchema.parse(proposal([...(withRunning ? [runningPlan] : []), catalogPlan(), freeformPlan()])) });
    const result = await generateComposedMenu({ requestText: compositionRequest, context: {} }, { ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => [catalogFixture()], interpret, compose });
    expect(result.ok).toBe(true); expect(interpret).toHaveBeenCalledTimes(1); expect(compose).toHaveBeenCalledTimes(1);
    if (!result.ok) return;
    const claims = verifyMenuCompositionToken(result.preview.previewToken, COMPOSITION_TEST_KEY);
    expect(claims?.proposal).toEqual(result.preview.composition);
    if (withRunning) expect(result.preview.runningPrescription).toMatchObject({ distanceMeters: 120, totalReps: 3, repRestSeconds: 900 });
    expect(compose.mock.calls[0][0].catalog[0]).toMatchObject({ description: catalogFixture().description, coachingPoint: catalogFixture().coachingPoint, defaultDurationSeconds: 40 });
  });
  it("stops on unavailable interpretation; no composer call or Engine default", async () => {
    const compose = vi.fn();
    const result = await generateComposedMenu({ requestText: compositionRequest, context: {} }, { ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => [], interpret: async () => ({ ok: false, reason: "INTERPRETATION_UNAVAILABLE", message: "取得不能" }), compose });
    expect(result).toMatchObject({ ok: false, code: "INTERPRETATION_UNAVAILABLE" }); expect(compose).not.toHaveBeenCalled();
  });
  it("does not call either AI stage without a usable signing key", async () => {
    const interpret = vi.fn(); const compose = vi.fn();
    expect((await generateComposedMenu({ requestText: compositionRequest, context: {} }, { ownerId: DEFAULT_OWNER_ID, signingKey: "", catalog: async () => [], interpret, compose })).ok).toBe(false);
    expect(interpret).not.toHaveBeenCalled(); expect(compose).not.toHaveBeenCalled();
  });
  it("keeps a safety-required result out of composition", async () => {
    const compose = vi.fn();
    const fixture = interpretedFixture(); fixture.running = { status: "COACH_REVIEW_REQUIRED", reason: "STRONG_FATIGUE_OR_UNWELL", message: "コーチ確認", explicitDistances: [] };
    const result = await generateComposedMenu({ requestText: compositionRequest, context: {} }, { ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => [], interpret: async () => fixture, compose });
    expect(result).toMatchObject({ ok: false, code: "COACH_REVIEW_REQUIRED" }); expect(compose).not.toHaveBeenCalled();
  });
  it("bounds rich candidate context and retains explicit metadata matches", () => {
    const rows = Array.from({ length: 158 }, (_, i) => catalogFixture({ id: `id-${i}`, name: `種目${i}`, description: "基礎動作" }));
    rows[157] = catalogFixture({ id: "explicit", name: "股関節の動き", purposes: ["HIP_JOINT"] });
    const chosen = selectComposerCatalog(rows, "股関節の動き", ["explicit"]);
    expect(chosen[0].id).toBe("explicit"); expect(chosen.length).toBeLessThanOrEqual(COMPOSER_CATALOG_LIMIT);
    expect(JSON.stringify(chosen).length).toBeLessThanOrEqual(COMPOSER_CATALOG_CHARACTER_LIMIT + 25);
  });
});
