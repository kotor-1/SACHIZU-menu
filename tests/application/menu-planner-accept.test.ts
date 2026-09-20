/**
 * [R12-A3A] signed preview accept token の application boundary。
 *
 * 確認すること:
 *   - 発行は saveable な preview のときだけ。使えない token を捏造しない。
 *   - 改変・別 owner・期限切れは signature / 期限で落ち、DB を読まない。
 *   - accept 時は authoritative context を **再読込して A2 を再実行** し、binding の両 gate を比較する。
 *   - 発行も再検証も DB write 0。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// spies / overrides
// ---------------------------------------------------------------------------

const plannerRequests = vi.hoisted(() => [] as Record<string, unknown>[]);
const plannerFailure = vi.hoisted(() => ({ value: false }));
vi.mock("@/domain/running/planning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/running/planning")>();
  return {
    ...actual,
    planRunningPrescriptionWithRuleSet: (request: unknown, resolved: unknown) => {
      plannerRequests.push(request as Record<string, unknown>);
      if (plannerFailure.value) throw new Error("simulated deterministic planner failure");
      return (actual.planRunningPrescriptionWithRuleSet as (a: unknown, b: unknown) => unknown)(request, resolved);
    },
  };
});

const dbOps = vi.hoisted(() => [] as string[]);
const menuReadFailure = vi.hoisted(() => ({ value: false }));
const WRITE_ACTIONS = vi.hoisted(
  () =>
    new Set([
      "create",
      "createMany",
      "createManyAndReturn",
      "update",
      "updateMany",
      "updateManyAndReturn",
      "delete",
      "deleteMany",
      "upsert",
      "executeRaw",
      "executeRawUnsafe",
    ]),
);
vi.mock("@/infra/db/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/infra/db/prisma")>();
  const real = actual.prisma as unknown as Record<string, unknown>;
  const wrapDelegate = (name: string, delegate: unknown) =>
    new Proxy(delegate as object, {
      get(target, prop) {
        const fn = Reflect.get(target, prop);
        if (typeof fn === "function") {
          return (...args: unknown[]) => {
            if (name === "menuTemplate" && prop === "findFirst" && menuReadFailure.value) {
              throw new Error("simulated menu read failure");
            }
            if (typeof prop === "string") dbOps.push(WRITE_ACTIONS.has(prop) ? `WRITE:${name}.${prop}` : `${name}.${prop}`);
            return (fn as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return fn;
      },
    });
  /**
   * `$` 付き（`$executeRaw` / `$executeRawUnsafe` / `$queryRaw` / `$transaction` …）も必ず記録する。
   * ここを素通しにすると「raw write が 0」を証明できない（A2 側の同型 proxy はこの穴がある）。
   */
  const RAW_WRITE_MEMBERS = new Set(["$executeRaw", "$executeRawUnsafe"]);
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && !prop.startsWith("_") && value !== null && typeof value === "object") {
        return wrapDelegate(prop, value);
      }
      if (typeof prop === "string" && typeof value === "function") {
        return (...args: unknown[]) => {
          dbOps.push(RAW_WRITE_MEMBERS.has(prop) ? `WRITE:prisma.${prop}` : `prisma.${prop}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });
  return { ...actual, prisma: proxy };
});

/** RuleSet の内容 hash を差し替えて「RuleSet が入れ替わった」状況を作る（静的 JSON は書き換えない）。 */
const ruleSetHashOverride = vi.hoisted(() => ({ value: null as string | null }));
const ruleSetStatusOverride = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/domain/running/rules/loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/running/rules/loader")>();
  return {
    ...actual,
    getActiveRuleSet: (at: never) => {
      const result = actual.getActiveRuleSet(at);
      if (ruleSetHashOverride.value === null && ruleSetStatusOverride.value === null) return result;
      return {
        ...result,
        contentHash: ruleSetHashOverride.value ?? result.contentHash,
        ruleSet:
          ruleSetStatusOverride.value === null
            ? result.ruleSet
            : { ...result.ruleSet, status: ruleSetStatusOverride.value as never },
      };
    },
  };
});

/**
 * 再計算結果の materializationDigest だけを差し替える。
 * 「authoritative context は同一なのに materialization semantics が変わった」＝ digest gate だけが落ちる状況を
 * 人工的に作るための注入（item 67 の application 版）。実装の再計算は本物を通す。
 */
const digestOverride = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/application/menu-planner/preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/application/menu-planner/preview")>();
  return {
    ...actual,
    // 引数は **必ず本物へ全部渡す**（取りこぼすと replay が効かず、実装ではなく mock を検証してしまう）。
    buildMenuPlannerPreviewForRevalidation: async (input: never, replay?: never) => {
      const result = await actual.buildMenuPlannerPreviewForRevalidation(input, replay);
      if (!result.ok || digestOverride.value === null) return result;
      return {
        ...result,
        preview: { ...result.preview, binding: { ...result.preview.binding, materializationDigest: digestOverride.value } },
      };
    },
  };
});

import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { prisma } from "@/infra/db/prisma";
import { verifyHmacToken } from "@/infra/security/hmac-token";
import {
  issueMenuPlannerSignedPreview,
  revalidateMenuPlannerAccept,
  type MenuPlannerAcceptDependencies,
} from "@/application/menu-planner/accept";
import { buildMenuPlannerPreviewForRevalidation } from "@/application/menu-planner/preview";
import { makeExercise, resetDb } from "../helpers";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const KEY = "a3a-test-signing-key-0123456789-abcdef"; // 32+ bytes, test only
const TTL_MS = 2 * 60 * 60 * 1000;
const ISSUED_AT = new Date("2026-09-20T07:00:00.000Z");

let clock = new Date(ISSUED_AT.getTime());
let idCounter = 0;

function deps(overrides: Partial<MenuPlannerAcceptDependencies> = {}): MenuPlannerAcceptDependencies {
  return {
    signingKey: KEY,
    now: () => new Date(clock.getTime()),
    tokenTtlMs: TTL_MS,
    generateId: () => `id-${(idCounter += 1)}`,
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

async function createContextMenu(sourceExerciseId: string, ctx: unknown = runningContext()) {
  return prisma.menuTemplate.create({
    data: {
      ownerId: DEFAULT_OWNER_ID,
      name: "参照メニュー",
      phase: "PREPARATION",
      status: "DRAFT",
      runningContextJson: JSON.stringify(ctx),
      blocks: {
        create: {
          name: "既存ブロック",
          sortOrder: 0,
          items: { create: { exerciseId: sourceExerciseId, displayName: "既存", sortOrder: 0, sets: 2, distanceMeters: 20 } },
        },
      },
    },
  });
}

/** saveable な preview になる proposal。 */
function saveableProposal(exerciseId: string) {
  return {
    schemaVersion: 1,
    items: [
      { kind: "EXERCISE", proposal: { blockName: "主運動", exerciseId, reason: "動作の質を整えるため" } },
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
    ],
    question: null,
  };
}

async function setup() {
  const sourceExercise = await makeExercise({ name: "参照用種目" });
  const menu = await createContextMenu(sourceExercise.id);
  const drill = await makeExercise({ name: "ドリル", defaultDistanceMeters: 30 });
  return { sourceExercise, menu, drill };
}

async function issue(
  drillId: string,
  menuId: string,
  overrides: Partial<MenuPlannerAcceptDependencies> = {},
  inputOverrides: { intent?: unknown; proposal?: unknown } = {},
) {
  return issueMenuPlannerSignedPreview(
    {
      ownerId: DEFAULT_OWNER_ID,
      contextMenuTemplateId: menuId,
      menuName: "コーチ作成メニュー",
      intent: inputOverrides.intent ?? intent(),
      proposal: inputOverrides.proposal ?? saveableProposal(drillId),
    },
    deps(overrides),
  );
}

/** server-only な revalidation source（公開 entry の結果には含まれない）。 */
async function revalidationSource(menuId: string, drillId: string) {
  const result = await buildMenuPlannerPreviewForRevalidation({
    schemaVersion: 1,
    ownerId: DEFAULT_OWNER_ID,
    contextMenuTemplateId: menuId,
    menuName: "コーチ作成メニュー",
    intent: intent() as never,
    proposal: saveableProposal(drillId),
  });
  if (!result.ok) throw new Error("revalidation source failed");
  return result.revalidation;
}

/** 発行済み token の claim を取り出す（テスト用に同じ鍵で復号する）。 */
function claimsOf(token: string): Record<string, unknown> {
  const verified = verifyHmacToken(token, KEY);
  if (!verified.ok) throw new Error("token did not verify");
  return JSON.parse(verified.payload) as Record<string, unknown>;
}

beforeEach(async () => {
  await resetDb();
  clock = new Date(ISSUED_AT.getTime());
  idCounter = 0;
  plannerRequests.length = 0;
  plannerFailure.value = false;
  dbOps.length = 0;
  menuReadFailure.value = false;
  ruleSetHashOverride.value = null;
  ruleSetStatusOverride.value = null;
  digestOverride.value = null;
});

// ---------------------------------------------------------------------------

describe("R12-A3A issue", () => {
  it("saveable な preview にだけ accept token を発行する", async () => {
    const { menu, drill } = await setup();
    const result = await issue(drill.id, menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.signed.preview.canSave).toBe(true);
    expect(typeof result.signed.acceptToken).toBe("string");

    const claims = claimsOf(result.signed.acceptToken!);
    expect(claims.schemaVersion).toBe(1);
    expect(claims.ownerId).toBe(DEFAULT_OWNER_ID);
    expect(claims.contextMenuTemplateId).toBe(menu.id);
    expect(claims.menuName).toBe("コーチ作成メニュー");
    expect(claims.intent).toBeUndefined();
    expect(claims.constraints).toEqual(intent().constraints);
    expect(claims.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(claims.contextFingerprint).toBe(result.signed.preview.binding.contextFingerprint);
    expect(claims.materializationDigest).toBe(result.signed.preview.binding.materializationDigest);
    expect(claims.savedDraftIdentityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(claims.issuedAt).toBe("2026-09-20T07:00:00.000Z");
    expect(claims.expiresAt).toBe(new Date(ISSUED_AT.getTime() + TTL_MS).toISOString());
    const source = await revalidationSource(menu.id, drill.id);
    expect(claims.ruleSet).toEqual(source.ruleSet);
    expect(claims.planner).toEqual(source.planner);
  });

  it("requestDigest は canonical request の binding であり、raw requestText を token に載せない", async () => {
    const { menu, drill } = await setup();
    const sameA = await issue(drill.id, menu.id);
    const sameB = await issue(drill.id, menu.id);
    const changedText = await issue(drill.id, menu.id, {}, {
      intent: { ...intent(), requestText: "別のrequestText" },
    });
    const changedConstraint = await issue(drill.id, menu.id, {}, {
      intent: {
        ...intent(),
        constraints: { ...intent().constraints, availableMinutes: 120 },
      },
    });
    if (!sameA.ok || !sameB.ok || !changedText.ok || !changedConstraint.ok) throw new Error("issue failed");

    const sameClaimsA = claimsOf(sameA.signed.acceptToken!);
    const sameClaimsB = claimsOf(sameB.signed.acceptToken!);
    const changedTextClaims = claimsOf(changedText.signed.acceptToken!);
    const changedConstraintClaims = claimsOf(changedConstraint.signed.acceptToken!);
    expect(sameClaimsA.requestDigest).toBe(sameClaimsB.requestDigest);
    expect(changedTextClaims.requestDigest).not.toBe(sameClaimsA.requestDigest);
    expect(changedConstraintClaims.requestDigest).not.toBe(sameClaimsA.requestDigest);
    // requestDigest は lineage binding のみ。raw requestText の変更で処方 authority は変わらない。
    expect(changedText.signed.preview.binding.materializationDigest).toBe(sameA.signed.preview.binding.materializationDigest);

    const payload = verifyHmacToken(sameA.signed.acceptToken!, KEY);
    if (!payload.ok) throw new Error("token did not verify");
    expect(payload.payload).not.toContain("requestText");
    expect(payload.payload).not.toContain("短距離の練習メニューを作成");
    const replay = await revalidateMenuPlannerAccept(
      { token: sameA.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID },
      deps(),
    );
    expect(replay.ok).toBe(true);
  });

  it("saveable でない preview には token を発行しない（preview は返す）", async () => {
    const { menu } = await setup();
    const result = await issueMenuPlannerSignedPreview(
      {
        ownerId: DEFAULT_OWNER_ID,
        contextMenuTemplateId: menu.id,
        menuName: "コーチ作成メニュー",
        intent: intent(),
        proposal: {
          schemaVersion: 1,
          items: [
            {
              kind: "RUNNING",
              proposal: {
                blockName: "主運動",
                method: "ACCELERATION",
                templateId: "ACC_BLOCK_10",
                positionPreference: null,
                reason: "r",
              },
            },
          ],
          question: null,
        },
      },
      deps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("issue failed");
    expect(result.signed.preview.canSave).toBe(false);
    expect(result.signed.acceptToken).toBeNull();
  });

  it("planner の error は A3A の kind へ畳んで返す（raw 例外を出さない）", async () => {
    const { menu } = await setup();
    const result = await issueMenuPlannerSignedPreview(
      {
        ownerId: DEFAULT_OWNER_ID,
        contextMenuTemplateId: menu.id,
        menuName: "m",
        intent: intent(),
        proposal: { schemaVersion: 1, items: [{ kind: "EXERCISE", proposal: { blockName: "b", exerciseId: "does-not-exist", reason: "r" } }], question: null },
      },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.error.kind).toBe("INVALID_INPUT");
    expect(result.error.code).toBe("PROPOSAL_CATALOG_INVALID");
  });

  it("署名鍵は fail closed（空・短すぎる鍵では署名しない）", async () => {
    const { menu, drill } = await setup();
    await expect(issue(drill.id, menu.id, { signingKey: "" })).rejects.toThrow();
    await expect(issue(drill.id, menu.id, { signingKey: "short" })).rejects.toThrow();
  });

  it("TTL は注入値で決まり、domain の固定値ではない", async () => {
    const { menu, drill } = await setup();
    const short = await issue(drill.id, menu.id, { tokenTtlMs: 60_000 });
    expect(short.ok).toBe(true);
    if (!short.ok) throw new Error("issue failed");
    expect(claimsOf(short.signed.acceptToken!).expiresAt).toBe(new Date(ISSUED_AT.getTime() + 60_000).toISOString());
    await expect(issue(drill.id, menu.id, { tokenTtlMs: 0 })).rejects.toThrow();
  });

  it("previewId / targetMenuId は毎回 server 生成され、binding へ混ざらない", async () => {
    const { menu, drill } = await setup();
    // 同一の authoritative context のまま 2 回発行する。identity だけが変わる。
    const first = await issue(drill.id, menu.id);
    const second = await issue(drill.id, menu.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("issue failed");
    const a = claimsOf(first.signed.acceptToken!);
    const b = claimsOf(second.signed.acceptToken!);

    // identity は server 生成で毎回新しい（counter を戻さない = 固定値では通らない assertion）
    expect(a.previewId).not.toBe(b.previewId);
    expect(a.targetMenuId).not.toBe(b.targetMenuId);

    // identity が変わっても binding は変わらない（random を digest / fingerprint に混ぜていない）
    expect(a.contextFingerprint).toBe(b.contextFingerprint);
    expect(a.materializationDigest).toBe(b.materializationDigest);
    expect(a.contextFingerprint).toBe(first.signed.preview.binding.contextFingerprint);
    expect(a.materializationDigest).toBe(first.signed.preview.binding.materializationDigest);
  });
});

describe("R12-A3A revalidate — token integrity", () => {
  it("改変されていない token は fresh として通り、再計算 material を返す", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");

    const result = await revalidateMenuPlannerAccept({ token: issued.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID }, deps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.preview.binding.contextFingerprint).toBe(issued.signed.preview.binding.contextFingerprint);
    expect(result.materialization.materializationDigest).toBe(issued.signed.preview.binding.materializationDigest);
    const source = await revalidationSource(menu.id, drill.id);
    expect(result.materialization.ruleSet).toEqual(source.ruleSet);
    expect(result.materialization.sanitizedProposal).toEqual(source.sanitizedProposal);
  });

  it("payload を 1 byte 変えた token は INVALID_INPUT", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    const [payload, signature] = issued.signed.acceptToken!.split(".");
    const decoded = Buffer.from(payload!, "base64url");
    // JSON のどこかを書き換える（署名はそのまま）
    const text = decoded.toString("utf8");
    const tampered = Buffer.from(text.replace("コーチ作成メニュー", "別のメニュー名!"), "utf8").toString("base64url");
    const result = await revalidateMenuPlannerAccept({ token: `${tampered}.${signature!}`, ownerId: DEFAULT_OWNER_ID }, deps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.error.kind).toBe("INVALID_INPUT");
    expect(result.error.code).toBe("ACCEPT_TOKEN_SIGNATURE_INVALID");
  });

  it("digest claim だけ書き換えた token も INVALID_INPUT（STALE ではない）", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    const claims = claimsOf(issued.signed.acceptToken!);
    // 攻撃者は署名鍵を持たないので、payload だけ差し替えて既存の signature を流用する。
    // digest claim を書き換えても signature が合わないため INVALID_INPUT（STALE ではない）。
    const forged = { ...claims, materializationDigest: "f".repeat(64) };
    const payload = Buffer.from(JSON.stringify(forged), "utf8").toString("base64url");
    const [, signature] = issued.signed.acceptToken!.split(".");
    const result = await revalidateMenuPlannerAccept({ token: `${payload}.${signature!}`, ownerId: DEFAULT_OWNER_ID }, deps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.error.kind).toBe("INVALID_INPUT");
  });

  it("壊れた token は例外を投げず INVALID_INPUT（signature の詳細を出さない）", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    // 有効な token から signature だけ差し替えた「構造は正しいが署名が違う」ケースを必ず含める。
    const [validPayload, validSignature] = issued.signed.acceptToken!.split(".");
    const forged = Buffer.alloc(32, 9).toString("base64url");
    const cases: { token: string; code: string }[] = [
      { token: "", code: "ACCEPT_TOKEN_MALFORMED" },
      { token: "no-dot", code: "ACCEPT_TOKEN_MALFORMED" },
      { token: "a.b", code: "ACCEPT_TOKEN_MALFORMED" },
      { token: "!!!.###", code: "ACCEPT_TOKEN_MALFORMED" },
      { token: "x".repeat(40_000), code: "ACCEPT_TOKEN_MALFORMED" },
      // signature だけ差し替え（MALFORMED ではなく SIGNATURE_INVALID に落ちる）
      { token: `${validPayload}.${forged}`, code: "ACCEPT_TOKEN_SIGNATURE_INVALID" },
    ];

    const messagesByCode = new Map<string, Set<string>>();
    for (const { token, code } of cases) {
      const result = await revalidateMenuPlannerAccept({ token, ownerId: DEFAULT_OWNER_ID }, deps());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("should fail");
      expect(result.error.kind).toBe("INVALID_INPUT");
      expect(result.error.code).toBe(code);
      expect(result.error.message).not.toMatch(/[0-9a-f]{16,}/u);
      const set = messagesByCode.get(code) ?? new Set<string>();
      set.add(result.error.message);
      messagesByCode.set(code, set);
    }
    // code ごとに文言は 1 つに固定される（失敗の種類ごとに増殖しない）
    for (const set of messagesByCode.values()) expect(set.size).toBe(1);
    expect(messagesByCode.size).toBe(2);

    // 末尾1文字削除は、残ったbase64urlのtrailing bitによって
    // MALFORMEDまたはsignature length mismatchのいずれにもなりうる。
    // どちらもINVALID_INPUTであり、受理されないことが契約上の要件。
    const truncated = await revalidateMenuPlannerAccept(
      { token: `${validPayload}.${validSignature!.slice(0, -1)}`, ownerId: DEFAULT_OWNER_ID },
      deps(),
    );
    expect(truncated.ok).toBe(false);
    if (truncated.ok) throw new Error("should fail");
    expect(truncated.error.kind).toBe("INVALID_INPUT");
    expect(["ACCEPT_TOKEN_MALFORMED", "ACCEPT_TOKEN_SIGNATURE_INVALID"]).toContain(truncated.error.code);
  });

  it("別 owner の token は INVALID_INPUT で、DB を一切読まない", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");

    dbOps.length = 0;
    const result = await revalidateMenuPlannerAccept({ token: issued.signed.acceptToken!, ownerId: "another-owner" }, deps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.error.kind).toBe("INVALID_INPUT");
    expect(result.error.code).toBe("ACCEPT_TOKEN_OWNER_MISMATCH");
    expect(dbOps).toEqual([]);
    // 署名不正でも DB を読まない
    dbOps.length = 0;
    await revalidateMenuPlannerAccept({ token: "a.b", ownerId: DEFAULT_OWNER_ID }, deps());
    expect(dbOps).toEqual([]);
  });

  it("source menu の repository read failure は STALE に偽装しない", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    menuReadFailure.value = true;
    const result = await revalidateMenuPlannerAccept({ token: issued.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID }, deps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.error.kind).toBe("PLANNING_REJECTED");
    expect(result.error.code).toBe("CONTEXT_MENU_READ_FAILED");
  });

  it("同一authoritative contextでのunexpected planner failureは STALE に偽装しない", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    plannerFailure.value = true;
    const result = await revalidateMenuPlannerAccept({ token: issued.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID }, deps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.error.kind).toBe("PLANNING_REJECTED");
    expect(result.error.code).toBe("DETERMINISTIC_PLANNING_FAILED");
  });

  it("期限: 境界の直前は通り、境界ちょうど／以降は STALE_PREVIEW", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    const token = issued.signed.acceptToken!;
    const expiry = ISSUED_AT.getTime() + TTL_MS;

    clock = new Date(expiry - 1);
    expect((await revalidateMenuPlannerAccept({ token, ownerId: DEFAULT_OWNER_ID }, deps())).ok).toBe(true);

    for (const at of [expiry, expiry + 1]) {
      clock = new Date(at);
      const result = await revalidateMenuPlannerAccept({ token, ownerId: DEFAULT_OWNER_ID }, deps());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("should fail");
      expect(result.error.kind).toBe("STALE_PREVIEW");
      expect(result.error.code).toBe("ACCEPT_TOKEN_EXPIRED");
    }
  });

  it("token の claim は accept 時に差し替えられない（余分な入力は無視される）", async () => {
    const { menu, drill } = await setup();
    const other = await makeExercise({ name: "別ドリル", defaultDistanceMeters: 90 });
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");

    const result = await revalidateMenuPlannerAccept(
      {
        token: issued.signed.acceptToken!,
        ownerId: DEFAULT_OWNER_ID,
        // client が差し替えようとした値（token の proposal / menuName / constraints が authority）
        proposal: saveableProposal(other.id),
        menuName: "別名",
        intent: intent(),
      } as unknown as { token: string; ownerId: string },
      deps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should pass");
    const source = await revalidationSource(menu.id, drill.id);
    expect(result.materialization.sanitizedProposal).toEqual(source.sanitizedProposal);
  });
});

describe("R12-A3A revalidate — stale detection", () => {
  async function issuedToken() {
    const { menu, drill, sourceExercise } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    return { menu, drill, sourceExercise, token: issued.signed.acceptToken! };
  }

  /** STALE 系はどれも「何も保存しない」ので、write verb が 1 つも出ないことも併せて確認する。 */
  async function expectStale(token: string, code: string | null = null) {
    dbOps.length = 0;
    const result = await revalidateMenuPlannerAccept({ token, ownerId: DEFAULT_OWNER_ID }, deps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.error.kind).toBe("STALE_PREVIEW");
    if (code !== null) expect(result.error.code).toBe(code);
    expect(dbOps.filter((op) => op.startsWith("WRITE:"))).toEqual([]);
  }

  it("source menu の context 変化（availableMinutes）で STALE", async () => {
    const ctx = await issuedToken();
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { runningContextJson: JSON.stringify(runningContext(240)) } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("source menu が削除された場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    await prisma.menuTemplate.delete({ where: { id: ctx.menu.id } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("source menu がtrusted ownerのscope外になった場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { ownerId: "another-owner" } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("runningContext が削除された場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { runningContextJson: null } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("runningContext が現在のschemaで読めなくなった場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { runningContextJson: "{not-json" } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("plannedDate が消えた場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    const changed = { ...runningContext(), plannedDate: null, plannedAt: null };
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { runningContextJson: JSON.stringify(changed) } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("plannedAt が現在のschemaで読めなくなった場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    const changed = runningContext();
    changed.plannedAt = "not-a-date";
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { runningContextJson: JSON.stringify(changed) } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("phase がsigned constraintを満たさなくなった場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { phase: "COMPETITION" } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("availableMinutes がsigned constraintを満たさなくなった場合は STALE_PREVIEW", async () => {
    const { menu, drill } = await setup();
    const constrainedIntent = {
      ...intent(),
      constraints: { ...intent().constraints, availableMinutes: 120 },
    };
    const issued = await issue(drill.id, menu.id, {}, { intent: constrainedIntent });
    if (!issued.ok) throw new Error("issue failed");
    const changed = runningContext(90);
    await prisma.menuTemplate.update({ where: { id: menu.id }, data: { runningContextJson: JSON.stringify(changed) } });
    await expectStale(issued.signed.acceptToken!, "CONTEXT_BINDING_STALE");
  });

  it("subject の変化で STALE", async () => {
    const ctx = await issuedToken();
    const changed = runningContext();
    changed.subject.members[0]!.ageBandOverride = "U15";
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { runningContextJson: JSON.stringify(changed) } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("plannedAt の変化で STALE", async () => {
    const ctx = await issuedToken();
    const changed = runningContext();
    changed.plannedAt = "2026-09-20T18:00:00+09:00";
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { runningContextJson: JSON.stringify(changed) } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("source menu の item 変化で STALE", async () => {
    const ctx = await issuedToken();
    await prisma.menuItem.updateMany({ where: { displayName: "既存" }, data: { note: "changed" } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("Exercise default の変化で STALE", async () => {
    const ctx = await issuedToken();
    await prisma.exercise.update({ where: { id: ctx.drill.id }, data: { defaultDistanceMeters: 45 } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("catalog の（proposal が参照しない）Exercise の status 変化で STALE", async () => {
    const ctx = await issuedToken();
    // 参照メニューの item が指す Exercise = owner catalog の 1 件。proposal はこれを参照しないので
    // catalog validation は通り、fingerprint だけが変わる。
    await prisma.exercise.update({ where: { id: ctx.sourceExercise.id }, data: { status: "ARCHIVED" } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("proposal が参照する Exercise が catalog から外れた場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    // 発行後に selectable catalog から外れたため、binding 比較前でも stale invalidation として扱う。
    await prisma.exercise.update({ where: { id: ctx.drill.id }, data: { status: "ARCHIVED" } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("proposal が参照する Exercise が REVIEWED→DRAFT になった場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    await prisma.exercise.update({ where: { id: ctx.drill.id }, data: { status: "DRAFT" } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("proposal が参照する Exercise が削除された場合も STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    await prisma.exercise.delete({ where: { id: ctx.drill.id } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("Load history の変化で STALE", async () => {
    const ctx = await issuedToken();
    const session = await prisma.trainingSession.create({
      data: { ownerId: DEFAULT_OWNER_ID, date: new Date("2026-09-18T10:00:00.000Z"), title: "直前練習", status: "COMPLETED" },
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
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("Competition の変化で STALE", async () => {
    const ctx = await issuedToken();
    await prisma.competition.create({
      data: { ownerId: DEFAULT_OWNER_ID, name: "県大会", date: new Date("2026-09-22T00:00:00.000Z"), priority: "PEAK" },
    });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("RuleSet の内容 hash が変わると STALE（同一コードでも version が上がった状況）", async () => {
    const ctx = await issuedToken();
    ruleSetHashOverride.value = "rotated-ruleset-content-hash";
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("RuleSet の status が DRAFT→ACTIVE に変わると STALE（silent accept しない）", async () => {
    const ctx = await issuedToken();
    expect((claimsOf(ctx.token).ruleSet as { status: string }).status).toBe("DRAFT");
    ruleSetStatusOverride.value = "ACTIVE";
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });

  it("context が同一でも materializationDigest が変われば STALE（digest gate）", async () => {
    const ctx = await issuedToken();
    digestOverride.value = "0".repeat(64);
    await expectStale(ctx.token, "MATERIALIZATION_STALE");
  });

  it("source menu が archived になった場合は STALE_PREVIEW", async () => {
    const ctx = await issuedToken();
    await prisma.menuTemplate.update({ where: { id: ctx.menu.id }, data: { status: "ARCHIVED" } });
    await expectStale(ctx.token, "CONTEXT_BINDING_STALE");
  });
});

describe("R12-A3A invariants", () => {
  it("再計算の planner call も AI_PLANNER の固定条件のまま", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");

    plannerRequests.length = 0;
    await revalidateMenuPlannerAccept({ token: issued.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID }, deps());
    expect(plannerRequests.length).toBeGreaterThan(0);
    for (const request of plannerRequests) {
      expect((request.actor as { kind: string }).kind).toBe("AI_PLANNER");
      expect(request.readiness).toBeNull();
      expect(request.coachEdits).toEqual([]);
      expect(request.overrides).toEqual([]);
      expect(request.coachReference).toBeNull();
      expect(request.confirmedFindingCodes).toEqual([]);
    }
  });

  it("発行も再検証も DB write 0", async () => {
    const { menu, drill } = await setup();
    dbOps.length = 0;
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    expect(dbOps.filter((op) => op.startsWith("WRITE:"))).toEqual([]);

    dbOps.length = 0;
    const result = await revalidateMenuPlannerAccept({ token: issued.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID }, deps());
    expect(result.ok).toBe(true);
    expect(dbOps.filter((op) => op.startsWith("WRITE:"))).toEqual([]);
    expect(dbOps.length).toBeGreaterThan(0);
  });

  it("token に health / provenance JSON / raw RuleSet を載せない", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    const payload = verifyHmacToken(issued.signed.acceptToken!, KEY);
    if (!payload.ok) throw new Error("verify failed");
    expect(payload.payload).not.toContain("requestText");
    expect(payload.payload).not.toContain("短距離の練習メニューを作成");
    expect(payload.payload).not.toMatch(/soreness|pain|fatigue|sleep|birthDate|sexForNorms/iu);
    expect(payload.payload).not.toMatch(/prescriptionJson|runningContextJson|envelopes|stopPolicies|evidence/iu);
    expect(payload.payload).not.toMatch(/signingKey|hmac/iu);
  });
});

describe("R12-A3A regressions", () => {
  /** sanitizer が実際に書き換える reason（数値 dose の文が落ちる）。 */
  const SANITIZED_REASON = "100mを5本。姿勢を整えるため";

  async function issueWithReason(reason: string) {
    const { menu, drill } = await setup();
    const result = await issueMenuPlannerSignedPreview(
      {
        ownerId: DEFAULT_OWNER_ID,
        contextMenuTemplateId: menu.id,
        menuName: "コーチ作成メニュー",
        intent: intent(),
        proposal: {
          schemaVersion: 1,
          items: [{ kind: "EXERCISE", proposal: { blockName: "主運動", exerciseId: drill.id, reason } }],
          question: null,
        },
      },
      deps(),
    );
    if (!result.ok) throw new Error("issue failed");
    return { menu, drill, result };
  }

  it("sanitize された reason を持つ preview でも accept は fresh（判定を token へ binding して replay する）", async () => {
    const { menu, drill, result } = await issueWithReason(SANITIZED_REASON);
    const item = result.signed.preview.blocks.flatMap((b) => b.items)[0]!;
    // 前提: sanitizer が実際に働いている（この finding が付くことが replay を必要にする）
    expect(item.findings.map((f) => f.developerCode)).toContain("AI_REASON_SANITIZED");
    expect(item.aiReason).toBe("姿勢を整えるため");

    const claims = claimsOf(result.signed.acceptToken!);
    expect(claims.reasonSanitized).toEqual([true]);

    // 再計算は token の proposal（sanitize 済み）を使う。判定を replay しないと finding が消えて
    // materializationDigest が一致しなくなる（= 恒久的に STALE_PREVIEW になる）バグの回帰テスト。
    const revalidated = await revalidateMenuPlannerAccept(
      { token: result.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID },
      deps(),
    );
    if (!revalidated.ok) throw new Error(`revalidate rejected: ${JSON.stringify(revalidated.error)}`);
    expect(revalidated.ok).toBe(true);
    expect(revalidated.materialization.materializationDigest).toBe(result.signed.preview.binding.materializationDigest);
    expect(revalidated.preview.binding.contextFingerprint).toBe(result.signed.preview.binding.contextFingerprint);

    // replay された side でも同じ finding が出る
    const recomputedItem = revalidated.preview.blocks.flatMap((b) => b.items)[0]!;
    expect(recomputedItem.findings.map((f) => f.developerCode)).toContain("AI_REASON_SANITIZED");
    expect(recomputedItem.aiReason).toBe("姿勢を整えるため");
    void menu;
    void drill;
  });

  it("reason が sanitize されない場合は flag が false で、同じく fresh", async () => {
    const { result } = await issueWithReason("姿勢を整えるため");
    const claims = claimsOf(result.signed.acceptToken!);
    expect(claims.reasonSanitized).toEqual([false]);
    const revalidated = await revalidateMenuPlannerAccept(
      { token: result.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID },
      deps(),
    );
    expect(revalidated.ok).toBe(true);
  });

  it("Clock が Invalid Date を返したら発行も検証も fail closed（期限 gate を黙って落とさない）", async () => {
    const { menu, drill } = await setup();
    const badClock = () => new Date(Number.NaN);
    await expect(issue(drill.id, menu.id, { now: badClock })).rejects.toThrow();

    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    await expect(
      revalidateMenuPlannerAccept({ token: issued.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID }, deps({ now: badClock })),
    ).rejects.toThrow();
  });

  it("schema 合法な大きい proposal でも token は検証可能な長さに収まる", async () => {
    const { menu, drill } = await setup();
    // reason 300 字（日本語）× 多数 item の proposal を作る。
    const longReason = "あ".repeat(300);
    const items = Array.from({ length: 12 }, (_, i) => ({
      kind: "EXERCISE" as const,
      proposal: { blockName: `主運動${Math.floor(i / 4)}`, exerciseId: drill.id, reason: longReason },
    }));
    const result = await issueMenuPlannerSignedPreview(
      {
        ownerId: DEFAULT_OWNER_ID,
        contextMenuTemplateId: menu.id,
        menuName: "コーチ作成メニュー",
        intent: { ...intent(), requestText: "い".repeat(2_000) },
        proposal: { schemaVersion: 1, items, question: null },
      },
      deps(),
    );
    // 同一 exerciseId の重複 item は proposal schema が拒否するため、ここでは拒否されることを確認する。
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("duplicate exercise proposal must be rejected");

    // 重複しない提案（同一 exercise を 1 件ずつ別 owner 種目で用意）でも上限に収まることを確認する。
    const many = await Promise.all(
      Array.from({ length: 12 }, (_, i) => makeExercise({ name: `長文ドリル${i}`, defaultDistanceMeters: 30 })),
    );
    // block は最大 8 個まで（A1 契約）。12 item を 3 block に分ける。
    const okItems = many.map((row, i) => ({
      kind: "EXERCISE" as const,
      proposal: { blockName: `主運動${Math.floor(i / 4)}`, exerciseId: row.id, reason: longReason },
    }));
    const big = await issueMenuPlannerSignedPreview(
      {
        ownerId: DEFAULT_OWNER_ID,
        contextMenuTemplateId: menu.id,
        menuName: "コーチ作成メニュー",
        intent: { ...intent(), requestText: "い".repeat(2_000) },
        proposal: { schemaVersion: 1, items: okItems, question: null },
      },
      deps(),
    );
    expect(big.ok).toBe(true);
    if (!big.ok) throw new Error("issue failed");
    expect(typeof big.signed.acceptToken).toBe("string");
    expect(verifyHmacToken(big.signed.acceptToken!, KEY).ok).toBe(true);

    const revalidated = await revalidateMenuPlannerAccept(
      { token: big.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID },
      deps(),
    );
    expect(revalidated.ok).toBe(true);
  });

  it("accept 結果は double-submit 用の previewId / targetMenuId を返す", async () => {
    const { menu, drill } = await setup();
    const issued = await issue(drill.id, menu.id);
    if (!issued.ok) throw new Error("issue failed");
    const claims = claimsOf(issued.signed.acceptToken!);
    const revalidated = await revalidateMenuPlannerAccept(
      { token: issued.signed.acceptToken!, ownerId: DEFAULT_OWNER_ID },
      deps(),
    );
    expect(revalidated.ok).toBe(true);
    if (!revalidated.ok) throw new Error("should pass");
    expect(revalidated.materialization.previewId).toBe(claims.previewId);
    expect(revalidated.materialization.targetMenuId).toBe(claims.targetMenuId);
  });
});
