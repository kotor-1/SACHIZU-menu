/**
 * R12-A3G — MenuPlanner の production composition。
 *
 * この module は server-only composition だけを持つ。client request から
 * provider / model / catalog / subject / RuleSet / token material を受け取らず、
 * 既存の application use case と owner-scoped repository を接続する。
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  generateMenuPlannerPreview,
  type GenerateMenuPlannerPreviewDependencies,
  type GenerateMenuPlannerPreviewInput,
  type GenerateMenuPlannerPreviewOptions,
  type GenerateMenuPlannerPreviewResult,
  type MenuPlannerAuthoritativeParserContext,
  type MenuPlannerBeforePreviewContext,
  type MenuPlannerGenerateContextError,
} from "@/application/menu-planner/generate";
import {
  reviseMenuPlannerPreview,
  type ReviseMenuPlannerPreviewInput,
  type ReviseMenuPlannerPreviewResult,
} from "@/application/menu-planner/revise";
import {
  saveAiMenuDraft,
  type SaveAiMenuDraftResult,
} from "@/application/menu-planner/save";
import {
  exerciseCandidateDtoSchema,
  menuPlannerProviderRequestSchema,
  type MenuPlannerProviderRequest,
} from "@/domain/menu-planner";
import { runningMenuContextSchema, type RunningMenuContext } from "@/domain/running/persistence/menuContext";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { buildAiSafeSubjectContext } from "@/domain/running/readiness/aiSafeContext";
import { getActiveRuleSet } from "@/domain/running/rules/loader";
import { resolveSubjectProfile } from "@/domain/running/context/subject";
import type { Subject } from "@/domain/running/types/subject";
import { createOpenAiMenuIntentParser } from "@/infra/menu-planner/openai-menu-intent-parser";
import { prisma } from "@/infra/db/prisma";
import { listExercisesForMenuPlanner } from "@/infra/repositories/exercise-repository";
import { findMenuForOwner } from "@/infra/repositories/menu-repository";
import type { RevalidateMenuPlannerAcceptInput } from "@/application/menu-planner/accept";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { isRunningV2UiEnabled } from "@/lib/feature-flags";

/** Formal production flag from the R12 specification. Unset is disabled. */
export const MENU_PLANNER_FEATURE_ENV = "AI_MENU_PLANNER_ENABLED" as const;
export const MENU_PLANNER_OPEN20_ENV = "RUNNING_V2_OPEN20_COMPLETED" as const;

export function isMenuPlannerFeatureEnabled(): boolean {
  return process.env[MENU_PLANNER_FEATURE_ENV] === "true";
}

/**
 * Server-only attestation of the already-defined OPEN-20 procedure. This
 * value does not redefine that procedure; it only represents its completion
 * at the production boundary. Unset and every value other than exact "true"
 * remain incomplete.
 */
export function isMenuPlannerOpen20Completed(): boolean {
  return process.env[MENU_PLANNER_OPEN20_ENV] === "true";
}

type AuthoritativeContextError = MenuPlannerGenerateContextError;

function contextError(code: string, message: string): { ok: false; error: AuthoritativeContextError } {
  return {
    ok: false,
    error: { kind: "PLANNING_REJECTED", code, message },
  };
}

function productionGateError(code: string, message: string): { ok: false; error: AuthoritativeContextError } {
  return contextError(code, message);
}

function validateProposalBeforePreview({ containsRunning }: MenuPlannerBeforePreviewContext): AuthoritativeContextError | null {
  if (containsRunning && !isRunningV2UiEnabled()) {
    return {
      kind: "PLANNING_REJECTED",
      code: "RUNNING_V2_UI_REQUIRED",
      message: "Runningメニューは現在利用できません。",
    };
  }
  return null;
}

function subjectFromRunningContext(context: RunningMenuContext): Subject {
  return {
    kind: "GROUP",
    profile: {
      label: context.subject.label,
      members: context.subject.members.map((member) => ({
        birthDate: null,
        ageBandOverride: member.ageBandOverride,
        maturity: {
          status: member.maturity.status,
          confidence: member.maturity.confidence,
          method: member.maturity.method,
          assessedAt: member.maturity.assessedAt,
        },
        trainingAge: member.trainingAge,
        primaryEvent: member.primaryEvent,
      })),
      memberCountHint: context.subject.memberCountHint,
      availableMinutes: null,
      allowAdvancedMethods: context.subject.allowAdvancedMethods,
    },
  };
}

