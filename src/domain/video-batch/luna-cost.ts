import { createHash } from "node:crypto";
import { z } from "zod";

/** Prices are represented as nanoUSD per token. Final totals round up to microUSD. */
const NANO_PER_MICRO = BigInt(1_000);
const PRICE_URL = "https://developers.openai.com/api/docs/pricing" as const;
export const LUNA_MODEL = "gpt-6-luna" as const;
export const LUNA_SERVICE_TIER = "default" as const;
export const LUNA_MAX_OUTPUT_TOKENS = 8_192 as const;
export const LUNA_SHORT_CONTEXT_LIMIT = 272_000 as const;
export const PRICE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const PRICE_SNAPSHOT_FUTURE_SKEW_MS = 60_000;

export type PriceRates = Readonly<{
  uncachedInputNanoUsdPerToken: number;
  cachedInputNanoUsdPerToken: number;
  cacheWriteNanoUsdPerToken: number;
  outputNanoUsdPerToken: number;
}>;
export type PriceVerification = Readonly<{
  source: typeof PRICE_URL;
  pricingAsOf: string;
  scheduleHash: string;
  sourceContentHash: string;
  checkedAt: string;
}>;
export type PriceSnapshot = Readonly<{
  model: typeof LUNA_MODEL;
  serviceTier: typeof LUNA_SERVICE_TIER;
  endpoint: "global";
  pricingAsOf: string;
  source: typeof PRICE_URL;
  scheduleHash: string;
  sourceContentHash: string;
  verifiedAt: string;
  cacheMode: "explicit";
  explicitBreakpointCount: 0;
  shortContextLimit: typeof LUNA_SHORT_CONTEXT_LIMIT;
  short: PriceRates;
  long: PriceRates;
}>;

export type LunaPreflightErrorCode = "PRICE_SNAPSHOT_STALE" | "INVALID_PRICE_SNAPSHOT"
  | "INVALID_TOKEN_RECEIPT" | "TOKEN_COUNT_REQUIRED" | "TOKEN_RECEIPT_STALE"
  | "PAYLOAD_HASH_MISMATCH" | "MAX_OUTPUT_TOKENS_UNSET" | "COST_CAP_UNKNOWN"
  | "COST_CAP_INVALID" | "COST_CAP_EXCEEDED" | "MODEL_MISMATCH" | "USAGE_UNKNOWN";
export class LunaPreflightError extends Error {
  constructor(readonly code: LunaPreflightErrorCode, message = code) {
    super(message);
    this.name = "LunaPreflightError";
  }
}

const ratesSchema = z.object({
  uncachedInputNanoUsdPerToken: z.number().int().positive(),
  cachedInputNanoUsdPerToken: z.number().int().positive(),
  cacheWriteNanoUsdPerToken: z.number().int().positive(),
  outputNanoUsdPerToken: z.number().int().positive(),
}).strict();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const isoDateTime = z.string().datetime({ offset: true });
export const priceVerificationSchema = z.object({
  source: z.literal(PRICE_URL), pricingAsOf: dateSchema, scheduleHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: isoDateTime,
}).strict();
export const priceSnapshotSchema = z.object({
  model: z.literal(LUNA_MODEL), serviceTier: z.literal(LUNA_SERVICE_TIER), endpoint: z.literal("global"),
  pricingAsOf: dateSchema, source: z.literal(PRICE_URL), scheduleHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/), verifiedAt: isoDateTime,
  cacheMode: z.literal("explicit"), explicitBreakpointCount: z.literal(0),
  shortContextLimit: z.literal(LUNA_SHORT_CONTEXT_LIMIT), short: ratesSchema, long: ratesSchema,
}).strict();

export const LUNA_PRICE_RATES = Object.freeze({
  short: Object.freeze({ uncachedInputNanoUsdPerToken: 100, cachedInputNanoUsdPerToken: 10,
    cacheWriteNanoUsdPerToken: 125, outputNanoUsdPerToken: 500 }),
  long: Object.freeze({ uncachedInputNanoUsdPerToken: 200, cachedInputNanoUsdPerToken: 20,
    cacheWriteNanoUsdPerToken: 250, outputNanoUsdPerToken: 750 }),
}) satisfies Readonly<{ short: PriceRates; long: PriceRates }>;

