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
    const tired = await propose({ state: "TIRED" });
    expect(tired.ok && tired.preview.runningStatusReason).toContain("目的を「基礎の走力」にしてください");
    const basic = await propose({ athlete: "HIGH_SCHOOL_BEGINNER", goal: "BASIC" });
    expect(basic.ok && basic.preview.composition.blocks[1].items.map(item => item.type)).toEqual(["RUNNING_POLICY"]);
  });
});
