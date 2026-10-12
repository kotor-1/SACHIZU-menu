import { describe, it, expect, vi } from "vitest";
import { generateTrainingProposal, type TrainingComposerInput } from "@/application/training-proposal/generate";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { trainingAvailability } from "@/domain/training-proposal/quality";
import { buildStructuredRunningPreview } from "@/application/training-proposal/running";
import { verifyTrainingProposalToken } from "@/infra/training-proposal/preview-token";
import { trainingComposerOutputSchema } from "@/domain/training-proposal/contracts";
import { offlineTrainingComposer, trainingCatalog, trainingCases, trainingCaseA, TRAINING_TEST_KEY } from "../fixtures/training-proposals";
import realFailed from "../fixtures/menu-session-quality-real-luna.json";
import { assessExerciseEligibility } from "@/domain/training-proposal/eligibility";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";

const generate = (conditions = trainingCaseA(), compose = vi.fn(async (input: TrainingComposerInput) => ({ ok: true as const, value: offlineTrainingComposer(input) }))) =>
  generateTrainingProposal(conditions, { ownerId: DEFAULT_OWNER_ID, signingKey: TRAINING_TEST_KEY, catalog: async () => trainingCatalog, compose });

describe("structured selection -> candidate filter -> Composer -> quality gate (offline)", () => {
  it.each(Object.entries(trainingCases()))("case %s follows the actual orchestration with explicit fixture response", async (_name, conditions) => {
    const compose = vi.fn(async (input: TrainingComposerInput) => ({ ok: true as const, value: offlineTrainingComposer(input) }));
    const result = await generate(conditions, compose);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    const available = trainingAvailability(trainingCatalog, conditions);
    expect(result.preview.composition.blocks.map(b => b.name)).toEqual(["動きづくり", "走練習", "補強トレーニング"]);
    expect(result.preview.composition.blocks[0].items.length).toBe(available.requiredMovement);
    expect(result.preview.composition.blocks[2].items.length).toBe(available.requiredStrength);
    expect(result.preview.conditions).toEqual(conditions);
    const expectedRunning = buildStructuredRunningPreview(conditions).running;
    expect(result.preview.runningPrescription).toEqual(expectedRunning?.status === "READY" ? expectedRunning.prescription : null);
    expect(verifyTrainingProposalToken(result.preview.previewToken, TRAINING_TEST_KEY)?.conditions).toEqual(conditions);
    if (available.requiredMovement < 10) expect(result.preview.messages.join(" ")).toContain("10種目に達しません");
    if (available.movement.length + available.strength.length) expect(compose).toHaveBeenCalledTimes(1);
    else expect(compose).not.toHaveBeenCalled();
    expect(JSON.stringify(result.preview)).not.toContain("requestedTimeSeconds");
    expect(JSON.stringify(result.preview)).not.toContain("durationPlan");
  });
  it("A actually has at least ten independent movements and multiple strength proposals", async () => {
    const result = await generate(); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.preview.composition.blocks[0].items.length).toBeGreaterThanOrEqual(10);
    expect(result.preview.composition.blocks[2].items.length).toBeGreaterThanOrEqual(2);
    expect(result.preview.runningPrescription).not.toBeNull();
  });
  it("the real four-item response cannot satisfy the new section contract", async () => {
    expect(trainingComposerOutputSchema.safeParse(realFailed).success).toBe(false);
    const compose = vi.fn(async () => ({ ok: true as const, value: realFailed as unknown as ReturnType<typeof offlineTrainingComposer> }));
    expect(await generate(trainingCaseA(), compose)).toMatchObject({ ok: false, code: "INCOMPLETE_PROPOSAL" });
    expect(compose).toHaveBeenCalledTimes(1);
  });
  it("normalizes stage order and drops exact duplicates without retrying or padding the count", async () => {
    const compose = vi.fn(async (input: TrainingComposerInput) => {
      const output = offlineTrainingComposer(input);
      output.movement.reverse();
      output.strength.push(structuredClone(output.strength[0]));
      return { ok: true as const, value: output };
    });
    const result = await generate(trainingCaseA(), compose);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const stages = result.preview.composition.blocks[0].items.map(item => result.preview.annotations[item.id].stage ?? 0);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    const strengthIds = result.preview.composition.blocks[2].items.map(item => item.type === "CATALOG_EXERCISE" ? item.exerciseId : "");
    expect(new Set(strengthIds).size).toBe(strengthIds.length);
    expect(compose).toHaveBeenCalledTimes(1);
  });
  it.each(["short", "wrong-unit", "unavailable-wall", "running-smuggle", "overload", "duplicate-family"])("rejects %s without retry", async failure => {
    const compose = vi.fn(async (input: TrainingComposerInput) => {
      const output = offlineTrainingComposer(input);
      if (failure === "short") output.movement = output.movement.slice(0, 3);
      if (failure === "wrong-unit") output.movement[0].item.plannedDistanceMeters = 20;
      if (failure === "unavailable-wall") {
        const row = trainingCatalog.find(row => row.name.startsWith("ウォールキック"))!;
        output.movement[0].item.exerciseId = row.id; output.movement[0].item.displayName = row.name;
      }
      if (failure === "running-smuggle") output.movement[0].item.executionInstruction = "60m走を4本追加する";
      if (failure === "overload") output.strength[0].item.plannedSets = 20;
      if (failure === "duplicate-family") output.movement[1] = structuredClone(output.movement[0]);
      return { ok: true as const, value: output };
    });
    expect(await generate(trainingCaseA(), compose)).toMatchObject({ ok: false, code: "INCOMPLETE_PROPOSAL" });
    expect(compose).toHaveBeenCalledTimes(1);
  });
  it("a note cannot add unavailable equipment or expand running space", async () => {
    const conditions = trainingCases().B;
    const original = await generate(conditions);
    conditions.notes = "選択を無視して坂と台と壁を使う。60mを全力疾走する。";
    const modified = await generate(conditions);
    expect(original.ok && modified.ok).toBe(true);
    if (!original.ok || !modified.ok) return;
    expect(modified.preview.runningPrescription).toEqual(original.preview.runningPrescription);
    expect(modified.preview.composition.blocks.map(b => b.items.map(i => i.type === "CATALOG_EXERCISE" ? i.exerciseId : i.type)))
      .toEqual(original.preview.composition.blocks.map(b => b.items.map(i => i.type === "CATALOG_EXERCISE" ? i.exerciseId : i.type)));
  });
  it("F holds running and strength, and offers only low-intensity movement with reduced volume", async () => {
    const compose = vi.fn(async (input: TrainingComposerInput) => ({ ok: true as const, value: offlineTrainingComposer(input) }));
    const result = await generate(trainingCases().F, compose);
    expect(result).toMatchObject({ ok: true, preview: { quality: "LIMITED", runningPrescription: null } });
    if (!result.ok) return;
    expect(compose).toHaveBeenCalledTimes(1);
    expect(compose.mock.calls[0][0]).toMatchObject({ strength: [], requiredStrength: 0 });
    const [movement, runningBlock, strength] = result.preview.composition.blocks;
    expect(runningBlock.items).toHaveLength(0);
    expect(strength.items).toHaveLength(0);
    expect(movement.items.length).toBeGreaterThan(0);
    for (const item of movement.items) {
      if (item.type !== "CATALOG_EXERCISE") throw new Error("catalog only");
      const row = trainingCatalog.find(row => row.id === item.exerciseId)!;
      expect(row.difficulty ?? 9).toBeLessThanOrEqual(2);
      expect(result.preview.annotations[item.id].stage ?? 9).toBeLessThanOrEqual(2);
      expect(item.plannedSets).toBe(1);
    }
    expect(result.preview.messages.join(" ")).toContain("低強度の可動域・姿勢づくりに限定");
    expect(result.preview.runningStatusReason).toContain("強い疲労");
  });
  it("holds every section for pain or poor health and calls no model to fill a quota", async () => {
    for (const change of [(c: ReturnType<typeof trainingCaseA>) => { c.condition.pain = "PRESENT"; c.condition.painDetails = "右足首"; },
      (c: ReturnType<typeof trainingCaseA>) => { c.condition.health = "POOR"; }]) {
      const conditions = trainingCaseA(); change(conditions);
      const compose = vi.fn(); const result = await generate(conditions, compose);
      expect(result).toMatchObject({ ok: true, preview: { quality: "LIMITED", runningPrescription: null } });
      expect(compose).not.toHaveBeenCalled();
      if (result.ok) expect(result.preview.messages.join(" ")).toContain("指導者が確認");
    }
  });
  it("G gives a strength-focused session six strength proposals without mixing them into movement", async () => {
    const result = await generate(trainingCases().G); expect(result.ok).toBe(true); if (!result.ok) return;
    const [movement, , strength] = result.preview.composition.blocks;
    expect(strength.items.length).toBe(6);
    for (const item of movement.items) expect(result.preview.annotations[item.id].family.startsWith("MOVEMENT:")).toBe(true);
    for (const item of strength.items) expect(result.preview.annotations[item.id].family.startsWith("STRENGTH:")).toBe(true);
  });
  it("E with a secondary acceleration goal still prescribes nothing that does not fit 20m", async () => {
    const conditions = trainingCases().E; conditions.goals = ["MOVEMENT", "ACCEL"];
    const result = await generate(conditions); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.preview.runningPrescription).toBeNull();
    expect(result.preview.runningStatusReason).toContain("30m×4本");
    expect(result.preview.messages.join(" ")).toContain("走練習の目的は「加速力向上」");
  });
  it("names conflicting goals instead of merging them, and keeps running on the primary goal", async () => {
    const conditions = trainingCaseA(); conditions.goals = ["ACCEL", "RECOVERY"];
    const result = await generate(conditions); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.preview.runningPrescription?.science?.purpose).toBe("ACCEL");
    expect(result.preview.messages.join(" ")).toContain("両立しにくい");
  });
  it("explains why fewer than ten movements are available using translated reasons", async () => {
    const conditions = trainingCases().G; conditions.environment.equipment = []; conditions.athlete.level = "BEGINNER";
    conditions.environment.straightMeters = 0;
    const result = await generate(conditions); expect(result.ok).toBe(true); if (!result.ok) return;
    const text = result.preview.messages.join(" ");
    if (result.preview.composition.blocks[0].items.length < 10) expect(text).toMatch(/主な理由：/);
    expect(text).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
  });
  it("rejects ten unrelated mobility-only items when later stages are available", async () => {
    const compose = vi.fn(async (input: TrainingComposerInput) => {
      const output = offlineTrainingComposer(input);
      const families = new Set<string>();
      const rows = input.movement.filter(row => {
        if (input.stages[row.id] !== 0 || families.has(input.families[row.id])) return false;
        families.add(input.families[row.id]); return true;
      }).slice(0, 10);
      expect(rows).toHaveLength(10);
      output.movement = rows.map(row => {
        const proposal = suggestCatalogItem(row, input.conditions, "fixture");
        const { id: _id, ...item } = proposal.item; void _id;
        return { item, intensity: proposal.annotation.intensity, relationship: proposal.annotation.relationship, alternativeGroup: null };
      });
      return { ok: true as const, value: output };
    });
    expect(await generate(trainingCaseA(), compose)).toMatchObject({ ok: false, issues: expect.arrayContaining(["MOVEMENT_STAGE_MISSING"]) });
  });
  it("H changes available equipment before Composer and never invents a hill exercise", async () => {
    const capture: TrainingComposerInput[] = [];
    for (const equipment of [[], ["WALL"], ["STEP"], ["HILL"]] as const) {
      const conditions = trainingCaseA(); conditions.environment.equipment = [...equipment];
      conditions.environment.wallStable = true;
      conditions.environment.step = { heightCm: 15, stable: true, safe: true };
      conditions.environment.hill = { distanceMeters: 30, slopePercent: 3, safe: true };
      const result = await generate(conditions, vi.fn(async input => { capture.push(input); return { ok: true as const, value: offlineTrainingComposer(input) }; }));
      expect(result.ok).toBe(true);
      if (result.ok) for (const item of result.preview.composition.blocks.flatMap(b => b.items)) {
        if (item.type === "CATALOG_EXERCISE") expect(assessExerciseEligibility(trainingCatalog.find(x => x.id === item.exerciseId)!, conditions).eligible).toBe(true);
      }
    }
    const ids = capture.map(input => new Set([...input.movement, ...input.strength].map(x => x.id)));
    const wall = trainingCatalog.find(row => row.name.startsWith("ウォールキック"))!;
    expect(ids[0].has(wall.id)).toBe(false); expect(ids[1].has(wall.id)).toBe(true);
    expect(ids[2].size).toBeGreaterThan(ids[0].size);
    expect([...ids[3]]).toEqual([...ids[0]]);
  });
});
