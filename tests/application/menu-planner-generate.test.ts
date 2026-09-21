import { beforeEach, describe, expect, it } from "vitest";

import {
  generateMenuPlannerPreview,
  type GenerateMenuPlannerPreviewDependencies,
  type MenuPlannerAuthoritativeParserContext,
} from "@/application/menu-planner/generate";
import type { MenuIntentParser } from "@/domain/menu-planner";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { prisma } from "@/infra/db/prisma";
import { verifyHmacToken } from "@/infra/security/hmac-token";
import { makeExercise, resetDb } from "../helpers";

const SIGNING_KEY = "a3d-test-signing-key-0123456789-abcdef";
const BASE_DATE = new Date("2026-09-20T07:00:00.000Z");

function coachRequest() {
  return {
    schemaVersion: 1,
    requestText: "加速とドリルを組み合わせたメニューを作成",
    constraints: {
      phase: "PREPARATION",
      targetEvents: [],
      purposes: [],
      availableMinutes: null,
      equipment: null,
      preferredExerciseIds: [],
      excludedExerciseIds: [],
    },
  };
}

function authoritativeContext(exerciseId = "exercise-a"): MenuPlannerAuthoritativeParserContext {
  return {
    subject: {
      tier: "DEVELOPMENTAL",
      ageBand: "U18",
      allowedMethods: ["ACCELERATION", "STRIDE"],
      autogenBlockedMethods: [],
      highIntensityAllowedToday: true,
      primaryEvent: "400m",
    },
    catalog: {
      exercises: [
        {
          id: exerciseId,
          name: "A3Dドリル",
          category: "DRILL",
          purposes: ["ACCELERATION"],
          events: ["SPRINT"],
          equipmentTagIds: [],
        },
      ],
      runningTemplates: [
        {
          method: "ACCELERATION",
          templateId: "ACC_BLOCK_20",
          label: "20m加速",
        },
      ],
      equipment: [],
    },
  };
}

function exerciseProposal(exerciseId = "exercise-a") {
  return {
    schemaVersion: 1,
    items: [
      {
        kind: "EXERCISE" as const,
        proposal: {
          blockName: "ドリル",
          exerciseId,
          reason: "動作の準備を整えるため",
        },
      },
    ],
    question: null,
  };
}

function runningProposal() {
  return {
    schemaVersion: 1,
    items: [
      {
        kind: "RUNNING" as const,
        proposal: {
          blockName: "主運動",
          method: "ACCELERATION" as const,
          templateId: "ACC_BLOCK_20",
          positionPreference: null,
          reason: "加速の質を確認するため",
        },
      },
    ],
    question: null,
  };
}

function hybridProposal(exerciseId = "exercise-a") {
  return {
    schemaVersion: 1,
    items: [
      ...exerciseProposal(exerciseId).items,
      ...runningProposal().items,
    ],
    question: null,
  };
}

function clarificationProposal() {
  return {
    schemaVersion: 1,
    items: [],
    question: {
      missingField: "PURPOSE" as const,
      text: "どの目的を優先しますか？",
      options: [],
    },
  };
}

function parserReturning(output: unknown, calls: Array<{ request: unknown }>): MenuIntentParser {
  return {
    async propose(request) {
      calls.push({ request });
      return { ok: true, output };
    },
  };
}

