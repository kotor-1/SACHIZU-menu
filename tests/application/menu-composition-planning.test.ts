import { describe, expect, it } from "vitest";
import before75 from "../fixtures/menu-time-before-75.json";
import actualLuna from "../fixtures/menu-time-luna-20261012.json";
import offlineRevision from "../fixtures/menu-time-offline-revision.json";
import { editableComposition, compositionSchema } from "@/domain/menu-composition/contracts";
import { proposedDurationPlan } from "@/application/menu-composition/planning";
import { calculateMenuDuration, type RunningDurationInput } from "@/domain/menu-composition/duration";
import type { EditableComposition, MenuComposition } from "@/domain/menu-composition/contracts";
import { runningMenuPrescriptionSchema, type RunningMenuFinalPrescription } from "@/application/running-menu/persistence";

const runningBlockId = "11111111-1111-4111-8111-111111111111";
const runningItemId = "22222222-2222-4222-8222-222222222222";
const drillBlockId = "33333333-3333-4333-8333-333333333333";

function runPrescription(overrides: Partial<RunningMenuFinalPrescription> = {}): RunningMenuFinalPrescription {
  return {
    policyVersion: "test", policyHash: "a".repeat(64), event: "100m", distanceMeters: 30,
    totalReps: 4, totalDistanceMeters: 120, repRestSeconds: 180, sets: 1, setReps: null, setRestSeconds: null,
    intensityPresentation: "PLAIN_LANGUAGE", executionInstructionText: null, coachTargetTimeSeconds: null,
    coachTargetTimeRange: null, minimumKnownRestSeconds: 540, fullSessionTimeGuaranteed: false, ...overrides,
  };
}

function singleRunningBlock(): EditableComposition {
  return { blocks: [{ id: runningBlockId, name: "走", items: [{ type: "RUNNING_POLICY", id: runningItemId, plannedNote: "" }] }] };
}

describe("proposed duration plan scheduling bounds", () => {
  it("does not round an already sufficient precise allocation and break its estimate sum", () => {
    const composition = singleRunningBlock();
    const prescription = runPrescription({ totalReps: 2, repRestSeconds: 75 });
    const proposal: MenuComposition = { transitionSeconds: 0, blocks: [{ name: "走", phase: "RUNNING",
      allocatedSeconds: 95, allocationBasis: { itemEstimatesSeconds: [95], preparationSeconds: 0,
        explanation: "休息75秒と走行計20秒の計画上の見積もり", preparationDescription: "" }, items: [{ type: "RUNNING_POLICY" }] }] };
    const plan = proposedDurationPlan(proposal, composition, prescription);
    expect(plan.blocks[0].allocatedSeconds).toBe(95);
    expect(calculateMenuDuration(composition, prescription, 95, plan).planningStatus).toBe("ACCOUNTED_FOR");
  });

  it("raises the allocation to the Engine prescription's known rest minimum without changing its dose", () => {
    const composition = singleRunningBlock();
    const prescription = runPrescription();
    const before = structuredClone({ composition, prescription });
    const proposal: MenuComposition = { transitionSeconds: 0, blocks: [{ name: "走", phase: "RUNNING", allocatedSeconds: 300,
      items: [{ type: "RUNNING_POLICY" }] }] };
    const running: RunningDurationInput = { byItemId: { [runningItemId]: prescription } };

    const result = proposedDurationPlan(proposal, composition, running);

    expect(result).toEqual({ transitionSeconds: 0, blocks: [{ blockId: runningBlockId, phase: "RUNNING", allocatedSeconds: 540 }] });
    expect(calculateMenuDuration(composition, running, null, result).blocks[0].knownMinimumSeconds).toBe(540);
    expect({ composition, prescription }).toEqual(before);
  });

  it("keeps legacy unknown work/rest unknown and creates no synthetic phase blocks", () => {
    const composition: EditableComposition = { blocks: [
      { id: runningBlockId, name: "保存済み走", items: [{ type: "RUNNING_POLICY", id: runningItemId, plannedNote: "" }] },
      { id: drillBlockId, name: "補助", items: [{ type: "FREEFORM", id: "44444444-4444-4444-8444-444444444444",
        category: "DRILL", originalUserInstruction: "補助動作", displayName: "補助", executionInstruction: "補助動作を行う",
        plannedNote: "", reason: "", plannedSets: null, plannedReps: null, plannedDurationSeconds: null,
        plannedDistanceMeters: null, plannedRestSeconds: null }] },
    ] };
    const proposal: MenuComposition = { transitionSeconds: null, blocks: [
      { name: "保存済み走", phase: "RUNNING", allocatedSeconds: 120, items: [{ type: "RUNNING_POLICY" }] },
      { name: "補助", phase: "DRILLS_STRENGTH", allocatedSeconds: 300, items: [{ type: "FREEFORM", category: "DRILL",
        originalUserInstruction: "補助動作", displayName: "補助", executionInstruction: "補助動作を行う", plannedNote: "", reason: "",
        plannedSets: null, plannedReps: null, plannedDurationSeconds: null, plannedDistanceMeters: null, plannedRestSeconds: null }] },
    ] };

    // A legacy/unreadable saved prescription is represented per item as null.
    const unknownLegacyRunning: RunningDurationInput = { byItemId: { [runningItemId]: null } };
    const result = proposedDurationPlan(proposal, composition, unknownLegacyRunning);
    const summary = calculateMenuDuration(composition, unknownLegacyRunning, null, result);

    expect(result.blocks).toEqual([
      { blockId: runningBlockId, phase: "RUNNING", allocatedSeconds: 120 },
      { blockId: drillBlockId, phase: "DRILLS_STRENGTH", allocatedSeconds: 300 },
    ]);
    expect(result.blocks).toHaveLength(composition.blocks.length);
    expect(summary.unknownComponents.filter((row) => row.blockId === runningBlockId).map((row) => row.component))
      .toEqual(expect.arrayContaining(["WORK", "REST"]));
    expect(summary.blocks[0].knownMinimumSeconds).toBe(0);
  });
});


