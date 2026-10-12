import type { ZodType } from "zod";

export const RUNNING_SEMANTIC_CLIENT_DEFAULTS = {
  model: "gpt-6-luna", reasoningEffort: "low", timeoutMs: 20_000,
  maxOutputTokens: 3_000, maxRetries: 1,
} as const;

export type RunningResponseDiagnostic = {
  stage: string; attempt: number; httpStatus: number | null; contentType: string | null;
  model: string; effort: RunningSemanticClientOptions["reasoningEffort"];
  timeoutMs: number; maxOutputTokens: number; elapsedMs: number; retryNumber: number;
  responseBodyPresent: boolean | null; sdkParseFailure: false; truncation: boolean | null;
  bodyByteLength: number | null; jsonParseSuccess: boolean | null;
  structuredJsonParseSuccess: boolean | null; structuredSchemaSuccess: boolean | null;
  responseStatus: string | null; incompleteReason: string | null;
  usage: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null;
    reasoningTokens: number | null; totalTokens: number | null } | null;
  errorClass: string | null; errorName: string | null; networkErrorCode: string | null;
  emptyOutput: boolean | null; schemaFailure: boolean; retryable: boolean;
  other: "FETCH_FAILURE" | "BODY_READ_FAILURE" | "ENVELOPE_PARSE_FAILURE" |
    "STRUCTURED_PARSE_FAILURE" | "INVALID_RESPONSE_ENVELOPE" | "OUTPUT_REFUSAL" | "HTTP_ERROR" | null;
};

export type RunningSemanticClientOptions = {
  apiKey?: string; model?: string; fetchImpl?: typeof fetch;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number; maxOutputTokens?: number;
  maxRetries?: 0 | 1;
  /** Receives metadata only: no text, body, credentials, URL, or raw exceptions. */
  onAttempt?: (diagnostic: RunningResponseDiagnostic) => void;
};

export function runningSemanticClientConfig(options: RunningSemanticClientOptions = {}) {
  return {
    model: options.model ?? process.env.MENU_PLANNER_OPENAI_MODEL ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.model,
    reasoningEffort: options.reasoningEffort ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.reasoningEffort,
    timeoutMs: options.timeoutMs ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.timeoutMs,
    maxOutputTokens: options.maxOutputTokens ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.maxOutputTokens,
    maxRetries: options.maxRetries ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.maxRetries,
  };
}

type FailureReason = "UNAVAILABLE" | "FAILED" | "INVALID_OUTPUT";
type Result<T> = { ok: true; value: T } | { ok: false; reason: FailureReason };
const transientStatus = (status: number) => [408, 409, 429].includes(status) || status >= 500;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const tokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function responseMetadata(payload: unknown, diagnostic: RunningResponseDiagnostic) {
  if (!object(payload)) return;
  diagnostic.responseStatus = typeof payload.status === "string" && ["completed", "incomplete", "failed", "in_progress", "queued", "cancelled"].includes(payload.status)
    ? payload.status : null;
  if (object(payload.incomplete_details)) {
    diagnostic.incompleteReason = typeof payload.incomplete_details.reason === "string" && ["max_output_tokens", "content_filter"].includes(payload.incomplete_details.reason)
      ? payload.incomplete_details.reason : "UNKNOWN";
  }
  if (object(payload.usage)) {
    const usage = payload.usage;
    diagnostic.usage = { inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens),
      totalTokens: tokenCount(usage.total_tokens),
      cachedInputTokens: object(usage.input_tokens_details) ? tokenCount(usage.input_tokens_details.cached_tokens) : null,
      reasoningTokens: object(usage.output_tokens_details) ? tokenCount(usage.output_tokens_details.reasoning_tokens) : null };
  }
}