function exerciseCandidate(row: Awaited<ReturnType<typeof listExercisesForMenuPlanner>>[number]) {
  return exerciseCandidateDtoSchema.parse({
    id: row.id,
    name: row.name,
    category: row.category,
    purposes: row.purposes.map((purpose) => purpose.purpose),
    events: row.events.map((event) => event.event),
    equipmentTagIds: row.tags
      .filter((tag) => tag.tag.kind === "EQUIPMENT")
      .map((tag) => tag.tagId)
      .sort(),
  });
}

function buildCatalog(
  rows: Awaited<ReturnType<typeof listExercisesForMenuPlanner>>,
  ruleSet: ReturnType<typeof getActiveRuleSet>["ruleSet"],
): MenuPlannerProviderRequest["catalog"] {
  const equipmentById = new Map<string, string>();
  for (const row of rows) {
    for (const tag of row.tags) {
      if (tag.tag.kind === "EQUIPMENT") equipmentById.set(tag.tagId, tag.tag.name);
    }
  }

  const catalog = {
    // The application preview uses the reviewed subset as the selectable
    // Exercise catalog. The rows themselves remain server-owned and are never
    // forwarded to the provider.
    exercises: rows.filter((row) => row.status === "REVIEWED").map(exerciseCandidate),
    runningTemplates: ruleSet.templates.map((template) => ({
      method: template.method,
      templateId: template.id,
      label: template.labelJa,
    })),
    equipment: [...equipmentById.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, name]) => ({ id, name })),
  };

  const parsed = menuPlannerProviderRequestSchema.shape.catalog.safeParse(catalog);
  if (!parsed.success) throw new Error("AUTHORITATIVE_CATALOG_INVALID");
  return parsed.data;
}

/**
 * Build only the A3C-safe subject/catalog projection. This loader deliberately
 * does not include raw menu rows, history, competition rows, token claims, or
 * any deterministic numeric material in the provider request.
 */
async function loadAuthoritativeParserContext({
  ownerId,
  contextMenuTemplateId,
}: {
  ownerId: string;
  contextMenuTemplateId: string;
}): Promise<
  | { ok: true; context: MenuPlannerAuthoritativeParserContext }
  | { ok: false; error: AuthoritativeContextError }
> {
  let menu;
  try {
    menu = await findMenuForOwner(contextMenuTemplateId, ownerId);
  } catch {
    return contextError("CONTEXT_MENU_READ_FAILED", "計画の参照メニューを読み取れません。");
  }
  if (menu === null) return contextError("CONTEXT_MENU_UNAVAILABLE", "計画の参照メニューを確認できません。");

  const parsedContext = parseJsonColumn(menu.runningContextJson, runningMenuContextSchema, { rejectHealthKeys: true });
  if (!parsedContext.ok || parsedContext.value.subject.kind !== "GROUP") {
    return contextError("RUNNING_CONTEXT_UNAVAILABLE", "計画対象のグループ条件を確認できません。");
  }
  if (parsedContext.value.plannedDate === null) {
    return contextError("PLANNED_DATE_UNAVAILABLE", "計画日が設定された参照メニューを使用してください。");
  }

  let selectedRuleSet: ReturnType<typeof getActiveRuleSet>;
  let subject: Subject;
  let safeSubject: ReturnType<typeof buildAiSafeSubjectContext>;
  let rows: Awaited<ReturnType<typeof listExercisesForMenuPlanner>>;
  try {
    selectedRuleSet = getActiveRuleSet(parsedContext.value.plannedDate);
    if (selectedRuleSet.isDraftFallback) {
      return contextError("ACTIVE_RULESET_REQUIRED", "計画に必要なRuleSetがまだ有効化されていません。");
    }
    subject = subjectFromRunningContext(parsedContext.value);
    const profile = resolveSubjectProfile({
      subject,
      asOf: parsedContext.value.plannedDate,
      ruleSet: selectedRuleSet.ruleSet,
    });
    safeSubject = buildAiSafeSubjectContext({ profile, ruleSet: selectedRuleSet.ruleSet, decision: null });
    rows = await listExercisesForMenuPlanner(ownerId);
  } catch (error) {
    if (error instanceof z.ZodError || (error instanceof Error && error.message === "AUTHORITATIVE_CATALOG_INVALID")) {
      return contextError("AUTHORITATIVE_CONTEXT_INVALID", "計画に必要なserver contextを確認できません。");
    }
    return contextError("AUTHORITATIVE_CONTEXT_UNAVAILABLE", "計画に必要なserver contextを確認できません。");
  }

  let catalog: MenuPlannerProviderRequest["catalog"];
  try {
    catalog = buildCatalog(rows, selectedRuleSet.ruleSet);
  } catch {
    return contextError("AUTHORITATIVE_CATALOG_INVALID", "ExerciseとRunningのカタログを確認できません。");
  }

  const parsedSubject = menuPlannerProviderRequestSchema.shape.subject.safeParse(safeSubject);
  if (!parsedSubject.success) return contextError("AUTHORITATIVE_CONTEXT_INVALID", "計画に必要なserver contextを確認できません。");

  return {
    ok: true,
    context: {
      subject: parsedSubject.data,
      catalog,
    },
  };
}

