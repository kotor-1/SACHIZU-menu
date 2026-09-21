/**
 * R12-A3D — MenuPlanner の generate application orchestration。
 *
 * この module は provider / client / persistence の境界を接続するだけで、
 * 決定論的な処方計算や token の署名を複製しない。
 *
 *   trusted request
 *   -> server-composed safe parser context
 *   -> A3C strict parser boundary
 *   -> clarification short-circuit
 *   -> A2 deterministic preview + A3A token issuer
 *
 * `loadAuthoritativeParserContext` と `ownerId` は server composition が認証済み
 * principal / owner-scoped repository から注入する。client が provider request、
 * Prisma row、subject、catalog、provider metadata を authority にする入口は持たない。
 *
 * Server Action / route / real provider adapter はこの phase の責務ではない。
 */
import { z } from "zod";

import type {
  MenuIntentParser,
  MenuPlannerProviderRequest,
} from "@/domain/menu-planner";
import type { AiClarificationQuestion } from "@/domain/menu-planner/contracts";
import {
  buildMenuIntentParserRequest,
  parseMenuIntent,
  type MenuIntentParserApplicationResult,
  type MenuIntentParserBoundaryError,
  type ParseMenuIntentOptions,
} from "./intent-parser";
import {
  issueMenuPlannerSignedPreview,
  type IssueMenuPlannerSignedPreviewResult,
  type MenuPlannerAcceptDependencies,
  type MenuPlannerAcceptError,
} from "./accept";
import type { MenuPlannerPreview } from "@/presentation/menu-planner/preview";

const generateInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** server-authenticated owner binding; never take this from an untrusted body */
    ownerId: z.string().trim().min(1).max(120),
    contextMenuTemplateId: z.string().trim().min(1).max(64),
    menuName: z.string().trim().min(1).max(120),
    coachRequest: z.unknown(),
  })
  .strict();

export type GenerateMenuPlannerPreviewInput = z.infer<typeof generateInputSchema>;

/**
 * A3D receives only the already reduced A3C provider context. The loader that
 * creates this value is server-side and must apply the owner scope itself.
 */
export type MenuPlannerAuthoritativeParserContext = Pick<
  MenuPlannerProviderRequest,
  "subject" | "catalog"
>;

export type MenuPlannerGenerateContextError = {
  kind: "INVALID_INPUT" | "PLANNING_REJECTED";
  code: string;
  message: string;
};

export type LoadMenuPlannerAuthoritativeParserContext = (input: {
  ownerId: string;
  contextMenuTemplateId: string;
}) => Promise<
  | { ok: true; context: MenuPlannerAuthoritativeParserContext }
  | { ok: false; error: MenuPlannerGenerateContextError }
>;

export type GenerateMenuPlannerPreviewDependencies = {
  parser: MenuIntentParser;
  /** Server-owned repository composition; no client/provider context is accepted here. */
  loadAuthoritativeParserContext: LoadMenuPlannerAuthoritativeParserContext;
  parserOptions: Pick<ParseMenuIntentOptions, "timeoutMs" | "maxOutputBytes">;
  accept: MenuPlannerAcceptDependencies;
};

export type GenerateMenuPlannerPreviewOptions = {
  signal?: AbortSignal;
};

export type MenuPlannerGenerateError =
  | MenuPlannerGenerateContextError
  | MenuIntentParserBoundaryError
  | MenuPlannerAcceptError;

export type GenerateMenuPlannerPreviewResult =
  | {
      ok: true;
      result: {
        kind: "CLARIFICATION";
        question: AiClarificationQuestion;
      };
    }
  | {
      ok: true;
      result: {
        kind: "PREVIEW";
        preview: MenuPlannerPreview;
        acceptToken: string | null;
      };
    }
  | { ok: false; error: MenuPlannerGenerateError };

function invalidGenerateInput(): { ok: false; error: MenuPlannerGenerateContextError } {
  return {
    ok: false,
    error: {
      kind: "INVALID_INPUT",
      code: "GENERATE_INPUT_INVALID",
      message: "メニュー生成の入力を確認できません。",
    },
  };
}