function scheduleHash(value: Pick<PriceSnapshot, "model" | "serviceTier" | "endpoint" | "pricingAsOf" | "source"
  | "cacheMode" | "explicitBreakpointCount" | "shortContextLimit" | "short" | "long">): string {
  // Stable JSON property insertion order is defined here, independently of caller object order.
  const canonical = JSON.stringify({ model: value.model, serviceTier: value.serviceTier, endpoint: value.endpoint,
    pricingAsOf: value.pricingAsOf, source: value.source, cacheMode: value.cacheMode,
    explicitBreakpointCount: value.explicitBreakpointCount, shortContextLimit: value.shortContextLimit,
    short: value.short, long: value.long });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Hash the fixed schedule for a pricing publication date, for use in a separately verified record. */
export function expectedLunaScheduleHash(pricingAsOf: string): string {
  return scheduleHash({ model: LUNA_MODEL, serviceTier: LUNA_SERVICE_TIER, endpoint: "global",
    pricingAsOf, source: PRICE_URL, cacheMode: "explicit", explicitBreakpointCount: 0,
    shortContextLimit: LUNA_SHORT_CONTEXT_LIMIT, short: LUNA_PRICE_RATES.short, long: LUNA_PRICE_RATES.long });
}

/** Build a price snapshot only after an independent official-page check supplies its hashes/time. */
export function createLunaPriceSnapshot(verification: PriceVerification): PriceSnapshot {
  const base = { model: LUNA_MODEL, serviceTier: LUNA_SERVICE_TIER, endpoint: "global" as const,
    pricingAsOf: verification.pricingAsOf, source: PRICE_URL, cacheMode: "explicit" as const,
    explicitBreakpointCount: 0 as const, shortContextLimit: LUNA_SHORT_CONTEXT_LIMIT,
    short: LUNA_PRICE_RATES.short, long: LUNA_PRICE_RATES.long };
  const snapshot: PriceSnapshot = { ...base, scheduleHash: scheduleHash(base),
    sourceContentHash: verification.sourceContentHash, verifiedAt: verification.checkedAt };
  if (!priceVerificationSchema.safeParse(verification).success
    || verification.scheduleHash !== snapshot.scheduleHash) {
    throw new LunaPreflightError("INVALID_PRICE_SNAPSHOT");
  }
  return priceSnapshotSchema.parse(snapshot);
}

export type TokenReceipt = Readonly<{
  model: typeof LUNA_MODEL;
  payloadHash: string;
  frameManifestHash: string;
  inputTokens: number;
  countedAt: string;
  schemaVersion: "luna-visual-guidance-v1";
  promptVersion: "luna-frame-observation-v1";
  detail: "high";
  frameCount: 12;
}>;
export const tokenReceiptSchema = z.object({
  model: z.literal(LUNA_MODEL), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  frameManifestHash: z.string().regex(/^[a-f0-9]{64}$/), inputTokens: z.number().int().nonnegative().safe(),
  countedAt: isoDateTime, schemaVersion: z.literal("luna-visual-guidance-v1"),
  promptVersion: z.literal("luna-frame-observation-v1"), detail: z.literal("high"), frameCount: z.literal(12),
}).strict();

export type CostGateInput = Readonly<{
  priceSnapshot?: PriceSnapshot | null;
  currentPriceVerification?: PriceVerification | null;
  tokenReceipt?: TokenReceipt | null;
  expectedPayloadHash: string;
  expectedFrameManifestHash?: string;
  /** The concrete request value; absence/undefined is fail closed. */
  maxOutputTokens?: number | null;
  /** Exact USD decimal, e.g. "0.004096". UNKNOWN/null/undefined denies. */
  costCapUsd?: string | null;
  now?: Date;
}>;
export type CostGateResult = Readonly<{
  allowed: true;
  model: typeof LUNA_MODEL;
  contextClass: "short" | "long";
  inputTokens: number;
  maxOutputTokens: typeof LUNA_MAX_OUTPUT_TOKENS;
  inputUpperBoundMicroUsd: number;
  outputUpperBoundMicroUsd: number;
  upperBoundMicroUsd: number;
  capMicroUsd: number;
}>;

function toMicroUsd(nanoUsd: bigint): bigint { return (nanoUsd + NANO_PER_MICRO - BigInt(1)) / NANO_PER_MICRO; }
function asSafeNumber(value: bigint, code: LunaPreflightErrorCode): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new LunaPreflightError(code);
  return n;
}