function configuredTokenTtlMs(): number {
  const raw = process.env.MENU_PLANNER_ACCEPT_TOKEN_TTL_MS?.trim();
  if (raw === undefined || raw === "") return 2 * 60 * 60 * 1_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function productionDependencies(): GenerateMenuPlannerPreviewDependencies {
  return {
    parser: createOpenAiMenuIntentParser(),
    loadAuthoritativeParserContext,
    parserOptions: { timeoutMs: 30_000 },
    accept: {
      // No fallback secret is permitted. A missing/invalid value fails closed
      // inside the existing A3A issuer and never reaches a client response.
      signingKey: process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET ?? "",
      now: () => new Date(),
      tokenTtlMs: configuredTokenTtlMs(),
      generateId: () => randomUUID(),
    },
  };
}

export type MenuPlannerServerComposition = {
  generate: (
    input: GenerateMenuPlannerPreviewInput,
    options?: GenerateMenuPlannerPreviewOptions,
  ) => Promise<GenerateMenuPlannerPreviewResult>;
  revise: (input: ReviseMenuPlannerPreviewInput, options?: { signal?: AbortSignal }) => Promise<ReviseMenuPlannerPreviewResult>;
  save: (input: RevalidateMenuPlannerAcceptInput) => Promise<SaveAiMenuDraftResult>;
};

/**
 * The only production composition factory. Tests replace this server-internal
 * factory; no client input can inject parser, fetch, repository, or Prisma.
 */
export function createMenuPlannerProductionComposition(): MenuPlannerServerComposition {
  const dependencies = productionDependencies();
  const saveDependencies = { ...dependencies.accept, database: prisma };
  return {
    generate: async (input, options) => {
      if (!isMenuPlannerOpen20Completed()) {
        return productionGateError("OPEN20_REQUIRED", "本番利用に必要なOPEN-20手順が完了していません。");
      }
      return generateMenuPlannerPreview(
        { ...input, ownerId: DEFAULT_OWNER_ID },
        { ...dependencies, beforePreview: validateProposalBeforePreview },
        options,
      );
    },
    revise: async (input, options) => {
      if (!isMenuPlannerOpen20Completed()) {
        return productionGateError("OPEN20_REQUIRED", "本番利用に必要なOPEN-20手順が完了していません。");
      }
      return reviseMenuPlannerPreview(
        { ...input, ownerId: DEFAULT_OWNER_ID },
        { ...dependencies, beforePreview: validateProposalBeforePreview },
        options,
      );
    },
    save: async (input) => {
      // A3B owns token verification, existing-target idempotency, stale
      // revalidation, and atomic creation. Do not add a source preflight here:
      // it would break same-token retry and A3E's stale taxonomy.
      return saveAiMenuDraft(
        { ownerId: DEFAULT_OWNER_ID, token: input.token },
        saveDependencies,
      );
    },
  };
}
