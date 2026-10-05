import { createHash } from "node:crypto";
import { z } from "zod";
import { sourceBindingSchema } from "@/domain/exercise/video-guidance-persistence";

const id = z.string().min(1).max(128).refine(v => v.trim() === v);
const units = z.number().int().min(0).max(1_000_000_000);
export const budgetSchema = z.object({ requests: units, tokens: units, cost: units }).strict();
export const configSchema = z.object({
  provider: z.literal("isolated-fake"), model: z.literal("synthetic-v1"), schemaVersion: z.literal("neutral-v1"),
  promptVersion: id, configVersion: id, recipe: id, inputManifest: id,
  segment: z.object({ startMs: units, endMs: units }).strict().refine(v => v.endMs > v.startMs),
  worstCase: budgetSchema.refine(v => v.requests === 1 && v.tokens >= 30 && v.cost >= 7),
  maxRetries: z.number().int().min(0).max(5), leaseMs: z.number().int().min(100).max(300_000),
}).strict();
export const targetSchema = z.object({ exerciseId: id, sourceBinding: sourceBindingSchema }).strict();
export const createBatchSchema = z.object({ ownerId: id, creationKey: id, config: configSchema,
  budget: budgetSchema, targets: z.array(targetSchema).min(1).max(1000) }).strict();
export type BatchInput = z.infer<typeof createBatchSchema>;
export type Config = z.infer<typeof configSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Budget = z.infer<typeof budgetSchema>;
/** This is deliberately not the Exercise guidance schema. No coach/dose/counting fields. */
export const neutralObservationSchema = z.object({
  schemaVersion: z.literal("neutral-v1"), quality: z.enum(["COMPLETE", "PARTIAL"]),
  events: z.array(z.object({ atMs: units, kind: z.enum(["CONTACT", "FLIGHT", "MOVEMENT"]),
    evidenceRef: id }).strict()).max(100),
  unresolved: z.array(z.enum(["OCCLUSION", "MISSING_AUDIO", "MISSING_FRAMES"])).max(3),
}).strict();
export const usageSchema = z.object({ requests: units, inputTokens: units, cachedTokens: units,
  outputTokens: units, reasoningTokens: units, cost: units }).strict()
  .refine(v => v.cachedTokens <= v.inputTokens && v.reasoningTokens <= v.outputTokens);
export type Usage = z.infer<typeof usageSchema>;
// Cached tokens are part of input; reasoning tokens are part of output. Never double count.
export const totals = (u: Usage): Budget => ({ requests: u.requests, tokens: u.inputTokens + u.outputTokens, cost: u.cost });
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function contentKey(ownerId: string, target: Target, config: Config) {
  return digest({ ownerId, mediaFingerprint: target.sourceBinding.contentSha256, segment: config.segment,
    recipe: config.recipe, inputManifest: config.inputManifest, provider: config.provider, model: config.model,
    schemaVersion: config.schemaVersion, promptVersion: config.promptVersion, configVersion: config.configVersion });
}
export const workKey = (ownerId: string, target: Target, config: Config) =>
  digest({ ownerId, exerciseId: target.exerciseId, sourceBinding: target.sourceBinding, contentKey: contentKey(ownerId, target, config), configHash: digest(config) });
export type BatchCode = "INVALID_VIDEO_SOURCE" | "STALE_VIDEO_GUIDANCE" | "PERSISTENCE_ERROR" | "REQUEST_OUTCOME_UNKNOWN"
  | "BUDGET_EXCEEDED" | "OPERATION_KEY_CONFLICT" | "LEASE_LOST" | "PAUSED" | "RETRY_NOT_ALLOWED" | "SCHEMA_INVALID" | "USAGE_EXCEEDS_RESERVATION";
export class BatchError extends Error {
  constructor(readonly code: BatchCode) { super(code); this.name = "VideoBatchError"; }
}
export type Claim = { itemId: string; workId: string; batchId: string; ownerId: string; workerId: string; fence: number };
export type FakeBehavior = "SUCCESS" | "PARTIAL" | "SCHEMA_INVALID" | "HTTP_429" | "HTTP_500" | "TIMEOUT_BEFORE_SEND"
  | "FAILURE_CONFIRMED_AFTER_SEND" | "UNKNOWN_AFTER_SEND" | "DELAYED_SUCCESS";
export type ProviderResult = { kind: "response"; raw: string; usage: Usage; requestId: string }
  | { kind: "confirmed-failure"; code: string; retryable: boolean; usage: Usage; requestId: string | null }
  | { kind: "unknown"; code: "REQUEST_OUTCOME_UNKNOWN" };
export interface IsolatedProvider {
  readonly capability: "SYNTHETIC_ONLY";
  dispatch(dispatchKey: string): Promise<ProviderResult>;
}
