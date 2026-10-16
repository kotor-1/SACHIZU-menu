import type { ZodType } from "zod";

/**
 * Claude Messages API without the SDK: one JSON-schema answer per call, never retried here.
 * Only metadata leaves this boundary; texts, bodies, headers and the key are never reported.
 */
export const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const CLAUDE_API_VERSION = "2023-06-01";

export type ClaudeAttempt = {
  model: string; elapsedMs: number; httpStatus: number | null; stopReason: string | null;
  errorClass: "TIMEOUT" | "NETWORK_FAILURE" | "HTTP_ERROR" | "INVALID_RESPONSE" | "MAX_TOKENS" | "REFUSAL"
    | "STRUCTURED_PARSE_FAILURE" | "SCHEMA_FAILURE" | null;
  /** outputTokens includes the thinking, which is billed as output even when its text is not returned. */
  inputTokens: number | null; outputTokens: number | null; thinkingTokens: number | null;
  cacheReadInputTokens: number | null; cacheCreationInputTokens: number | null;
};
export type ClaudeStructuredOptions = {
  model: string; maxTokens: number; timeoutMs: number; effort?: "low" | "medium" | "high";
  apiKey?: string; fetchImpl?: typeof fetch;
  /** Receives metadata only. */
  onAttempt?: (attempt: ClaudeAttempt) => void;
};
type Result<T> = { ok: true; value: T } | { ok: false; reason: "UNAVAILABLE" | "FAILED" | "INVALID_OUTPUT" };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const tokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Constraints that constrained decoding does not take. The App's Zod validator still enforces every one of them afterwards. */
const UNSUPPORTED_KEYWORDS = new Set(["minLength", "maxLength", "maxItems", "minimum", "maximum"]);
/**
 * The App's JSON schema in the subset the Messages API accepts: unsupported length and count limits are dropped
 * (validation after the answer still applies them), an array minimum above 1 becomes 1, and a nullable type list
 * becomes anyOf.
 */
export function claudeOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(claudeOutputSchema);
  if (!object(schema)) return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === "minItems") { if (typeof value === "number" && value > 0) result.minItems = 1; continue; }
    result[key] = key === "properties" && object(value)
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, claudeOutputSchema(child)]))
      : claudeOutputSchema(value);
  }
  if (Array.isArray(result.type) && result.type.includes("null") && result.type.length === 2) {
    const { type, ...rest } = result;
    const other = (type as string[]).find(entry => entry !== "null");
    return { anyOf: [{ ...rest, type: other }, { type: "null" }] };
  }
  return result;
}

/** The request body. The schema goes in exactly as given; callers pass it through claudeOutputSchema first. */
export function claudeRequestBody(input: unknown, system: string, schema: object, options: ClaudeStructuredOptions) {
  return { model: options.model, max_tokens: options.maxTokens, system,
    messages: [{ role: "user", content: JSON.stringify(input) }],
    output_config: { format: { type: "json_schema", schema }, ...(options.effort ? { effort: options.effort } : {}) } };
}

/** A single send. Any failure is reported as metadata and returned as not ok; the caller shows its own proposal instead. */
export async function callClaudeStructuredMessage<T>(input: unknown, system: string, schema: object, validator: ZodType<T>,
  options: ClaudeStructuredOptions): Promise<Result<T>> {
  const apiKey = (options.apiKey ?? process.env.ANTHROPIC_API_KEY)?.trim();
  if (!apiKey) return { ok: false, reason: "UNAVAILABLE" };
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || !Number.isInteger(options.maxTokens) || options.maxTokens <= 0) {
    return { ok: false, reason: "FAILED" };
  }
  const attempt: ClaudeAttempt = { model: options.model, elapsedMs: 0, httpStatus: null, stopReason: null, errorClass: null,
    inputTokens: null, outputTokens: null, thinkingTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null };
  const started = performance.now();
  const signal = AbortSignal.timeout(options.timeoutMs);
  const finish = (result: Result<T>) => {
    attempt.elapsedMs = Math.round(performance.now() - started);
    try { options.onAttempt?.({ ...attempt }); } catch { /* Observability cannot change user results. */ }
    return result;
  };
  let payload: unknown;
  try {
    const response = await (options.fetchImpl ?? fetch)(CLAUDE_MESSAGES_URL, {
      method: "POST", signal,
      headers: { "x-api-key": apiKey, "anthropic-version": CLAUDE_API_VERSION, "content-type": "application/json" },
      body: JSON.stringify(claudeRequestBody(input, system, schema, options)),
    });
    attempt.httpStatus = response.status;
    if (!response.ok) {
      attempt.errorClass = "HTTP_ERROR";
      await response.body?.cancel().catch(() => undefined);
      return finish({ ok: false, reason: response.status === 429 || response.status >= 500 ? "UNAVAILABLE" : "FAILED" });
    }
    payload = JSON.parse(await response.text());
  } catch (error) {
    const name = object(error) && typeof error.name === "string" ? error.name : null;
    attempt.errorClass = signal.aborted || name === "TimeoutError" ? "TIMEOUT" : attempt.httpStatus === null ? "NETWORK_FAILURE" : "INVALID_RESPONSE";
    return finish({ ok: false, reason: "UNAVAILABLE" });
  }
  if (!object(payload) || !Array.isArray(payload.content)) {
    attempt.errorClass = "INVALID_RESPONSE";
    return finish({ ok: false, reason: "INVALID_OUTPUT" });
  }
  attempt.stopReason = typeof payload.stop_reason === "string" ? payload.stop_reason.slice(0, 40) : null;
  if (object(payload.usage)) {
    attempt.inputTokens = tokenCount(payload.usage.input_tokens);
    attempt.outputTokens = tokenCount(payload.usage.output_tokens);
    attempt.cacheReadInputTokens = tokenCount(payload.usage.cache_read_input_tokens);
    attempt.cacheCreationInputTokens = tokenCount(payload.usage.cache_creation_input_tokens);
    if (object(payload.usage.output_tokens_details)) attempt.thinkingTokens = tokenCount(payload.usage.output_tokens_details.thinking_tokens);
  }
  // Only a finished answer counts: a cut-off answer can still parse, and a refusal need not follow the schema.
  if (payload.stop_reason !== "end_turn") {
    attempt.errorClass = payload.stop_reason === "max_tokens" ? "MAX_TOKENS" : payload.stop_reason === "refusal" ? "REFUSAL" : "INVALID_RESPONSE";
    return finish({ ok: false, reason: "INVALID_OUTPUT" });
  }
  // Thinking blocks (empty text by default) come first and are skipped: only the answer's text is the JSON.
  const text = payload.content.filter(block => object(block) && block.type === "text" && typeof block.text === "string")
    .map(block => (block as { text: string }).text).join("");
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    attempt.errorClass = text.trim() ? "STRUCTURED_PARSE_FAILURE" : "INVALID_RESPONSE";
    return finish({ ok: false, reason: "INVALID_OUTPUT" });
  }
  const parsed = validator.safeParse(value);
  if (!parsed.success) { attempt.errorClass = "SCHEMA_FAILURE"; return finish({ ok: false, reason: "INVALID_OUTPUT" }); }
  return finish({ ok: true, value: parsed.data });
}
