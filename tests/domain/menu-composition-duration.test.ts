import { describe, expect, it } from "vitest";
import { calculateMenuDuration, durationBasisKey, durationPlanSchema, type DurationPlan } from "@/domain/menu-composition/duration";
import type { EditableComposition } from "@/domain/menu-composition/contracts";
import type { RunningMenuFinalPrescription } from "@/application/running-menu/persistence";

const blockA = "11111111-1111-4111-8111-111111111111";
const blockB = "22222222-2222-4222-8222-222222222222";
const itemA = "33333333-3333-4333-8333-333333333333";
const itemB = "44444444-4444-4444-8444-444444444444";

function exercise(overrides: Record<string, unknown> = {}) {
  return { type: "CATALOG_EXERCISE", id: itemA, exerciseId: "exercise-1", displayName: "Test",
    executionInstruction: "Follow the existing instruction", plannedNote: "", reason: "",
    plannedSets: 2, plannedReps: null, plannedDurationSeconds: 30, plannedDistanceMeters: null, plannedRestSeconds: 15,
    ...overrides };
}
function composition(items: unknown[] = [exercise()], ids = [blockA]): EditableComposition {
  return { blocks: ids.map((id, index) => ({ id, name: `Block ${index + 1}`, items: items as never })) } as EditableComposition;
}
function run(target: number | null, range: { minSeconds: number; maxSeconds: number } | null = null): RunningMenuFinalPrescription {
  return { policyVersion: "test", policyHash: "a".repeat(64), event: "100m", distanceMeters: 100, totalReps: 3,
    totalDistanceMeters: 300, repRestSeconds: 60, sets: 1, setReps: null, setRestSeconds: null,
    intensityPresentation: "PLAIN_LANGUAGE", executionInstructionText: null, coachTargetTimeSeconds: target,
    coachTargetTimeRange: range, minimumKnownRestSeconds: 120, fullSessionTimeGuaranteed: false };
}
const plan = (blocks: DurationPlan["blocks"], transitionSeconds: number | null = 0): DurationPlan => ({ blocks, transitionSeconds });

