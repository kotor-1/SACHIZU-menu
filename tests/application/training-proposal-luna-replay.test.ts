import { describe, expect, it, vi } from "vitest";
import { generateTrainingProposal, type TrainingComposerInput } from "@/application/training-proposal/generate";
import { catalogCompositionItemSchema } from "@/domain/menu-composition/contracts";
import { trainingComposerOutputSchema, type TrainingComposerOutput } from "@/domain/training-proposal/contracts";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";
import { trainingComposerJsonSchema } from "@/infra/training-proposal/composer";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { trainingCatalog, trainingCases, TRAINING_TEST_KEY } from "../fixtures/training-proposals";
import recorded from "../fixtures/training-proposal-luna-20261012.json";
import recordedV2 from "../fixtures/training-proposal-luna-v2-20261012.json";

// Replay of real gpt-6-luna outputs (no network). The recorded outputs are kept unmodified.
// They were made under the first contract, where Luna also wrote names, instructions and
// numbers; the current contract keeps only each item's choice and explanation, which are
// exactly the fields Luna is still asked for. Everything else now comes from the App.
type Case = "A" | "B" | "F";
type RecordedProposal = { item: { exerciseId: string; reason: string; displayName: string } & Record<string, unknown>;
  intensity: string; relationship: "COMBINABLE" | "ALTERNATIVE"; alternativeGroup: string | null };
type RecordedOutput = { movement: RecordedProposal[]; strength: RecordedProposal[]; explanation: string; uncertainty: string };
const requests = recorded.requests.map(request => ({ ...request, case: request.case as Case, output: request.output as unknown as RecordedOutput }));
const selection = (output: RecordedOutput): TrainingComposerOutput => {
  const keep = ({ item, intensity, relationship, alternativeGroup }: RecordedProposal) =>
    ({ exerciseId: item.exerciseId, reason: item.reason, intensity, relationship, alternativeGroup });
  return { movement: output.movement.map(keep), strength: output.strength.map(keep), explanation: output.explanation, uncertainty: output.uncertainty };
};
const FALLBACK = "AIを使わない基本提案";
async function replay(run: number, name: Case) {
  const request = requests.find(entry => entry.run === run && entry.case === name)!;
  const compose = vi.fn(async () => ({ ok: true as const, value: selection(request.output) }));
  const result = await generateTrainingProposal(trainingCases()[name], { ownerId: DEFAULT_OWNER_ID, signingKey: TRAINING_TEST_KEY,
    catalog: async () => trainingCatalog, compose });
  return { result, request, compose };
}