function authoritativeContextFailure(): {
  ok: false;
  error: MenuPlannerGenerateContextError;
} {
  return {
    ok: false,
    error: {
      kind: "PLANNING_REJECTED",
      code: "AUTHORITATIVE_CONTEXT_UNAVAILABLE",
      message: "計画に必要なserver contextを確認できません。",
    },
  };
}

function parserFailure(error: MenuIntentParserBoundaryError): {
  ok: false;
  error: MenuIntentParserBoundaryError;
} {
  return { ok: false, error };
}

function acceptFailure(error: MenuPlannerAcceptError): {
  ok: false;
  error: MenuPlannerAcceptError;
} {
  return { ok: false, error };
}

/**
 * A3D の唯一の generate application entry point。
 *
 * parser は1回、proposal の deterministic preview は既存 A3A issuer 内で1回、
 * token は preview が saveable かつ成功した後だけ発行される。clarification は
 * question DTO だけを返して直ちに終了する。
 */
export async function generateMenuPlannerPreview(
  input: unknown,
  deps: GenerateMenuPlannerPreviewDependencies,
  options: GenerateMenuPlannerPreviewOptions = {},
): Promise<GenerateMenuPlannerPreviewResult> {
  const parsedInput = generateInputSchema.safeParse(input);
  if (!parsedInput.success) return invalidGenerateInput();

  let loaded: Awaited<ReturnType<LoadMenuPlannerAuthoritativeParserContext>>;
  try {
    loaded = await deps.loadAuthoritativeParserContext({
      ownerId: parsedInput.data.ownerId,
      contextMenuTemplateId: parsedInput.data.contextMenuTemplateId,
    });
  } catch {
    return authoritativeContextFailure();
  }
  if (!loaded.ok) return loaded;

  const parserRequest = buildMenuIntentParserRequest({
    // The generate boundary intentionally accepts unknown client input. The
    // A3C builder performs the runtime schema validation before this value can
    // enter the provider request.
    coachRequest: parsedInput.data.coachRequest as MenuPlannerProviderRequest["coachRequest"],
    subject: loaded.context.subject,
    catalog: loaded.context.catalog,
  });
  if (!parserRequest.ok) return parserFailure(parserRequest.error);

  let parsed: MenuIntentParserApplicationResult;
  try {
    parsed = await parseMenuIntent(deps.parser, parserRequest.request, {
      ...deps.parserOptions,
      signal: options.signal,
    });
  } catch {
    // The A3C parser normally contains provider exceptions. Keep this outer
    // boundary safe if a custom composition implementation violates the port.
    return {
      ok: false,
      error: {
        kind: "AI_PROVIDER_FAILED",
        code: "PROVIDER_EXCEPTION",
        message: "AIサービスで提案を生成できません。",
      },
    };
  }
  if (!parsed.ok) return parserFailure(parsed.error);

  if (parsed.proposal.question !== null) {
    // No A2 call, token issuer, raw proposal, or persistence on clarification.
    return {
      ok: true,
      result: { kind: "CLARIFICATION", question: parsed.proposal.question },
    };
  }

  let issued: IssueMenuPlannerSignedPreviewResult;
  try {
    issued = await issueMenuPlannerSignedPreview(
      {
        ownerId: parsedInput.data.ownerId,
        contextMenuTemplateId: parsedInput.data.contextMenuTemplateId,
        menuName: parsedInput.data.menuName,
        // A3C already canonicalized and strictly validated this request.
        intent: parserRequest.request.coachRequest,
        // A3C already returned the only accepted, sanitized proposal shape.
        proposal: parsed.proposal,
      },
      deps.accept,
    );
  } catch {
    // Do not expose crypto, database, stack, or provider implementation details.
    return {
      ok: false,
      error: {
        kind: "PLANNING_REJECTED",
        code: "GENERATE_PREVIEW_FAILED",
        message: "決定論的なプレビューを生成できません。",
      },
    };
  }
  if (!issued.ok) return acceptFailure(issued.error);

  return {
    ok: true,
    result: {
      kind: "PREVIEW",
      preview: issued.signed.preview,
      acceptToken: issued.signed.acceptToken,
    },
  };
}

/** A named alias for compositions that use “generate” as the application verb. */
export const generateMenuPlanner = generateMenuPlannerPreview;
