import { describe, expect, it } from "vitest";
import {
  calculateLunaActualCost,
  createLunaPriceSnapshot,
  evaluateLunaCostGate,
  expectedLunaScheduleHash,
  LUNA_MAX_OUTPUT_TOKENS,
  LunaPreflightError,
  parseLunaUsageBody,
  parseUsdCapMicroUsd,
  type PriceVerification,
  type TokenReceipt,
} from "@/domain/video-batch/luna-cost";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const HASH = "a".repeat(64);
const SOURCE_HASH = "b".repeat(64);
const verification = (overrides: Partial<PriceVerification> = {}): PriceVerification => ({
  source: "https://developers.openai.com/api/docs/pricing",
  pricingAsOf: "2026-10-05",
  scheduleHash: expectedLunaScheduleHash("2026-10-05"),
  sourceContentHash: SOURCE_HASH,
  checkedAt: NOW.toISOString(),
  ...overrides,
});
const receipt = (overrides: Partial<TokenReceipt> = {}): TokenReceipt => ({
  model: "gpt-6-luna", payloadHash: HASH, frameManifestHash: "c".repeat(64),
  inputTokens: 10_000, countedAt: NOW.toISOString(), schemaVersion: "luna-visual-guidance-v1",
  promptVersion: "luna-frame-observation-v1", detail: "high", frameCount: 12, ...overrides,
});
const setup = () => {
  const checked = verification();
  return { checked, snapshot: createLunaPriceSnapshot(checked) };
};
const gate = (overrides: Record<string, unknown> = {}) => {
  const { checked, snapshot } = setup();
  return evaluateLunaCostGate({ priceSnapshot: snapshot, currentPriceVerification: checked,
    tokenReceipt: receipt(), expectedPayloadHash: HASH, maxOutputTokens: LUNA_MAX_OUTPUT_TOKENS,
    costCapUsd: "0.005096", now: NOW, ...overrides } as Parameters<typeof evaluateLunaCostGate>[0]);
};
const code = (fn: () => unknown, expected: string) => {
  try { fn(); throw new Error("expected preflight failure"); }
  catch (error) { expect(error).toBeInstanceOf(LunaPreflightError); expect((error as LunaPreflightError).code).toBe(expected); }
};

describe("Luna exact price snapshot and cost gate", () => {
  it("creates an independently verifiable strict Luna/default/global no-breakpoint price snapshot", () => {
    const { checked, snapshot } = setup();
    expect(snapshot.model).toBe("gpt-6-luna");
    expect(snapshot.serviceTier).toBe("default");
    expect(snapshot.endpoint).toBe("global");
    expect(snapshot.cacheMode).toBe("explicit");
    expect(snapshot.explicitBreakpointCount).toBe(0);
    expect(snapshot.short.uncachedInputNanoUsdPerToken).toBe(100);
    expect(snapshot.short.cachedInputNanoUsdPerToken).toBe(10);
    expect(snapshot.short.cacheWriteNanoUsdPerToken).toBe(125);
    expect(snapshot.short.outputNanoUsdPerToken).toBe(500);
    expect(snapshot.long).toEqual({ uncachedInputNanoUsdPerToken: 200, cachedInputNanoUsdPerToken: 20,
      cacheWriteNanoUsdPerToken: 250, outputNanoUsdPerToken: 750 });
    expect(createLunaPriceSnapshot(checked)).toEqual(snapshot);
  });

  it("uses integer microUSD ceiling math, allows exact cap, and denies a smaller cap", () => {
    expect(gate()).toMatchObject({ allowed: true, contextClass: "short", inputUpperBoundMicroUsd: 1_000,
      outputUpperBoundMicroUsd: 4_096, upperBoundMicroUsd: 5_096, capMicroUsd: 5_096 });
    code(() => gate({ costCapUsd: "0.005095" }), "COST_CAP_EXCEEDED");
    expect(gate({ costCapUsd: "0.005097" }).upperBoundMicroUsd).toBe(5_096);
    expect(parseUsdCapMicroUsd("0.005096")).toBe(5_096);
    expect(() => parseUsdCapMicroUsd("0.0050961")).toThrowError(LunaPreflightError);
    expect(() => parseUsdCapMicroUsd("5.096e-3")).toThrowError(LunaPreflightError);
    expect(gate({ tokenReceipt: receipt({ inputTokens: 1 }), costCapUsd: "0.004097" }).upperBoundMicroUsd).toBe(4_097);
  });

  it("selects long-context rates once the receipt exceeds 272,000 input tokens", () => {
    const result = gate({ tokenReceipt: receipt({ inputTokens: 272_001 }), costCapUsd: "0.060545" });
    expect(result).toMatchObject({ contextClass: "long", inputUpperBoundMicroUsd: 54_401,
      outputUpperBoundMicroUsd: 6_144, upperBoundMicroUsd: 60_545 });
  });

  it("fails closed when token receipt, current prices, fixed output cap, cost cap or hash are absent/wrong", () => {
    code(() => gate({ tokenReceipt: null }), "TOKEN_COUNT_REQUIRED");
    code(() => gate({ priceSnapshot: null }), "PRICE_SNAPSHOT_STALE");
    code(() => gate({ currentPriceVerification: null }), "PRICE_SNAPSHOT_STALE");
    code(() => gate({ maxOutputTokens: null }), "MAX_OUTPUT_TOKENS_UNSET");
    code(() => gate({ maxOutputTokens: 8_193 }), "MAX_OUTPUT_TOKENS_UNSET");
    code(() => gate({ costCapUsd: "UNKNOWN" }), "COST_CAP_UNKNOWN");
    code(() => gate({ costCapUsd: "not dollars" }), "COST_CAP_INVALID");
    code(() => gate({ expectedPayloadHash: "d".repeat(64) }), "PAYLOAD_HASH_MISMATCH");
    code(() => gate({ expectedFrameManifestHash: "d".repeat(64) }), "PAYLOAD_HASH_MISMATCH");
    expect(gate({ expectedFrameManifestHash: "c".repeat(64) }).allowed).toBe(true);
    for (const model of ["gpt-6-sol", "gpt-6-astra", "gpt-5.6-luna", "unknown", ""] as const) {
      code(() => gate({ tokenReceipt: receipt({ model: model as "gpt-6-luna" }) }), "INVALID_TOKEN_RECEIPT");
    }
    code(() => gate({ tokenReceipt: receipt({ schemaVersion: "neutral-v1" as TokenReceipt["schemaVersion"] }) }),
      "INVALID_TOKEN_RECEIPT");
    code(() => gate({ tokenReceipt: receipt({ promptVersion: "other-prompt" as TokenReceipt["promptVersion"] }) }),
      "INVALID_TOKEN_RECEIPT");
    code(() => gate({ tokenReceipt: receipt({ frameCount: 11 as TokenReceipt["frameCount"] }) }), "INVALID_TOKEN_RECEIPT");
  });

  it("rejects stale, future, tampered and mismatched official price verification", () => {
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1_000).toISOString();
    code(() => gate({ currentPriceVerification: verification({ checkedAt: old }) }), "PRICE_SNAPSHOT_STALE");
    code(() => gate({ currentPriceVerification: verification({ checkedAt: new Date(NOW.getTime() - 1).toISOString() }) }),
      "PRICE_SNAPSHOT_STALE");
    code(() => gate({ currentPriceVerification: verification({ sourceContentHash: "d".repeat(64) }) }), "PRICE_SNAPSHOT_STALE");
    code(() => gate({ currentPriceVerification: verification({ pricingAsOf: "2026-10-04" }) }), "PRICE_SNAPSHOT_STALE");
    code(() => gate({ tokenReceipt: receipt({ countedAt: old }) }), "TOKEN_RECEIPT_STALE");
    const { checked, snapshot } = setup();
    code(() => evaluateLunaCostGate({ priceSnapshot: { ...snapshot, short: { ...snapshot.short,
      uncachedInputNanoUsdPerToken: 1 } }, currentPriceVerification: checked, tokenReceipt: receipt(),
      expectedPayloadHash: HASH, maxOutputTokens: LUNA_MAX_OUTPUT_TOKENS, costCapUsd: "1", now: NOW }),
    "PRICE_SNAPSHOT_STALE");
  });
});