describe("recorded Luna selection outputs (replay, no API)", () => {
  it("keeps six recorded responses from gpt-6-luna using only catalog IDs, each reducible to the current contract", () => {
    expect(requests.map(entry => `${entry.run}${entry.case}`)).toEqual(["1A", "1B", "1F", "2F", "2A", "3F"]);
    for (const request of requests) {
      expect(request.model).toBe("gpt-6-luna");
      for (const proposal of [...request.output.movement, ...request.output.strength]) {
        expect(catalogCompositionItemSchema.safeParse(proposal.item).success).toBe(true);
        expect(trainingCatalog.some(row => row.id === proposal.item.exerciseId)).toBe(true);
      }
      expect(trainingComposerOutputSchema.safeParse(selection(request.output)).success).toBe(true);
    }
  });

  it.each([[1, "A"], [1, "B"], [2, "A"], [2, "F"], [3, "F"]] as const)("run %i case %s passes on Luna's own choice", async (run, name) => {
    const { result, compose } = await replay(run, name);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.preview.messages.join(" ")).not.toContain(FALLBACK);
    const [movement, running, strength] = result.preview.composition.blocks;
    const stages = movement.items.map(item => result.preview.annotations[item.id].stage ?? 0);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(new Set(movement.items.map(item => result.preview.annotations[item.id].family)).size).toBeGreaterThanOrEqual(10);
    if (name === "F") {
      expect(running.items).toHaveLength(0); expect(strength.items).toHaveLength(0);
      expect(new Set(stages)).toEqual(new Set([0, 1, 2]));
      expect(result.preview.messages.join(" ")).toContain("低強度の可動域・姿勢づくりに限定");
    } else {
      expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3, 4]));
      expect(strength.items.length).toBeGreaterThanOrEqual(3);
    }
    if (name === "A") expect(running.items.map(item => item.type)).toEqual(["RUNNING_POLICY"]);
    if (name === "B") { expect(running.items).toHaveLength(0); expect(result.preview.runningStatusReason).toContain("45m"); }
    for (const item of [...movement.items, ...strength.items]) {
      if (item.type !== "CATALOG_EXERCISE") throw new Error("catalog only");
      const row = trainingCatalog.find(entry => entry.id === item.exerciseId)!;
      const { id: _id, reason: _reason, ...appValues } = suggestCatalogItem(row, trainingCases()[name], item.id).item; void _id; void _reason;
      expect(item).toMatchObject(appValues);
      if (item.plannedDistanceMeters !== null) expect(item.plannedDistanceMeters).toBeLessThanOrEqual(trainingCases()[name].environment.straightMeters!);
    }
  });

  it("run 2 case F: the three items that failed on Luna's own numbers or names now carry the App's", async () => {
    const { result, request } = await replay(2, "F");
    expect(request.gateAtRun.ok).toBe(false);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const movement = result.preview.composition.blocks[0].items;
    expect(movement).toHaveLength(11);
    expect(result.preview.messages.join(" ")).not.toMatch(/除外しました|AIを使わない基本提案/);
    // Luna gave this REPS exercise a distance; the App uses the registered unit.
    const lunge = movement.find(item => item.type === "CATALOG_EXERCISE" && item.displayName === "ウォーキングランジ＆ニーリフト");
    expect(lunge).toMatchObject({ plannedReps: 4, plannedDistanceMeters: null, plannedSets: 1 });
    // The placeholder repeat of the same ID is normalized away, whatever its recorded display name said.
    expect(movement.filter(item => item.type === "CATALOG_EXERCISE" && item.displayName === "引きつけウォーク")).toHaveLength(1);
    for (const item of movement) if (item.type === "CATALOG_EXERCISE") expect(item.plannedSets).toBe(1);
  });

  it("run 2 case A: registered Exercise defaults are used as registered, a sprint prohibition stays a cue", async () => {
    const { result, request } = await replay(2, "A");
    expect(request.gateAtRun.issues).toEqual(["RUNNING_INSTRUCTION_OUTSIDE_ENGINE"]);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const gallop = result.preview.composition.blocks[0].items.find(item => item.type === "CATALOG_EXERCISE" && item.displayName === "ギャロップ（片脚リード走）");
    expect(gallop).toMatchObject({ plannedSets: 3, plannedDistanceMeters: 30, plannedRestSeconds: 60 });
    expect(Object.values(result.preview.annotations).some(annotation => annotation.intensity.includes("全力疾走にしない"))).toBe(true);
  });

  it("run 1 case F: a same-name pair from the first request left nine families, so the App's labelled proposal is shown", async () => {
    const { result, request, compose } = await replay(1, "F");
    expect(request.output.movement.map(proposal => proposal.item.displayName).filter(name => name === "引きつけウォーク")).toHaveLength(2);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, preview: { quality: "LIMITED" } }); if (!result.ok) return;
    expect(result.preview.messages[0]).toMatch(/^AIの提案が条件・構成の確認を通らなかったため、AIを使わない基本提案を表示しています。/);
    const movement = result.preview.composition.blocks[0].items;
    expect(movement).toHaveLength(10);
    for (const item of movement) {
      if (item.type !== "CATALOG_EXERCISE") throw new Error("catalog only");
      expect(result.preview.annotations[item.id].stage ?? 9).toBeLessThanOrEqual(2);
      expect(item.plannedSets).toBe(1);
    }
  });
});