function dependencies(
  parser: MenuIntentParser,
  context: MenuPlannerAuthoritativeParserContext,
  calls: Array<{ kind: string; value?: unknown }>,
): GenerateMenuPlannerPreviewDependencies {
  return {
    parser,
    loadAuthoritativeParserContext: async (input) => {
      calls.push({ kind: "context", value: input });
      return { ok: true, context };
    },
    parserOptions: { timeoutMs: 1_000 },
    accept: {
      signingKey: SIGNING_KEY,
      now: () => new Date(BASE_DATE.getTime()),
      tokenTtlMs: 60_000,
      generateId: (() => {
        let counter = 0;
        return () => `a3d-id-${counter += 1}`;
      })(),
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    ownerId: DEFAULT_OWNER_ID,
    contextMenuTemplateId: "source-menu",
    menuName: "コーチ作成メニュー",
    coachRequest: coachRequest(),
    ...overrides,
  };
}

describe("R12-A3D generate application orchestration", () => {
  beforeEach(resetDb);

  it("returns clarification and short-circuits preview/token issuance", async () => {
    const parserCalls: Array<{ request: unknown }> = [];
    const calls: Array<{ kind: string; value?: unknown }> = [];

    const result = await generateMenuPlannerPreview(
      input(),
      dependencies(
        parserReturning(clarificationProposal(), parserCalls),
        authoritativeContext(),
        calls,
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("clarification failed");
    expect(result.result).toEqual({
      kind: "CLARIFICATION",
      question: { ...clarificationProposal().question, text: "どの目的を優先しますか?" },
    });
    expect(parserCalls).toHaveLength(1);
    expect(calls.map((call) => call.kind)).toEqual(["context"]);
  });

  it("does not invoke downstream planning when the provider is unavailable", async () => {
    const calls: Array<{ kind: string; value?: unknown }> = [];
    const parser: MenuIntentParser = {
      async propose() {
        return { ok: false as const, kind: "UNAVAILABLE" as const };
      },
    };

    const result = await generateMenuPlannerPreview(
      input(),
      dependencies(parser, authoritativeContext(), calls),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "AI_PROVIDER_UNAVAILABLE",
        code: "PROVIDER_UNAVAILABLE",
        message: "AIサービスを利用できません。",
      },
    });
  });

  it("maps a provider failure without invoking deterministic planning", async () => {
    const calls: Array<{ kind: string; value?: unknown }> = [];
    const parser: MenuIntentParser = {
      async propose() {
        return { ok: false as const, kind: "FAILED" as const };
      },
    };

    const result = await generateMenuPlannerPreview(
      input(),
      dependencies(parser, authoritativeContext(), calls),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "AI_PROVIDER_FAILED",
        code: "PROVIDER_FAILED",
        message: "AIサービスで提案を生成できません。",
      },
    });
  });

  it("rejects strict invalid provider output before deterministic planning", async () => {
    const calls: Array<{ kind: string; value?: unknown }> = [];
    const invalidOutput = {
      ...exerciseProposal(),
      items: [{ ...exerciseProposal().items[0], proposal: { ...exerciseProposal().items[0]!.proposal, reps: 5 } }],
    };

    const result = await generateMenuPlannerPreview(
      input(),
      dependencies(parserReturning(invalidOutput, []), authoritativeContext(), calls),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "AI_OUTPUT_INVALID" } });
  });

  it("does not expose a token when the deterministic planner rejects", async () => {
    const calls: Array<{ kind: string; value?: unknown }> = [];

    const result = await generateMenuPlannerPreview(
      input(),
      dependencies(parserReturning(exerciseProposal(), []), authoritativeContext(), calls),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED" } });
  });

  it("isolates the pre-preview gate from the proposal used by A2/A3A", async () => {
    const generatedExercise = await makeExercise({ name: "A3G.2ドリル" });
    const sourceMenu = await prisma.menuTemplate.create({
      data: {
        ownerId: DEFAULT_OWNER_ID,
        name: "A3G.2参照メニュー",
        phase: "PREPARATION",
        runningContextJson: JSON.stringify({
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
          availableMinutes: 90,
        }),
      },
    });
    const calls: Array<{ kind: string; value?: unknown }> = [];
    let observedContext: unknown;
    const deps = dependencies(
      parserReturning(exerciseProposal(generatedExercise.id), []),
      authoritativeContext(generatedExercise.id),
      calls,
    );
    deps.beforePreview = (context) => {
      observedContext = context;
      expect(context).toEqual({ containsRunning: false });
      expect(Object.isFrozen(context)).toBe(true);
      expect("items" in context).toBe(false);
      expect(() => {
        (context as { containsRunning: boolean }).containsRunning = true;
      }).toThrow();
      return null;
    };

    const result = await generateMenuPlannerPreview(
      input({ contextMenuTemplateId: sourceMenu.id }),
      deps,
    );

    expect(observedContext).toEqual({ containsRunning: false });
    expect(result.ok).toBe(true);
    if (!result.ok || result.result.kind !== "PREVIEW" || result.result.acceptToken === null) {
      throw new Error(JSON.stringify(result));
    }
    const verified = verifyHmacToken(result.result.acceptToken, SIGNING_KEY);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("generated token did not verify");
    const claims = JSON.parse(verified.payload) as { proposal: ReturnType<typeof exerciseProposal> };
    expect(claims.proposal.items[0]?.proposal.exerciseId).toBe(generatedExercise.id);
  });

  it("returns a safe planning failure when authoritative context loading throws", async () => {
    const deps = dependencies(parserReturning(exerciseProposal(), []), authoritativeContext(), []);
    deps.loadAuthoritativeParserContext = async () => {
      throw new Error("raw repository details must not escape");
    };

    const result = await generateMenuPlannerPreview(input(), deps);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "PLANNING_REJECTED",
        code: "AUTHORITATIVE_CONTEXT_UNAVAILABLE",
        message: "計画に必要なserver contextを確認できません。",
      },
    });
  });

  it("runs the real A2/A3A read-only path and does not create preview or draft rows", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const generatedExercise = await makeExercise({ name: "A3Dドリル", defaultDistanceMeters: 30 });
    const menu = await prisma.menuTemplate.create({
      data: {
        ownerId: DEFAULT_OWNER_ID,
        name: "参照メニュー",
        phase: "PREPARATION",
        status: "DRAFT",
        runningContextJson: JSON.stringify({
          schemaVersion: 1,
          subject: {
            kind: "GROUP",
            label: "短距離ブロック",
            members: [
              {
                ageBandOverride: "U18",
                maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: "2026-09-01" },
                trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
                primaryEvent: "400m",
              },
            ],
            allowAdvancedMethods: true,
          },
          plannedDate: "2026-09-20",
          plannedAt: "2026-09-20T16:00:00+09:00",
          availableMinutes: 90,
        }),
        blocks: {
          create: {
            name: "既存ブロック",
            sortOrder: 0,
            items: { create: { exerciseId: sourceExercise.id, displayName: "既存", sortOrder: 0, sets: 2, distanceMeters: 20 } },
          },
        },
      },
    });
    const before = {
      menus: await prisma.menuTemplate.count(),
      blocks: await prisma.menuBlock.count(),
      items: await prisma.menuItem.count(),
    };
    const parserCalls: Array<{ request: unknown }> = [];
    let parserOutput: unknown = exerciseProposal(generatedExercise.id);
    const parser: MenuIntentParser = {
      async propose(request) {
        parserCalls.push({ request });
        return { ok: true, output: parserOutput };
      },
    };
    const accept = {
      signingKey: SIGNING_KEY,
      now: () => new Date(BASE_DATE.getTime()),
      tokenTtlMs: 60_000,
      generateId: (() => {
        let id = 0;
        return () => `real-a3d-id-${id += 1}`;
      })(),
    };
    const generate = () => generateMenuPlannerPreview(
      input({ contextMenuTemplateId: menu.id }),
      {
        parser,
        loadAuthoritativeParserContext: async () => ({ ok: true, context: authoritativeContext(generatedExercise.id) }),
        parserOptions: { timeoutMs: 1_000 },
        accept,
      },
    );

    const result = await generate();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.result.kind).toBe("PREVIEW");
    if (result.result.kind !== "PREVIEW") throw new Error("preview result expected");
    expect(result.result.preview.statusOnSave).toBe("DRAFT");
    expect(result.result.acceptToken).toEqual(expect.any(String));
    expect(parserCalls).toHaveLength(1);
    const verified = verifyHmacToken(result.result.acceptToken!, SIGNING_KEY);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("generated token did not verify");
    expect(verified.payload).not.toContain("加速とドリルを組み合わせたメニューを作成");
    expect(verified.payload).not.toContain("raw provider");

    parserOutput = runningProposal();
    const running = await generate();
    expect(running.ok).toBe(true);
    if (!running.ok) throw new Error(JSON.stringify(running));
    expect(running.result.kind).toBe("PREVIEW");
    if (running.result.kind !== "PREVIEW") throw new Error("running preview result expected");
    expect(running.result.preview.blocks.flatMap((block) => block.items.map((item) => item.selection.kind))).toContain("RUNNING");

    parserOutput = hybridProposal(generatedExercise.id);
    const hybrid = await generate();
    expect(hybrid.ok).toBe(true);
    if (!hybrid.ok) throw new Error(JSON.stringify(hybrid));
    expect(hybrid.result.kind).toBe("PREVIEW");
    if (hybrid.result.kind !== "PREVIEW") throw new Error("hybrid preview result expected");
    expect(new Set(hybrid.result.preview.blocks.flatMap((block) => block.items.map((item) => item.selection.kind)))).toEqual(
      new Set(["EXERCISE", "RUNNING"]),
    );

    expect(parserCalls).toHaveLength(3);
    await expect(prisma.menuTemplate.count()).resolves.toBe(before.menus);
    await expect(prisma.menuBlock.count()).resolves.toBe(before.blocks);
    await expect(prisma.menuItem.count()).resolves.toBe(before.items);
  });
});