describe("recorded 90-minute request regression", () => {
  it("preserves the latest actual Luna response as incomplete, including its PER_SIDE 10", () => {
    const proposal = compositionSchema.parse(actualLuna);
    let id = 0;
    const composition = editableComposition(proposal, () => `actual-${++id}`);
    const prescription = runningMenuPrescriptionSchema.parse(offlineRevision.runningPrescription);
    const before = structuredClone({ proposal, prescription });
    const plan = proposedDurationPlan(proposal, composition, prescription);
    const result = calculateMenuDuration(composition, prescription, 5400, plan);
    expect(result).toMatchObject({ knownMinimumSeconds: 720, plannedTotalSeconds: null, planningStatus: "NEEDS_REVIEW" });
    expect(proposal.blocks[2].items[0]).toMatchObject({ plannedReps: 10 });
    expect(plan.blocks.every(block => block.allocatedSeconds === null)).toBe(true);
    expect({ proposal, prescription }).toEqual(before);
  });

  it("accounts for an explicitly offline edited draft without padding the missing 61 minutes", () => {
    const proposal = compositionSchema.parse(offlineRevision.composition);
    let id = 0;
    const composition = editableComposition(proposal, () => `edited-${++id}`);
    const prescription = runningMenuPrescriptionSchema.parse(offlineRevision.runningPrescription);
    const before = structuredClone({ proposal, prescription });
    const plan = proposedDurationPlan(proposal, composition, prescription);
    const result = calculateMenuDuration(composition, prescription, 5400, plan);
    expect(result).toMatchObject({ plannedTotalSeconds: 1740, remainingSeconds: 3660, status: "UNDERALLOCATED", planningStatus: "NEEDS_REVIEW", physicalDurationExact: false });
    expect(result.planIssues.map(issue => issue.code)).toEqual(["TARGET_MISMATCH"]);
    expect(result.blocks.map(block => block.allocatedSeconds)).toEqual([480, 960, 120]);
    expect(composition.blocks.flatMap(block => block.items)).toHaveLength(5);
    expect({ proposal, prescription }).toEqual(before);
    const item = composition.blocks[0].items[0];
    if (item.type !== "CATALOG_EXERCISE") throw new Error("fixture");
    item.plannedDistanceMeters = 30;
    expect(calculateMenuDuration(composition, prescription, 5400, plan).planIssues).toContainEqual(expect.objectContaining({ code: "STALE_BASIS" }));
  });

  it("rejects an inflated timed item even if the total has been made exactly 90 minutes", () => {
    const proposal = compositionSchema.parse(offlineRevision.composition);
    proposal.blocks[0].allocationBasis!.itemEstimatesSeconds[2] = 360; // 2×20s + 45s is only 85s.
    proposal.blocks[0].allocatedSeconds! += 275;
    proposal.transitionSeconds! += 3660 - 275;
    let id = 0;
    const composition = editableComposition(proposal, () => `padded-${++id}`);
    const prescription = runningMenuPrescriptionSchema.parse(offlineRevision.runningPrescription);
    const plan = proposedDurationPlan(proposal, composition, prescription);
    const result = calculateMenuDuration(composition, prescription, 5400, plan);
    expect(result.plannedTotalSeconds).toBe(5400);
    expect(result.planningStatus).toBe("NEEDS_REVIEW");
    expect(result.planIssues).toContainEqual(expect.objectContaining({ code: "BREAKDOWN_MISMATCH" }));
  });

  it("retains the real 75-minute proposal as an editable draft without filling the remaining 15 minutes", () => {
    const proposal = compositionSchema.parse(before75.composition);
    let id = 0;
    const composition = editableComposition(proposal, () => `recorded-${++id}`);
    const prescription = runPrescription({ distanceMeters: 60, totalDistanceMeters: 240,
      repRestSeconds: 240, minimumKnownRestSeconds: 720 });
    const frozen = structuredClone({ proposal, prescription });
    const plan = proposedDurationPlan(proposal, composition, prescription);
    const result = calculateMenuDuration(composition, prescription, 5400, plan);
    expect(result.blocks.reduce((sum, row) => sum + (row.allocatedSeconds ?? 0), 0)).toBe(4500);
    expect(result.plannedTotalSeconds).toBeNull();
    expect(result.planningStatus).toBe("NEEDS_REVIEW");
    expect(result.planIssues.some(issue => issue.code === "MISSING_BASIS")).toBe(true);
    expect(plan.transitionSeconds).toBeNull();
    expect(plan.blocks).toHaveLength(4);
    expect(result.knownMinimumSeconds).toBe(720);
    expect({ proposal, prescription }).toEqual(frozen);
  });
});