describe("menu duration accounting", () => {
  it("does not turn a known work duration into an unentered block allocation", () => {
    const result = calculateMenuDuration(composition([exercise()]), null, 75,
      plan([{ blockId: blockA, phase: "OTHER", allocatedSeconds: null }]));
    expect(result.knownMinimumSeconds).toBe(75);
    expect(result.blocks[0].physicalDurationExact).toBe(true);
    expect(result.plannedTotalSeconds).toBeNull();
    expect(result.planningStatus).toBe("NEEDS_REVIEW");
  });

  it("counts explicit work and only between-set rest", () => {
    const result = calculateMenuDuration(composition([exercise()]), null, 100, plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: 75 }]));
    expect(result.knownMinimumSeconds).toBe(75);
    expect(result.blocks[0].underallocated).toBe(false);
  });

  it("does not turn reps or distance into guessed work seconds", () => {
    const reps = exercise({ plannedReps: 8, plannedDurationSeconds: null, plannedRestSeconds: 20, plannedSets: 3 });
    const result = calculateMenuDuration(composition([reps]), null, null, plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: null }]));
    expect(result.knownMinimumSeconds).toBe(40);
    expect(result.unknownComponents.some((row) => row.component === "WORK")).toBe(true);
  });

  it("counts user-entered per-rep work/rest but keeps missing inter-set rest unknown", () => {
    const pending = { type: "UNPRESCRIBED_RUNNING", id: itemA, reasonCode: "NEEDS_POLICY", reasonMessage: "未処方",
      plannedNote: "", plannedSets: 2, plannedReps: 2, plannedDistanceMeters: null, plannedRestSeconds: 60,
      plannedIntensityPercent: null, plannedDurationSeconds: 5 };
    const input = composition([pending]);
    const before = JSON.stringify(input);
    const result = calculateMenuDuration(input, null, 200, plan([{ blockId: blockA, phase: "RUNNING", allocatedSeconds: 200 }], 0));
    expect(result.knownMinimumSeconds).toBe(140); // 5×2×2 work + 60×1×2 rep rest
    expect(result.blocks[0].physicalDurationExact).toBe(false);
    expect(result.unknownComponents.some(row => row.component === "REST")).toBe(true); // no set-rest field exists
    expect(JSON.stringify(input)).toBe(before);
  });

  it("has a complete known duration for one manually entered set", () => {
    const pending = { type: "UNPRESCRIBED_RUNNING", id: itemA, reasonCode: "NEEDS_POLICY", reasonMessage: "未処方",
      plannedNote: "", plannedSets: 1, plannedReps: 2, plannedDistanceMeters: null, plannedRestSeconds: 60,
      plannedIntensityPercent: null, plannedDurationSeconds: 5 };
    const result = calculateMenuDuration(composition([pending]), null, 70, plan([{ blockId: blockA, phase: "RUNNING", allocatedSeconds: null }], 0));
    expect(result.knownMinimumSeconds).toBe(70); // 2×5 work + 1×60 rest
    expect(result.blocks[0].physicalDurationExact).toBe(true);
    expect(result.unknownComponents.some(row => row.component === "WORK" || row.component === "REST")).toBe(false);
  });

  it("uses minimum running target and known rest without claiming a range is exact", () => {
    const result = calculateMenuDuration(composition([{ type: "RUNNING_POLICY", id: itemB, plannedNote: "" }]), run(null, { minSeconds: 15, maxSeconds: 18 }), 200,
      plan([{ blockId: blockA, phase: "RUNNING", allocatedSeconds: 180 }], 20));
    expect(result.knownMinimumSeconds).toBe(165); // Exercise work/rest only: 3 × 15s + 2 × 60s
    expect(result.blocks[0].physicalDurationExact).toBe(false);
    expect(result.unknownComponents.some((row) => row.component === "RUNNING_TARGET_RANGE")).toBe(true);
  });

  it("accounts for each saved running item's own prescription and set rests", () => {
    const split = { ...run(10), sets: 2, setReps: [1, 2], repRestSeconds: 10, setRestSeconds: 30, minimumKnownRestSeconds: 40 };
    const compositionWithTwoRuns = composition([
      { type: "RUNNING_POLICY", id: itemA, plannedNote: "" },
      { type: "RUNNING_POLICY", id: itemB, plannedNote: "" },
    ]);
    const result = calculateMenuDuration(compositionWithTwoRuns, { byItemId: { [itemA]: split, [itemB]: run(20) } }, null);
    expect(result.knownMinimumSeconds).toBe(250); // (3×10 + 40 set/rep rest) + (3×20 + 120 rest)
  });

  it("reports missing allocations, transition time, and deleted-block allocations", () => {
    const result = calculateMenuDuration(composition([exercise()]), null, 180,
      plan([{ blockId: blockB, phase: "WARM_UP", allocatedSeconds: 80 }], null));
    expect(result.plannedTotalSeconds).toBeNull();
    expect(result.orphanPlanBlockIds).toEqual([blockB]);
    expect(result.unknownComponents.map((row) => row.component)).toEqual(expect.arrayContaining(["ALLOCATION", "TRANSITION"]));
  });

  it("checks block known minimums and total requested budget, and reports remaining time", () => {
    const under = calculateMenuDuration(composition([exercise()]), null, 90,
      plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: 70 }], 10));
    expect(under.blocks[0].underallocated).toBe(true);
    expect(under.status).toBe("UNDERALLOCATED");
    const remainder = calculateMenuDuration(composition([exercise()]), null, 120,
      plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: 75 }], 10));
    expect(remainder.plannedTotalSeconds).toBe(85);
    expect(remainder.remainingSeconds).toBe(35);
    expect(remainder.status).toBe("UNDERALLOCATED");
    const over = calculateMenuDuration(composition([exercise()]), null, 80,
      plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: 75 }], 10));
    expect(over.status).toBe("OVER_BUDGET");
  });

  it("counts an explicit transition against the cap even when work remains unknown", () => {
    const reps = exercise({ plannedReps: 8, plannedDurationSeconds: null, plannedRestSeconds: 20, plannedSets: 3 });
    const result = calculateMenuDuration(composition([reps]), null, 90,
      plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: null }], 51));
    expect(result.knownMinimumSeconds).toBe(40); // dose minimum excludes the 51s planned transition
    expect(result.status).toBe("OVER_BUDGET");
  });

  it("distinguishes budget match from exact exercise duration and does not mutate inputs", () => {
    const input = composition([exercise()]);
    const before = JSON.stringify(input);
    const result = calculateMenuDuration(input, null, 85,
      { ...plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: 75 }], 10), transitionDescription: "ブロック間の移動" });
    expect(result.status).toBe("MATCHES_REQUEST");
    expect(result.physicalDurationExact).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("recalculates by current block IDs and validates the plan shape", () => {
    const compositionAfterEdit = composition([exercise()], [blockB]);
    const result = calculateMenuDuration(compositionAfterEdit, null, null, plan([
      { blockId: blockA, phase: "WARM_UP", allocatedSeconds: 10 },
      { blockId: blockB, phase: "COOL_DOWN", allocatedSeconds: 80 },
    ]));
    expect(result.orphanPlanBlockIds).toEqual([blockA]);
    expect(result.phases.COOL_DOWN.allocatedSeconds).toBe(80);
    expect(durationPlanSchema.safeParse({ blocks: [{ blockId: "", phase: "OTHER", allocatedSeconds: -1 }], transitionSeconds: null }).success).toBe(false);
    expect(durationPlanSchema.safeParse({ blocks: [{ blockId: blockA, phase: "OTHER", allocatedSeconds: 604801 }], transitionSeconds: null }).success).toBe(false);
  });

  it("accounts for an explicit per-item estimate breakdown without claiming physical duration exactness", () => {
    const item = exercise({ plannedSets: 1, plannedDurationSeconds: 75, plannedRestSeconds: null });
    const input = composition([item]);
    const allocationBasis = { itemEstimatesSeconds: [75], preparationSeconds: 15, explanation: "1回75秒の実施と15秒の準備枠", preparationDescription: "器具を準備", durationBasisKey: durationBasisKey(input.blocks[0], null) };
    const result = calculateMenuDuration(input, null, 90, plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: 90, allocationBasis }], 0));
    expect(result).toMatchObject({ knownMinimumSeconds: 75, plannedTotalSeconds: 90, budgetDifferenceSeconds: 0,
      status: "MATCHES_REQUEST", planningStatus: "ACCOUNTED_FOR", planIssues: [], physicalDurationExact: false });
  });

  it("shows two 25-minute exercises as 25 planned minutes against 90 requested, not a false 90-minute match", () => {
    const first = exercise({ plannedSets: 1, plannedDurationSeconds: 750, plannedRestSeconds: null });
    const second = { ...exercise({ plannedSets: 1, plannedDurationSeconds: 750, plannedRestSeconds: null }), id: itemB };
    const input = composition([first, second]);
    const allocationBasis = { itemEstimatesSeconds: [750, 750], preparationSeconds: 0, explanation: "各種目の明示時間", preparationDescription: "", durationBasisKey: durationBasisKey(input.blocks[0], null) };
    const result = calculateMenuDuration(input, null, 90 * 60, plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: 25 * 60, allocationBasis }], 0));
    expect(result).toMatchObject({ knownMinimumSeconds: 25 * 60, plannedTotalSeconds: 25 * 60, budgetDifferenceSeconds: -65 * 60,
      status: "UNDERALLOCATED", planningStatus: "NEEDS_REVIEW" });
    expect(result.planIssues.some((issue) => issue.code === "TARGET_MISMATCH")).toBe(true);
  });

  it("requires a non-running item's dose fields even when the arithmetic breakdown is filled", () => {
    const item = exercise({ plannedSets: null, plannedReps: null, plannedDurationSeconds: null, plannedDistanceMeters: null, plannedRestSeconds: null });
    const input = composition([item]);
    const allocationBasis = { itemEstimatesSeconds: [5000], preparationSeconds: 400, explanation: "見積", preparationDescription: "準備枠", durationBasisKey: durationBasisKey(input.blocks[0], null) };
    const result = calculateMenuDuration(input, null, 90 * 60, plan([{ blockId: blockA, phase: "OTHER", allocatedSeconds: 90 * 60, allocationBasis }], 0));
    expect(result.status).toBe("MATCHES_REQUEST"); // arithmetic only; UI must consult planningStatus
    expect(result.planningStatus).toBe("NEEDS_REVIEW");
    expect(result.planIssues.some((issue) => issue.code === "DOSE_MISSING")).toBe(true);
  });

  it("invalidates a basis after a dose edit and preserves unknown Running work as a separate unknown", () => {
    const input = composition([exercise({ plannedSets: 1, plannedDurationSeconds: 30, plannedRestSeconds: null })]);
    const allocationBasis = { itemEstimatesSeconds: [30], preparationSeconds: 0, explanation: "明示時間", preparationDescription: "", durationBasisKey: durationBasisKey(input.blocks[0], null) };
    const basisPlan = plan([{ blockId: blockA, phase: "OTHER", allocatedSeconds: 30, allocationBasis }], 0);
    const changed = composition([exercise({ plannedSets: 2, plannedDurationSeconds: 30, plannedRestSeconds: 15 })]);
    const stale = calculateMenuDuration(changed, null, 30, basisPlan);
    expect(stale.planningStatus).toBe("NEEDS_REVIEW");
    expect(stale.planIssues.some((issue) => issue.code === "STALE_BASIS")).toBe(true);

    const running = composition([{ type: "RUNNING_POLICY", id: itemB, plannedNote: "" }]);
    const runningInput = { byItemId: { [itemB]: run(null) } };
    const runningBasis = { itemEstimatesSeconds: [140], preparationSeconds: 460, explanation: "処方休息120秒と走行20秒の計画見積もり。目標タイムではない。", preparationDescription: "準備枠", durationBasisKey: durationBasisKey(running.blocks[0], runningInput) };
    const accounted = calculateMenuDuration(running, runningInput, 600, plan([{ blockId: blockA, phase: "RUNNING", allocatedSeconds: 600, allocationBasis: runningBasis }], 0));
    expect(accounted.planningStatus).toBe("ACCOUNTED_FOR");
    expect(accounted.unknownComponents.some((component) => component.component === "WORK")).toBe(true);
  });

  it("invalidates instruction/name changes even when numeric doses stay the same", () => {
    const input = composition([exercise()]);
    const key = durationBasisKey(input.blocks[0], null);
    for (const patch of [{ executionInstruction: "左右それぞれ30秒" }, { plannedNote: "休止せず次へ移る" }, { displayName: "別の種目" }]) {
      expect(durationBasisKey(composition([exercise(patch)]).blocks[0], null)).not.toBe(key);
    }
    const renamedIds = composition([{ ...exercise(), id: "persisted-item" }], ["persisted-block"]);
    expect(durationBasisKey(renamedIds.blocks[0], null)).toBe(key);
  });

  it("does not count missing work or rest as a complete planning estimate", () => {
    const input = composition([{ type: "RUNNING_POLICY", id: itemB, plannedNote: "" }]);
    for (const prescription of [run(null), { ...run(10), repRestSeconds: null }]) {
      const minimum = prescription.repRestSeconds === null ? 30 : 120;
      const basis = { itemEstimatesSeconds: [minimum], preparationSeconds: 600 - minimum,
        explanation: "不足する実施・休息は準備枠で埋められない", preparationDescription: "準備",
        durationBasisKey: durationBasisKey(input.blocks[0], prescription) };
      const result = calculateMenuDuration(input, prescription, 600, plan([{ blockId: blockA, phase: "RUNNING", allocatedSeconds: 600, allocationBasis: basis }]));
      expect(result.planningStatus).toBe("NEEDS_REVIEW");
      expect(result.planIssues.map(issue => issue.code)).toContain(prescription.repRestSeconds === null ? "DOSE_MISSING" : "WORK_ESTIMATE_MISSING");
    }
  });

  it("requires a description for a positive transition estimate", () => {
    const input = composition([exercise({ plannedSets: 1, plannedDurationSeconds: 30, plannedRestSeconds: null })]);
    const allocationBasis = { itemEstimatesSeconds: [30], preparationSeconds: 0, explanation: "明示時間", preparationDescription: "", durationBasisKey: durationBasisKey(input.blocks[0], null) };
    const result = calculateMenuDuration(input, null, null, { blocks: [{ blockId: blockA, phase: "OTHER", allocatedSeconds: 30, allocationBasis }], transitionSeconds: 10 });
    expect(result.planningStatus).toBe("NEEDS_REVIEW");
    expect(result.planIssues.some((issue) => issue.code === "TRANSITION_UNSPECIFIED")).toBe(true);
  });

  it("rejects arithmetic breakdowns that do not sum to the slot or understate an item minimum", () => {
    const item = exercise({ plannedSets: 1, plannedDurationSeconds: 75, plannedRestSeconds: null });
    const input = composition([item]);
    const allocationBasis = { itemEstimatesSeconds: [60], preparationSeconds: 10, explanation: "見積", preparationDescription: "準備", durationBasisKey: durationBasisKey(input.blocks[0], null) };
    const result = calculateMenuDuration(input, null, 70, plan([{ blockId: blockA, phase: "OTHER", allocatedSeconds: 80, allocationBasis }], 0));
    expect(result.planIssues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["BELOW_MINIMUM", "BREAKDOWN_MISMATCH"]));
    expect(result.planningStatus).toBe("NEEDS_REVIEW");
  });
});