/** Allowlisted names/codes only. Exception messages, stacks and nested payloads never leave this boundary. */
function transportError(error: unknown, signal: AbortSignal, diagnostic: RunningResponseDiagnostic, bodyRead: boolean) {
  const name = object(error) && typeof error.name === "string" ? error.name : null;
  diagnostic.errorName = name && ["TimeoutError", "AbortError", "TypeError", "Error", "AggregateError"].includes(name) ? name : "UNKNOWN";
  const cause = object(error) && object(error.cause) ? error.cause : null;
  const code = cause?.code;
  diagnostic.networkErrorCode = typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND",
    "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"].includes(code) ? code : null;
  diagnostic.errorClass = signal.aborted || name === "TimeoutError" ? "TIMEOUT"
    : name === "AbortError" ? "ABORT" : bodyRead ? "BODY_READ_FAILURE"
      : diagnostic.networkErrorCode ? "NETWORK_FAILURE" : "FETCH_FAILURE";
}

function structuredText(payload: unknown, diagnostic: RunningResponseDiagnostic): string | null {
  if (!object(payload)) {
    diagnostic.other = "INVALID_RESPONSE_ENVELOPE";
    diagnostic.retryable = true;
    return null;
  }
  if (payload.status === "incomplete") {
    diagnostic.truncation = object(payload.incomplete_details) && payload.incomplete_details.reason === "max_output_tokens";
    diagnostic.other = "INVALID_RESPONSE_ENVELOPE";
    diagnostic.retryable = diagnostic.truncation;
    return null;
  }
  if (payload.status !== "completed" || !Array.isArray(payload.output)) {
    diagnostic.other = "INVALID_RESPONSE_ENVELOPE";
    diagnostic.retryable = payload.status === "failed" && object(payload.error) &&
      ["server_error", "rate_limit_exceeded"].includes(String(payload.error.code));
    return null;
  }
  diagnostic.truncation = false;
  const text: string[] = [];
  for (const item of payload.output) {
    if (!object(item) || item.type !== "message" || item.role !== "assistant") continue;
    if (!Array.isArray(item.content)) {
      diagnostic.other = "INVALID_RESPONSE_ENVELOPE";
      diagnostic.retryable = true;
      return null;
    }
    for (const part of item.content) {
      if (object(part) && part.type === "refusal") {
        diagnostic.other = "OUTPUT_REFUSAL";
        return null;
      }
      if (!object(part) || part.type !== "output_text" || typeof part.text !== "string") {
        diagnostic.other = "INVALID_RESPONSE_ENVELOPE";
        diagnostic.retryable = true;
        return null;
      }
      text.push(part.text);
    }
  }
  const joined = text.join("");
  diagnostic.emptyOutput = joined.trim().length === 0;
  if (diagnostic.emptyOutput) {
    diagnostic.retryable = true;
    return null;
  }
  return joined;
}

