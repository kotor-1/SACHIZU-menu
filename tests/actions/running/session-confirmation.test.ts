/**
 * R11-B1 — セッション作成時の REQUIRE_CONFIRMATION の2段階確認。
 *
 * 実 DB（テスト用）と実 Action を使う。確認の照合は「現在の評価の再実行結果」に対してだけ行われ、
 * 以前の評価に対する確認（code だけ同じ・値が変わった・対象が消えた）は受け付けないことを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { makeExercise, resetDb } from "../../helpers";
import { makeMenuWithBlock, persistInputFor, planAcc } from "../../repository/running/fixtures";
import { addMenuItem } from "@/infra/repositories/menu-repository";
import { createRunningMenuItem, saveMenuRunningContext } from "@/infra/repositories/running-item-repository";
import { createCompetition } from "@/infra/repositories/competition-repository";
import * as sessionRepository from "@/infra/repositories/session-repository";
import { buildSourceMenuFingerprint } from "@/infra/repositories/session-fingerprint";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { planningSnapshotSchema } from "@/domain/running/persistence/sessionSnapshot";
import { dtoRawKeyLeaks, rawKeyLeaks } from "../../presentation/running/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { createSessionFromMenuAction } = await import("@/actions/session-actions");
const sessionPlanningService = await import("@/actions/_session-planning-service");

const SESSION_DATE = "2026-09-20";

function runningContextJson(overrides: { availableMinutes?: number | null; plannedAt?: string | null } = {}) {
  return JSON.stringify({
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
    plannedDate: SESSION_DATE,
    plannedAt: overrides.plannedAt === undefined ? `${SESSION_DATE}T16:00:00+09:00` : overrides.plannedAt,
    availableMinutes: overrides.availableMinutes === undefined ? 90 : overrides.availableMinutes,
  });
}

/** メニュー内容（MenuItem）の指紋。context / 大会を変えても変わらないことの確認に使う。 */
async function menuFingerprint(menuId: string) {
  const menu = await prisma.menuTemplate.findUniqueOrThrow({
    where: { id: menuId },
    include: { blocks: { orderBy: { sortOrder: "asc" }, include: { items: { orderBy: { sortOrder: "asc" }, include: { exercise: { select: { category: true } } } } } } },
  });
  return buildSourceMenuFingerprint(
    menu.blocks.flatMap((block) =>
      block.items.map((item) => ({
        id: item.id,
        sortOrder: item.sortOrder,
        prescriptionKind: item.prescriptionKind,
        ruleSetVersion: item.ruleSetVersion,
        ruleSetContentHash: item.ruleSetContentHash,
        prescriptionJson: item.prescriptionJson,
          provenanceJson: item.provenanceJson,
        sets: item.sets,
        reps: item.reps,
        distanceMeters: item.distanceMeters,
        durationSeconds: item.durationSeconds,
        restSeconds: item.restSeconds,
        intensityPercent: item.intensityPercent,
        loadKg: item.loadKg,
        exerciseCategory: item.exercise?.category ?? null,
      })),
    ),
  );
}

type ActionResultShape = Awaited<ReturnType<typeof createSessionFromMenuAction>>;

/** 成功時は redirect が例外で終わるので `{ ok: true, id }` に正規化する。 */
async function createSession(
  menuId: string,
  confirmation: { codes?: string[]; challenge?: string } = {},
): Promise<{ ok: true; id: string } | Extract<ActionResultShape, { ok: false }>> {
  const form = new FormData();
  form.set("menuTemplateId", menuId);
  form.set("date", SESSION_DATE);
  for (const code of confirmation.codes ?? []) form.append("confirmedFindingCodes", code);
  if (confirmation.challenge !== undefined) form.set("confirmationChallenge", confirmation.challenge);
  try {
    const result = await createSessionFromMenuAction(null, form);
    if (result.ok) return { ok: true, id: result.data.id };
    return result;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT:/sessions/")) {
      return { ok: true, id: e.message.slice("NEXT_REDIRECT:/sessions/".length) };
    }
    throw e;
  }
}

async function snapshotOf(sessionId: string) {
  const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
  return planningSnapshotSchema.parse(JSON.parse(row.planningSnapshotJson!));
}

/** 走項目 + legacy の長距離走で「確認が必要」な合計にする（B4A の action-contract と同じ作り方）。 */
async function menuNeedingConfirmation(legacyDistanceMeters = "6000") {
  const { menu, block } = await makeMenuWithBlock();
  await saveMenuRunningContext(menu.id, runningContextJson());
  await createRunningMenuItem(block.id, persistInputFor(planAcc()));
  const ex = await makeExercise({ category: "ENDURANCE" });
  const legacy = await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: ex.id, distanceMeters: legacyDistanceMeters }));
  return { menu, block, legacy };
}

