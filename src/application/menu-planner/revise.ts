/**
 * R12-A3E — signed preview revision orchestration。
 *
 * verified accept-token
 *   -> authoritative A3A revalidation
 *   -> A3C safe revision request
 *   -> strict intent parser
 *   -> A2 deterministic preview + A3A signed token
 *
 * This module has no persistence, provider implementation, or save call. The
 * old token is never revoked or mutated; a successful revision returns a new
 * preview lineage and a newly issued token.
 */
import { z } from "zod";

import {
  MENU_PLANNER_SCHEMA_VERSION,
  type AiPlannerProposal,
} from "@/domain/menu-planner";
import {
  HMAC_TOKEN_MAX_LENGTH,
} from "@/infra/security/hmac-token";
import {
  verifyMenuPlannerAcceptToken,
  revalidateVerifiedMenuPlannerAccept,
  issueMenuPlannerSignedPreview,
  type MenuPlannerAcceptError,
} from "./accept";
import type {
  MenuIntentParserBoundaryError,
  MenuIntentParserApplicationResult,
} from "./intent-parser";
import {
  buildMenuIntentParserRequest,
  parseMenuIntent,
} from "./intent-parser";
import type {
  GenerateMenuPlannerPreviewDependencies,
  LoadMenuPlannerAuthoritativeParserContext,
  MenuPlannerGenerateContextError,
} from "./generate";
import type { MenuPlannerPreview } from "@/presentation/menu-planner/preview";

const reviseInputSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_SCHEMA_VERSION),
    /** trusted authenticated principal binding, supplied by server composition */
    ownerId: z.string().trim().min(1).max(120),
    acceptToken: z.string().trim().min(1).max(HMAC_TOKEN_MAX_LENGTH),
    revisionText: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type ReviseMenuPlannerPreviewInput = z.infer<typeof reviseInputSchema>;

export type ReviseMenuPlannerPreviewDependencies = GenerateMenuPlannerPreviewDependencies;

