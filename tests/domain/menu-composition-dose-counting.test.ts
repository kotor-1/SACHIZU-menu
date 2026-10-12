import { describe, expect, it } from "vitest";
import { editableComposition, validateComposition, type MenuComposition } from "@/domain/menu-composition/contracts";
import { exerciseRepetitionCountMatches, exerciseUsesPerSideCount, exerciseUsesTotalCount } from "@/domain/menu-composition/dose-counting";
import type { ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { catalogFixture, catalogPlan } from "../fixtures/menu-composition";

const guidance: ExerciseVideoGuidance = {
  executionSummary: "片側の膝を寄せて戻す。", movementPattern: "対角膝肘引きつけ", countingUnit: "PER_SIDE",
  bilateralCounting: "COACH_DEFINED: 片側10回を終えてから反対側10回。左右合計10回ではない。",
  typicalStructure: "片側の寄せて戻す1周期を1回とする。", equipment: [], setup: null, keyCues: [], commonErrors: [],
  doseObservations: ["COACH_DEFINED: 片側10回→反対側10回。"], videoAnalysisStatus: "COACH_REVIEWED",
  sourceVideoId: "video-a", analysisVersion: "fixture-v1", analyzedAt: "2026-10-12T00:00:00.000Z", coachReviewedAt: "2026-10-12T00:00:00.000Z",
};
const catalog = catalogFixture({ videoGuidance: guidance });
const sidePlan = (executionInstruction: string, plannedReps: number | null = 10) => catalogPlan({
  plannedSets: 1, plannedReps, plannedDurationSeconds: null, executionInstruction, plannedNote: "",
});

describe("editable per-side repetition contract", () => {
  it("does not replace another approved counting definition with a prose-inferred PER_SIDE", () => {
    for (const countingUnit of ["ROUND_TRIP", "CUSTOM"] as const) {
      const exercise = catalogFixture({ videoGuidance: { ...guidance, countingUnit } });
      const item = sidePlan("片側5回の動きを組み合わせて1往復とする。", 2);
      expect(exerciseUsesPerSideCount(item, exercise)).toBe(false);
      expect(exerciseRepetitionCountMatches(item, exercise)).toBe(true);
      expect(item.plannedReps).toBe(2);
    }
  });
  it.each([
    "左右10回ずつ行う。", "左右各10回行う。", "左右それぞれ10回行う。", "片側10回を終えてから反対側10回を行う。",
    "片脚１０回ずつ行う。", "10 reps per side", "片側10回、左右合計20回。",
    "片側10回を行う。左右合計10回ではない。片側の寄せて戻す1周期を1回とする。",
  ])("preserves ten per side for %s", instruction => {
    const item = sidePlan(instruction);
    expect(exerciseUsesPerSideCount(item)).toBe(true);
    expect(exerciseRepetitionCountMatches(item, catalog)).toBe(true);
    expect(item.plannedReps).toBe(10);
    expect(exerciseRepetitionCountMatches(sidePlan(instruction, 20), catalog)).toBe(false);
  });

  it("uses approved PER_SIDE while leaving AI observations unapproved", () => {
    const item = sidePlan("膝を寄せて元へ戻す。");
    expect(exerciseUsesPerSideCount(item, catalog)).toBe(true);
    expect(exerciseUsesPerSideCount(item, catalogFixture({ videoGuidance: { ...guidance, videoAnalysisStatus: "AI_ANALYZED", coachReviewedAt: null } }))).toBe(false);
    expect(exerciseRepetitionCountMatches(sidePlan("左右合計20回行う。", 10), catalog)).toBe(true);
    expect(exerciseRepetitionCountMatches(sidePlan("左右合計20回行う。", 20), catalog)).toBe(false);
  });

  it.each(["TOTAL_REPS", "ALTERNATING_TOTAL"] as const)("preserves approved %s instead of redefining the field from side prose", countingUnit => {
    const totalCatalog = catalogFixture({ videoGuidance: { ...guidance, countingUnit } });
    const item = sidePlan("左右10回ずつ、左右合計20回行う。", 20);
    expect(exerciseUsesTotalCount(totalCatalog)).toBe(true);
    expect(exerciseUsesPerSideCount(item, totalCatalog)).toBe(false);
    expect(exerciseRepetitionCountMatches(item, totalCatalog)).toBe(true);
    expect(exerciseRepetitionCountMatches(sidePlan("左右10回ずつ行う。", 10), totalCatalog)).toBe(false);
    expect(item.plannedReps).toBe(20);
  });

  it("keeps a no-guidance swing proposal at five per side and two sets", () => {
    const item = { ...sidePlan("左右各5回、2セット行う。", 5), plannedSets: 2 };
    expect(exerciseUsesPerSideCount(item, catalogFixture())).toBe(true);
    expect(exerciseRepetitionCountMatches(item, catalogFixture())).toBe(true);
    expect(item).toMatchObject({ plannedReps: 5, plannedSets: 2 });
  });

  it("does not mistake a cycle definition or a negated dose for a repetition proposal", () => {
    const item = sidePlan("片側の寄せて戻す1周期を1回とする。左右10回ずつではなく、回数欄で指定する。", 8);
    expect(exerciseUsesPerSideCount(item)).toBe(false);
    expect(exerciseRepetitionCountMatches(item, catalog)).toBe(true);
  });

  it("keeps null unconfigured and never creates a dose from defaults or coach guidance", () => {
    const item = sidePlan("片側10回を終えてから反対側10回を行う。", null);
    expect(exerciseRepetitionCountMatches(item, catalog)).toBe(true);
    expect(item.plannedReps).toBeNull();
  });

  it("rejects contradictory generated and human-edited counts without mutating the input", () => {
    const proposal: MenuComposition = { blocks: [{ name: "体幹", items: [sidePlan("左右10回ずつ行う。", 20)] }] };
    const options = { ownerId: DEFAULT_OWNER_ID, catalog: [catalog], requestText: "体幹の練習", runningAvailable: false };
    expect(validateComposition(proposal, options)).toEqual({ ok: false, code: "DOSE_COUNT_MISMATCH" });
    let sequence = 0;
    const editable = editableComposition(proposal, () => `row-${++sequence}`);
    expect(validateComposition(editable, { ...options, edited: true })).toEqual({ ok: false, code: "DOSE_COUNT_MISMATCH" });
    expect(editable.blocks[0].items[0]).toMatchObject({ plannedReps: 20 });
    const corrected = { blocks: [{ name: "体幹", items: [sidePlan("左右8回ずつ行う。", 8)] }] };
    // The dose remains editable; the user must update prose and the numeric field together.
    const edited = editableComposition(corrected, () => `row-${++sequence}`);
    expect(validateComposition(edited, { ...options, edited: true }).ok).toBe(true);
  });
});
