import { describe, expect, it, vi } from "vitest";
import { extractRunningSemanticIntentV2, SEMANTIC_INTENT_V2_OUTPUT_SCHEMA, SEMANTIC_INTENT_V2_INSTRUCTIONS, SEMANTIC_REVIEW_V2_INSTRUCTIONS } from "@/infra/running-menu/openai-semantic-intent-v2";
import { runningSemanticClientConfig, type RunningResponseDiagnostic } from "@/infra/running-menu/structured-response";
import { verifyPrimarySemanticIntentV2 } from "@/application/running-menu/semantic-intent-v2";

const interpretation = { interpreterVersion: "running-intent-v2", requestKind: "RUNNING", claims: [
  { field: "EVENT", value: "200m", sourceText: "200出る", polarity: "AFFIRMED", temporalScope: "FUTURE", status: "ACTIVE", numericParts: [{ rawText: "200", unit: "NONE" }] },
], corrections: [], unsupportedIntents: [], ambiguity: null, exerciseIds: [] };
const review = { assessments: [{ index: 0, supported: true }], activeClaimIndexes: [0], requestKindSupported: true,
  missingCriticalClaim: false, ambiguityCorrect: true, unsupportedIntentsSupported: true, correctionsSupported: true };
const numericRoleReview = { roles: [{ sourceText: "200出る", rawText: "200", role: "EVENT" }] };
const envelope = (text: string) => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
const response = (value: unknown) => new Response(JSON.stringify(envelope(JSON.stringify(value))), { status: 200, headers: { "content-type": "application/json" } });