async function menuWithoutConfirmation() {
  const { menu, block } = await makeMenuWithBlock();
  await saveMenuRunningContext(menu.id, runningContextJson());
  await createRunningMenuItem(block.id, persistInputFor(planAcc()));
  return { menu, block };
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("R11-B1: 1回目（確認入力なし）", () => {
  it("unknown repository exceptionを固定文言へ閉じて内部messageを返さない", async () => {
    const { menu } = await menuWithoutConfirmation();
    const sentinel = "SECRET_INTERNAL_SENTINEL prisma://private/path";
    vi.spyOn(sessionRepository, "createSessionFromMenu").mockRejectedValueOnce(new Error(sentinel));

    const result = await createSession(menu.id);
    expect(result).toEqual({
      ok: false,
      kind: "REJECTED",
      message: "セッションを作成できませんでした。もう一度お試しください。",
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("確認が必要なら Session を作らず、必要な code・日本語 Finding・challenge を返す", async () => {
    const { menu } = await menuNeedingConfirmation();
    const first = await createSession(menu.id);

    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("unreachable");
    expect(first.kind).toBe("CONFIRMATION_REQUIRED");
    if (first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");
    expect(first.requiredFindingCodes.length).toBeGreaterThan(0);
    expect(first.findings.length).toBeGreaterThan(0);
    expect(first.findings.every((f) => f.requiresExplicitConfirmation)).toBe(true);
    expect(first.confirmationChallenge).toMatch(/^[0-9a-f]{64}$/);
    // 内部 code をユーザー向け文字列に出さない
    expect(rawKeyLeaks(first.message)).toEqual([]);
    expect(dtoRawKeyLeaks(first.findings)).toEqual([]);
    expect(await prisma.trainingSession.count()).toBe(0);
    expect(await prisma.sessionItem.count()).toBe(0);
  });

  it("同じ評価なら challenge は再計算で同じ値になる（時刻・乱数を含めない）", async () => {
    const { menu } = await menuNeedingConfirmation();
    const a = await createSession(menu.id);
    const b = await createSession(menu.id);
    if (a.ok || b.ok || a.kind !== "CONFIRMATION_REQUIRED" || b.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");
    expect(a.confirmationChallenge).toBe(b.confirmationChallenge);
  });
});

describe("R11-B1: 2回目（確認入力あり）", () => {
  it("現在の評価と完全一致する確認なら作成でき、確認記録と Finding の両方が残る", async () => {
    const { menu } = await menuNeedingConfirmation();
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    const created = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(await prisma.trainingSession.count()).toBe(1);

    const snapshot = await snapshotOf(created.id);
    // 監査記録（code + server 時刻）
    expect(snapshot.findingConfirmations).toEqual(first.requiredFindingCodes.map((code) => ({ code, at: expect.any(String) })));
    for (const record of snapshot.findingConfirmations ?? []) expect(Number.isNaN(Date.parse(record.at))).toBe(false);
    // 確認しても Finding は消さない
    const confirmed = new Set(first.requiredFindingCodes);
    expect(snapshot.findings.some((f) => confirmed.has(f.code) && f.severity === "REQUIRE_CONFIRMATION")).toBe(true);
  });

  it("確認が無ければ作らない（Action / service 側で true に補完しない）", async () => {
    const { menu } = await menuNeedingConfirmation();
    const result = await createSession(menu.id, { codes: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("CONFIRMATION_REQUIRED");
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("必要な code が足りなければ CONFIRMATION_REQUIRED（不足分は再確認）", async () => {
    const { menu } = await menuNeedingConfirmation("9000");
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");
    expect(first.requiredFindingCodes.length).toBeGreaterThan(1);

    const partial = first.requiredFindingCodes.slice(0, 1);
    const result = await createSession(menu.id, { codes: partial, challenge: first.confirmationChallenge });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("CONFIRMATION_REQUIRED");
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("現在の評価に無い code が含まれていれば CONFIRMATION_STATE_STALE", async () => {
    const { menu } = await menuNeedingConfirmation();
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    const result = await createSession(menu.id, {
      codes: [...first.requiredFindingCodes, "AGG_OLD_RESULT_CODE"],
      challenge: first.confirmationChallenge,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("CONFIRMATION_STATE_STALE");
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("challenge が無い確認は受け付けない（code だけの一致では作成しない）", async () => {
    const { menu } = await menuNeedingConfirmation();
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    const result = await createSession(menu.id, { codes: first.requiredFindingCodes });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("CONFIRMATION_REQUIRED");
    expect(await prisma.trainingSession.count()).toBe(0);
  });
});

describe("R11-B1: 同じ code でも中身が変わったら流用できない", () => {
  it("同じ code のまま合計だけ増えた（9,000m → 9,500m）→ challenge 不一致で STALE", async () => {
    // 本番 RuleSet の確認 Finding は value / limit を持たない（code + metric + scope のみ）。
    // そのため「同じ code で中身だけ違う」評価は sourceMenuFingerprint で区別される（§12）。
    const { menu, legacy } = await menuNeedingConfirmation("9000");
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    await prisma.menuItem.update({ where: { id: legacy.id }, data: { distanceMeters: 9500 } });

    const second = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.kind).toBe("CONFIRMATION_STATE_STALE");
    if (second.kind !== "CONFIRMATION_STATE_STALE") throw new Error("unreachable");
    // 必要な code は同じ。challenge だけが変わる（code 照合だけでは防げないケース）
    expect(second.requiredFindingCodes).toEqual(first.requiredFindingCodes);
    expect(second.confirmationChallenge).not.toBe(first.confirmationChallenge);
    expect(await prisma.trainingSession.count()).toBe(0);

    // 最新の challenge で確認すれば作成できる
    const third = await createSession(menu.id, { codes: second.requiredFindingCodes, challenge: second.confirmationChallenge });
    expect(third.ok, JSON.stringify(third)).toBe(true);
  });

  it("確認が必要な内容が増えたら（code が足りない）CONFIRMATION_REQUIRED として再確認させる", async () => {
    const { menu, legacy } = await menuNeedingConfirmation("6000");
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    // 合計が 8,000m を超え、確認対象の code が1つ増える
    await prisma.menuItem.update({ where: { id: legacy.id }, data: { distanceMeters: 9000 } });

    const second = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.kind).toBe("CONFIRMATION_REQUIRED");
    if (second.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");
    expect(second.requiredFindingCodes.length).toBeGreaterThan(first.requiredFindingCodes.length);
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("Finding が同じでもメニュー内容が変われば challenge が変わる（sourceMenuFingerprint を含む）", async () => {
    const { menu, block } = await menuNeedingConfirmation();
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    // 集計に影響しない項目を1件足す（Finding は同じでも指紋は変わる）
    const ex = await makeExercise({ category: "CORE" });
    await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: ex.id, sets: "3", reps: "10" }));

    const second = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.kind).toBe("CONFIRMATION_STATE_STALE");
    if (second.kind !== "CONFIRMATION_STATE_STALE") throw new Error("unreachable");
    expect(second.requiredFindingCodes).toEqual(first.requiredFindingCodes);
    expect(second.confirmationChallenge).not.toBe(first.confirmationChallenge);
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("確認対象が消えたのに古い確認が送られてきたら、黙って作らず一度やり直させる", async () => {
    const { menu, legacy } = await menuNeedingConfirmation();
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    // 確認が要らない内容へ変更
    await prisma.menuItem.delete({ where: { id: legacy.id } });

    const second = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.kind).toBe("CONFIRMATION_STATE_STALE");
    expect(await prisma.trainingSession.count()).toBe(0);

    // 確認入力なしの新しいリクエストなら通常どおり作成できる
    const third = await createSession(menu.id);
    expect(third.ok, JSON.stringify(third)).toBe(true);
    expect(await prisma.trainingSession.count()).toBe(1);
    const snapshot = await snapshotOf((third as { ok: true; id: string }).id);
    expect(snapshot.findingConfirmations).toBeUndefined();
  });
});

describe("R11-B1: severity ごとの扱い", () => {
  it("BLOCK は確認では解除できない（confirmation を送っても Session 0）", async () => {
    const { menu } = await menuNeedingConfirmation("35000");
    const first = await createSession(menu.id);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("unreachable");
    expect(first.kind).toBe("REJECTED");

    const forced = await createSession(menu.id, {
      codes: ["AGG_TOTAL_RUNNING_BLOCK", "AGG_TOTAL_RUNNING_CONFIRM"],
      challenge: "0".repeat(64),
    });
    expect(forced.ok).toBe(false);
    if (forced.ok) throw new Error("unreachable");
    expect(forced.kind).toBe("REJECTED");
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("REQUIRE_COACH_REVIEW だけなら確認なしで作成できる", async () => {
    const { menu } = await menuWithoutConfirmation();
    const result = await createSession(menu.id);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await prisma.trainingSession.count()).toBe(1);
  });

  it("legacy-only のメニューは確認評価を強制しない（B2 前と同じ挙動）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const ex = await makeExercise({ category: "ENDURANCE" });
    await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: ex.id, distanceMeters: "50000" }));
    const result = await createSession(menu.id);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});

describe("R11-B1.1: MenuItem 以外の planning context が変わった場合", () => {
  it("評価結果が変わる設定変更（練習時間が足りなくなる）なら STALE。MenuItem の指紋は同じ", async () => {
    const { menu } = await menuNeedingConfirmation("9000");
    const before = await menuFingerprint(menu.id);
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    // MenuItem は触らず、練習時間だけを「レストが収まらない」値へ変える（R6 の評価結果が変わる）
    await saveMenuRunningContext(menu.id, runningContextJson({ availableMinutes: 5 }));
    expect(await menuFingerprint(menu.id)).toBe(before);

    const second = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.kind).toBe("CONFIRMATION_STATE_STALE");
    if (second.kind !== "CONFIRMATION_STATE_STALE") throw new Error("unreachable");
    expect(second.requiredFindingCodes).toEqual(first.requiredFindingCodes);
    expect(second.confirmationChallenge).not.toBe(first.confirmationChallenge);
    expect(await prisma.trainingSession.count()).toBe(0);

    // 最新の challenge で確認すれば作成できる
    const third = await createSession(menu.id, { codes: second.requiredFindingCodes, challenge: second.confirmationChallenge });
    expect(third.ok, JSON.stringify(third)).toBe(true);
  });

  it("設定を変えても評価結果が同じなら、以前の確認はそのまま有効（policy 結果に対する確認）", async () => {
    const { menu } = await menuNeedingConfirmation("9000");
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    // 練習時間 90 分 → 20 分。どちらもレストは収まるため R6 / R7 の結果は完全に同じ
    await saveMenuRunningContext(menu.id, runningContextJson({ availableMinutes: 20 }));

    const second = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(await prisma.trainingSession.count()).toBe(1);
  });

  it("開始予定時刻が消えれば STALE（週次評価が NOT_EVALUATED に変わる）", async () => {
    const { menu } = await menuNeedingConfirmation("9000");
    const before = await menuFingerprint(menu.id);
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    await saveMenuRunningContext(menu.id, runningContextJson({ plannedAt: null }));
    expect(await menuFingerprint(menu.id)).toBe(before);

    const second = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.kind).toBe("CONFIRMATION_STATE_STALE");
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  it("大会文脈が変われば STALE（当日が大会期間になる。MenuItem の指紋は同じ）", async () => {
    const { menu } = await menuNeedingConfirmation("9000");
    const before = await menuFingerprint(menu.id);
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    await createCompetition({ name: "県大会", date: SESSION_DATE, endDate: null, priority: "IMPORTANT", note: null });
    expect(await menuFingerprint(menu.id)).toBe(before);

    const second = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.kind).toBe("CONFIRMATION_STATE_STALE");
    if (second.kind !== "CONFIRMATION_STATE_STALE") throw new Error("unreachable");
    expect(second.confirmationChallenge).not.toBe(first.confirmationChallenge);
    expect(await prisma.trainingSession.count()).toBe(0);
  });
});

describe("R11-B1: fingerprint（stale evaluation）との関係", () => {
  it("確認を通した後にメニューが変わったら、repository の指紋検証で中止する（Session 0）", async () => {
    const { menu, legacy } = await menuNeedingConfirmation();
    const first = await createSession(menu.id);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");

    // 評価・確認照合は通り、repository が書き込む直前にメニューが変わる状況を作る
    const real = sessionPlanningService.buildSessionPlanningEvaluation;
    vi.spyOn(sessionPlanningService, "buildSessionPlanningEvaluation").mockImplementationOnce(async (input) => {
      const decision = await real(input);
      await prisma.menuItem.update({ where: { id: legacy.id }, data: { distanceMeters: 7000 } });
      return decision;
    });

    const result = await createSession(menu.id, { codes: first.requiredFindingCodes, challenge: first.confirmationChallenge });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("PLANNING_EVALUATION_STALE");
    expect(result.message).toMatch(/メニュー内容が更新されたため/);
    expect(await prisma.trainingSession.count()).toBe(0);
    expect(await prisma.sessionItem.count()).toBe(0);
  });
});
