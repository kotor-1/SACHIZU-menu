import {
  MENU_INTENT_PARSER_SYSTEM_INSTRUCTIONS,
} from "@/application/menu-planner/intent-parser";
import {
  AI_CLARIFICATION_MISSING_FIELDS,
  MENU_PLANNER_SCHEMA_VERSION,
  menuPlannerProviderRequestSchema,
  type MenuPlannerProviderRequest,
} from "@/domain/menu-planner";
import { RUNNING_TRAINING_METHODS } from "@/domain/running/types/method";
import type {
  MenuIntentParser,
  MenuIntentParserResult,
} from "@/domain/menu-planner/port";

export const OPENAI_RESPONSES_ENDPOINT =
  "https://api.openai.com/v1/responses" as const;
export const OPENAI_MENU_INTENT_DEFAULT_MODEL = "gpt-5.6-luna" as const;
export const OPENAI_MENU_INTENT_MAX_OUTPUT_TOKENS = 2_048 as const;

type OpenAiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * This is an internal server composition option. It is not part of the
 * MenuIntentParser request and is never read from a client payload.
 */
export type OpenAiMenuIntentParserOptions = {
  apiKey?: string;
  model?: string;
  fetchImpl?: OpenAiFetch;
};

type JsonSchema = Record<string, unknown>;

type ExtractedOutput =
  | { ok: true; text: string }
  | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return isRecord(error) && error.name === "AbortError";
}

function failure(kind: Extract<MenuIntentParserResult, { ok: false }>["kind"]):
  Extract<MenuIntentParserResult, { ok: false }> {
  return { ok: false, kind };
}

function configuredApiKey(override: string | undefined): string | null {
  const value = override === undefined ? process.env.OPENAI_API_KEY : override;
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function configuredModel(override: string | undefined): string {
  const value =
    override === undefined
      ? process.env.MENU_PLANNER_OPENAI_MODEL
      : override;
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? OPENAI_MENU_INTENT_DEFAULT_MODEL
    : normalized;
}

function dynamicIdentitySchema(): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 64 };
}

function outputSchema(): JsonSchema {
  const exerciseItem: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["EXERCISE"] },
      proposal: {
        type: "object",
        additionalProperties: false,
        properties: {
          blockName: { type: "string", minLength: 1, maxLength: 80 },
          exerciseId: dynamicIdentitySchema(),
          reason: { type: "string", maxLength: 300 },
        },
        required: ["blockName", "exerciseId", "reason"],
      },
    },
    required: ["kind", "proposal"],
  };

  const runningItem: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["RUNNING"] },
      proposal: {
        type: "object",
        additionalProperties: false,
        properties: {
          blockName: { type: "string", minLength: 1, maxLength: 80 },
          method: { type: "string", enum: [...RUNNING_TRAINING_METHODS] },
          templateId: dynamicIdentitySchema(),
          positionPreference: {
            anyOf: [
              { type: "string", enum: ["LOWER", "MIDDLE"] },
              { type: "null" },
            ],
          },
          reason: { type: "string", maxLength: 300 },
        },
        required: [
          "blockName",
          "method",
          "templateId",
          "positionPreference",
          "reason",
        ],
      },
    },
    required: ["kind", "proposal"],
  };

  const clarification: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      missingField: {
        type: "string",
        enum: [...AI_CLARIFICATION_MISSING_FIELDS],
      },
      text: { type: "string", minLength: 1, maxLength: 200 },
      options: {
        type: "array",
        maxItems: 4,
        items: { type: "string", minLength: 1, maxLength: 80 },
      },
    },
    required: ["missingField", "text", "options"],
  };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { type: "integer", enum: [MENU_PLANNER_SCHEMA_VERSION] },
      items: {
        type: "array",
        maxItems: 20,
        items: { anyOf: [exerciseItem, runningItem] },
      },
      question: { anyOf: [clarification, { type: "null" }] },
    },
    required: ["schemaVersion", "items", "question"],
  };
}

function buildRequestBody(
  request: MenuPlannerProviderRequest,
  model: string,
): Record<string, unknown> | null {
  const parsed = menuPlannerProviderRequestSchema.safeParse(request);
  if (!parsed.success) return null;

  return {
    model,
    reasoning: { effort: "low" },
    instructions: MENU_INTENT_PARSER_SYSTEM_INSTRUCTIONS,
    input: JSON.stringify(parsed.data),
    text: {
      format: {
        type: "json_schema",
        name: "menu_intent_parser_result",
        strict: true,
        schema: outputSchema(),
      },
    },
    store: false,
    max_output_tokens: OPENAI_MENU_INTENT_MAX_OUTPUT_TOKENS,
  };
}

function statusFailure(status: number): Extract<
  MenuIntentParserResult,
  { ok: false }
> {
  if (status === 429 || status >= 500) return failure("UNAVAILABLE");
  return failure("FAILED");
}

function extractOutputText(payload: unknown): ExtractedOutput {
  if (!isRecord(payload) || payload.status !== "completed") return { ok: false };
  if (!Array.isArray(payload.output)) return { ok: false };

  let assistantMessageCount = 0;
  let outputText: string | undefined;

  for (const item of payload.output) {
    if (!isRecord(item) || typeof item.type !== "string") {
      return { ok: false };
    }

    // Reasoning items are provider-internal and are intentionally discarded.
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant") {
      return { ok: false };
    }

    assistantMessageCount += 1;
    if (!Array.isArray(item.content)) return { ok: false };
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "output_text") {
        // Refusal, tool, and any other content is not a proposal payload.
        return { ok: false };
      }
      if (typeof content.text !== "string" || outputText !== undefined) {
        return { ok: false };
      }
      outputText = content.text;
    }
  }

  return assistantMessageCount === 1 && outputText !== undefined
    ? { ok: true, text: outputText }
    : { ok: false };
}

/**
 * OpenAI Responses API transport adapter for the existing MenuIntentParser
 * port. It does not validate proposal semantics, build previews, sign tokens,
 * or persist anything; parseMenuIntent remains the application authority.
 */
export function createOpenAiMenuIntentParser(
  options: OpenAiMenuIntentParserOptions = {},
): MenuIntentParser {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async propose(request, requestOptions = {}) {
      const apiKey = configuredApiKey(options.apiKey);
      if (apiKey === null) return failure("UNAVAILABLE");
      if (requestOptions.signal?.aborted) return failure("ABORTED");

      const body = buildRequestBody(request, configuredModel(options.model));
      if (body === null) return failure("FAILED");

      let response: Response;
      try {
        response = await fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: requestOptions.signal,
        });
      } catch (error) {
        return failure(
          isAbortError(error, requestOptions.signal)
            ? "ABORTED"
            : "UNAVAILABLE",
        );
      }

      if (!response.ok) return statusFailure(response.status);

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return failure("FAILED");
      }

      const extracted = extractOutputText(payload);
      return extracted.ok
        ? { ok: true, output: extracted.text }
        : failure("FAILED");
    },
  };
}