/** At most one recovery per API stage. Semantic verification is outside this boundary. */
export async function callRunningStructuredResponse<T>(
  input: unknown, instructions: string, schema: object, name: string,
  validator: ZodType<T>, options: RunningSemanticClientOptions,
): Promise<Result<T>> {
  const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY)?.trim();
  if (!apiKey) return { ok: false, reason: "UNAVAILABLE" };
  const config = runningSemanticClientConfig(options);
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 ||
    !Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) return { ok: false, reason: "FAILED" };
  const report = (diagnostic: RunningResponseDiagnostic) => {
    try { options.onAttempt?.({ ...diagnostic, usage: diagnostic.usage ? { ...diagnostic.usage } : null }); } catch { /* Observability cannot change user results. */ }
  };
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    const started = performance.now();
    const signal = AbortSignal.timeout(config.timeoutMs);
    const diagnostic: RunningResponseDiagnostic = {
      stage: name, attempt, httpStatus: null, contentType: null, responseBodyPresent: null,
      model: config.model, effort: config.reasoningEffort, timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens,
      elapsedMs: 0, retryNumber: attempt - 1, bodyByteLength: null, jsonParseSuccess: null,
      structuredJsonParseSuccess: null, structuredSchemaSuccess: null, responseStatus: null, incompleteReason: null,
      usage: null, errorClass: null, errorName: null, networkErrorCode: null,
      sdkParseFailure: false, truncation: null, emptyOutput: null, schemaFailure: false, retryable: false, other: null,
    };
    let result: Result<T> = { ok: false, reason: "INVALID_OUTPUT" };
    let response: Response | null = null;
    try {
      response = await (options.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ model: config.model, reasoning: { effort: config.reasoningEffort }, instructions,
          input: JSON.stringify(input), text: { format: { type: "json_schema", name, strict: true, schema } },
          store: false, max_output_tokens: config.maxOutputTokens }),
      });
    } catch (error) {
      diagnostic.other = "FETCH_FAILURE";
      transportError(error, signal, diagnostic, false);
      diagnostic.retryable = true;
      result = { ok: false, reason: "UNAVAILABLE" };
    }
    if (response) {
      diagnostic.httpStatus = response.status;
      // Store only the MIME type, excluding arbitrary header parameters.
      diagnostic.contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
      if (!response.ok) {
        diagnostic.other = "HTTP_ERROR";
        diagnostic.retryable = transientStatus(response.status);
        result = { ok: false, reason: diagnostic.retryable ? "UNAVAILABLE" : "FAILED" };
        await response.body?.cancel().catch(() => undefined);
      } else {
        let raw: string | null = null;
        try {
          const bytes = await response.arrayBuffer();
          diagnostic.bodyByteLength = bytes.byteLength;
          diagnostic.responseBodyPresent = bytes.byteLength > 0;
          raw = new TextDecoder().decode(bytes);
        } catch (error) {
          // A stream exists, but bytes may not have arrived. Do not claim a received body.
          diagnostic.other = "BODY_READ_FAILURE";
          transportError(error, signal, diagnostic, true);
          diagnostic.retryable = true;
        }
        if (raw !== null) {
          let payload: unknown;
          try { payload = JSON.parse(raw); diagnostic.jsonParseSuccess = true; } catch {
            diagnostic.jsonParseSuccess = false;
            diagnostic.other = "ENVELOPE_PARSE_FAILURE";
            diagnostic.emptyOutput = raw.trim().length === 0;
            diagnostic.retryable = true;
          }
          if (diagnostic.other === null) {
            responseMetadata(payload, diagnostic);
            const text = structuredText(payload, diagnostic);
            if (text !== null) {
              let value: unknown;
              try { value = JSON.parse(text); diagnostic.structuredJsonParseSuccess = true; } catch {
                diagnostic.structuredJsonParseSuccess = false;
                diagnostic.other = "STRUCTURED_PARSE_FAILURE";
                diagnostic.retryable = true;
              }
              if (diagnostic.other === null) {
                const parsed = validator.safeParse(value);
                diagnostic.structuredSchemaSuccess = parsed.success;
                diagnostic.schemaFailure = !parsed.success;
                diagnostic.retryable = !parsed.success;
                if (parsed.success) result = { ok: true, value: parsed.data };
              }
            }
          }
        }
      }
    }
    if (!result.ok && diagnostic.errorClass === null) {
      diagnostic.errorClass = diagnostic.schemaFailure ? "SCHEMA_FAILURE"
        : diagnostic.responseBodyPresent === false ? "EMPTY_BODY"
          : diagnostic.truncation ? "INCOMPLETE_MAX_OUTPUT"
            : diagnostic.responseStatus === "incomplete" ? "INCOMPLETE_OTHER"
              : diagnostic.emptyOutput ? "EMPTY_OUTPUT" : diagnostic.other;
    }
    diagnostic.elapsedMs = Math.round(performance.now() - started);
    report(diagnostic);
    if (result.ok || !diagnostic.retryable || attempt > config.maxRetries) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, reason: "UNAVAILABLE" };
}