/** Parse a nonnegative exact USD amount to integer microUSD; floats and >6 decimals are forbidden. */
export function parseUsdCapMicroUsd(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new LunaPreflightError("COST_CAP_INVALID");
  const [whole, fraction = ""] = value.split(".");
  const micros = BigInt(whole) * BigInt(1_000_000) + BigInt((fraction + "000000").slice(0, 6));
  return asSafeNumber(micros, "COST_CAP_INVALID");
}

function assertFresh(iso: string, now: Date, errorCode: LunaPreflightErrorCode): void {
  const at = Date.parse(iso);
  const current = now.getTime();
  if (!Number.isFinite(at) || !Number.isFinite(current) || at > current + PRICE_SNAPSHOT_FUTURE_SKEW_MS
    || current - at > PRICE_SNAPSHOT_MAX_AGE_MS) throw new LunaPreflightError(errorCode);
}

function validatePrice(snapshotRaw: PriceSnapshot, currentRaw: PriceVerification, now: Date): PriceSnapshot {
  const snapshotResult = priceSnapshotSchema.safeParse(snapshotRaw);
  const currentResult = priceVerificationSchema.safeParse(currentRaw);
  if (!snapshotResult.success || !currentResult.success) throw new LunaPreflightError("INVALID_PRICE_SNAPSHOT");
  const snapshot = snapshotResult.data;
  if (snapshot.scheduleHash !== scheduleHash(snapshot)
    || snapshot.scheduleHash !== currentResult.data.scheduleHash
    || snapshot.sourceContentHash !== currentResult.data.sourceContentHash
    || snapshot.source !== currentResult.data.source
    || snapshot.pricingAsOf !== currentResult.data.pricingAsOf) {
    throw new LunaPreflightError("PRICE_SNAPSHOT_STALE");
  }
  assertFresh(snapshot.verifiedAt, now, "PRICE_SNAPSHOT_STALE");
  assertFresh(currentResult.data.checkedAt, now, "PRICE_SNAPSHOT_STALE");
  if (Date.parse(currentResult.data.checkedAt) < Date.parse(snapshot.verifiedAt)) {
    throw new LunaPreflightError("PRICE_SNAPSHOT_STALE");
  }
  return snapshot;
}

