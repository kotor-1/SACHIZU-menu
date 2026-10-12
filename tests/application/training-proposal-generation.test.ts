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

type Compose = Parameters<typeof generateTrainingProposal>[1]["compose"];
const generate = (conditions = trainingCaseA(), compose: Compose = vi.fn(async (input: TrainingComposerInput) => ({ ok: true as const, value: offlineTrainingComposer(input) }))) =>
  generateTrainingProposal(conditions, { ownerId: DEFAULT_OWNER_ID, signingKey: TRAINING_TEST_KEY, catalog: async () => trainingCatalog, compose });

describe("structured selection -> candidate filter -> Composer -> quality gate (offline)", () => {
  it.each(Object.entries(trainingCases()))("case %s follows the actual orchestration with explicit fixture response", async (_name, conditions) => {
    const compose = vi.fn(async (input: TrainingComposerInput) => ({ ok: true as const, value: offlineTrainingComposer(input) }));
    const result = await generate(conditions, compose);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    const available = trainingAvailability(trainingCatalog, conditions);
    expect(result.preview.composition.blocks.map(b => b.name)).toEqual(["動きづくり", "走練習", "補強トレーニング"]);
    const sent = compose.mock.calls[0]?.[0];
    expect(result.preview.composition.blocks[0].items.length).toBe(sent?.requestedMovement ?? 0);
    expect(result.preview.composition.blocks[2].items.length).toBe(sent?.requestedStrength ?? 0);
    const families = new Set(result.preview.composition.blocks[0].items.map(item => result.preview.annotations[item.id].family));
    expect(families.size).toBeGreaterThanOrEqual(available.requiredMovement);
    if (sent) expect(sent.requestedMovement).toBe(Math.min(available.requiredMovement + 2, new Set(sent.movement.map(row => sent.families[row.id])).size));
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
  it("the real four-item response cannot satisfy the contract, so the labelled rule-based proposal is shown instead", async () => {
    expect(trainingComposerOutputSchema.safeParse(realFailed).success).toBe(false);
    const compose = vi.fn(async () => ({ ok: true as const, value: realFailed as unknown as ReturnType<typeof offlineTrainingComposer> }));
    const result = await generate(trainingCaseA(), compose);
    expect(result).toMatchObject({ ok: true, preview: { quality: "LIMITED" } });
    if (result.ok) expect(result.preview.messages[0]).toBe("AIの提案の形式を確認できなかったため、AIを使わない基本提案を表示しています。");
    expect(compose).toHaveBeenCalledTimes(1);
  });
  it("the App sets every name, instruction and number: registered defaults win, the model keeps only its choice and explanation", async () => {
    const gallop = trainingCatalog.find(row => row.name === "ギャロップ（片脚リード走）")!;
    expect(gallop).toMatchObject({ defaultSets: 3, defaultDistanceMeters: 30, defaultRestSeconds: 60 });
    const compose = vi.fn(async (input: TrainingComposerInput) => {
      const output = offlineTrainingComposer(input);
      output.movement = output.movement.filter(selection => selection.exerciseId !== gallop.id);
      output.movement.push({ exerciseId: gallop.id, reason: "片脚で押し出す感覚を加速局面へつなげるため。",
        intensity: "リズムを崩さない速さで、接地は静かに行う。", relationship: "COMBINABLE", alternativeGroup: null });
      return { ok: true as const, value: output };
    });
    const result = await generate(trainingCaseA(), compose);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.preview.messages.join(" ")).not.toContain("AIを使わない基本提案");
    const items = result.preview.composition.blocks.flatMap(block => block.items);
    const picked = items.find(item => item.type === "CATALOG_EXERCISE" && item.exerciseId === gallop.id);
    expect(picked).toMatchObject({ displayName: gallop.name, executionInstruction: (gallop.description ?? "").slice(0, 400), reason: "片脚で押し出す感覚を加速局面へつなげるため。",
      plannedSets: 3, plannedDistanceMeters: 30, plannedReps: null, plannedDurationSeconds: null, plannedRestSeconds: 60 });
    expect(picked?.type === "CATALOG_EXERCISE" && picked.plannedNote).toMatch(/^登録された既定量をもとにした編集可能な提案。/);
    expect(result.preview.annotations[picked!.id].intensity).toBe("リズムを崩さない速さで、接地は静かに行う。");
    for (const item of items) {
      if (item.type !== "CATALOG_EXERCISE" || item.exerciseId === gallop.id) continue;
      const row = trainingCatalog.find(entry => entry.id === item.exerciseId)!;
      const { id: _id, reason: _reason, ...appValues } = suggestCatalogItem(row, trainingCaseA(), "x").item; void _id; void _reason;
      expect(item).toMatchObject(appValues);
    }
  });
  it("a model answer that tries to state its own dose or name fails the contract", async () => {
    const compose = vi.fn(async (input: TrainingComposerInput) => {
      const output = offlineTrainingComposer(input) as unknown as { movement: Record<string, unknown>[] };
      output.movement[0] = { ...output.movement[0], plannedSets: 4, displayName: "別名" };
      return { ok: true as const, value: output as unknown as ReturnType<typeof offlineTrainingComposer> };
    });
    const result = await generate(trainingCaseA(), compose);
    expect(result.ok && result.preview.messages[0]).toBe("AIの提案の形式を確認できなかったため、AIを使わない基本提案を表示しています。");
  });
  it.each(["unavailable", "throws"])("when the Composer %s, the labelled rule-based proposal is shown without any retry", async failure => {
    const compose = vi.fn(async (): Promise<{ ok: false; reason: string }> => {
      if (failure === "throws") throw new Error("network");
      return { ok: false, reason: "HTTP_503" };
    });
    const result = await generate(trainingCaseA(), compose);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, preview: { quality: "LIMITED" } }); if (!result.ok) return;
    expect(result.preview.messages[0]).toBe("AIの提案を取得できなかったため、AIを使わない基本提案を表示しています。");
    expect(result.preview.messages[1]).toContain("主目的「加速力向上」に関係する種目を優先");
    expect(result.preview.runningPrescription).not.toBeNull();
    expect(verifyTrainingProposalToken(result.preview.previewToken, TRAINING_TEST_KEY)?.messages).toEqual(result.preview.messages);
  });
  it.each(Object.entries(trainingCases()))("case %s: the rule-based proposal alone passes the same gate", async (_name, conditions) => {
    const compose = vi.fn(async () => ({ ok: false as const, reason: "OFFLINE" }));
    const result = await generate(conditions, compose);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true }); if (!result.ok) return;
    const available = trainingAvailability(trainingCatalog, conditions);
    const [movement, , strength] = result.preview.composition.blocks;
    const families = new Set(movement.items.map(item => result.preview.annotations[item.id].family));
    expect(families.size).toBe(movement.items.length);
    expect(movement.items.length).toBe(available.requiredMovement);
    expect(new Set(strength.items.map(item => result.preview.annotations[item.id].family)).size).toBe(available.requiredStrength);
    const stages = movement.items.map(item => result.preview.annotations[item.id].stage ?? 0);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    if (available.requiredMovement >= 10) expect(new Set(stages)).toEqual(new Set(available.movementStages));
    for (const item of [...movement.items, ...strength.items]) {
      if (item.type !== "CATALOG_EXERCISE") throw new Error("catalog only");
      const row = trainingCatalog.find(entry => entry.id === item.exerciseId)!;
      expect(assessExerciseEligibility(row, conditions).eligible).toBe(true);
      expect(item).toMatchObject({ ...suggestCatalogItem(row, conditions, item.id).item });
    }
  });
  it("normalizes stage order and drops exact duplicates without retrying or padding the count", async () => {
    const compose = vi.fn(async (input: TrainingComposerInput) => {
      const output = offlineTrainingComposer(input);
      output.movement.reverse();
      output.movement[1] = structuredClone(output.movement[0]);
      output.strength.push(structuredClone(output.strength[0]));
      return { ok: true as const, value: output };
    });
    const result = await generate(trainingCaseA(), compose);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const stages = result.preview.composition.blocks[0].items.map(item => result.preview.annotations[item.id].stage ?? 0);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    const movementFamilies = result.preview.composition.blocks[0].items.map(item => result.preview.annotations[item.id].family);
    expect(new Set(movementFamilies).size).toBe(movementFamilies.length);
    expect(movementFamilies.length).toBeGreaterThanOrEqual(10);
    const strengthIds = result.preview.composition.blocks[2].items.map(item => item.type === "CATALOG_EXERCISE" ? item.exerciseId : "");
    expect(new Set(strengthIds).size).toBe(strengthIds.length);
    expect(compose).toHaveBeenCalledTimes(1);
  });
  const corrupt = (failure: string) => vi.fn(async (input: TrainingComposerInput) => {
    const output = offlineTrainingComposer(input);
    const wall = trainingCatalog.find(row => row.name.startsWith("ウォールキック"))!;
    if (failure === "short") output.movement = output.movement.slice(0, 3);
    if (failure === "unavailable-wall") output.movement[0].exerciseId = wall.id;
    if (failure === "running-smuggle") output.movement[0].reason = "60m走を4本追加する";
    // The App's numbers are the only numbers; text naming another set count or rest contradicts them.
    if (failure === "set-count-text") output.strength[0].intensity = "9セット続けて行う。";
    if (failure === "rest-text") output.movement[0].intensity = "休息は299秒とる。";
    // Three extra copies of one family exceed the margin and leave fewer than ten families.
    if (failure === "duplicate-family") for (let index = 1; index <= 3; index++) output.movement[index] = structuredClone(output.movement[0]);
    if (failure === "many-bad") for (let index = 0; index < 3; index++) output.movement[index].reason = "60m走を4本追加する";
    return { ok: true as const, value: output };
  });
  it.each(["unavailable-wall", "running-smuggle", "set-count-text", "rest-text"])("drops a %s item, reports it and keeps the valid rest", async failure => {
    const compose = corrupt(failure);
    const result = await generate(trainingCaseA(), compose);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const sent = compose.mock.calls[0][0];
    const [movement, , strength] = result.preview.composition.blocks;
    if (failure === "set-count-text") expect(strength.items).toHaveLength(sent.requestedStrength - 1);
    else expect(movement.items).toHaveLength(sent.requestedMovement - 1);
    expect(new Set(movement.items.map(item => result.preview.annotations[item.id].family)).size).toBeGreaterThanOrEqual(10);
    expect(result.preview.messages.join(" ")).toMatch(/AIの提案のうち1件（.+）は.*除外しました/);
    expect(result.preview.messages.join(" ")).not.toContain("AIを使わない基本提案");
    for (const item of [...movement.items, ...strength.items]) {
      if (item.type !== "CATALOG_EXERCISE") continue;
      expect(`${item.reason} ${result.preview.annotations[item.id].intensity}`).not.toMatch(/60m走|9セット|299秒/);
      expect(assessExerciseEligibility(trainingCatalog.find(row => row.id === item.exerciseId)!, trainingCaseA()).eligible).toBe(true);
    }
  });
  it.each(["short", "duplicate-family", "many-bad"])("shows the labelled rule-based proposal for %s, without retry and without mixing in model items", async failure => {
    const compose = corrupt(failure);
    const result = await generate(trainingCaseA(), compose);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, preview: { quality: "LIMITED" } }); if (!result.ok) return;
    expect(result.preview.messages[0]).toMatch(/^AIの提案が条件・構成の確認を通らなかったため、AIを使わない基本提案を表示しています。主な理由：/);
    expect(result.preview.messages[0]).toContain("条件に合う動きづくりの提案が不足しています。");
    const [movement, , strength] = result.preview.composition.blocks;
    expect(new Set(movement.items.map(item => result.preview.annotations[item.id].family)).size).toBe(10);
    for (const item of [...movement.items, ...strength.items]) {
      if (item.type !== "CATALOG_EXERCISE") throw new Error("catalog only");
      const row = trainingCatalog.find(entry => entry.id === item.exerciseId)!;
      expect(item.reason).toBe(suggestCatalogItem(row, trainingCaseA(), "x").item.reason);
    }
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
    expect(compose.mock.calls[0][0]).toMatchObject({ strength: [], requiredStrength: 0, requestedStrength: 0 });
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
  it("G gives a strength-focused session six-plus strength proposals without mixing them into movement", async () => {
    const result = await generate(trainingCases().G); expect(result.ok).toBe(true); if (!result.ok) return;
    const [movement, , strength] = result.preview.composition.blocks;
    expect(strength.items.length).toBe(7);
    expect(new Set(strength.items.map(item => result.preview.annotations[item.id].family)).size).toBeGreaterThanOrEqual(6);
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
  it("does not accept ten unrelated mobility-only items when later stages are available", async () => {
    const compose = vi.fn(async (input: TrainingComposerInput) => {
      const output = offlineTrainingComposer(input);
      const families = new Set<string>();
      const rows = input.movement.filter(row => {
        if (input.stages[row.id] !== 0 || families.has(input.families[row.id])) return false;
        families.add(input.families[row.id]); return true;
      }).slice(0, 10);
      expect(rows).toHaveLength(10);
      output.movement = rows.map(row => ({ exerciseId: row.id, reason: "可動域を整えるため。", intensity: "反動をつけずに大きく動かす。",
        relationship: "COMBINABLE" as const, alternativeGroup: null }));
      return { ok: true as const, value: output };
    });
    const result = await generate(trainingCaseA(), compose);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.preview.messages[0]).toContain("動きづくりの段階（可動域から疾走への接続まで）に抜けがあります。");
    const stages = result.preview.composition.blocks[0].items.map(item => result.preview.annotations[item.id].stage);
    expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3, 4]));
  });
  it("offers same-name duplicate registrations to the Composer once, while both stay addable by hand", async () => {
    const compose = vi.fn(async (input: TrainingComposerInput) => ({ ok: true as const, value: offlineTrainingComposer(input) }));
    const result = await generate(trainingCaseA(), compose);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const duplicates = trainingCatalog.filter(row => row.name === "引きつけウォーク").map(row => row.id);
    expect(duplicates).toHaveLength(2);
    const offered = compose.mock.calls[0][0].movement.map(row => row.id);
    expect(offered.filter(id => duplicates.includes(id))).toHaveLength(1);
    expect(verifyTrainingProposalToken(result.preview.previewToken, TRAINING_TEST_KEY)?.allowedExerciseIds).toEqual(expect.arrayContaining(duplicates));
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