describe("semantic interpreter v2 OpenAI contract", () => {
  it("keeps race timing, desired fatigue accumulation, and a numeric self-rating semantically separate", async () => {
    const requestText = "高校生の100mです。来週末の試合に向けて少し疲労をためたいです。今は１０が一番疲労が強いとしたら１です。";
    const quote = "高校生の100mです。";
    const expected = {
      interpreterVersion: "running-intent-v2", requestKind: "RUNNING",
      claims: [
        { field: "RUNNING_REQUEST", value: true, sourceText: quote, polarity: "AFFIRMED", temporalScope: "CURRENT", status: "ACTIVE", numericParts: [], safetyConcernEvidence: null },
        { field: "AGE_GROUP", value: "HIGH_SCHOOL", sourceText: quote, polarity: "AFFIRMED", temporalScope: "CURRENT", status: "ACTIVE", numericParts: [], safetyConcernEvidence: null },
        { field: "EVENT", value: "100m", sourceText: quote, polarity: "AFFIRMED", temporalScope: "CURRENT", status: "ACTIVE", numericParts: [{ rawText: "100", unit: "METER" }], safetyConcernEvidence: null },
      ],
      corrections: [],
      unsupportedIntents: [
        { meaning: "試合に向けた疲労蓄積の希望", sourceText: "来週末の試合に向けて少し疲労をためたいです。" },
        { meaning: "本人が説明した現在の数値疲労尺度", sourceText: "今は１０が一番疲労が強いとしたら１です。" },
      ],
      ambiguity: null, exerciseIds: [],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(expected));
    const result = await extractRunningSemanticIntentV2({ requestText, exercises: [] }, { apiKey: "test-key", fetchImpl });
    expect(result).toMatchObject({ ok: true, interpretation: { requestKind: "RUNNING", unsupportedIntents: expected.unsupportedIntents } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const verification = verifyPrimarySemanticIntentV2(requestText, expected, []);
    expect(verification.ok).toBe(true);
    if (verification.ok) expect(verification.engineIntent).toMatchObject({
      ageGroup: { value: "HIGH_SCHOOL" }, event: { value: "100m" }, purpose: null,
      fatigueState: null, loadReductionRequested: null,
    });
    for (const instructions of [SEMANTIC_INTENT_V2_INSTRUCTIONS, SEMANTIC_REVIEW_V2_INSTRUCTIONS]) {
      expect(instructions).toContain("日程や「大会に向けて」という方向づけだけではPURPOSE=PRECOMPにしない");
      expect(instructions).toContain("疲労をためたい／疲労を蓄積したい希望");
      expect(instructions).toContain("数値をFATIGUE enum、医学的尺度");
    }
  });

  it("uses only the primary stage for a normal grounded request without prescription fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(interpretation)).mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(response(review));
    const result = await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", model: "gpt-6-luna", fetchImpl });
    expect(result).toMatchObject({ ok: true, interpretation: { requestKind: "RUNNING" }, review: null, numericRoleReview: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const first = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(first).toMatchObject({ model: "gpt-6-luna", store: false, text: { format: { type: "json_schema", strict: true } } });
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
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(badResponse()).mockResolvedValueOnce(response(interpretation));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "secret-key-must-not-escape", fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics[0]).toMatchObject({ stage: "running_semantic_intent_v2", attempt: 1,
      httpStatus: 200, sdkParseFailure: false, retryable: true, other });
    expect(diagnostics[1]).toMatchObject({ stage: "running_semantic_intent_v2", attempt: 2, retryable: false });
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret-key|200出る|inventedDistance|\{broken/u);
  });

  it("recovers a body read failure and keeps safe HTTP diagnostics", async () => {
    const diagnostics: RunningResponseDiagnostic[] = [];
    const unreadable = new Response("body", { headers: { "content-type": "application/json; charset=utf-8" } });
    vi.spyOn(unreadable, "arrayBuffer").mockRejectedValue(new Error("sensitive raw response"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(unreadable)
      .mockResolvedValueOnce(response(interpretation)).mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(response(review));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "test-key", fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toMatchObject({ ok: true });
    expect(diagnostics[0]).toMatchObject({ httpStatus: 200, contentType: "application/json",
      responseBodyPresent: null, bodyByteLength: null, errorClass: "BODY_READ_FAILURE", other: "BODY_READ_FAILURE", retryable: true });
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
    if (result.ok) expect(verifyPrimarySemanticIntentV2("200出る", result.interpretation, [], result.review))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records bounded usage and parsing metadata without response or exception content", async () => {
    const body = { ...envelope(JSON.stringify(interpretation)), usage: { input_tokens: 123, input_tokens_details: { cached_tokens: 100 },
      output_tokens: 456, output_tokens_details: { reasoning_tokens: 300 }, total_tokens: 579 }, private_data: "sensitive body" };
    const diagnostics: RunningResponseDiagnostic[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(response(review));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "private-api-key", model: "gpt-6.1-sol", reasoningEffort: "high", timeoutMs: 30000, fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toMatchObject({ ok: true });
    expect(diagnostics[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "high", timeoutMs: 30000, retryNumber: 0,
      bodyByteLength: new TextEncoder().encode(JSON.stringify(body)).byteLength, jsonParseSuccess: true,
      structuredJsonParseSuccess: true, structuredSchemaSuccess: true, responseStatus: "completed", errorClass: null,
      usage: { inputTokens: 123, cachedInputTokens: 100, outputTokens: 456, reasoningTokens: 300, totalTokens: 579 } });
    expect(diagnostics.every(d => d.elapsedMs >= 0)).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toMatch(/sensitive|private-api-key|200出る/u);
  });

  it("distinguishes a native timeout from network failure and bounds its retry", async () => {
    const diagnostics: RunningResponseDiagnostic[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "test-key", timeoutMs: 10, fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics.map(d => d.errorClass)).toEqual(["TIMEOUT", "TIMEOUT"]);
    expect(diagnostics.map(d => d.retryNumber)).toEqual([0, 1]);
    expect(diagnostics.every(d => d.httpStatus === null && d.bodyByteLength === null)).toBe(true);
  });

  it("records an allowlisted network cause without its sensitive message", async () => {
    const diagnostics: RunningResponseDiagnostic[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("secret host and request", { cause: { code: "ECONNRESET", message: "secret" } }));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "test-key", fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(diagnostics[0]).toMatchObject({ errorClass: "NETWORK_FAILURE", errorName: "TypeError", networkErrorCode: "ECONNRESET" });
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });

  it("cannot throw or log object-valued metadata from a malformed envelope", async () => {
    const diagnostics: RunningResponseDiagnostic[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: { toString: "sensitive" }, incomplete_details: { reason: { toString: "sensitive" } }, output: [],
    })));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "test-key", fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toEqual({ ok: false, reason: "INVALID_OUTPUT" });
    expect(diagnostics[0]).toMatchObject({ jsonParseSuccess: true, responseStatus: null, incompleteReason: "UNKNOWN" });
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive");
  });

  it("counts received bytes before replacement decoding a corrupted UTF-8 body", async () => {
    const diagnostics: RunningResponseDiagnostic[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([0xff])))
      .mockResolvedValueOnce(response(interpretation)).mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(response(review));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, {
      apiKey: "test-key", fetchImpl, onAttempt: d => diagnostics.push(d),
    })).toMatchObject({ ok: true });
    expect(diagnostics[0]).toMatchObject({ bodyByteLength: 1, responseBodyPresent: true,
      jsonParseSuccess: false, errorClass: "ENVELOPE_PARSE_FAILURE", retryable: true });
  });
});