/** Fail closed unless the receipt, official price recheck and exact request cap all agree. */
export function evaluateLunaCostGate(input: CostGateInput): CostGateResult {
  const now = input.now ?? new Date();
  if (!input.priceSnapshot || !input.currentPriceVerification) throw new LunaPreflightError("PRICE_SNAPSHOT_STALE");
  const prices = validatePrice(input.priceSnapshot, input.currentPriceVerification, now);
  if (!input.tokenReceipt) throw new LunaPreflightError("TOKEN_COUNT_REQUIRED");
  const parsedReceipt = tokenReceiptSchema.safeParse(input.tokenReceipt);
  if (!parsedReceipt.success) throw new LunaPreflightError("INVALID_TOKEN_RECEIPT");
  const receipt = parsedReceipt.data;
  assertFresh(receipt.countedAt, now, "TOKEN_RECEIPT_STALE");
  if (!/^[a-f0-9]{64}$/.test(input.expectedPayloadHash)
    || receipt.payloadHash !== input.expectedPayloadHash) throw new LunaPreflightError("PAYLOAD_HASH_MISMATCH");
  if (input.expectedFrameManifestHash !== undefined
    && (!/^[a-f0-9]{64}$/.test(input.expectedFrameManifestHash)
      || receipt.frameManifestHash !== input.expectedFrameManifestHash)) {
    throw new LunaPreflightError("PAYLOAD_HASH_MISMATCH");
  }
  if (input.maxOutputTokens !== LUNA_MAX_OUTPUT_TOKENS) throw new LunaPreflightError("MAX_OUTPUT_TOKENS_UNSET");
  if (typeof input.costCapUsd !== "string" || input.costCapUsd === "UNKNOWN" || input.costCapUsd.length === 0) {
    throw new LunaPreflightError("COST_CAP_UNKNOWN");
  }
  const cap = parseUsdCapMicroUsd(input.costCapUsd);
  const isLong = receipt.inputTokens > prices.shortContextLimit;
  const rates = isLong ? prices.long : prices.short;
  // Cache mode is explicit with zero breakpoints. The preflight bound therefore prices every
  // input token at the uncached rate; writing cache is impossible for this request configuration.
  const inputNano = BigInt(receipt.inputTokens) * BigInt(rates.uncachedInputNanoUsdPerToken);
  const outputNano = BigInt(LUNA_MAX_OUTPUT_TOKENS) * BigInt(rates.outputNanoUsdPerToken);
  const inputMicro = toMicroUsd(inputNano);
  const outputMicro = toMicroUsd(outputNano);
  // The cap is compared to the exact combined amount, rounded once to microUSD.
  const totalMicro = toMicroUsd(inputNano + outputNano);
  if (totalMicro > BigInt(cap)) throw new LunaPreflightError("COST_CAP_EXCEEDED");
  return { allowed: true, model: LUNA_MODEL, contextClass: isLong ? "long" : "short",
    inputTokens: receipt.inputTokens, maxOutputTokens: LUNA_MAX_OUTPUT_TOKENS,
    inputUpperBoundMicroUsd: asSafeNumber(inputMicro, "COST_CAP_INVALID"),
    outputUpperBoundMicroUsd: asSafeNumber(outputMicro, "COST_CAP_INVALID"),
    upperBoundMicroUsd: asSafeNumber(totalMicro, "COST_CAP_INVALID"), capMicroUsd: cap };
}

export type LunaActualUsage = Readonly<{
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  model: typeof LUNA_MODEL;
  serviceTier: typeof LUNA_SERVICE_TIER;
  responseId: string | null;
}>;
const actualUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().safe(), cachedTokens: z.number().int().nonnegative().safe(),
  cacheWriteTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
  reasoningTokens: z.number().int().nonnegative().safe(), totalTokens: z.number().int().nonnegative().safe(),
  model: z.literal(LUNA_MODEL), serviceTier: z.literal(LUNA_SERVICE_TIER), responseId: z.string().min(1).nullable(),
}).strict();
export type LunaActualCost = Readonly<LunaActualUsage & {
  contextClass: "short" | "long";
  uncachedInputTokens: number;
  actualInputMicroUsd: number;
  actualCachedMicroUsd: number;
  actualCacheWriteMicroUsd: number;
  actualOutputMicroUsd: number;
  actualTotalMicroUsd: number;
}>;

function unknownUsage(): never { throw new LunaPreflightError("USAGE_UNKNOWN"); }
function readNonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : unknownUsage();
}
function readObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : unknownUsage();
}

/** Parse captured JSON/body data only. No network, headers or retry behavior lives here. */
export function parseLunaUsageBody(body: unknown): LunaActualUsage {
  const raw = readObject(body);
  if (raw.model !== LUNA_MODEL) throw new LunaPreflightError("MODEL_MISMATCH");
  if (raw.service_tier !== LUNA_SERVICE_TIER
    || (raw.id !== undefined && raw.id !== null && (typeof raw.id !== "string" || raw.id.length === 0))) return unknownUsage();
  const usage = readObject(raw.usage);
  const inputDetails = readObject(usage.input_tokens_details);
  const inputTokens = readNonnegativeInteger(usage.input_tokens);
  const cachedTokens = readNonnegativeInteger(inputDetails.cached_tokens);
  const cacheWriteTokens = readNonnegativeInteger(inputDetails.cache_write_tokens ?? usage.cache_write_tokens);
  const outputTokens = readNonnegativeInteger(usage.output_tokens);
  const outputDetails = readObject(usage.output_tokens_details);
  const reasoningTokens = readNonnegativeInteger(outputDetails.reasoning_tokens);
  const totalTokens = readNonnegativeInteger(usage.total_tokens);
  if (!Number.isSafeInteger(cachedTokens + cacheWriteTokens) || !Number.isSafeInteger(inputTokens + outputTokens)
    || cachedTokens + cacheWriteTokens > inputTokens || reasoningTokens > outputTokens
    || totalTokens !== inputTokens + outputTokens) return unknownUsage();
  return { inputTokens, cachedTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens,
    model: LUNA_MODEL, serviceTier: LUNA_SERVICE_TIER, responseId: typeof raw.id === "string" ? raw.id : null };
}

