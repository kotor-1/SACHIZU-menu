import { beforeEach, describe, expect, it } from "vitest";

import {
  reviseMenuPlannerPreview,
  type ReviseMenuPlannerPreviewDependencies,
  type ReviseMenuPlannerPreviewInput,
} from "@/application/menu-planner/revise";
import {
  issueMenuPlannerSignedPreview,
  type MenuPlannerAcceptDependencies,
} from "@/application/menu-planner/accept";
import { saveAiMenuDraft } from "@/application/menu-planner/save";
import type { MenuPlannerAuthoritativeParserContext } from "@/application/menu-planner/generate";
import type { MenuIntentParser } from "@/domain/menu-planner";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { prisma } from "@/infra/db/prisma";
import { verifyHmacToken } from "@/infra/security/hmac-token";
import { makeExercise, resetDb } from "../helpers";

const SIGNING_KEY = "a3e-test-signing-key-0123456789-abcdef";
const ISSUED_AT = new Date("2026-09-20T07:00:00.000Z");
const TTL_MS = 60 * 60 * 1_000;

let clock = new Date(ISSUED_AT.getTime());
let idCounter = 0;

function acceptDependencies(
  overrides: Partial<MenuPlannerAcceptDependencies> = {},
): MenuPlannerAcceptDependencies {
  return {
    signingKey: SIGNING_KEY,
    now: () => new Date(clock.getTime()),
    tokenTtlMs: TTL_MS,
    generateId: () => `a3e-id-${idCounter += 1}`,
    ...overrides,
  };
}