export type ReviseMenuPlannerPreviewResult =
  | {
      ok: true;
      result: {
        kind: "CLARIFICATION";
        question: NonNullable<AiPlannerProposal["question"]>;
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
  | {
      ok: false;
      error:
        | MenuPlannerGenerateContextError
        | MenuIntentParserBoundaryError
        | MenuPlannerAcceptError;
    };

function invalidInput(): Extract<ReviseMenuPlannerPreviewResult, { ok: false }> {
  return {
    ok: false,
    error: {
      kind: "INVALID_INPUT",
      code: "REVISE_INPUT_INVALID",
      message: "プレビュー修正の入力を確認できません。",
    },
  };
}

function safeRevalidationFailure(): Extract<ReviseMenuPlannerPreviewResult, { ok: false }> {
  return {
    ok: false,
    error: {
      kind: "PLANNING_REJECTED",
      code: "REVISION_REVALIDATION_FAILED",
      message: "現在のプレビューを確認できません。もう一度プレビューを作成してください。",
    },
  };
}

function safeParserFailure(): Extract<ReviseMenuPlannerPreviewResult, { ok: false }> {
  return {
    ok: false,
    error: {
      kind: "AI_PROVIDER_FAILED",
      code: "PROVIDER_EXCEPTION",
      message: "AIサービスで修正案を生成できません。",
    },
  };
}

function safeIssuerFailure(): Extract<ReviseMenuPlannerPreviewResult, { ok: false }> {
  return {
    ok: false,
    error: {
      kind: "PLANNING_REJECTED",
      code: "REVISE_PREVIEW_FAILED",
      message: "決定論的な修正プレビューを生成できません。",
    },
  };
}

/**
 * Claims contain a complete sanitized proposal, but the provider receives a
 * smaller selection-only projection. In particular, reason text, preview
 * materialization, and every numeric execution field are excluded.
 */
function previousSelectionFromSignedProposal(
  proposal: AiPlannerProposal,
): NonNullable<
  Parameters<typeof buildMenuIntentParserRequest>[0]["previousProposal"]
> {
  return {
    schemaVersion: MENU_PLANNER_SCHEMA_VERSION,
    items: proposal.items.map((item) =>
      item.kind === "EXERCISE"
        ? {
            kind: "EXERCISE" as const,
            exerciseId: item.proposal.exerciseId,
          }
        : {
            kind: "RUNNING" as const,
            method: item.proposal.method,
            templateId: item.proposal.templateId,
            positionPreference: item.proposal.positionPreference,
          },
    ),
  };
}

function parserFailure(
  error: MenuIntentParserBoundaryError,
): Extract<ReviseMenuPlannerPreviewResult, { ok: false }> {
  return { ok: false, error };
}

function contextFailure(
  error: MenuPlannerGenerateContextError,
): Extract<ReviseMenuPlannerPreviewResult, { ok: false }> {
  return { ok: false, error };
}

function acceptFailure(
  error: MenuPlannerAcceptError,
): Extract<ReviseMenuPlannerPreviewResult, { ok: false }> {
  return { ok: false, error };
}

/**
 * Revise one previously issued preview. Verification and stale revalidation
 * happen before the parser is allowed to run.
 */
export async function reviseMenuPlannerPreview(
  input: unknown,
  deps: ReviseMenuPlannerPreviewDependencies,
  options: { signal?: AbortSignal } = {},
): Promise<ReviseMenuPlannerPreviewResult> {
  const parsedInput = reviseInputSchema.safeParse(input);
  if (!parsedInput.success) return invalidInput();

  let verified;
  try {
    verified = verifyMenuPlannerAcceptToken(
      {
        token: parsedInput.data.acceptToken,
        ownerId: parsedInput.data.ownerId,
      },
      deps.accept,
    );
  } catch {
    return safeRevalidationFailure();
  }
  if (!verified.ok) return acceptFailure(verified.error);

  // This recomputes the old signed proposal against current authoritative
  // context. A stale result returns before the provider is ever invoked.
  let prior;
  try {
    prior = await revalidateVerifiedMenuPlannerAccept(verified.verified);
  } catch {
    return safeRevalidationFailure();
  }
  if (!prior.ok) return acceptFailure(prior.error);

  let loaded: Awaited<ReturnType<LoadMenuPlannerAuthoritativeParserContext>>;
  try {
    loaded = await deps.loadAuthoritativeParserContext({
      ownerId: verified.verified.ownerId,
      contextMenuTemplateId: verified.verified.claims.contextMenuTemplateId,
    });
  } catch {
    return contextFailure({
      kind: "PLANNING_REJECTED",
      code: "AUTHORITATIVE_CONTEXT_UNAVAILABLE",
      message: "計画に必要なserver contextを確認できません。",
    });
  }
  if (!loaded.ok) return contextFailure(loaded.error);

  const parserRequest = buildMenuIntentParserRequest({
    coachRequest: {
      schemaVersion: MENU_PLANNER_SCHEMA_VERSION,
      requestText: parsedInput.data.revisionText,
      constraints: verified.verified.claims.constraints,
    },
    subject: loaded.context.subject,
    catalog: loaded.context.catalog,
    previousProposal: previousSelectionFromSignedProposal(
      verified.verified.claims.proposal,
    ),
  });
  if (!parserRequest.ok) return parserFailure(parserRequest.error);

  let parsed: MenuIntentParserApplicationResult;
  try {
    parsed = await parseMenuIntent(deps.parser, parserRequest.request, {
      ...deps.parserOptions,
      signal: options.signal,
    });
  } catch {
    return safeParserFailure();
  }
  if (!parsed.ok) return parserFailure(parsed.error);

  if (parsed.proposal.question !== null) {
    return {
      ok: true,
      result: { kind: "CLARIFICATION", question: parsed.proposal.question },
    };
  }

  if (deps.beforePreview !== undefined) {
    let proposalGate: MenuPlannerGenerateContextError | null;
    try {
      // The gate sees only a frozen derived fact. The A3C proposal remains
      // detached from the hook and is passed unchanged to A2/A3A below.
      const beforePreviewContext = Object.freeze({
        containsRunning: parsed.proposal.items.some((item) => item.kind === "RUNNING"),
      });
      proposalGate = deps.beforePreview(beforePreviewContext);
    } catch {
      return {
        ok: false,
        error: {
          kind: "PLANNING_REJECTED",
          code: "PROPOSAL_GATE_FAILED",
          message: "提案を本番利用できる状態か確認できません。",
        },
      };
    }
    if (proposalGate !== null) return { ok: false, error: proposalGate };
  }

  let issued;
  try {
    issued = await issueMenuPlannerSignedPreview(
      {
        ownerId: verified.verified.ownerId,
        contextMenuTemplateId: verified.verified.claims.contextMenuTemplateId,
        menuName: verified.verified.claims.menuName,
        intent: parserRequest.request.coachRequest,
        proposal: parsed.proposal,
        // The only trusted target authority for a revision is the verified
        // prior token claim. This is server-internal and is not accepted by
        // the revision request schema.
        trustedTargetMenuId: verified.verified.claims.targetMenuId,
      },
      deps.accept,
    );
  } catch {
    return safeIssuerFailure();
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

export const reviseMenuPlanner = reviseMenuPlannerPreview;