describe("Luna usage capture and actual cost", () => {
  const validBody = () => ({ id: "resp_abc", model: "gpt-6-luna", service_tier: "default",
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
      output_tokens: 40, output_tokens_details: { reasoning_tokens: 15 }, total_tokens: 140 } });

  it("captures required response usage and calculates disjoint actual input/cache/output cost", () => {
    const usage = parseLunaUsageBody(validBody());
    expect(usage).toEqual({ inputTokens: 100, cachedTokens: 20, cacheWriteTokens: 10,
      outputTokens: 40, reasoningTokens: 15, totalTokens: 140, model: "gpt-6-luna",
      serviceTier: "default", responseId: "resp_abc" });
    const { snapshot } = setup();
    const actual = calculateLunaActualCost(usage, snapshot);
    expect(actual).toMatchObject({ uncachedInputTokens: 70, actualInputMicroUsd: 7,
      actualCachedMicroUsd: 1, actualCacheWriteMicroUsd: 2, actualOutputMicroUsd: 20,
      actualTotalMicroUsd: 29 });
    expect(parseLunaUsageBody({ ...validBody(), id: null }).responseId).toBeNull();
  });

  it("rejects absent/invalid usage as UNKNOWN and rejects other models or tiers", () => {
    const noWrite = validBody();
    delete (noWrite.usage.input_tokens_details as { cache_write_tokens?: number }).cache_write_tokens;
    code(() => parseLunaUsageBody(noWrite), "USAGE_UNKNOWN");
    code(() => parseLunaUsageBody({ ...validBody(), model: "gpt-6-sol" }), "MODEL_MISMATCH");
    code(() => parseLunaUsageBody({ ...validBody(), service_tier: "auto" }), "USAGE_UNKNOWN");
    code(() => parseLunaUsageBody({ ...validBody(), usage: { ...validBody().usage, total_tokens: 141 } }), "USAGE_UNKNOWN");
    code(() => parseLunaUsageBody({ ...validBody(), usage: { ...validBody().usage,
      input_tokens_details: { cached_tokens: 100, cache_write_tokens: 1 } } }), "USAGE_UNKNOWN");
    expect(parseLunaUsageBody({ ...validBody(), id: undefined }).responseId).toBeNull();
  });
});
