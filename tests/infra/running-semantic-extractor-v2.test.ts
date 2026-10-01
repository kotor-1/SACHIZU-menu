import { describe, expect, it, vi } from "vitest";
import { extractRunningSemanticIntentV2, SEMANTIC_INTENT_V2_OUTPUT_SCHEMA } from "@/infra/running-menu/openai-semantic-intent-v2";
import { runningSemanticClientConfig, type RunningResponseDiagnostic } from "@/infra/running-menu/structured-response";
import { verifySemanticIntentV2 } from "@/application/running-menu/semantic-intent-v2";

const interpretation = { interpreterVersion: "running-intent-v2", requestKind: "RUNNING", claims: [
  { field: "EVENT", value: "200m", sourceText: "200出る", polarity: "AFFIRMED", temporalScope: "FUTURE", status: "ACTIVE", numericParts: [{ rawText: "200", unit: "NONE" }] },
], corrections: [], unsupportedIntents: [], ambiguity: null, exerciseIds: [] };
const review = { assessments: [{ index: 0, supported: true }], activeClaimIndexes: [0], requestKindSupported: true,
  missingCriticalClaim: false, ambiguityCorrect: true, unsupportedIntentsSupported: true, correctionsSupported: true };
const numericRoleReview = { roles: [{ sourceText: "200出る", rawText: "200", role: "EVENT" }] };
const envelope = (text: string) => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
const response = (value: unknown) => new Response(JSON.stringify(envelope(JSON.stringify(value))), { status: 200, headers: { "content-type": "application/json" } });

describe("semantic interpreter v2 OpenAI contract", () => {
  it("uses independent structured semantic and bare-number checks without prescription fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(interpretation)).mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(response(review));
    const result = await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", model: "gpt-6-luna", fetchImpl });
    expect(result).toMatchObject({ ok: true, interpretation: { requestKind: "RUNNING" }, review: { activeClaimIndexes: [0] }, numericRoleReview });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const first = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const third = JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body));
    expect(first).toMatchObject({ model: "gpt-6-luna", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(second).toMatchObject({ model: "gpt-6-luna", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(third).toMatchObject({ model: "gpt-6-luna", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(JSON.stringify(SEMANTIC_INTENT_V2_OUTPUT_SCHEMA)).not.toMatch(/generatedDistanceMeters|generatedReps|generatedRestSeconds|totalReps|repRestSeconds/u);
  });

  it("fails closed on malformed model output", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ inventedDistance: 60 }));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", fetchImpl })).toEqual({ ok: false, reason: "INVALID_OUTPUT" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves production model, effort, timeout, and output defaults while bounding retries", () => {
    const config = runningSemanticClientConfig();
    expect(config).toEqual({ model: process.env.MENU_PLANNER_OPENAI_MODEL ?? "gpt-6-luna",
      reasoningEffort: "low", timeoutMs: 20000, maxOutputTokens: 3000, maxRetries: 1 });
    expect(runningSemanticClientConfig({ model: "gpt-6.1-sol", reasoningEffort: "xhigh", timeoutMs: 120000, maxOutputTokens: 12000 }))
      .toEqual({ model: "gpt-6.1-sol", reasoningEffort: "xhigh", timeoutMs: 120000, maxOutputTokens: 12000, maxRetries: 1 });
  });

  it.each([
    ["malformed HTTP envelope", () => new Response("{broken", { headers: { "content-type": "application/json" } }), "ENVELOPE_PARSE_FAILURE"],
    ["empty HTTP body", () => new Response(""), "ENVELOPE_PARSE_FAILURE"],
    ["empty structured output", () => new Response(JSON.stringify({ status: "completed", output: [] })), null],
    ["malformed structured JSON", () => new Response(JSON.stringify(envelope("{"))), "STRUCTURED_PARSE_FAILURE"],
    ["schema failure", () => response({ inventedDistance: 60 }), null],
    ["output truncation", () => new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] })), "INVALID_RESPONSE_ENVELOPE"],
  ] as const)("recovers from %s once without repeating valid earlier stages", async (_name, badResponse, other) => {
    const diagnostics: RunningResponseDiagnostic[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(interpretation))
      .mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(badResponse())
      .mockResolvedValueOnce(response(review));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "secret-key-must-not-escape", fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(diagnostics[2]).toMatchObject({ stage: "running_semantic_review_v2", attempt: 1,
      httpStatus: 200, sdkParseFailure: false, retryable: true, other });
    expect(diagnostics[3]).toMatchObject({ stage: "running_semantic_review_v2", attempt: 2, retryable: false });
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret-key|200出る|inventedDistance|\{broken/u);
  });

  it("recovers a body read failure and keeps safe HTTP diagnostics", async () => {
    const diagnostics: RunningResponseDiagnostic[] = [];
    const unreadable = new Response("body", { headers: { "content-type": "application/json; charset=utf-8" } });
    vi.spyOn(unreadable, "text").mockRejectedValue(new Error("sensitive raw response"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(unreadable)
      .mockResolvedValueOnce(response(interpretation)).mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(response(review));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "test-key", fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toMatchObject({ ok: true });
    expect(diagnostics[0]).toMatchObject({ httpStatus: 200, contentType: "application/json",
      responseBodyPresent: true, other: "BODY_READ_FAILURE", retryable: true });
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive");
  });

  it.each([408, 409, 429, 500, 503])("retries transient HTTP %s at most once", async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status }));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", fetchImpl }))
      .toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds recoverable fetch failures and never exports the exception", async () => {
    const diagnostics: RunningResponseDiagnostic[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("key and response secret"));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "test-key", fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics[0]).toMatchObject({ httpStatus: null, other: "FETCH_FAILURE", retryable: true });
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });

  it.each([400, 401, 403, 404, 422])("does not retry HTTP %s provider rejection", async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", fetchImpl }))
      .toEqual({ ok: false, reason: "FAILED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry an explicit refusal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "refused" }] }] })));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", fetchImpl }))
      .toEqual({ ok: false, reason: "INVALID_OUTPUT" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes a schema-valid numeric hallucination to the verifier without a transport retry", async () => {
    const fake = { ...interpretation, claims: [{ ...interpretation.claims[0], value: "100m" }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(fake))
      .mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(response(review));
    const result = await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(verifySemanticIntentV2("200出る", result.interpretation, result.review, result.numericRoleReview, []))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
