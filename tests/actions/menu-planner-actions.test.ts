import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const composition = vi.hoisted(() => ({
  generate: vi.fn(),
  revise: vi.fn(),
  save: vi.fn(),
}));

const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/infra/menu-planner/menu-planner-composition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/infra/menu-planner/menu-planner-composition")>();
  return {
    ...actual,
    createMenuPlannerProductionComposition: () => composition,
  };
});

vi.mock("next/cache", () => ({ revalidatePath }));

import {
  generateMenuPlannerAction,
  reviseMenuPlannerAction,
  saveMenuPlannerAction,
} from "@/actions/menu-planner-actions";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { prisma } from "@/infra/db/prisma";
import { verifyHmacToken } from "@/infra/security/hmac-token";
import { resetDb } from "../helpers";

const previousFlag = process.env.AI_MENU_PLANNER_ENABLED;

function generateInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    contextMenuTemplateId: "source-menu",
    menuName: "テストメニュー",
    coachRequest: {
      schemaVersion: 1,
      requestText: "加速のメニュー",
      constraints: {
        phase: null,
        targetEvents: [],
        purposes: [],
        availableMinutes: null,
        equipment: null,
        preferredExerciseIds: [],
        excludedExerciseIds: [],
      },
    },
    ...overrides,
  };
}

function reviseInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    acceptToken: "opaque-signed-token",
    revisionText: "加速ドリルを優先してください",
    ...overrides,
  };
}

describe("R12-A3G MenuPlanner Server Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AI_MENU_PLANNER_ENABLED;
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.AI_MENU_PLANNER_ENABLED;
    else process.env.AI_MENU_PLANNER_ENABLED = previousFlag;
  });

  it.each([undefined, "false", "0", "TRUE", "unexpected"])(
    "keeps the feature disabled for an unenabled flag value: %s",
    async (flag) => {
      if (flag === undefined) delete process.env.AI_MENU_PLANNER_ENABLED;
      else process.env.AI_MENU_PLANNER_ENABLED = flag;

    const result = await generateMenuPlannerAction(generateInput());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "FEATURE_DISABLED",
        code: "FEATURE_DISABLED",
        message: "この機能はまだ有効になっていません。",
      },
    });
    expect(composition.generate).not.toHaveBeenCalled();
    expect(composition.revise).not.toHaveBeenCalled();
    expect(composition.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    "catalog",
    "subject",
    "ruleSet",
    "provider",
    "model",
    "ownerId",
    "targetMenuId",
    "previewId",
    "materializationDigest",
    "contextFingerprint",
  ])("rejects client trusted-context injection: %s", async (field) => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";

    const result = await generateMenuPlannerAction(generateInput({ [field]: "client-authority" }));

    expect(result).toMatchObject({ ok: false, error: { kind: "INVALID_INPUT" } });
    expect(composition.generate).not.toHaveBeenCalled();
  });

  it("passes only the strict generate contract to the server composition", async () => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    composition.generate.mockResolvedValue({
      ok: true,
      result: {
        kind: "CLARIFICATION",
        question: { missingField: "PURPOSE", text: "目的を教えてください。", options: [] },
      },
    });

    const input = generateInput();
    const result = await generateMenuPlannerAction(input);

    expect(result).toEqual(await composition.generate.mock.results[0]?.value);
    expect(composition.generate).toHaveBeenCalledWith({ ...input, ownerId: DEFAULT_OWNER_ID });
  });

  it("keeps revision prior state token-only and rejects previousProposal/preview input", async () => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";

    const invalid = await reviseMenuPlannerAction(reviseInput({ previousProposal: { items: [] } }));
    expect(invalid).toMatchObject({ ok: false, error: { kind: "INVALID_INPUT" } });
    expect(composition.revise).not.toHaveBeenCalled();

    composition.revise.mockResolvedValue({
      ok: true,
      result: {
        kind: "CLARIFICATION",
        question: { missingField: "REQUEST_DETAIL", text: "条件を教えてください。", options: [] },
      },
    });
    const valid = reviseInput();
    await reviseMenuPlannerAction(valid);
    expect(composition.revise).toHaveBeenCalledWith({ ...valid, ownerId: DEFAULT_OWNER_ID });
  });

  it("accepts only owner binding plus opaque acceptToken for save", async () => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    const invalid = await saveMenuPlannerAction({
      ownerId: DEFAULT_OWNER_ID,
      acceptToken: "token",
      preview: { targetMenuId: "client-draft" },
    });
    expect(invalid).toMatchObject({ ok: false, error: { kind: "INVALID_INPUT" } });
    expect(composition.save).not.toHaveBeenCalled();

    composition.save.mockResolvedValue({ ok: true, menuId: "target-1", status: "DRAFT", alreadySaved: false });
    const valid = { acceptToken: "opaque-token" };
    const result = await saveMenuPlannerAction(valid);

    expect(result).toEqual({ ok: true, menuId: "target-1", status: "DRAFT", alreadySaved: false });
    expect(composition.save).toHaveBeenCalledWith({ ownerId: DEFAULT_OWNER_ID, token: "opaque-token" });
    expect(revalidatePath).toHaveBeenCalledWith("/menus");
    expect(revalidatePath).toHaveBeenCalledWith("/menus/target-1");
  });

  it("does not leak an unexpected composition exception", async () => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    composition.generate.mockRejectedValue(new Error("OPENAI_API_KEY / stack / prisma://secret"));

    const result = await generateMenuPlannerAction(generateInput());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "PLANNING_REJECTED",
        code: "PRODUCTION_COMPOSITION_FAILED",
        message: "メニューを生成できませんでした。",
      },
    });
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result)).not.toContain("prisma://secret");
  });
});

