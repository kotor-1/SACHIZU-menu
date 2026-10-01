import type { ZodType } from "zod";

export const RUNNING_SEMANTIC_CLIENT_DEFAULTS = {
  model: "gpt-6-luna", reasoningEffort: "low", timeoutMs: 20_000,
  maxOutputTokens: 3_000, maxRetries: 1,
} as const;

export type RunningResponseDiagnostic = {
  stage: string; attempt: number; httpStatus: number | null; contentType: string | null;
  responseBodyPresent: boolean | null; sdkParseFailure: false; truncation: boolean | null;
  emptyOutput: boolean | null; schemaFailure: boolean; retryable: boolean;
  other: "FETCH_FAILURE" | "BODY_READ_FAILURE" | "ENVELOPE_PARSE_FAILURE" |
    "STRUCTURED_PARSE_FAILURE" | "INVALID_RESPONSE_ENVELOPE" | "OUTPUT_REFUSAL" | "HTTP_ERROR" | null;
};

export type RunningSemanticClientOptions = {
  apiKey?: string; model?: string; fetchImpl?: typeof fetch;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number; maxOutputTokens?: number;
  /** Receives metadata only: no text, body, credentials, URL, or raw exceptions. */
  onAttempt?: (diagnostic: RunningResponseDiagnostic) => void;
};

export function runningSemanticClientConfig(options: RunningSemanticClientOptions = {}) {
  return {
    model: options.model ?? process.env.MENU_PLANNER_OPENAI_MODEL ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.model,
    reasoningEffort: options.reasoningEffort ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.reasoningEffort,
    timeoutMs: options.timeoutMs ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.timeoutMs,
    maxOutputTokens: options.maxOutputTokens ?? RUNNING_SEMANTIC_CLIENT_DEFAULTS.maxOutputTokens,
    maxRetries: RUNNING_SEMANTIC_CLIENT_DEFAULTS.maxRetries,
  };
}

type FailureReason = "UNAVAILABLE" | "FAILED" | "INVALID_OUTPUT";
type Result<T> = { ok: true; value: T } | { ok: false; reason: FailureReason };
const transientStatus = (status: number) => [408, 409, 429].includes(status) || status >= 500;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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
    try { options.onAttempt?.({ ...diagnostic }); } catch { /* Observability cannot change user results. */ }
  };
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    const diagnostic: RunningResponseDiagnostic = {
      stage: name, attempt, httpStatus: null, contentType: null, responseBodyPresent: null,
      sdkParseFailure: false, truncation: null, emptyOutput: null, schemaFailure: false, retryable: false, other: null,
    };
    let result: Result<T> = { ok: false, reason: "INVALID_OUTPUT" };
    let response: Response | null = null;
    try {
      response = await (options.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({ model: config.model, reasoning: { effort: config.reasoningEffort }, instructions,
          input: JSON.stringify(input), text: { format: { type: "json_schema", name, strict: true, schema } },
          store: false, max_output_tokens: config.maxOutputTokens }),
      });
    } catch {
      diagnostic.other = "FETCH_FAILURE";
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
          raw = await response.text();
          diagnostic.responseBodyPresent = raw.length > 0;
        } catch {
          diagnostic.responseBodyPresent = response.body !== null;
          diagnostic.other = "BODY_READ_FAILURE";
          diagnostic.retryable = true;
        }
        if (raw !== null) {
          let payload: unknown;
          try { payload = JSON.parse(raw); } catch {
            diagnostic.other = "ENVELOPE_PARSE_FAILURE";
            diagnostic.emptyOutput = raw.trim().length === 0;
            diagnostic.retryable = true;
          }
          if (diagnostic.other === null) {
            const text = structuredText(payload, diagnostic);
            if (text !== null) {
              let value: unknown;
              try { value = JSON.parse(text); } catch {
                diagnostic.other = "STRUCTURED_PARSE_FAILURE";
                diagnostic.retryable = true;
              }
              if (diagnostic.other === null) {
                const parsed = validator.safeParse(value);
                diagnostic.schemaFailure = !parsed.success;
                diagnostic.retryable = !parsed.success;
                if (parsed.success) result = { ok: true, value: parsed.data };
              }
            }
          }
        }
      }
    }
    report(diagnostic);
    if (result.ok || !diagnostic.retryable || attempt > config.maxRetries) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, reason: "UNAVAILABLE" };
}
