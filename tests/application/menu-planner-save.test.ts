/**
 * [R12-A3B] signed acceptToken -> atomic MenuTemplate(DRAFT) save。
 *
 * このテストは、保存時の authority が fresh server replay だけであること、
 * revalidation と write が同一 transaction client を使うこと、失敗時に partial
 * menu が残らないことを固定する。provider / Server Action / UI は接続しない。
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const plannerFailure = vi.hoisted(() => ({ value: false }));
vi.mock("@/domain/running/planning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/running/planning")>();
  return {
    ...actual,
    planRunningPrescriptionWithRuleSet: (request: unknown, resolved: unknown) => {
      if (plannerFailure.value) throw new Error("simulated deterministic planner failure");
      return (actual.planRunningPrescriptionWithRuleSet as (a: unknown, b: unknown) => unknown)(request, resolved);
    },
  };
});

import { saveAiMenuDraft } from "@/application/menu-planner/save";
import {
  issueMenuPlannerSignedPreview,
  type MenuPlannerAcceptDependencies,
} from "@/application/menu-planner/accept";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { prisma } from "@/infra/db/prisma";
import { buildMenuPlannerDraftIdentityDigest } from "@/infra/repositories/menu-planner-draft-repository";
import { verifyHmacToken } from "@/infra/security/hmac-token";
import { makeExercise as makeExerciseBase, resetDb } from "../helpers";

const makeExercise = (overrides: Parameters<typeof makeExerciseBase>[0] = {}) =>
  makeExerciseBase({ category: "WARM_UP", ...overrides });

const OWNER = DEFAULT_OWNER_ID;
const OTHER_OWNER = "other-owner";
const KEY = "a3b-test-signing-key-0123456789-abcdef";
const TTL_MS = 2 * 60 * 60 * 1000;
const ISSUED_AT = new Date("2026-09-20T07:00:00.000Z");
const ACCEPTED_AT = new Date("2026-09-20T07:12:34.000Z");

let clock = new Date(ISSUED_AT.getTime());
let idCounter = 0;

function deps(overrides: Partial<MenuPlannerAcceptDependencies> = {}): MenuPlannerAcceptDependencies {
  return {
    signingKey: KEY,
    now: () => new Date(clock.getTime()),
    tokenTtlMs: TTL_MS,
    generateId: () => `a3b-id-${(idCounter += 1)}`,
    ...overrides,
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
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: "2026-09-01" },
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

function intent() {
  return {
    schemaVersion: 1,
    requestText: "保存されない raw coach prompt のテスト文字列",
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

function runningProposal(reason = "加速の質を確認するため") {
  return {
    schemaVersion: 1,
    items: [
      {
        kind: "RUNNING",
        proposal: {
          blockName: "主運動",
          method: "ACCELERATION",
          templateId: "ACC_BLOCK_20",
          positionPreference: null,
          reason,
        },
      },
    ],
    question: null,
  };
}

function exerciseProposal(exerciseId: string, blockName = "補強", reason = "動作の質を整えるため") {
  return {
    schemaVersion: 1,
    items: [
      { kind: "EXERCISE", proposal: { blockName, exerciseId, reason } },
    ],
    question: null,
  };
}

function hybridProposal(firstExerciseId: string, secondExerciseId: string) {
  return {
    schemaVersion: 1,
    items: [
      { kind: "EXERCISE", proposal: { blockName: "ウォームアップ", exerciseId: firstExerciseId, reason: "動作を整えるため" } },
      {
        kind: "RUNNING",
        proposal: {
          blockName: "主運動",
          method: "ACCELERATION",
          templateId: "ACC_BLOCK_20",
          positionPreference: null,
          reason: "加速の質を確認するため",
        },
      },
      { kind: "EXERCISE", proposal: { blockName: "補強", exerciseId: secondExerciseId, reason: "姿勢を保つため" } },
    ],
    question: null,
  };
}

async function createSourceMenu(sourceExerciseId: string, context: unknown = runningContext()) {
  return prisma.menuTemplate.create({
    data: {
      ownerId: OWNER,
      name: "参照メニュー",
      phase: "PREPARATION",
      status: "DRAFT",
      runningContextJson: JSON.stringify(context),
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
    include: { blocks: { include: { items: true } } },
  });
}

async function setup() {
  const sourceExercise = await makeExercise({ name: "参照用種目" });
  const source = await createSourceMenu(sourceExercise.id);
  const exercise = await makeExercise({ name: "保存対象ドリル", defaultDistanceMeters: 30 });
  return { source, sourceExercise, exercise };
}

async function issue(
  sourceMenuId: string,
  proposal: unknown,
  overrides: Partial<MenuPlannerAcceptDependencies> = {},
  requestIntent: unknown = intent(),
) {
  return issueMenuPlannerSignedPreview(
    {
      ownerId: OWNER,
      contextMenuTemplateId: sourceMenuId,
      menuName: "コーチ作成メニュー",
      intent: requestIntent,
      proposal,
    },
    deps(overrides),
  );
}

function targetIdOf(token: string): string {
  const verified = verifyHmacToken(token, KEY);
  if (!verified.ok) throw new Error("test token did not verify");
  const claims = JSON.parse(verified.payload) as { targetMenuId: string };
  return claims.targetMenuId;
}

type FailurePoint = { model: string; method: string } | null;

function instrumentDatabase(options: {
  writes: string[];
  reads: string[];
  failure?: FailurePoint;
}): PrismaClient {
  const modelNames = new Set(["menuTemplate", "menuBlock", "menuItem", "exercise", "competition", "trainingSession"]);
  const writeMethods = new Set([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "delete",
    "deleteMany",
    "upsert",
    "$executeRaw",
    "$executeRawUnsafe",
  ]);
  const wrap = (client: object) =>
    new Proxy(client, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property === "string" && modelNames.has(property) && value !== null && typeof value === "object") {
          return new Proxy(value, {
            get(delegate, method, delegateReceiver) {
              const fn = Reflect.get(delegate, method, delegateReceiver);
              if (typeof fn !== "function") return fn;
              return (...args: unknown[]) => {
                if (typeof method === "string") {
                  if (writeMethods.has(method)) options.writes.push(`${property}.${method}`);
                  else options.reads.push(`${property}.${method}`);
                  if (options.failure?.model === property && options.failure.method === method) {
                    throw new Error("injected repository failure");
                  }
                }
                return (fn as (...fnArgs: unknown[]) => unknown).apply(delegate, args);
              };
            },
          });
        }
        if (property === "$transaction") {
          return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            prisma.$transaction(async (tx) => callback(wrap(tx) as Prisma.TransactionClient));
        }
        if (typeof value === "function") return value.bind(target);
        return value;
      },
    }) as unknown as PrismaClient;
  return wrap(prisma) as PrismaClient;
}

function p2002AfterHiddenTargetDatabase(): PrismaClient {
  let hideTargetOnce = true;
  const conflict = new Prisma.PrismaClientKnownRequestError("duplicate target", {
    code: "P2002",
    clientVersion: "6.19.3",
  });
  const wrap = (client: object): object =>
    new Proxy(client, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "menuTemplate" && value !== null && typeof value === "object") {
          return new Proxy(value, {
            get(delegate, method, delegateReceiver) {
              const fn = Reflect.get(delegate, method, delegateReceiver);
              if (typeof fn !== "function") return fn;
              return (...args: unknown[]) => {
                if (method === "findUnique" && hideTargetOnce) {
                  hideTargetOnce = false;
                  return null;
                }
                if (method === "create") throw conflict;
                return (fn as (...fnArgs: unknown[]) => unknown).apply(delegate, args);
              };
            },
          });
        }
        if (property === "$transaction") {
          return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            prisma.$transaction(async (tx) => callback(wrap(tx) as Prisma.TransactionClient));
        }
        if (typeof value === "function") return value.bind(target);
        return value;
      },
    });
  return wrap(prisma) as PrismaClient;
}

async function countsFor(menuId: string) {
  return {
    menu: await prisma.menuTemplate.count({ where: { id: menuId } }),
    blocks: await prisma.menuBlock.count({ where: { menuTemplateId: menuId } }),
    items: await prisma.menuItem.count({ where: { menuBlock: { menuTemplateId: menuId } } }),
  };
}

async function assertMismatchedExistingTarget(
  mutate: (targetMenuId: string) => Promise<void>,
) {
  const { source } = await setup();
  const issued = await issue(source.id, runningProposal());
  if (!issued.ok) throw new Error(JSON.stringify(issued.error));
  const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
  const first = await saveAiMenuDraft(input, deps());
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  await mutate(first.menuId);

  const writes: string[] = [];
  const result = await saveAiMenuDraft(input, {
    ...deps(),
    database: instrumentDatabase({ reads: [], writes }),
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("mismatched existing target was accepted as alreadySaved");
  expect(result.error).toMatchObject({ kind: "SAVE_FAILED", code: "SAVE_FAILED" });
  expect(result.error.message).toBe("メニューを保存できませんでした。時間をおいてもう一度お試しください。");
  expect(writes).toEqual([]);
}

beforeEach(async () => {
  await resetDb();
  clock = new Date(ISSUED_AT.getTime());
  idCounter = 0;
  plannerFailure.value = false;
});

describe("R12-A3B atomic draft save", () => {
  it("fresh saved-draft identity mismatch は作成前に安全に拒否する", async () => {
    const previousBuildSha = process.env.RUNNING_ENGINE_BUILD_SHA;
    try {
      process.env.RUNNING_ENGINE_BUILD_SHA = "issue-build-a";
      const { source } = await setup();
      const issued = await issue(source.id, runningProposal());
      if (!issued.ok) throw new Error(JSON.stringify(issued.error));
      const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
      const targetMenuId = targetIdOf(input.token);

      // engineVersion は persisted provenance に含まれるが、A3A の preview digest には含まれない。
      // 署名済みtokenを改ざんせず、issue後のserver projectionだけを変えて初回save gateを検証する。
      process.env.RUNNING_ENGINE_BUILD_SHA = "save-build-b";
      const writes: string[] = [];
      const result = await saveAiMenuDraft(input, {
        ...deps(),
        database: instrumentDatabase({ reads: [], writes }),
      });

      expect(result).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED", code: "SAVE_FAILED" } });
      expect(writes).toEqual([]);
      expect(await countsFor(targetMenuId)).toEqual({ menu: 0, blocks: 0, items: 0 });
    } finally {
      if (previousBuildSha === undefined) delete process.env.RUNNING_ENGINE_BUILD_SHA;
      else process.env.RUNNING_ENGINE_BUILD_SHA = previousBuildSha;
    }
  });

  it("runningContextJson の object key order は identity digest を変えない", () => {
    const draft = (runningContextJson: string) => ({
      menuName: "identity-test",
      phase: "PREPARATION" as const,
      estimatedMinutes: null,
      runningContextJson,
      blocks: [],
      ownerId: OWNER,
      targetMenuId: "target-menu",
    });
    expect(buildMenuPlannerDraftIdentityDigest(draft('{"a":1,"b":2}'))).toBe(
      buildMenuPlannerDraftIdentityDigest(draft('{"b":2,"a":1}')),
    );
  });

  it("runningContextJson の whitespace は identity digest を変えない", () => {
    const draft = (runningContextJson: string) => ({
      menuName: "identity-test",
      phase: "PREPARATION" as const,
      estimatedMinutes: null,
      runningContextJson,
      blocks: [],
      ownerId: OWNER,
      targetMenuId: "target-menu",
    });
    expect(buildMenuPlannerDraftIdentityDigest(draft('{"a":1,"b":2}'))).toBe(
      buildMenuPlannerDraftIdentityDigest(draft('{ "a": 1, "b": 2 }')),
    );
  });

  it("runningContextJson の semantic change は identity digestを変える", () => {
    const draft = (runningContextJson: string) => ({
      menuName: "identity-test",
      phase: "PREPARATION" as const,
      estimatedMinutes: null,
      runningContextJson,
      blocks: [],
      ownerId: OWNER,
      targetMenuId: "target-menu",
    });
    expect(buildMenuPlannerDraftIdentityDigest(draft('{"a":1,"b":2}'))).not.toBe(
      buildMenuPlannerDraftIdentityDigest(draft('{"a":1,"b":3}')),
    );
  });

  it("runningContextJson の array order は semantic identityとして保持する", () => {
    const draft = (runningContextJson: string) => ({
      menuName: "identity-test",
      phase: "PREPARATION" as const,
      estimatedMinutes: null,
      runningContextJson,
      blocks: [],
      ownerId: OWNER,
      targetMenuId: "target-menu",
    });
    expect(buildMenuPlannerDraftIdentityDigest(draft('{"events":["100m","200m"]}'))).not.toBe(
      buildMenuPlannerDraftIdentityDigest(draft('{"events":["200m","100m"]}')),
    );
  });

  it("persisted runningContextJson が malformed なら retry はfail closedする", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
    const first = await saveAiMenuDraft(input, deps());
    if (!first.ok) throw new Error(JSON.stringify(first.error));

    await prisma.menuTemplate.update({
      where: { id: first.menuId },
      data: { runningContextJson: "{malformed" },
    });
    const writes: string[] = [];
    const retry = await saveAiMenuDraft(input, {
      ...deps(),
      database: instrumentDatabase({ reads: [], writes }),
    });

    expect(retry).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED", code: "SAVE_FAILED" } });
    expect(writes).toEqual([]);
    expect(await countsFor(first.menuId)).toEqual({ menu: 1, blocks: 1, items: 1 });
  });

  it("Running only を fresh prescription と provenance で DRAFT 保存する", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const targetMenuId = targetIdOf(issued.signed.acceptToken!);

    clock = new Date(ACCEPTED_AT.getTime());
    const result = await saveAiMenuDraft({ token: issued.signed.acceptToken!, ownerId: OWNER }, deps());
    expect(result).toEqual({ ok: true, menuId: targetMenuId, status: "DRAFT", alreadySaved: false });

    const saved = await prisma.menuTemplate.findUnique({
      where: { id: targetMenuId },
      include: { blocks: { orderBy: { sortOrder: "asc" }, include: { items: { orderBy: { sortOrder: "asc" } } } } },
    });
    expect(saved?.status).toBe("DRAFT");
    expect(saved?.ownerId).toBe(OWNER);
    expect(saved?.blocks.map((block) => block.name)).toEqual(["主運動"]);
    expect(saved?.blocks[0]?.items).toHaveLength(1);
    const item = saved?.blocks[0]?.items[0];
    expect(item?.prescriptionKind).toBe("RUNNING_V2");
    expect(item?.exerciseId).toBeNull();
    const provenance = JSON.parse(item!.provenanceJson!) as {
      generatedBy: { proposer: { kind: string }; createdByCoach: boolean; acceptedByCoachAt: string | null };
      aiReason: string | null;
    };
    const prescription = JSON.parse(item!.prescriptionJson!) as {
      generatedBy: { proposer: { kind: string }; createdByCoach: boolean; acceptedByCoachAt: string | null };
    };
    expect(provenance.generatedBy).toEqual({
      proposer: { kind: "AI_PLANNER", provider: "VALIDATED_PROPOSAL", model: "DETERMINISTIC_PREVIEW_V1", requestId: "r12-a2-preview" },
      createdByCoach: false,
      acceptedByCoachAt: ACCEPTED_AT.toISOString(),
    });
    expect(provenance.aiReason).toBe("加速の質を確認するため");
    expect(prescription.generatedBy.acceptedByCoachAt).toBe(ACCEPTED_AT.toISOString());
    expect(JSON.stringify(saved)).not.toContain("保存されない raw coach prompt のテスト文字列");
  });

  it("non-Running Exercise は fresh legacy prescription と関連付けだけを保存する", async () => {
    const { source, exercise } = await setup();
    const issued = await issue(source.id, exerciseProposal(exercise.id));
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const targetMenuId = targetIdOf(issued.signed.acceptToken!);

    const result = await saveAiMenuDraft({ token: issued.signed.acceptToken!, ownerId: OWNER }, deps());
    expect(result.ok).toBe(true);
    const saved = await prisma.menuTemplate.findUnique({
      where: { id: targetMenuId },
      include: { blocks: { include: { items: true } } },
    });
    const item = saved?.blocks[0]?.items[0];
    expect(item?.exerciseId).toBe(exercise.id);
    expect(item?.prescriptionKind).toBe("LEGACY");
    expect(item?.runningMethod).toBeNull();
    expect(item?.prescriptionJson).toBeNull();
    expect(item?.provenanceJson).toBeNull();
    expect(item?.rationale).toBeNull();
    expect(JSON.stringify(item)).not.toContain("動作の質を整えるため");
  });

  it("hybrid の block/item 順を保ち、source menuを変更しない", async () => {
    const { source, sourceExercise, exercise } = await setup();
    const before = await prisma.menuTemplate.findUnique({
      where: { id: source.id },
      include: { blocks: { include: { items: true } } },
    });
    const issued = await issue(source.id, hybridProposal(exercise.id, sourceExercise.id));
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const result = await saveAiMenuDraft({ token: issued.signed.acceptToken!, ownerId: OWNER }, deps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    const saved = await prisma.menuTemplate.findUnique({
      where: { id: result.menuId },
      include: { blocks: { orderBy: { sortOrder: "asc" }, include: { items: { orderBy: { sortOrder: "asc" } } } } },
    });
    expect(saved?.blocks.map((block) => block.name)).toEqual(["ウォームアップ", "主運動", "補強"]);
    expect(saved?.blocks.flatMap((block) => block.items.map((item) => item.sortOrder))).toEqual([0, 0, 0]);
    expect(saved?.blocks[0]?.items[0]?.exerciseId).toBe(exercise.id);
    expect(saved?.blocks[1]?.items[0]?.prescriptionKind).toBe("RUNNING_V2");
    const after = await prisma.menuTemplate.findUnique({
      where: { id: source.id },
      include: { blocks: { include: { items: true } } },
    });
    expect(after).toEqual(before);
  });

  it("同じ valid token の retry は既存 target を返し、重複 rows を作らない", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
    const first = await saveAiMenuDraft(input, deps());
    expect(first.ok).toBe(true);
    const targetMenuId = targetIdOf(input.token);
    const before = await countsFor(targetMenuId);
    const writes: string[] = [];
    const second = await saveAiMenuDraft(input, { ...deps(), database: instrumentDatabase({ reads: [], writes }) });
    expect(second).toEqual({ ok: true, menuId: targetMenuId, status: "DRAFT", alreadySaved: true });
    expect(await countsFor(targetMenuId)).toEqual(before);
    expect(writes).toEqual([]);
  });

  it("保存済みtokenのsource menu drift後retryはalreadySavedで、保存済み階層を変更しない", async () => {
    for (const mutation of ["rename", "archive", "delete"] as const) {
      await resetDb();
      const { source } = await setup();
      const issued = await issue(source.id, runningProposal());
      if (!issued.ok) throw new Error(`${mutation}: ${JSON.stringify(issued.error)}`);
      const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
      const first = await saveAiMenuDraft(input, deps());
      if (!first.ok) throw new Error(`${mutation}: ${JSON.stringify(first.error)}`);

      const before = await prisma.menuTemplate.findUnique({
        where: { id: first.menuId },
        include: { blocks: { orderBy: { sortOrder: "asc" }, include: { items: { orderBy: { sortOrder: "asc" } } } } },
      });
      if (mutation === "rename") {
        await prisma.menuTemplate.update({ where: { id: source.id }, data: { name: "参照メニュー変更後" } });
      } else if (mutation === "archive") {
        await prisma.menuTemplate.update({ where: { id: source.id }, data: { status: "ARCHIVED" } });
      } else {
        await prisma.menuTemplate.delete({ where: { id: source.id } });
      }

      const writes: string[] = [];
      const retry = await saveAiMenuDraft(input, { ...deps(), database: instrumentDatabase({ reads: [], writes }) });
      const after = await prisma.menuTemplate.findUnique({
        where: { id: first.menuId },
        include: { blocks: { orderBy: { sortOrder: "asc" }, include: { items: { orderBy: { sortOrder: "asc" } } } } },
      });
      expect(retry, mutation).toEqual({ ok: true, menuId: first.menuId, status: "DRAFT", alreadySaved: true });
      expect(after, mutation).toEqual(before);
      expect(writes, mutation).toEqual([]);
    }
  });

  it("保存済みtokenのExercise catalog drift後retryはalreadySavedで、doseを更新しない", async () => {
    const { source, exercise } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
    const first = await saveAiMenuDraft(input, deps());
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const before = await countsFor(first.menuId);
    await prisma.exercise.update({ where: { id: exercise.id }, data: { defaultDistanceMeters: 999 } });

    const writes: string[] = [];
    const retry = await saveAiMenuDraft(input, { ...deps(), database: instrumentDatabase({ reads: [], writes }) });
    expect(retry).toEqual({ ok: true, menuId: first.menuId, status: "DRAFT", alreadySaved: true });
    expect(await countsFor(first.menuId)).toEqual(before);
    expect(writes).toEqual([]);
  });

  it("保存済みtokenのLoad History / Competition drift後retryはalreadySaved", async () => {
    for (const mutation of ["history", "competition"] as const) {
      await resetDb();
      const { source } = await setup();
      const issued = await issue(source.id, runningProposal());
      if (!issued.ok) throw new Error(JSON.stringify(issued.error));
      const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
      const first = await saveAiMenuDraft(input, deps());
      if (!first.ok) throw new Error(`${mutation}: ${JSON.stringify(first.error)}`);

      if (mutation === "history") {
        const session = await prisma.trainingSession.create({
          data: { ownerId: OWNER, date: new Date("2026-09-18T10:00:00.000Z"), title: "直前練習", status: "COMPLETED" },
        });
        await prisma.sessionItem.create({
          data: {
            trainingSessionId: session.id,
            exerciseNameSnapshot: "加速走",
            blockNameSnapshot: "主運動",
            sortOrder: 0,
            prescriptionKind: "LEGACY",
            done: true,
            plannedSets: 5,
            plannedDistanceMeters: 30,
            plannedRestSeconds: 300,
          },
        });
      } else {
        await prisma.competition.create({
          data: { ownerId: OWNER, name: "県大会", date: new Date("2026-09-22T00:00:00.000Z"), priority: "PEAK" },
        });
      }

      const writes: string[] = [];
      const retry = await saveAiMenuDraft(input, { ...deps(), database: instrumentDatabase({ reads: [], writes }) });
      expect(retry, mutation).toEqual({ ok: true, menuId: first.menuId, status: "DRAFT", alreadySaved: true });
      expect(writes, mutation).toEqual([]);
    }
  });

  it("unrelated same-owner targetはcontext driftがあってもalreadySavedにしない", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const targetMenuId = targetIdOf(issued.signed.acceptToken!);
    await prisma.menuTemplate.update({ where: { id: source.id }, data: { status: "ARCHIVED" } });
    await prisma.menuTemplate.create({
      data: { id: targetMenuId, ownerId: OWNER, name: "無関係な手動メニュー", status: "DRAFT" },
    });

    const writes: string[] = [];
    const retry = await saveAiMenuDraft(
      { token: issued.signed.acceptToken!, ownerId: OWNER },
      { ...deps(), database: instrumentDatabase({ reads: [], writes }) },
    );
    expect(retry).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED", code: "SAVE_FAILED" } });
    expect(writes).toEqual([]);
  });

  it("same-owner target の status REVIEWED は alreadySaved にしない", async () => {
    await assertMismatchedExistingTarget(async (targetMenuId) => {
      await prisma.menuTemplate.update({ where: { id: targetMenuId }, data: { status: "REVIEWED" } });
    });
  });

  it("same-owner DRAFT target の menu name 不一致は alreadySaved にしない", async () => {
    await assertMismatchedExistingTarget(async (targetMenuId) => {
      await prisma.menuTemplate.update({ where: { id: targetMenuId }, data: { name: "別の手動メニュー" } });
    });
  });

  it("same-owner DRAFT target の block/item hierarchy 不一致は alreadySaved にしない", async () => {
    await assertMismatchedExistingTarget(async (targetMenuId) => {
      await prisma.menuBlock.deleteMany({ where: { menuTemplateId: targetMenuId } });
    });
  });

  it("same-owner DRAFT target の dose 不一致は alreadySaved にしない", async () => {
    await assertMismatchedExistingTarget(async (targetMenuId) => {
      const item = await prisma.menuItem.findFirst({ where: { menuBlock: { menuTemplateId: targetMenuId } } });
      if (item === null) throw new Error("saved item not found");
      await prisma.menuItem.update({ where: { id: item.id }, data: { sets: 99 } });
    });
  });

  it("same-owner DRAFT target の Running provenance欠落は alreadySaved にしない", async () => {
    await assertMismatchedExistingTarget(async (targetMenuId) => {
      const item = await prisma.menuItem.findFirst({ where: { menuBlock: { menuTemplateId: targetMenuId } } });
      if (item === null) throw new Error("saved item not found");
      await prisma.menuItem.update({ where: { id: item.id }, data: { provenanceJson: null } });
    });
  });

  it("同じtokenの真の並行submitは1 hierarchyだけを作り、片方だけalreadySavedになる", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
    const targetMenuId = targetIdOf(input.token);

    const results = await Promise.all([
      saveAiMenuDraft(input, deps()),
      saveAiMenuDraft(input, deps()),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => result.ok && result.alreadySaved)).toHaveLength(1);
    expect(await countsFor(targetMenuId)).toEqual({ menu: 1, blocks: 1, items: 1 });
  });

  it("P2002 recovery は完全一致する既存hierarchyだけをalreadySavedにする", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
    const first = await saveAiMenuDraft(input, deps());
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const before = await countsFor(first.menuId);
    await prisma.menuTemplate.update({ where: { id: source.id }, data: { name: "参照メニュー変更後" } });

    const retry = await saveAiMenuDraft(input, { ...deps(), database: p2002AfterHiddenTargetDatabase() });
    expect(retry).toEqual({ ok: true, menuId: first.menuId, status: "DRAFT", alreadySaved: true });
    expect(await countsFor(first.menuId)).toEqual(before);
  });

  it("P2002 recovery は不一致hierarchyをalreadySavedにしない", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const input = { token: issued.signed.acceptToken!, ownerId: OWNER };
    const first = await saveAiMenuDraft(input, deps());
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const item = await prisma.menuItem.findFirst({ where: { menuBlock: { menuTemplateId: first.menuId } } });
    if (item === null) throw new Error("saved item not found");
    await prisma.menuItem.update({ where: { id: item.id }, data: { sets: 99 } });
    const before = await countsFor(first.menuId);

    const retry = await saveAiMenuDraft(input, { ...deps(), database: p2002AfterHiddenTargetDatabase() });
    expect(retry).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED", code: "SAVE_FAILED" } });
    expect(await countsFor(first.menuId)).toEqual(before);
  });

  it("targetMenuId が別 owner の既存 row を指す場合は fail closed して返さない", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const targetMenuId = targetIdOf(issued.signed.acceptToken!);
    await prisma.menuTemplate.create({
      data: { id: targetMenuId, ownerId: OTHER_OWNER, name: "他 owner の menu", status: "DRAFT" },
    });
    const result = await saveAiMenuDraft({ token: issued.signed.acceptToken!, ownerId: OWNER }, deps());
    expect(result).toMatchObject({ ok: false, error: { kind: "INVALID_INPUT" } });
    const existing = await prisma.menuTemplate.findUnique({ where: { id: targetMenuId } });
    expect(existing?.ownerId).toBe(OTHER_OWNER);
    expect(existing?.name).toBe("他 owner の menu");
  });

  it("source menu deleted / archived は accept-time stale で write 0", async () => {
    for (const mutation of ["delete", "archive", "owner-scope"] as const) {
      await resetDb();
      const { source } = await setup();
      const issued = await issue(source.id, runningProposal());
      if (!issued.ok) throw new Error(JSON.stringify(issued.error));
      const targetMenuId = targetIdOf(issued.signed.acceptToken!);
      if (mutation === "delete") {
        await prisma.menuTemplate.delete({ where: { id: source.id } });
      } else if (mutation === "archive") {
        await prisma.menuTemplate.update({ where: { id: source.id }, data: { status: "ARCHIVED" } });
      } else {
        await prisma.menuTemplate.update({ where: { id: source.id }, data: { ownerId: OTHER_OWNER } });
      }
      const result = await saveAiMenuDraft({ token: issued.signed.acceptToken!, ownerId: OWNER }, deps());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("save unexpectedly succeeded");
      expect(result.error.kind).toBe("STALE_PREVIEW");
      expect(await countsFor(targetMenuId)).toEqual({ menu: 0, blocks: 0, items: 0 });
    }
  });

  it("Exercise の削除・status変更は catalog stale で write 0", async () => {
    for (const mutation of ["delete", "draft"] as const) {
      await resetDb();
      const { source, exercise } = await setup();
      const issued = await issue(source.id, exerciseProposal(exercise.id));
      if (!issued.ok) throw new Error(JSON.stringify(issued.error));
      const targetMenuId = targetIdOf(issued.signed.acceptToken!);
      if (mutation === "delete") {
        await prisma.exercise.delete({ where: { id: exercise.id } });
      } else {
        await prisma.exercise.update({ where: { id: exercise.id }, data: { status: "DRAFT" } });
      }
      const result = await saveAiMenuDraft({ token: issued.signed.acceptToken!, ownerId: OWNER }, deps());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("save unexpectedly succeeded");
      expect(result.error.kind).toBe("STALE_PREVIEW");
      expect(await countsFor(targetMenuId)).toEqual({ menu: 0, blocks: 0, items: 0 });
    }
  });

  it("runningContext / planned date-time のaccept-time invalidationは stale で write 0", async () => {
    const mutations = [
      {
        name: "runningContext removed",
        apply: (sourceId: string) => prisma.menuTemplate.update({ where: { id: sourceId }, data: { runningContextJson: null } }),
      },
      {
        name: "runningContext malformed",
        apply: (sourceId: string) => prisma.menuTemplate.update({ where: { id: sourceId }, data: { runningContextJson: "{not-json" } }),
      },
      {
        name: "plannedDate invalidated",
        apply: (sourceId: string) => prisma.menuTemplate.update({
          where: { id: sourceId },
          data: { runningContextJson: JSON.stringify({ ...runningContext(), plannedDate: null, plannedAt: null }) },
        }),
      },
      {
        name: "plannedAt invalidated",
        apply: (sourceId: string) => prisma.menuTemplate.update({
          where: { id: sourceId },
          data: { runningContextJson: JSON.stringify({ ...runningContext(), plannedAt: "not-a-time" }) },
        }),
      },
    ] as const;
    for (const mutation of mutations) {
      await resetDb();
      const { source } = await setup();
      const issued = await issue(source.id, runningProposal());
      if (!issued.ok) throw new Error(`${mutation.name}: ${JSON.stringify(issued.error)}`);
      const targetMenuId = targetIdOf(issued.signed.acceptToken!);
      await mutation.apply(source.id);
      const result = await saveAiMenuDraft({ token: issued.signed.acceptToken!, ownerId: OWNER }, deps());
      expect(result, mutation.name).toMatchObject({ ok: false, error: { kind: "STALE_PREVIEW" } });
      expect(await countsFor(targetMenuId)).toEqual({ menu: 0, blocks: 0, items: 0 });
    }
  });

  it("phase / availableMinutes のaccept-time constraint rejectionは stale で write 0", async () => {
    const phaseCase = await setup();
    const phaseIssued = await issue(phaseCase.source.id, runningProposal());
    if (!phaseIssued.ok) throw new Error(JSON.stringify(phaseIssued.error));
    const phaseTarget = targetIdOf(phaseIssued.signed.acceptToken!);
    await prisma.menuTemplate.update({ where: { id: phaseCase.source.id }, data: { phase: "TRANSITION" } });
    const phaseResult = await saveAiMenuDraft({ token: phaseIssued.signed.acceptToken!, ownerId: OWNER }, deps());
    expect(phaseResult).toMatchObject({ ok: false, error: { kind: "STALE_PREVIEW" } });
    expect(await countsFor(phaseTarget)).toEqual({ menu: 0, blocks: 0, items: 0 });

    await resetDb();
    const timeCase = await setup();
    const constrainedIntent = {
      ...intent(),
      constraints: { ...intent().constraints, availableMinutes: 120 },
    };
    const timeIssued = await issue(timeCase.source.id, runningProposal(), {}, constrainedIntent);
    if (!timeIssued.ok) throw new Error(JSON.stringify(timeIssued.error));
    const timeTarget = targetIdOf(timeIssued.signed.acceptToken!);
    await prisma.menuTemplate.update({
      where: { id: timeCase.source.id },
      data: { runningContextJson: JSON.stringify(runningContext(90)) },
    });
    const timeResult = await saveAiMenuDraft({ token: timeIssued.signed.acceptToken!, ownerId: OWNER }, deps());
    expect(timeResult).toMatchObject({ ok: false, error: { kind: "STALE_PREVIEW" } });
    expect(await countsFor(timeTarget)).toEqual({ menu: 0, blocks: 0, items: 0 });
  });

  it("expiry と owner mismatch は保存せず、owner mismatch は context read もしない", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const expiredTarget = targetIdOf(issued.signed.acceptToken!);
    clock = new Date(ISSUED_AT.getTime() + TTL_MS);
    const expired = await saveAiMenuDraft({ token: issued.signed.acceptToken!, ownerId: OWNER }, deps());
    expect(expired).toMatchObject({ ok: false, error: { kind: "STALE_PREVIEW" } });
    expect(await countsFor(expiredTarget)).toEqual({ menu: 0, blocks: 0, items: 0 });

    clock = new Date(ISSUED_AT.getTime());
    const second = await issue(source.id, runningProposal());
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    const reads: string[] = [];
    const writes: string[] = [];
    const result = await saveAiMenuDraft(
      { token: second.signed.acceptToken!, ownerId: OTHER_OWNER },
      { ...deps(), database: instrumentDatabase({ reads, writes }) },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "INVALID_INPUT" } });
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("source read failure は staleにせず safe PLANNING_REJECTEDへ落とす", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const reads: string[] = [];
    const writes: string[] = [];
    const result = await saveAiMenuDraft(
      { token: issued.signed.acceptToken!, ownerId: OWNER },
      { ...deps(), database: instrumentDatabase({ reads, writes, failure: { model: "menuTemplate", method: "findFirst" } }) },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED", code: "CONTEXT_MENU_READ_FAILED" } });
    expect(result.ok ? "" : result.error.message).not.toContain("injected repository failure");
    expect(writes).toEqual([]);
  });

  it("same context の unexpected planner failure は staleにしない", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const targetMenuId = targetIdOf(issued.signed.acceptToken!);
    plannerFailure.value = true;
    const writes: string[] = [];
    const result = await saveAiMenuDraft(
      { token: issued.signed.acceptToken!, ownerId: OWNER },
      { ...deps(), database: instrumentDatabase({ writes, reads: [] }) },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "PLANNING_REJECTED", code: "DETERMINISTIC_PLANNING_FAILED" } });
    expect(await countsFor(targetMenuId)).toEqual({ menu: 0, blocks: 0, items: 0 });
    expect(writes).toEqual([]);
  });

  it("MenuBlock create failure は MenuTemplate も含めて atomic rollback", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const targetMenuId = targetIdOf(issued.signed.acceptToken!);
    const writes: string[] = [];
    const result = await saveAiMenuDraft(
      { token: issued.signed.acceptToken!, ownerId: OWNER },
      { ...deps(), database: instrumentDatabase({ writes, reads: [], failure: { model: "menuBlock", method: "create" } }) },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED" } });
    expect(writes).toContain("menuTemplate.create");
    expect(writes).toContain("menuBlock.create");
    expect(await countsFor(targetMenuId)).toEqual({ menu: 0, blocks: 0, items: 0 });
  });

  it("MenuItem create failure after multiple blocks は全階層を atomic rollback", async () => {
    const { source, sourceExercise, exercise } = await setup();
    const issued = await issue(source.id, hybridProposal(exercise.id, sourceExercise.id));
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const targetMenuId = targetIdOf(issued.signed.acceptToken!);
    const writes: string[] = [];
    const result = await saveAiMenuDraft(
      { token: issued.signed.acceptToken!, ownerId: OWNER },
      { ...deps(), database: instrumentDatabase({ writes, reads: [], failure: { model: "menuItem", method: "create" } }) },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "SAVE_FAILED" } });
    expect(writes.filter((write) => write === "menuBlock.create")).toHaveLength(1);
    expect(writes).toContain("menuItem.create");
    expect(await countsFor(targetMenuId)).toEqual({ menu: 0, blocks: 0, items: 0 });
  });

  it("save path の write model は MenuTemplate / MenuBlock / MenuItem だけ", async () => {
    const { source } = await setup();
    const issued = await issue(source.id, runningProposal());
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    const writes: string[] = [];
    const result = await saveAiMenuDraft(
      { token: issued.signed.acceptToken!, ownerId: OWNER },
      { ...deps(), database: instrumentDatabase({ writes, reads: [] }) },
    );
    expect(result.ok).toBe(true);
    expect(new Set(writes)).toEqual(new Set(["menuTemplate.create", "menuBlock.create", "menuItem.create"]));
  });
});
