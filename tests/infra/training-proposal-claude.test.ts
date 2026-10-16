import { afterEach, describe, expect, it, vi } from "vitest";
import { composeTraining, composeTrainingWithClaude, trainingClaudeModel, trainingComposerJsonSchema, trainingComposerRequestInput,
  TRAINING_COMPOSER_INSTRUCTIONS, type ComposerAttempt } from "@/infra/training-proposal/composer";
import { CLAUDE_MESSAGES_URL, claudeOutputSchema, type ClaudeAttempt } from "@/infra/training-proposal/claude-transport";
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
// Shaped like a real answer: by default the thinking block comes first with its text omitted.
const message = (text: string, stop = "end_turn") => new Response(JSON.stringify({ id: "msg_offline", type: "message", role: "assistant",
  model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "", signature: "offline-signature" }, { type: "text", text }], stop_reason: stop,
  usage: { input_tokens: 21000, output_tokens: 1900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    output_tokens_details: { thinking_tokens: 200 } } }), { status: 200 });
const keywords = (schema: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(schema)) schema.forEach(entry => keywords(entry, found));
  else if (schema && typeof schema === "object") for (const [key, value] of Object.entries(schema)) {
    if (key !== "properties") found.add(key);
    keywords(value, found);
  }
  return found;
};
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Claude selection Composer (mock only)", () => {
  it("sends one Claude request with the same choice-and-explanation contract as Luna", async () => {
    const input = await inputFixture(); const output = offlineTrainingComposer(input);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(message(JSON.stringify(output)));
    const attempts: ClaudeAttempt[] = [];
    expect(await composeTrainingWithClaude(input, { apiKey: "offline-fake-key", fetchImpl, onAttempt: attempt => attempts.push(attempt) }))
      .toEqual({ ok: true, value: output });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CLAUDE_MESSAGES_URL);
    expect(init?.headers).toEqual({ "x-api-key": "offline-fake-key", "anthropic-version": "2023-06-01", "content-type": "application/json" });
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("claude-opus-5-5");
    // Thinking counts toward max_tokens; Opus 5.5 cannot switch it off, and sampling settings are fixed on these models.
    expect(body.max_tokens).toBe(8000);
    expect(body.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(body.system).toBe(TRAINING_COMPOSER_INSTRUCTIONS);
    expect(body.messages).toHaveLength(1);
    expect(JSON.parse(body.messages[0].content)).toEqual(trainingComposerRequestInput(input));
    // Names, instructions and every number still belong to the App.
    expect(body.messages[0].content).not.toMatch(/defaultSets|defaultReps|defaultDurationSeconds|defaultDistanceMeters|defaultRestSeconds|videoUrl|ownerId/);
    expect(JSON.stringify(body)).not.toMatch(/planned|displayName|executionInstruction|RUNNING_POLICY/);
    expect(body.stream).toBeUndefined();
    expect(attempts).toEqual([expect.objectContaining({ model: "claude-opus-5-5", httpStatus: 200, stopReason: "end_turn", errorClass: null,
      inputTokens: 21000, outputTokens: 1900, thinkingTokens: 200 })]);
    expect(JSON.stringify(attempts)).not.toMatch(/offline-fake-key|reason|intensity/);
  });
  it("keeps the ID allowlists and leaves out only the limits that Zod checks after the answer", async () => {
    const input = await inputFixture();
    const schema = claudeOutputSchema(trainingComposerJsonSchema(input)) as {
      properties: Record<string, { minItems?: number; items: { properties: Record<string, unknown> } }> };
    const found = keywords(schema);
    for (const unsupported of ["minLength", "maxLength", "maxItems", "minimum", "maximum"]) expect(found.has(unsupported)).toBe(false);
    expect(schema.properties.movement.minItems).toBe(1);
    expect(schema.properties.movement.items.properties.exerciseId).toEqual({ type: "string", enum: input.movement.map(row => row.id) });
    expect(schema.properties.strength.items.properties.exerciseId).toEqual({ type: "string", enum: input.strength.map(row => row.id) });
    expect(schema.properties.movement.items.properties.alternativeGroup).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(JSON.stringify(schema)).toContain('"additionalProperties":false');
  });
  it.each([
    ["overloaded", () => new Response(null, { status: 529 }), "HTTP_ERROR"],
    ["bad request", () => new Response(null, { status: 400 }), "HTTP_ERROR"],
    ["max tokens", () => message("{\"movement\":[", "max_tokens"), "MAX_TOKENS"],
    ["refusal", () => message("", "refusal"), "REFUSAL"],
    ["unfinished turn", () => message("{}", "pause_turn"), "INVALID_RESPONSE"],
    ["broken JSON", () => message("not json"), "STRUCTURED_PARSE_FAILURE"],
    ["wrong shape", () => message("{}"), "SCHEMA_FAILURE"],
  ] as const)("does not retry: %s", async (_label, response, errorClass) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const attempts: ClaudeAttempt[] = [];
    expect((await composeTrainingWithClaude(await inputFixture(), { apiKey: "offline-fake-key", fetchImpl, onAttempt: attempt => attempts.push(attempt) })).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(attempts.map(attempt => attempt.errorClass)).toEqual([errorClass]);
  });
  it("gives up at the time limit instead of waiting past the hosting proxy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    }));
    const attempts: ClaudeAttempt[] = [];
    expect((await composeTrainingWithClaude(await inputFixture(), { apiKey: "offline-fake-key", fetchImpl, timeoutMs: 50,
      onAttempt: attempt => attempts.push(attempt) })).ok).toBe(false);
    expect(attempts.map(attempt => attempt.errorClass)).toEqual(["TIMEOUT"]);
  });
  it("uses Opus 5.5 unless Sonnet 5.5 is named", () => {
    expect(trainingClaudeModel({})).toBe("claude-opus-5-5");
    expect(trainingClaudeModel({ TRAINING_PROPOSAL_CLAUDE_MODEL: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(trainingClaudeModel({ TRAINING_PROPOSAL_CLAUDE_MODEL: "claude-unknown" })).toBe("claude-opus-5-5");
  });
  it("asks Claude only when its key is set, and Luna otherwise", async () => {
    const input = await inputFixture(); const output = offlineTrainingComposer(input);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async url => String(url) === CLAUDE_MESSAGES_URL ? message(JSON.stringify(output))
      : new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const attempts: ComposerAttempt[] = [];
    vi.stubEnv("OPENAI_API_KEY", "offline-fake-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "offline-fake-claude-key");
    vi.stubEnv("TRAINING_PROPOSAL_CLAUDE_MODEL", "claude-sonnet-5-5");
    expect((await composeTraining(input, { onAttempt: attempt => attempts.push(attempt) })).ok).toBe(true);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect((await composeTraining(input, { onAttempt: attempt => attempts.push(attempt) })).ok).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([CLAUDE_MESSAGES_URL, "https://api.openai.com/v1/responses"]);
    expect(attempts.map(attempt => attempt.model)).toEqual(["claude-sonnet-5-5", "gpt-6-luna"]);
  });
});
