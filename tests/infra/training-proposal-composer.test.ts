import { describe, it, expect, vi } from "vitest";
import { composeTrainingWithLuna, trainingComposerJsonSchema } from "@/infra/training-proposal/composer";
import { generateTrainingProposal, type TrainingComposerInput } from "@/application/training-proposal/generate";
import { offlineTrainingComposer, trainingCatalog, trainingCaseA, TRAINING_TEST_KEY } from "../fixtures/training-proposals";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";

async function inputFixture() {
  let captured: TrainingComposerInput | undefined;
  await generateTrainingProposal(trainingCaseA(), { ownerId: DEFAULT_OWNER_ID, signingKey: TRAINING_TEST_KEY,
    catalog: async () => trainingCatalog, compose: async input => { captured = input; return { ok: true, value: offlineTrainingComposer(input) }; } });
  if (!captured) throw new Error("fixture input missing");
  return captured;
}
describe("selection Composer transport (mock only)", () => {
  it("encodes real minimum output counts, separate ID allowlists, no running or duration fields", async () => {
    const input = await inputFixture(); const schema = trainingComposerJsonSchema(input);
    const props = schema.properties as Record<string, { minItems: number; items: { properties: { item: { properties: { exerciseId: { enum: string[] } } } } } }>;
    expect(props.movement.minItems).toBe(input.requestedMovement);
    expect(input.requestedMovement).toBe(input.requiredMovement + 2);
    expect(input.requiredMovement).toBe(10);
    expect(props.strength.minItems).toBe(input.requestedStrength);
    expect(props.strength.minItems).toBeGreaterThanOrEqual(3);
    expect(props.movement.items.properties.item.properties.exerciseId.enum).toEqual(input.movement.map(x => x.id));
    expect(JSON.stringify(schema)).not.toMatch(/RUNNING_POLICY|availableTime|allocatedSeconds|transitionSeconds/);
  });
  it("sends only one Luna request, no Intent stage, and retains the raw output contract", async () => {
    const input = await inputFixture(); const output = offlineTrainingComposer(input);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(output) }] }] }), { status: 200 }));
    expect(await composeTrainingWithLuna(input, { apiKey: "offline-fake-key", fetchImpl })).toEqual({ ok: true, value: output });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.model).toBe("gpt-6-luna"); expect(body.store).toBe(false);
    const sent = JSON.parse(body.input);
    expect(sent.conditions).toEqual(input.conditions);
    expect(sent.movement.map((row: { id: string }) => row.id)).toEqual(input.movement.map(row => row.id));
    expect(sent.movement[0]).toMatchObject({ stage: input.stages[input.movement[0].id], family: input.families[input.movement[0].id] });
    expect(body.input).not.toMatch(/videoUrl|ownerId|doseObservations|sourceVideoId|analyzedAt/);
    expect(body.input.length).toBeLessThan(JSON.stringify(input).length);
    expect(body.max_output_tokens).toBe(8000);
  });
  it.each(["http", "truncated", "invalid"])("does not retry %s failure", async reason => {
    const response = reason === "http" ? new Response(null, { status: 503 }) : new Response(JSON.stringify(reason === "truncated"
      ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
      : { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] }] }), { status: 200 });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect((await composeTrainingWithLuna(await inputFixture(), { apiKey: "offline-fake-key", fetchImpl })).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