// Real gpt-6-luna outputs under the current contract: Luna chose and explained, the App set every number.
describe("recorded Luna outputs under the App-owned-dose contract (replay, no API)", () => {
  type V2Request = (typeof recordedV2.requests)[number];
  const v2 = recordedV2.requests.map(request => ({ ...request, case: request.case as Case }));
  async function replayV2(run: number, seq: number) {
    const request = v2.find(entry => entry.run === run && entry.seq === seq)!;
    let sent: TrainingComposerInput | undefined;
    const compose = vi.fn(async (input: TrainingComposerInput) => {
      sent = input;
      return request.output ? { ok: true as const, value: request.output as TrainingComposerOutput } : { ok: false as const, reason: "INCOMPLETE_MAX_OUTPUT" };
    });
    const result = await generateTrainingProposal(trainingCases()[request.case], { ownerId: DEFAULT_OWNER_ID, signingKey: TRAINING_TEST_KEY,
      catalog: async () => trainingCatalog, compose });
    return { result, request, compose, sent: () => sent! };
  }
  const complete = (request: V2Request) => request.output !== null;

  it("keeps five responses from gpt-6-luna: four schema-valid on catalog IDs, one truncated", () => {
    expect(v2.map(entry => `${entry.run}-${entry.seq}${entry.case}`)).toEqual(["4-1F", "4-2F", "4-3F", "5-1A", "5-2B"]);
    for (const request of v2) {
      expect(request.model).toBe("gpt-6-luna");
      if (!complete(request)) continue;
      const output = trainingComposerOutputSchema.parse(request.output);
      for (const proposal of [...output.movement, ...output.strength]) {
        expect(trainingCatalog.some(row => row.id === proposal.exerciseId)).toBe(true);
        expect(`${proposal.reason}${proposal.intensity}`).not.toMatch(/\d/u);
      }
    }
  });

  it.each([[4, 1], [4, 2], [5, 1], [5, 2]] as const)("run %i #%i passes on Luna's own choice with the App's numbers", async (run, seq) => {
    const { result, request, compose } = await replayV2(run, seq);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.preview.messages.join(" ")).not.toMatch(/AIを使わない基本提案|除外しました/);
    const [movement, running, strength] = result.preview.composition.blocks;
    expect(movement.items).toHaveLength(12);
    const stages = movement.items.map(item => result.preview.annotations[item.id].stage ?? 0);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(new Set(stages)).toEqual(new Set(request.case === "F" ? [0, 1, 2] : [0, 1, 2, 3, 4]));
    expect(strength.items).toHaveLength(request.case === "F" ? 0 : 4);
    expect(running.items.map(item => item.type)).toEqual(request.case === "A" ? ["RUNNING_POLICY"] : []);
    for (const item of [...movement.items, ...strength.items]) {
      if (item.type !== "CATALOG_EXERCISE") throw new Error("catalog only");
      const row = trainingCatalog.find(entry => entry.id === item.exerciseId)!;
      const { id: _id, reason: _reason, ...appValues } = suggestCatalogItem(row, trainingCases()[request.case], item.id).item; void _id; void _reason;
      expect(item).toMatchObject(appValues);
      if (request.case === "F") expect(item.plannedSets).toBe(1);
    }
  });

  it("run 4 #3: Luna stopped at ten items under a minimum of twelve and emitted whitespace until the token limit", async () => {
    const { result, request, sent } = await replayV2(4, 3);
    expect(request.incomplete).toMatchObject({ reason: "max_output_tokens", itemsStarted: 10 });
    expect(request.incomplete!.trailingWhitespaceChars).toBeGreaterThan(6000);
    expect(request.usage.output_tokens).toBe(8000);
    // The App shows its labelled proposal, and the current schema lets an answer close at the App's floor.
    expect(result).toMatchObject({ ok: true, preview: { quality: "LIMITED" } }); if (!result.ok) return;
    expect(result.preview.messages[0]).toBe("AIの提案を取得できなかったため、AIを使わない基本提案を表示しています。");
    expect(result.preview.composition.blocks[0].items).toHaveLength(10);
    const schema = trainingComposerJsonSchema(sent()) as unknown as { properties: { movement: { minItems: number } } };
    expect(schema.properties.movement.minItems).toBe(10);
    expect(sent().requestedMovement).toBe(12);
  });
});
