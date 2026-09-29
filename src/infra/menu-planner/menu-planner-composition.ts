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
  MENU_PLANNER_INLINE_CONTEXT_SOURCE_ID,
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
  inlineRunningContextJson,
}: {
  ownerId: string;
  contextMenuTemplateId: string;
  inlineRunningContextJson?: string;
}): Promise<
  | { ok: true; context: MenuPlannerAuthoritativeParserContext }
  | { ok: false; error: AuthoritativeContextError }
> {
  // [R12 unified composer] 参照メニューを持たない新規メニュー。context はコーチの入力（preview と同じ JSON）。
  const isInline = contextMenuTemplateId === MENU_PLANNER_INLINE_CONTEXT_SOURCE_ID;
  if (isInline !== (inlineRunningContextJson !== undefined)) {
    return contextError("RUNNING_CONTEXT_UNAVAILABLE", "計画対象のグループ条件を確認できません。");
  }
  if (inlineRunningContextJson !== undefined) return buildParserContextFromRunningContext(ownerId, inlineRunningContextJson);

  let menu;
  try {
    menu = await findMenuForOwner(contextMenuTemplateId, ownerId);
  } catch {
    return contextError("CONTEXT_MENU_READ_FAILED", "計画の参照メニューを読み取れません。");
  }
  if (menu === null) return contextError("CONTEXT_MENU_UNAVAILABLE", "計画の参照メニューを確認できません。");
  return buildParserContextFromRunningContext(ownerId, menu.runningContextJson);
}

/**
 * [R12 unified composer] 参照メニューを介さず、running context JSON から直接 A3C-safe な
 * subject/catalog projection を作る（新規メニューの AI 生成用）。
 */
export async function buildParserContextFromRunningContext(
  ownerId: string,
  runningContextJson: string | null,
): Promise<
  | { ok: true; context: MenuPlannerAuthoritativeParserContext }
  | { ok: false; error: AuthoritativeContextError }
> {
  const parsedContext = parseJsonColumn(runningContextJson, runningMenuContextSchema, { rejectHealthKeys: true });
  if (!parsedContext.ok || parsedContext.value.subject.kind !== "GROUP") {
    return contextError("RUNNING_CONTEXT_UNAVAILABLE", "計画対象のグループ条件を確認できません。");
  }
  if (parsedContext.value.plannedDate === null) {
    return contextError("PLANNED_DATE_UNAVAILABLE", "計画日が設定されたメニューにしてください。");
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

/**
 * [R12 unified composer] 参照メニューを介さず、コーチが入力した running context で AI 生成する。
 * `contextMenuTemplateId` は inline sentinel。OPEN20 / proposal gate / A3A 署名は既存 generate と同じ経路。
 * AI 生成の時点では何も保存しない（MenuTemplate は保存 Action で初めて作る）。
 */
export async function generateMenuDraftFromRunningContext(input: {
  menuName: string;
  runningContextJson: string;
  coachRequest: unknown;
}): Promise<GenerateMenuPlannerPreviewResult> {
  if (!isMenuPlannerOpen20Completed()) {
    return productionGateError("OPEN20_REQUIRED", "本番利用に必要なOPEN-20手順が完了していません。");
  }
  const dependencies = productionDependencies();
  return generateMenuPlannerPreview(
    {
      schemaVersion: 1,
      ownerId: DEFAULT_OWNER_ID,
      contextMenuTemplateId: MENU_PLANNER_INLINE_CONTEXT_SOURCE_ID,
      menuName: input.menuName,
      coachRequest: input.coachRequest,
      inlineRunningContextJson: input.runningContextJson,
    },
    {
      ...dependencies,
      // Composer's signed legacy branch now handles Exercise-only requests.
      // Old Running templates remain available to legacy screens, but never
      // enter this Composer provider request or its new Running preview path.
      loadAuthoritativeParserContext: async (request) => {
        const loaded = await dependencies.loadAuthoritativeParserContext(request);
        if (!loaded.ok) return loaded;
        return { ok: true as const, context: { ...loaded.context, catalog: { ...loaded.context.catalog, runningTemplates: [] } } };
      },
      beforePreview: validateProposalBeforePreview,
    },
  );
}

/**
 * [R12 unified composer] 署名済み preview を保存する（A3B の検証・TOCTOU 再計算・freshness gate をそのまま通す）。
 * inline context は client の再送値だが authority ではない：再計算した contextFingerprint が
 * 署名済みの値と違えば STALE で拒否される。AI 項目の id は dry-run と一致させるため決定的に採番する。
 * ambient transaction の中で呼ばれた場合は、その transaction に合流する。
 */
export async function saveSignedMenuDraftForComposer(input: {
  token: string;
  inlineRunningContextJson: string | null;
}): Promise<SaveAiMenuDraftResult> {
  // 既存 save と同じく OPEN20 gate は token 発行（generate）側。署名済み token が無ければここへ来ない。
  return saveAiMenuDraft(
    {
      ownerId: DEFAULT_OWNER_ID,
      token: input.token,
      ...(input.inlineRunningContextJson !== null ? { inlineRunningContextJson: input.inlineRunningContextJson } : {}),
    },
    { ...productionDependencies().accept, database: prisma, deterministicItemIds: true },
  );
}
