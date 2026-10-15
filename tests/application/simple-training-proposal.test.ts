import { describe, expect, it } from "vitest";
import { generateTrainingProposal, type TrainingComposerInput } from "@/application/training-proposal/generate";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { conditionsFromSimple, DEFAULT_SIMPLE_CONDITIONS, type SimpleConditions } from "@/domain/training-proposal/simple-conditions";
import { offlineTrainingComposer, trainingCatalog, TRAINING_TEST_KEY } from "../fixtures/training-proposals";

// Offline: the handwritten composer double stands in for Luna. No API call.
const propose = (simple: Partial<SimpleConditions> = {}) => generateTrainingProposal(conditionsFromSimple({ ...DEFAULT_SIMPLE_CONDITIONS, ...simple }), {
  ownerId: DEFAULT_OWNER_ID, signingKey: TRAINING_TEST_KEY, catalog: async () => trainingCatalog,
  compose: async (input: TrainingComposerInput) => ({ ok: true as const, value: offlineTrainingComposer(input) }),
});

describe("proposals from the five choices", () => {
  it("proposes movement, running and strength with the defaults alone", async () => {
    const result = await propose();
    expect(result.ok).toBe(true); if (!result.ok) return;
    const [movement, running, strength] = result.preview.composition.blocks;
    expect(movement.items.length).toBeGreaterThanOrEqual(10);
    expect(running.items.map(item => item.type)).toEqual(["RUNNING_POLICY"]);
    expect(strength.items.length).toBeGreaterThanOrEqual(3);
  });

  it("still proposes movement and strength at home on a short road", async () => {
    const result = await propose({ location: "ROAD", straightMeters: 20, goal: "MOVEMENT" });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.preview.composition.blocks[0].items.length).toBeGreaterThanOrEqual(10);
    expect(result.preview.composition.blocks[2].items.length).toBeGreaterThanOrEqual(3);
    expect(result.preview.runningStatusReason).toContain("目的を「加速」「最高速度」「スピード持久」「基礎の走力」のどれか");
  });

  it("explains held running in terms of the five choices", async () => {
    const beginner = await propose({ athlete: "HIGH_SCHOOL_BEGINNER", goal: "ACCEL" });
    expect(beginner.ok && beginner.preview.runningStatusReason).toContain("目的を「基礎の走力」にすると");
    const juniorHigh = await propose({ athlete: "JUNIOR_HIGH", goal: "MAX_SPEED" });
    expect(juniorHigh.ok && juniorHigh.preview.runningStatusReason).toContain("中学生には、最高速度・スピード持久の走練習は出していません");
    const basic = await propose({ athlete: "HIGH_SCHOOL_BEGINNER", goal: "BASIC" });
    expect(basic.ok && basic.preview.composition.blocks[1].items.map(item => item.type)).toEqual(["RUNNING_POLICY"]);
  });

  it("keeps the chosen running at its usual dose when the athlete is only a little tired", async () => {
    for (const goal of ["ACCEL", "MAX_SPEED", "SPEED_ENDURANCE", "BASIC", "PRECOMP"] as const) {
      const usual = await propose({ goal });
      const tired = await propose({ goal, state: "TIRED" });
      if (!usual.ok || !tired.ok) throw new Error(`${goal}: proposal failed`);
      expect(tired.preview.runningStatusReason).toBeNull();
      expect(tired.preview.composition.blocks[1].items.map(item => item.type)).toEqual(["RUNNING_POLICY"]);
      const before = usual.preview.runningPrescription!;
      expect(tired.preview.runningPrescription).toMatchObject({ distanceMeters: before.distanceMeters, totalReps: before.totalReps, repRestSeconds: before.repRestSeconds });
      expect(tired.preview.runningPrescription?.science?.stopInstruction).toContain("疲れの申告あり");
    }
    // Strong fatigue still holds running.
    const veryTired = await propose({ goal: "MAX_SPEED", state: "VERY_TIRED" });
    if (!veryTired.ok) throw new Error("very tired: proposal failed");
    expect(veryTired.preview.runningPrescription).toBeNull();
  });
});