function intent() {
  return {
    schemaVersion: 1,
    requestText: "短距離の練習メニューを作成",
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

function runningContext(availableMinutes = 180) {
  return {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "短距離ブロック",
      members: [
        {
          ageBandOverride: "U18",
          maturity: {
            status: "POST",
            confidence: "HIGH",
            method: "COACH_OBSERVATION",
            assessedAt: "2026-09-01",
          },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
          primaryEvent: "400m",
        },
      ],
      allowAdvancedMethods: true,
    },
    plannedDate: "2026-09-20",
    plannedAt: "2026-09-20T16:00:00+09:00",
    availableMinutes,
  };
}

function parserContext(exerciseId: string): MenuPlannerAuthoritativeParserContext {
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
          name: "A3Eドリル",
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

function exerciseProposal(exerciseId: string) {
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

function hybridProposal(exerciseId: string) {
  return {
    schemaVersion: 1,
    items: [...exerciseProposal(exerciseId).items, ...runningProposal().items],
    question: null,
  };
}

function clarificationProposal() {
  return {
    schemaVersion: 1,
    items: [],
    question: {
      missingField: "REQUEST_DETAIL" as const,
      text: "どの種目を優先しますか？",
      options: [],
    },
  };
}

async function createSourceMenu(sourceExerciseId: string) {
  return prisma.menuTemplate.create({
    data: {
      ownerId: DEFAULT_OWNER_ID,
      name: "参照メニュー",
      phase: "PREPARATION",
      status: "DRAFT",
      runningContextJson: JSON.stringify(runningContext()),
      blocks: {
        create: {
          name: "既存ブロック",
          sortOrder: 0,
          items: {
            create: {
              exerciseId: sourceExerciseId,
              displayName: "既存",
              sortOrder: 0,
              sets: 2,
              distanceMeters: 20,
            },
          },
        },
      },
    },
  });
}

async function issuePrior(menuId: string, exerciseId: string) {
  const result = await issueMenuPlannerSignedPreview(
    {
      ownerId: DEFAULT_OWNER_ID,
      contextMenuTemplateId: menuId,
      menuName: "コーチ作成メニュー",
      intent: intent(),
      proposal: hybridProposal(exerciseId),
    },
    acceptDependencies(),
  );
  if (!result.ok || result.signed.acceptToken === null) {
    throw new Error(`prior issue failed: ${JSON.stringify(result)}`);
  }
  return result.signed.acceptToken;
}

function revisionInput(token: string, overrides: Partial<ReviseMenuPlannerPreviewInput> = {}) {
  return {
    schemaVersion: 1 as const,
    ownerId: DEFAULT_OWNER_ID,
    acceptToken: token,
    revisionText: "加速系を増やしたい",
    ...overrides,
  };
}

function claimsOf(token: string): {
  previewId: string;
  targetMenuId: string;
  savedDraftIdentityDigest: string;
} {
  const verified = verifyHmacToken(token, SIGNING_KEY);
  if (!verified.ok) throw new Error("token did not verify");
  return JSON.parse(verified.payload) as {
    previewId: string;
    targetMenuId: string;
    savedDraftIdentityDigest: string;
  };
}

async function reviseWithProposal(
  token: string,
  exerciseId: string,
  proposal: unknown,
  revisionText = "修正する",
) {
  const parser: MenuIntentParser = {
    async propose() {
      return { ok: true, output: proposal };
    },
  };
  return reviseMenuPlannerPreview(
    revisionInput(token, { revisionText }),
    revisionDependencies(parser, exerciseId, []),
  );
}

function revisionDependencies(
  parser: MenuIntentParser,
  exerciseId: string,
  calls: Array<{ kind: string; value?: unknown }>,
  acceptOverrides: Partial<MenuPlannerAcceptDependencies> = {},
): ReviseMenuPlannerPreviewDependencies {
  return {
    parser,
    loadAuthoritativeParserContext: async (input) => {
      calls.push({ kind: "context", value: input });
      return { ok: true, context: parserContext(exerciseId) };
    },
    parserOptions: { timeoutMs: 1_000 },
    accept: acceptDependencies(acceptOverrides),
  };
}

async function setup() {
  const sourceExercise = await makeExercise({ name: "参照用種目" });
  const revisedExercise = await makeExercise({ name: "A3Eドリル", defaultDistanceMeters: 30 });
  const menu = await createSourceMenu(sourceExercise.id);
  const token = await issuePrior(menu.id, revisedExercise.id);
  return { menu, revisedExercise, token };
}

beforeEach(async () => {
  await resetDb();
  clock = new Date(ISSUED_AT.getTime());
  idCounter = 0;
});

describe("R12-A3E revise preview orchestration", () => {
  it("verifies the old token, exposes only signed selection state, and issues a new preview/token", async () => {
    const { menu, revisedExercise, token } = await setup();
    const before = {
      menus: await prisma.menuTemplate.count(),
      blocks: await prisma.menuBlock.count(),
      items: await prisma.menuItem.count(),
    };
    const parserRequests: unknown[] = [];
    const calls: Array<{ kind: string; value?: unknown }> = [];
    const parser: MenuIntentParser = {
      async propose(request) {
        parserRequests.push(request);
        return { ok: true, output: exerciseProposal(revisedExercise.id) };
      },
    };

    const result = await reviseMenuPlannerPreview(
      revisionInput(token),
      revisionDependencies(parser, revisedExercise.id, calls),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.result.kind !== "PREVIEW") throw new Error(JSON.stringify(result));
    expect(result.result.acceptToken).toEqual(expect.any(String));
    expect(result.result.acceptToken).not.toBe(token);
    expect(parserRequests).toHaveLength(1);
    expect(calls.map((call) => call.kind)).toEqual(["context"]);

    const request = parserRequests[0] as {
      coachRequest: { requestText: string };
      previousProposal: unknown;
    };
    expect(request.coachRequest.requestText).toBe("加速系を増やしたい");
    expect(request.previousProposal).toEqual({
      schemaVersion: 1,
      items: [
        { kind: "EXERCISE", exerciseId: revisedExercise.id },
        {
          kind: "RUNNING",
          method: "ACCELERATION",
          templateId: "ACC_BLOCK_20",
          positionPreference: null,
        },
      ],
    });
    expect(JSON.stringify(request.previousProposal)).not.toMatch(
      /sets|reps|distance|duration|rest|intensity|runningPrescription|materialization/iu,
    );

    const oldVerified = verifyHmacToken(token, SIGNING_KEY);
    const newVerified = verifyHmacToken(result.result.acceptToken!, SIGNING_KEY);
    expect(oldVerified.ok).toBe(true);
    expect(newVerified.ok).toBe(true);
    if (!oldVerified.ok || !newVerified.ok) throw new Error("token verification failed");
    const oldClaims = JSON.parse(oldVerified.payload) as {
      previewId: string;
      targetMenuId: string;
      savedDraftIdentityDigest: string;
    };
    const newClaims = JSON.parse(newVerified.payload) as {
      previewId: string;
      targetMenuId: string;
      savedDraftIdentityDigest: string;
    };
    expect(newVerified.payload).not.toContain("加速系を増やしたい");
    expect(newClaims.previewId).not.toBe(oldClaims.previewId);
    expect(newClaims.targetMenuId).toBe(oldClaims.targetMenuId);
    expect(newClaims.savedDraftIdentityDigest).not.toBe(oldClaims.savedDraftIdentityDigest);
    await expect(prisma.menuTemplate.count()).resolves.toBe(before.menus);
    await expect(prisma.menuBlock.count()).resolves.toBe(before.blocks);
    await expect(prisma.menuItem.count()).resolves.toBe(before.items);
    expect(menu.id).toBeTruthy();
  });

  it("keeps the revised proposal immutable across the pre-preview gate", async () => {
    const alternateExercise = await makeExercise({ name: "A3G.2別ドリル", defaultDistanceMeters: 25 });
    const { revisedExercise, token } = await setup();
    const parser: MenuIntentParser = {
      async propose() {
        return { ok: true, output: exerciseProposal(alternateExercise.id) };
      },
    };
    const deps = revisionDependencies(parser, alternateExercise.id, []);
    let observedContext: unknown;
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

    const result = await reviseMenuPlannerPreview(revisionInput(token), deps);

    expect(observedContext).toEqual({ containsRunning: false });
    expect(result.ok).toBe(true);
    if (!result.ok || result.result.kind !== "PREVIEW" || result.result.acceptToken === null) {
      throw new Error(JSON.stringify(result));
    }
    const verified = verifyHmacToken(result.result.acceptToken, SIGNING_KEY);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("revised token did not verify");
    const claims = JSON.parse(verified.payload) as { proposal: ReturnType<typeof exerciseProposal> };
    expect(claims.proposal.items[0]?.proposal.exerciseId).toBe(alternateExercise.id);
    expect(revisedExercise.id).not.toBe(alternateExercise.id);
  });

  it("rebuilds Running prescription deterministically from a revised selection", async () => {
    const { revisedExercise, token } = await setup();
    const parserRequests: unknown[] = [];
    const parser: MenuIntentParser = {
      async propose(request) {
        parserRequests.push(request);
        return { ok: true, output: runningProposal() };
      },
    };

    const result = await reviseMenuPlannerPreview(
      revisionInput(token, { revisionText: "加速走を主運動にしたい" }),
      revisionDependencies(parser, revisedExercise.id, []),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.result.kind !== "PREVIEW") throw new Error(JSON.stringify(result));
    expect(result.result.preview.blocks.flatMap((block) => block.items.map((item) => item.selection.kind))).toContain("RUNNING");
    expect(parserRequests).toHaveLength(1);
  });

  it("supports a Hybrid revised proposal with one parser call and one new token", async () => {
    const { revisedExercise, token } = await setup();
    let parserCalls = 0;
    const parser: MenuIntentParser = {
      async propose() {
        parserCalls += 1;
        return { ok: true, output: hybridProposal(revisedExercise.id) };
      },
    };

    const result = await reviseMenuPlannerPreview(
      revisionInput(token, { revisionText: "ドリルと加速を組み合わせたい" }),
      revisionDependencies(parser, revisedExercise.id, []),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.result.kind !== "PREVIEW") throw new Error(JSON.stringify(result));
    expect(parserCalls).toBe(1);
    expect(result.result.acceptToken).toEqual(expect.any(String));
    expect(new Set(result.result.preview.blocks.flatMap((block) => block.items.map((item) => item.selection.kind)))).toEqual(
      new Set(["EXERCISE", "RUNNING"]),
    );
  });

  it("short-circuits clarification without issuing a revised token", async () => {
    const { revisedExercise, token } = await setup();
    let parserCalls = 0;
    const parser: MenuIntentParser = {
      async propose() {
        parserCalls += 1;
        return { ok: true, output: clarificationProposal() };
      },
    };

    const result = await reviseMenuPlannerPreview(
      revisionInput(token),
      revisionDependencies(parser, revisedExercise.id, [], {
        generateId: () => {
          throw new Error("revised token must not be issued for clarification");
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: {
        kind: "CLARIFICATION",
        question: { ...clarificationProposal().question, text: "どの種目を優先しますか?" },
      },
    });
    expect(parserCalls).toBe(1);
  });

  it.each([
    ["unavailable", { ok: false as const, kind: "UNAVAILABLE" as const }, "AI_PROVIDER_UNAVAILABLE"],
    ["failed", { ok: false as const, kind: "FAILED" as const }, "AI_PROVIDER_FAILED"],
  ] as const)("maps parser %s without revised preview/token", async (_name, parserResult, kind) => {
    const { revisedExercise, token } = await setup();
    const parser: MenuIntentParser = { async propose() { return parserResult; } };
    const result = await reviseMenuPlannerPreview(
      revisionInput(token),
      revisionDependencies(parser, revisedExercise.id, [], {
        generateId: () => {
          throw new Error("token must not be issued after parser failure");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { kind } });
  });

  it("rejects strict invalid revised output before deterministic planning", async () => {
    const { revisedExercise, token } = await setup();
    const invalid = { ...exerciseProposal(revisedExercise.id), items: [{ ...exerciseProposal(revisedExercise.id).items[0], proposal: { ...exerciseProposal(revisedExercise.id).items[0]!.proposal, reps: 5 } }] };
    const parser: MenuIntentParser = { async propose() { return { ok: true, output: invalid }; } };
    const result = await reviseMenuPlannerPreview(
      revisionInput(token),
      revisionDependencies(parser, revisedExercise.id, [], {
        generateId: () => {
          throw new Error("token must not be issued after invalid output");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "AI_OUTPUT_INVALID" } });
  });

  it("rejects deterministic planning failure without a new token", async () => {
    const { menu, revisedExercise, token } = await setup();
    let parserCalls = 0;
    const parser: MenuIntentParser = {
      async propose() {
        parserCalls += 1;
        return { ok: true, output: exerciseProposal(revisedExercise.id) };
      },
    };
    const deps = revisionDependencies(parser, revisedExercise.id, [], {
      generateId: () => {
        throw new Error("token must not be issued after planning rejection");
      },
    });
    const originalLoader = deps.loadAuthoritativeParserContext;
    deps.loadAuthoritativeParserContext = async (input) => {
      // Simulate a source phase mutation after the prior stale gate and before
      // the revised deterministic materialization. A2 must reject it safely.
      await prisma.menuTemplate.update({
        where: { id: menu.id },
        data: { phase: "COMPETITION" },
      });
      return originalLoader(input);
    };
    const result = await reviseMenuPlannerPreview(
      revisionInput(token),
      deps,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED" } });
    expect(parserCalls).toBe(1);
  });

  it("rejects invalid, owner-mismatched, and expired tokens before provider/context access", async () => {
    const { revisedExercise, token } = await setup();
    const parserCalls: unknown[] = [];
    const contextCalls: Array<{ kind: string; value?: unknown }> = [];
    const parser: MenuIntentParser = { async propose(request) { parserCalls.push(request); return { ok: true, output: exerciseProposal(revisedExercise.id) }; } };
    const deps = revisionDependencies(parser, revisedExercise.id, contextCalls);

    const invalid = await reviseMenuPlannerPreview(revisionInput(`${token.slice(0, -1)}x`), deps);
    expect(invalid).toMatchObject({ ok: false, error: { kind: "INVALID_INPUT" } });

    const ownerMismatch = await reviseMenuPlannerPreview(
      revisionInput(token, { ownerId: "another-owner" }),
      deps,
    );
    expect(ownerMismatch).toMatchObject({ ok: false, error: { kind: "INVALID_INPUT" } });

    clock = new Date(ISSUED_AT.getTime() + TTL_MS);
    const expired = await reviseMenuPlannerPreview(revisionInput(token), deps);
    expect(expired).toMatchObject({ ok: false, error: { kind: "STALE_PREVIEW" } });
    expect(parserCalls).toHaveLength(0);
    expect(contextCalls).toHaveLength(0);
  });

  it("stops before the provider when authoritative prior context is stale", async () => {
    const { menu, revisedExercise, token } = await setup();
    await prisma.menuTemplate.update({
      where: { id: menu.id },
      data: { runningContextJson: JSON.stringify(runningContext(179)) },
    });
    const parserCalls: unknown[] = [];
    const contextCalls: Array<{ kind: string; value?: unknown }> = [];
    const parser: MenuIntentParser = { async propose(request) { parserCalls.push(request); return { ok: true, output: exerciseProposal(revisedExercise.id) }; } };
    const result = await reviseMenuPlannerPreview(
      revisionInput(token),
      revisionDependencies(parser, revisedExercise.id, contextCalls),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "STALE_PREVIEW" } });
    expect(parserCalls).toHaveLength(0);
    expect(contextCalls).toHaveLength(0);
  });

  it("maps authoritative parser-context exceptions safely and rejects client prior-proposal authority", async () => {
    const { revisedExercise, token } = await setup();
    let parserCalls = 0;
    const parser: MenuIntentParser = { async propose() { parserCalls += 1; return { ok: true, output: exerciseProposal(revisedExercise.id) }; } };
    const deps = revisionDependencies(parser, revisedExercise.id, []);
    deps.loadAuthoritativeParserContext = async () => {
      throw new Error("database details must not escape");
    };
    const infrastructure = await reviseMenuPlannerPreview(revisionInput(token), deps);
    expect(infrastructure).toEqual({
      ok: false,
      error: {
        kind: "PLANNING_REJECTED",
        code: "AUTHORITATIVE_CONTEXT_UNAVAILABLE",
        message: "計画に必要なserver contextを確認できません。",
      },
    });
    expect(parserCalls).toBe(0);

    const clientOverride = await reviseMenuPlannerPreview(
      {
        ...revisionInput(token),
        previousProposal: exerciseProposal(revisedExercise.id),
        targetMenuId: "client-controlled-target",
      },
      revisionDependencies(parser, revisedExercise.id, []),
    );
    expect(clientOverride).toMatchObject({ ok: false, error: { kind: "INVALID_INPUT" } });
    expect(parserCalls).toBe(0);
  });

  it("preserves one target lineage across a multi-revision chain while refreshing preview identities", async () => {
    const { revisedExercise, token } = await setup();
    const first = await reviseWithProposal(token, revisedExercise.id, exerciseProposal(revisedExercise.id), "ドリルを残す");
    expect(first.ok).toBe(true);
    if (!first.ok || first.result.kind !== "PREVIEW" || first.result.acceptToken === null) throw new Error(JSON.stringify(first));

    const second = await reviseWithProposal(first.result.acceptToken, revisedExercise.id, runningProposal(), "加速走へ変更");
    expect(second.ok).toBe(true);
    if (!second.ok || second.result.kind !== "PREVIEW" || second.result.acceptToken === null) throw new Error(JSON.stringify(second));

    const priorClaims = claimsOf(token);
    const firstClaims = claimsOf(first.result.acceptToken);
    const secondClaims = claimsOf(second.result.acceptToken);
    expect(firstClaims.previewId).not.toBe(priorClaims.previewId);
    expect(secondClaims.previewId).not.toBe(firstClaims.previewId);
    expect(firstClaims.targetMenuId).toBe(priorClaims.targetMenuId);
    expect(secondClaims.targetMenuId).toBe(priorClaims.targetMenuId);
  });

  it.each([
    ["old then revised", false],
    ["revised then old", true],
  ] as const)("materializes only one logical target for %s", async (_name, revisedFirst) => {
    const { menu, revisedExercise, token } = await setup();
    const revised = await reviseWithProposal(token, revisedExercise.id, exerciseProposal(revisedExercise.id));
    expect(revised.ok).toBe(true);
    if (!revised.ok || revised.result.kind !== "PREVIEW" || revised.result.acceptToken === null) throw new Error(JSON.stringify(revised));

    const oldInput = { token, ownerId: DEFAULT_OWNER_ID };
    const revisedInputValue = { token: revised.result.acceptToken, ownerId: DEFAULT_OWNER_ID };
    const first = revisedFirst
      ? await saveAiMenuDraft(revisedInputValue, acceptDependencies())
      : await saveAiMenuDraft(oldInput, acceptDependencies());
    const second = revisedFirst
      ? await saveAiMenuDraft(oldInput, acceptDependencies())
      : await saveAiMenuDraft(revisedInputValue, acceptDependencies());

    expect(first).toMatchObject({ ok: true, alreadySaved: false });
    expect(second).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED" } });

    const targetMenuId = claimsOf(token).targetMenuId;
    expect(claimsOf(revised.result.acceptToken).targetMenuId).toBe(targetMenuId);
    expect(await prisma.menuTemplate.count({ where: { id: targetMenuId } })).toBe(1);
    expect(await prisma.menuTemplate.count()).toBe(2); // source menu + one logical target
    expect(menu.id).not.toBe(targetMenuId);
  });

  it("sibling revisions share the target, have distinct previews, and only one can materialize it", async () => {
    const { revisedExercise, token } = await setup();
    const revisionA = await reviseWithProposal(token, revisedExercise.id, exerciseProposal(revisedExercise.id), "ドリル案");
    const revisionB = await reviseWithProposal(token, revisedExercise.id, runningProposal(), "加速走案");
    expect(revisionA.ok && revisionB.ok).toBe(true);
    if (
      !revisionA.ok || revisionA.result.kind !== "PREVIEW" || revisionA.result.acceptToken === null ||
      !revisionB.ok || revisionB.result.kind !== "PREVIEW" || revisionB.result.acceptToken === null
    ) throw new Error("sibling revision failed");

    const priorClaims = claimsOf(token);
    const claimsA = claimsOf(revisionA.result.acceptToken);
    const claimsB = claimsOf(revisionB.result.acceptToken);
    expect(claimsA.targetMenuId).toBe(priorClaims.targetMenuId);
    expect(claimsB.targetMenuId).toBe(priorClaims.targetMenuId);
    expect(claimsA.previewId).not.toBe(claimsB.previewId);
    expect(claimsA.savedDraftIdentityDigest).not.toBe(claimsB.savedDraftIdentityDigest);

    const first = await saveAiMenuDraft(
      { token: revisionA.result.acceptToken, ownerId: DEFAULT_OWNER_ID },
      acceptDependencies(),
    );
    const second = await saveAiMenuDraft(
      { token: revisionB.result.acceptToken, ownerId: DEFAULT_OWNER_ID },
      acceptDependencies(),
    );
    expect(first).toMatchObject({ ok: true, alreadySaved: false });
    expect(second).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED" } });
    expect(await prisma.menuTemplate.count({ where: { id: priorClaims.targetMenuId } })).toBe(1);
  });

  it("revised token retry is idempotent, while the old token remains a different identity", async () => {
    const { revisedExercise, token } = await setup();
    const revised = await reviseWithProposal(token, revisedExercise.id, exerciseProposal(revisedExercise.id));
    expect(revised.ok).toBe(true);
    if (!revised.ok || revised.result.kind !== "PREVIEW" || revised.result.acceptToken === null) throw new Error(JSON.stringify(revised));

    const revisedInputValue = { token: revised.result.acceptToken, ownerId: DEFAULT_OWNER_ID };
    const first = await saveAiMenuDraft(revisedInputValue, acceptDependencies());
    const retry = await saveAiMenuDraft(revisedInputValue, acceptDependencies());
    const old = await saveAiMenuDraft({ token, ownerId: DEFAULT_OWNER_ID }, acceptDependencies());
    expect(first).toMatchObject({ ok: true, alreadySaved: false });
    expect(retry).toMatchObject({ ok: true, alreadySaved: true });
    if (!first.ok || !retry.ok) throw new Error("revised retry did not save");
    expect(retry.menuId).toBe(first.menuId);
    expect(old).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED" } });
    expect(await prisma.menuTemplate.count({ where: { id: claimsOf(token).targetMenuId } })).toBe(1);
  });
});