/** Apply actual observed usage to its context-specific exact PriceSnapshot rates. */
export function calculateLunaActualCost(usage: LunaActualUsage, snapshotRaw: PriceSnapshot): LunaActualCost {
  const snapshotResult = priceSnapshotSchema.safeParse(snapshotRaw);
  if (!snapshotResult.success) {
    throw new LunaPreflightError("INVALID_PRICE_SNAPSHOT");
  }
  const snapshot = snapshotResult.data;
  if (snapshot.scheduleHash !== scheduleHash(snapshot)) throw new LunaPreflightError("INVALID_PRICE_SNAPSHOT");
  const usageResult = actualUsageSchema.safeParse(usage);
  if (!usageResult.success) return unknownUsage();
  const validUsage = usageResult.data;
  if (!Number.isSafeInteger(validUsage.cachedTokens + validUsage.cacheWriteTokens)
    || !Number.isSafeInteger(validUsage.inputTokens + validUsage.outputTokens)
    || validUsage.cachedTokens + validUsage.cacheWriteTokens > validUsage.inputTokens
    || validUsage.reasoningTokens > validUsage.outputTokens
    || validUsage.totalTokens !== validUsage.inputTokens + validUsage.outputTokens) return unknownUsage();
  const contextClass = validUsage.inputTokens > snapshot.shortContextLimit ? "long" : "short";
  const rates = snapshot[contextClass];
  const uncachedInputTokens = validUsage.inputTokens - validUsage.cachedTokens - validUsage.cacheWriteTokens;
  const actualInputMicroUsd = toMicroUsd(BigInt(uncachedInputTokens) * BigInt(rates.uncachedInputNanoUsdPerToken));
  const actualCachedMicroUsd = toMicroUsd(BigInt(validUsage.cachedTokens) * BigInt(rates.cachedInputNanoUsdPerToken));
  const actualCacheWriteMicroUsd = toMicroUsd(BigInt(validUsage.cacheWriteTokens) * BigInt(rates.cacheWriteNanoUsdPerToken));
  // Reasoning tokens are contained in output_tokens; do not charge them a second time.
  const actualOutputMicroUsd = toMicroUsd(BigInt(validUsage.outputTokens) * BigInt(rates.outputNanoUsdPerToken));
  const actualTotalMicroUsd = toMicroUsd(BigInt(uncachedInputTokens) * BigInt(rates.uncachedInputNanoUsdPerToken)
    + BigInt(validUsage.cachedTokens) * BigInt(rates.cachedInputNanoUsdPerToken)
    + BigInt(validUsage.cacheWriteTokens) * BigInt(rates.cacheWriteNanoUsdPerToken)
    + BigInt(validUsage.outputTokens) * BigInt(rates.outputNanoUsdPerToken));
  return { ...validUsage, contextClass, uncachedInputTokens,
    actualInputMicroUsd: asSafeNumber(actualInputMicroUsd, "USAGE_UNKNOWN"),
    actualCachedMicroUsd: asSafeNumber(actualCachedMicroUsd, "USAGE_UNKNOWN"),
    actualCacheWriteMicroUsd: asSafeNumber(actualCacheWriteMicroUsd, "USAGE_UNKNOWN"),
    actualOutputMicroUsd: asSafeNumber(actualOutputMicroUsd, "USAGE_UNKNOWN"),
    actualTotalMicroUsd: asSafeNumber(actualTotalMicroUsd, "USAGE_UNKNOWN") };
}

export function compareActualToLunaUpperBound(actual: LunaActualCost, upperBoundMicroUsd: number): boolean {
  return Number.isSafeInteger(upperBoundMicroUsd) && upperBoundMicroUsd >= 0
    && actual.actualTotalMicroUsd <= upperBoundMicroUsd;
}
