import { describe, expect, it } from "vitest";
import { calculateMenuDuration, durationPlanSchema, type DurationPlan } from "@/domain/menu-composition/duration";
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
    expect(result.knownMinimumSeconds).toBe(185); // 3 × 15s + 2 × 60s + 20s transition
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
    expect(result.knownMinimumSeconds).toBe(91); // 2 prescribed rests + explicit transition
    expect(result.status).toBe("OVER_BUDGET");
  });

  it("distinguishes budget match from exact exercise duration and does not mutate inputs", () => {
    const input = composition([exercise()]);
    const before = JSON.stringify(input);
    const result = calculateMenuDuration(input, null, 85,
      plan([{ blockId: blockA, phase: "DRILLS_STRENGTH", allocatedSeconds: 75 }], 10));
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
});
