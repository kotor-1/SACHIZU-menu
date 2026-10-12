import { describe, expect, it, vi } from "vitest";
import { generateTrainingProposal, type TrainingComposerInput } from "@/application/training-proposal/generate";
import { trainingComposerOutputSchema, type TrainingComposerOutput } from "@/domain/training-proposal/contracts";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { trainingCatalog, trainingCases, TRAINING_TEST_KEY } from "../fixtures/training-proposals";
import recorded from "../fixtures/training-proposal-luna-20261012.json";

// Replay of real gpt-6-luna outputs (no network). The outputs are kept unmodified.
type Case = "A" | "B" | "F";
const requests = recorded.requests.map(request => ({ ...request, case: request.case as Case, output: request.output as unknown as TrainingComposerOutput }));
async function replay(run: number, name: Case) {
  const request = requests.find(entry => entry.run === run && entry.case === name)!;
  const compose = vi.fn(async (input: TrainingComposerInput) => { void input; return { ok: true as const, value: request.output }; });
  const result = await generateTrainingProposal(trainingCases()[name], { ownerId: DEFAULT_OWNER_ID, signingKey: TRAINING_TEST_KEY,
    catalog: async () => trainingCatalog, compose });
  return { result, request };
}

describe("recorded Luna selection outputs (replay, no API)", () => {
  it("keeps six schema-valid recorded responses from gpt-6-luna using only catalog IDs", () => {
    expect(requests.map(entry => `${entry.run}${entry.case}`)).toEqual(["1A", "1B", "1F", "2F", "2A", "3F"]);
    for (const request of requests) {
      expect(request.model).toBe("gpt-6-luna");
      const output = trainingComposerOutputSchema.parse(request.output);
      for (const proposal of [...output.movement, ...output.strength]) {
        expect(trainingCatalog.some(row => row.id === proposal.item.exerciseId)).toBe(true);
      }
    }
  });

  it.each([[1, "A"], [1, "B"], [2, "A"]] as const)("run %i case %s passes with 10+ distinct, stage-ordered movements", async (run, name) => {
    const { result } = await replay(run, name);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const [movement, running, strength] = result.preview.composition.blocks;
    const stages = movement.items.map(item => result.preview.annotations[item.id].stage ?? 0);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(new Set(movement.items.map(item => result.preview.annotations[item.id].family)).size).toBeGreaterThanOrEqual(10);
    expect(strength.items.length).toBeGreaterThanOrEqual(3);
    if (name === "A") expect(running.items.map(item => item.type)).toEqual(["RUNNING_POLICY"]);
    if (name === "B") { expect(running.items).toHaveLength(0); expect(result.preview.runningStatusReason).toContain("45m"); }
    for (const item of movement.items) if (item.type === "CATALOG_EXERCISE" && item.plannedDistanceMeters !== null) {
      expect(item.plannedDistanceMeters).toBeLessThanOrEqual(trainingCases()[name].environment.straightMeters!);
    }
  });

  it("run 2 case A: a sprint prohibition in a drill cue is no longer mistaken for hidden running", async () => {
    const { result, request } = await replay(2, "A");
    expect(request.gateAtRun.issues).toEqual(["RUNNING_INSTRUCTION_OUTSIDE_ENGINE"]);
    expect(result.ok).toBe(true);
    expect(request.output.movement.some(proposal => proposal.intensity.includes("全力疾走にしない"))).toBe(true);
  });

  it("run 1 case F: two same-name registrations collapse below ten families", async () => {
    const { result, request } = await replay(1, "F");
    expect(result).toMatchObject({ ok: false, code: "INCOMPLETE_PROPOSAL", issues: ["MOVEMENT_PROPOSALS_MISSING"] });
    const picked = request.output.movement.map(proposal => proposal.item.displayName);
    expect(picked.filter(name => name === "引きつけウォーク")).toHaveLength(2);
    expect(new Set(picked).size).toBe(9);
  });

  it("run 2 case F: unit, counting-text and placeholder items are dropped and nine families are not enough", async () => {
    const { result } = await replay(2, "F");
    expect(result).toMatchObject({ ok: false, code: "INCOMPLETE_PROPOSAL" });
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining(["MOVEMENT_PROPOSALS_MISSING", "DOSE_COUNT_MISMATCH", "REGISTERED_UNIT_MISMATCH", "EXERCISE_NAME_MISMATCH"]));
  });

  it("run 3 case F: low-intensity movements only, a repeated drill normalized away, running and strength held", async () => {
    const { result, request } = await replay(3, "F");
    expect(request.gateAtRun.ok).toBe(true);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const [movement, running, strength] = result.preview.composition.blocks;
    expect(request.output.movement).toHaveLength(12);
    expect(movement.items).toHaveLength(11);
    expect(running.items).toHaveLength(0);
    expect(strength.items).toHaveLength(0);
    for (const item of movement.items) {
      if (item.type !== "CATALOG_EXERCISE") throw new Error("catalog only");
      expect(result.preview.annotations[item.id].stage ?? 9).toBeLessThanOrEqual(2);
      expect(item.plannedSets).toBe(1);
      expect(trainingCatalog.find(row => row.id === item.exerciseId)?.difficulty ?? 9).toBeLessThanOrEqual(2);
    }
    expect(result.preview.messages.join(" ")).toContain("低強度の可動域・姿勢づくりに限定");
  });
});