/**
 * These tests deliberately use the real A3G composition and A3D/A3E/A3B
 * application paths. Only the OpenAI transport is replaced, so action-boundary
 * gates, token claims, stale replay, and atomic save semantics remain real.
 */
describe("R12-A3G production composition integration", () => {
  const signingKey = "a3g-integration-signing-key-0123456789-abcdef";
  let ruleSetMode: "ACTIVE" | "DRAFT" | "MISSING" = "ACTIVE";
  let actions: typeof import("@/actions/menu-planner-actions");
  let providerOutput: unknown;
  let providerCalls = 0;
  const environmentNames = [
    "AI_MENU_PLANNER_ENABLED",
    "RUNNING_V2_OPEN20_COMPLETED",
    "RUNNING_V2_UI_ENABLED",
    "OPENAI_API_KEY",
    "MENU_PLANNER_ACCEPT_TOKEN_SECRET",
  ] as const;
  let originalEnvironment: Partial<Record<(typeof environmentNames)[number], string | undefined>>;

  vi.doMock("@/domain/running/rules/loader", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/domain/running/rules/loader")>();
    return {
      ...actual,
      getActiveRuleSet: (date: string) => {
        if (ruleSetMode === "MISSING") throw new Error("RULESET_UNAVAILABLE");
        const selected = actual.getActiveRuleSet(date);
        return ruleSetMode === "ACTIVE"
          ? { ...selected, isDraftFallback: false, ruleSet: { ...selected.ruleSet, status: "ACTIVE" } }
          : { ...selected, isDraftFallback: true, ruleSet: { ...selected.ruleSet, status: "DRAFT" } };
      },
    };
  });

  beforeAll(async () => {
    originalEnvironment = Object.fromEntries(
      environmentNames.map((name) => [name, process.env[name]]),
    );
    vi.doUnmock("@/infra/menu-planner/menu-planner-composition");
    vi.resetModules();
    actions = await import("@/actions/menu-planner-actions");
  });

  beforeEach(async () => {
    await resetDb();
    ruleSetMode = "ACTIVE";
    providerOutput = null;
    providerCalls = 0;
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    process.env.RUNNING_V2_OPEN20_COMPLETED = "true";
    process.env.RUNNING_V2_UI_ENABLED = "false";
    process.env.OPENAI_API_KEY = "a3g-test-key";
    process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = signingKey;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(providerOutput) }],
        }],
      }), { status: 200 });
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    for (const name of environmentNames) {
      const value = originalEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await prisma.$disconnect();
  });

  function runningContext() {
    return {
      schemaVersion: 1,
      subject: {
        kind: "GROUP",
        label: "短距離ブロック",
        members: [{
          ageBandOverride: "U18",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: "2026-09-01" },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
          primaryEvent: "400m",
        }],
        allowAdvancedMethods: true,
      },
      plannedDate: "2026-09-20",
      plannedAt: "2026-09-20T16:00:00+09:00",
      availableMinutes: 180,
    };
  }

  async function fixture() {
    const exercise = await prisma.exercise.create({
      data: {
        ownerId: DEFAULT_OWNER_ID,
        name: "A3G監査ドリル",
        category: "WARM_UP",
        metricType: "DISTANCE",
        status: "REVIEWED",
        defaultSets: 3,
        defaultDistanceMeters: 30,
      },
    });
    const revisedExercise = await prisma.exercise.create({
      data: {
        ownerId: DEFAULT_OWNER_ID,
        name: "A3G修正ドリル",
        category: "WARM_UP",
        metricType: "DISTANCE",
        status: "REVIEWED",
        defaultSets: 2,
        defaultDistanceMeters: 20,
      },
    });
    const source = await prisma.menuTemplate.create({
      data: {
        ownerId: DEFAULT_OWNER_ID,
        name: "A3G参照メニュー",
        phase: "PREPARATION",
        runningContextJson: JSON.stringify(runningContext()),
      },
    });
    return { exercise, revisedExercise, source };
  }

  function request(sourceId: string) {
    return {
      schemaVersion: 1,
      contextMenuTemplateId: sourceId,
      menuName: "A3Gテストメニュー",
      coachRequest: {
        schemaVersion: 1,
        requestText: "ドリルの練習メニューを作成",
        constraints: {
          phase: "PREPARATION",
          targetEvents: [],
          purposes: [],
          availableMinutes: null,
          equipment: null,
          preferredExerciseIds: [],
          excludedExerciseIds: [],
        },
      },
    };
  }

  function exerciseProposal(exerciseId: string) {
    return {
      schemaVersion: 1,
      items: [{ kind: "EXERCISE", proposal: {
        blockName: "ドリル",
        exerciseId,
        reason: "動作の準備を整えるため",
      } }],
      question: null,
    };
  }

  function runningProposal() {
    return {
      schemaVersion: 1,
      items: [{ kind: "RUNNING", proposal: {
        blockName: "主運動",
        method: "ACCELERATION",
        templateId: "ACC_BLOCK_20",
        positionPreference: null,
        reason: "加速の質を確認するため",
      } }],
      question: null,
    };
  }

  function hybridProposal(exerciseId: string) {
    return {
      schemaVersion: 1,
      items: [...exerciseProposal(exerciseId).items, ...runningProposal().items],
      question: null,
    };
  }

  function claims(token: string) {
    const verified = verifyHmacToken(token, signingKey);
    if (!verified.ok) throw new Error("token did not verify");
    return JSON.parse(verified.payload) as {
      ownerId: string;
      previewId: string;
      targetMenuId: string;
      savedDraftIdentityDigest: string;
    };
  }

  async function generateFor(sourceId: string, output: unknown = undefined) {
    providerOutput = output ?? providerOutput;
    const result = await actions.generateMenuPlannerAction(request(sourceId));
    return result;
  }

  it("enforces AI flag, independent OPEN20, and ACTIVE RuleSet gates before provider", async () => {
    const { exercise, source } = await fixture();
    providerOutput = exerciseProposal(exercise.id);

    delete process.env.AI_MENU_PLANNER_ENABLED;
    expect(await generateFor(source.id)).toMatchObject({ ok: false, error: { kind: "FEATURE_DISABLED" } });
    expect(providerCalls).toBe(0);

    process.env.AI_MENU_PLANNER_ENABLED = "true";
    for (const value of [undefined, "false", "0", "TRUE", "yes", "garbage"]) {
      if (value === undefined) delete process.env.RUNNING_V2_OPEN20_COMPLETED;
      else process.env.RUNNING_V2_OPEN20_COMPLETED = value;
      expect(await generateFor(source.id)).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED", code: "OPEN20_REQUIRED" } });
    }
    expect(providerCalls).toBe(0);

    process.env.RUNNING_V2_OPEN20_COMPLETED = "true";
    ruleSetMode = "DRAFT";
    expect(await generateFor(source.id)).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED", code: "ACTIVE_RULESET_REQUIRED" } });
    expect(providerCalls).toBe(0);

    ruleSetMode = "MISSING";
    expect(await generateFor(source.id)).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED" } });
    expect(providerCalls).toBe(0);

    ruleSetMode = "ACTIVE";
    const allowed = await generateFor(source.id);
    expect(allowed).toMatchObject({ ok: true, result: { kind: "PREVIEW", acceptToken: expect.any(String) } });
    expect(providerCalls).toBe(1);
  });

  it("keeps owner server-owned across generate, revise, and save", async () => {
    const { exercise, revisedExercise, source } = await fixture();
    providerOutput = exerciseProposal(exercise.id);
    const generated = await generateFor(source.id);
    expect(generated).toMatchObject({ ok: true, result: { kind: "PREVIEW" } });
    if (!generated.ok || generated.result.kind !== "PREVIEW" || generated.result.acceptToken === null) throw new Error("generate failed");
    const priorClaims = claims(generated.result.acceptToken);
    expect(priorClaims.ownerId).toBe(DEFAULT_OWNER_ID);

    providerOutput = exerciseProposal(revisedExercise.id);
    const revised = await actions.reviseMenuPlannerAction({
      schemaVersion: 1,
      acceptToken: generated.result.acceptToken,
      revisionText: "別のドリルに変更",
    });
    expect(revised).toMatchObject({ ok: true, result: { kind: "PREVIEW" } });
    if (!revised.ok || revised.result.kind !== "PREVIEW" || revised.result.acceptToken === null) throw new Error("revise failed");
    const revisedClaims = claims(revised.result.acceptToken);
    expect(revisedClaims.ownerId).toBe(DEFAULT_OWNER_ID);
    expect(revisedClaims.previewId).not.toBe(priorClaims.previewId);
    expect(revisedClaims.targetMenuId).toBe(priorClaims.targetMenuId);

    expect(await actions.saveMenuPlannerAction({
      acceptToken: revised.result.acceptToken,
    })).toMatchObject({ ok: true, alreadySaved: false, menuId: priorClaims.targetMenuId });
    expect(await actions.saveMenuPlannerAction({
      acceptToken: revised.result.acceptToken,
    })).toMatchObject({ ok: true, alreadySaved: true, menuId: priorClaims.targetMenuId });
    expect(await actions.generateMenuPlannerAction({ ...request(source.id), ownerId: "other-owner" })).toMatchObject({
      ok: false,
      error: { kind: "INVALID_INPUT" },
    });
  });

  it("requires Running UI for Running proposals but allows Exercise-only proposals", async () => {
    const { exercise, source } = await fixture();
    const exerciseResult = await generateFor(source.id, exerciseProposal(exercise.id));
    expect(exerciseResult).toMatchObject({ ok: true, result: { kind: "PREVIEW", acceptToken: expect.any(String) } });

    providerOutput = runningProposal();
    const runningResult = await generateFor(source.id);
    expect(runningResult).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED", code: "RUNNING_V2_UI_REQUIRED" } });
    expect(runningResult).not.toHaveProperty("result");

    providerOutput = hybridProposal(exercise.id);
    const hybridResult = await generateFor(source.id);
    expect(hybridResult).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED", code: "RUNNING_V2_UI_REQUIRED" } });
    expect(hybridResult).not.toHaveProperty("result");

    process.env.RUNNING_V2_UI_ENABLED = "true";
    const enabledResult = await generateFor(source.id);
    expect(enabledResult).toMatchObject({ ok: true, result: { kind: "PREVIEW", acceptToken: expect.any(String) } });
  });

  it("preserves A3B retry and A3E stale semantics after source change", async () => {
    const { exercise, revisedExercise, source } = await fixture();
    providerOutput = exerciseProposal(exercise.id);
    const generated = await generateFor(source.id);
    if (!generated.ok || generated.result.kind !== "PREVIEW" || generated.result.acceptToken === null) throw new Error("generate failed");
    const token = generated.result.acceptToken;

    const firstSave = await actions.saveMenuPlannerAction({ acceptToken: token });
    expect(firstSave).toMatchObject({ ok: true, alreadySaved: false });
    await prisma.menuTemplate.update({ where: { id: source.id }, data: { status: "ARCHIVED" } });
    const retry = await actions.saveMenuPlannerAction({ acceptToken: token });
    expect(retry).toMatchObject({ ok: true, alreadySaved: true, menuId: firstSave.ok ? firstSave.menuId : undefined });

    providerOutput = exerciseProposal(revisedExercise.id);
    const stale = await actions.reviseMenuPlannerAction({
      schemaVersion: 1,
      acceptToken: token,
      revisionText: "修正",
    });
    expect(stale).toMatchObject({ ok: false, error: { kind: "STALE_PREVIEW" } });
    expect(providerCalls).toBe(1);
  });

  it("keeps conflicting old and revised identities fail-closed through the action", async () => {
    const { exercise, revisedExercise, source } = await fixture();
    providerOutput = exerciseProposal(exercise.id);
    const generated = await generateFor(source.id);
    if (!generated.ok || generated.result.kind !== "PREVIEW" || generated.result.acceptToken === null) throw new Error("generate failed");
    const prior = claims(generated.result.acceptToken);

    providerOutput = exerciseProposal(revisedExercise.id);
    const revised = await actions.reviseMenuPlannerAction({
      schemaVersion: 1,
      acceptToken: generated.result.acceptToken,
      revisionText: "修正",
    });
    if (!revised.ok || revised.result.kind !== "PREVIEW" || revised.result.acceptToken === null) throw new Error("revise failed");
    const next = claims(revised.result.acceptToken);
    expect(next.targetMenuId).toBe(prior.targetMenuId);
    expect(next.previewId).not.toBe(prior.previewId);
    expect(next.savedDraftIdentityDigest).not.toBe(prior.savedDraftIdentityDigest);

    expect(await actions.saveMenuPlannerAction({ acceptToken: generated.result.acceptToken })).toMatchObject({
      ok: true,
      alreadySaved: false,
      menuId: prior.targetMenuId,
    });
    expect(await actions.saveMenuPlannerAction({ acceptToken: revised.result.acceptToken })).toMatchObject({
      ok: false,
      error: { kind: "SAVE_FAILED" },
    });
    expect(await prisma.menuTemplate.count()).toBe(2);
  });
});
