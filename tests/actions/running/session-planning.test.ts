/**
 * R10-B2 — Session Planning Evaluation の統合テスト（session-actions.ts + _session-planning-service.ts）。
 *
 * `createSessionFromMenu()` 自身は RuleSet を読まない・plan() を呼ばない（T-SNAP-05・§49・§51）。
 * ここは「application layer が評価を完了した data を渡す」経路そのものを検証する。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb, makeExercise } from "../../helpers";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { addMenuItem } from "@/infra/repositories/menu-repository";
import { createRunningMenuItem, saveMenuRunningContext, findRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { createSessionFromMenu } from "@/infra/repositories/session-repository";
import { createCompetition, listCompetitionRefs } from "@/infra/repositories/competition-repository";
import * as competitionWindows from "@/domain/running/competition/windows";
import { planningSnapshotSchema } from "@/domain/running/persistence/sessionSnapshot";
import { PlanningEvaluationStaleError } from "@/domain/running/persistence/sessionSnapshot";
import * as loader from "@/domain/running/rules/loader";
import * as planning from "@/domain/running/planning";
import { getRuleSet } from "@/domain/running/rules/loader";
import { makeMenuWithBlock, persistInputFor, planAcc, planWith } from "../../repository/running/fixtures";
import * as sessionPlanningService from "@/actions/_session-planning-service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { createSessionFromMenuAction } = await import("@/actions/session-actions");

const SESSION_DATE = "2026-09-20";

function runningContextJson(overrides: Partial<{ plannedDate: string | null; plannedAt: string | null; availableMinutes: number | null }> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "テストグループ",
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
    plannedDate: "plannedDate" in overrides ? overrides.plannedDate : SESSION_DATE,
    plannedAt: "plannedAt" in overrides ? overrides.plannedAt : `${SESSION_DATE}T16:00:00+09:00`,
    availableMinutes: "availableMinutes" in overrides ? overrides.availableMinutes : 90,
  });
}

function spyRuleAccess() {
  const spies = {
    getActiveRuleSet: vi.spyOn(loader, "getActiveRuleSet"),
    getRuleSetByIdentity: vi.spyOn(loader, "getRuleSetByIdentity"),
    planRunningPrescription: vi.spyOn(planning, "planRunningPrescription"),
    planRunningPrescriptionWithRuleSet: vi.spyOn(planning, "planRunningPrescriptionWithRuleSet"),
  };
  return { spies, restore: () => Object.values(spies).forEach((s) => s.mockRestore()) };
}

function planFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/**
 * 成功時の `createSessionFromMenuAction` は（本物の Next.js と同様に）`redirect()` が例外を投げて
 * 終わる。それを吸収して `{ ok: true, id }` に正規化する（失敗時は通常どおり ActionResult を返す）。
 */
async function callCreateSessionFromMenuAction(menuId: string, date = SESSION_DATE): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  try {
    const result = await createSessionFromMenuAction(null, planFormData({ menuTemplateId: menuId, date }));
    if (result.ok) return { ok: true, id: result.data.id };
    return { ok: false, message: result.message };
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

describe("R10-B2: session planning evaluation", () => {
  let access: ReturnType<typeof spyRuleAccess> | null = null;
  beforeEach(resetDb);
  afterEach(() => access?.restore());

  it("単一の exact RuleSet で aggregation / weeklyContext が EVALUATED になり、getActiveRuleSet は呼ばれない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    const acc = planAcc();
    await createRunningMenuItem(block.id, persistInputFor(acc));

    access = spyRuleAccess();
    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(access.spies.getActiveRuleSet).not.toHaveBeenCalled();
    expect(access.spies.planRunningPrescription).not.toHaveBeenCalled();
    expect(access.spies.planRunningPrescriptionWithRuleSet).not.toHaveBeenCalled();
    expect(access.spies.getRuleSetByIdentity).toHaveBeenCalled();

    const snapshot = await snapshotOf(result.id);
    expect(snapshot.aggregation.status).toBe("EVALUATED");
    expect(snapshot.weeklyContext.status).toBe("EVALUATED");
    if (snapshot.weeklyContext.status !== "EVALUATED") throw new Error("unreachable");
    // plannedAt がそのまま使われる（0:00 などで補完しない）
    expect(snapshot.weeklyContext.items[0]!.result.evaluatedAt).toBe(`${SESSION_DATE}T16:00:00+09:00`);
  });

  it("RUNNING_V2 の版が混在する場合、NOT_EVALUATED / MIXED_RULESET_VERSIONS で保存し、Session 作成自体は成功する。active loader は呼ばれない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    const acc = planAcc();
    const olderStride = planWith(
      { ruleSet: { ...structuredClone(getRuleSet("rs-2026.09.0")!), ruleSetVersion: "rs-2026.03.0" }, contentHash: "older-hash", isDraftFallback: true },
      "STRIDE",
      "ST_RELAXED",
    );
    await createRunningMenuItem(block.id, persistInputFor(acc));
    await createRunningMenuItem(block.id, persistInputFor(olderStride));

    access = spyRuleAccess();
    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(access.spies.getActiveRuleSet).not.toHaveBeenCalled();

    const snapshot = await snapshotOf(result.id);
    expect(snapshot.aggregation).toEqual({ status: "NOT_EVALUATED", reasons: ["MIXED_RULESET_VERSIONS"] });
    expect(snapshot.weeklyContext).toEqual({ status: "NOT_EVALUATED", reasons: ["MIXED_RULESET_VERSIONS"] });
    expect(snapshot.findings.some((f) => f.code === "MIXED_RULESET_VERSIONS" && f.severity === "REQUIRE_COACH_REVIEW")).toBe(true);
  });

  it("plannedAt が session date と一致すれば weekly は EVALUATED", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson({ plannedAt: `${SESSION_DATE}T16:00:00+09:00` }));
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));

    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const snapshot = await snapshotOf(result.id);
    expect(snapshot.weeklyContext.status).toBe("EVALUATED");
  });

  it("plannedAt が無ければ weekly は NOT_EVALUATED / PLANNED_AT_UNAVAILABLE。aggregation は影響を受けず EVALUATED", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson({ plannedDate: null, plannedAt: null }));
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));

    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const snapshot = await snapshotOf(result.id);
    expect(snapshot.weeklyContext).toEqual({ status: "NOT_EVALUATED", reasons: ["PLANNED_AT_UNAVAILABLE"] });
    expect(snapshot.aggregation.status).toBe("EVALUATED");
  });

  it("plannedAt の暦日が session date と異なれば weekly は NOT_EVALUATED / SESSION_DATE_CONTEXT_MISMATCH（別日の plannedAt を流用しない）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson({ plannedDate: "2026-09-10", plannedAt: "2026-09-10T16:00:00+09:00" }));
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));

    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const snapshot = await snapshotOf(result.id);
    expect(snapshot.weeklyContext).toEqual({ status: "NOT_EVALUATED", reasons: ["SESSION_DATE_CONTEXT_MISMATCH"] });
    expect(snapshot.findings.some((f) => f.code === "SESSION_DATE_CONTEXT_MISMATCH" && f.severity === "REQUIRE_COACH_REVIEW")).toBe(true);
  });

  it("runningContextJson が無い（NONE）場合、aggregation / weeklyContext とも NOT_EVALUATED / RUNNING_CONTEXT_UNAVAILABLE。plan() は呼ばれない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    // runningContextJson を保存しない（NONE）
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));

    access = spyRuleAccess();
    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(access.spies.getActiveRuleSet).not.toHaveBeenCalled();
    expect(access.spies.planRunningPrescription).not.toHaveBeenCalled();

    const snapshot = await snapshotOf(result.id);
    expect(snapshot.aggregation).toEqual({ status: "NOT_EVALUATED", reasons: ["RUNNING_CONTEXT_UNAVAILABLE"] });
    expect(snapshot.weeklyContext).toEqual({ status: "NOT_EVALUATED", reasons: ["RUNNING_CONTEXT_UNAVAILABLE"] });
    expect(snapshot.findings.some((f) => f.code === "RUNNING_CONTEXT_UNAVAILABLE")).toBe(true);
  });

  it("runningContextJson が壊れている（INVALID）場合も同様に RUNNING_CONTEXT_UNAVAILABLE。Session copy 自体は成功する", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    // repository の validation を経由せず、壊れた JSON を直接書き込む
    await prisma.menuTemplate.update({ where: { id: menu.id }, data: { runningContextJson: "{not valid json" } });

    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const snapshot = await snapshotOf(result.id);
    expect(snapshot.aggregation).toEqual({ status: "NOT_EVALUATED", reasons: ["RUNNING_CONTEXT_UNAVAILABLE"] });
  });

  it("保存済みの ruleSetVersion + contentHash に一致する RuleSet を読めない場合、NOT_EVALUATED / RULESET_VERSION_UNAVAILABLE。active へは fallback しない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    const item = await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    // 保存済みの contentHash を改ざんする（identity mismatch を再現）
    await prisma.menuItem.update({ where: { id: item.id }, data: { ruleSetContentHash: "tampered-hash" } });

    access = spyRuleAccess();
    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(access.spies.getActiveRuleSet).not.toHaveBeenCalled();

    const snapshot = await snapshotOf(result.id);
    expect(snapshot.aggregation).toEqual({ status: "NOT_EVALUATED", reasons: ["RULESET_VERSION_UNAVAILABLE"] });
    expect(snapshot.weeklyContext).toEqual({ status: "NOT_EVALUATED", reasons: ["RULESET_VERSION_UNAVAILABLE"] });
  });

  it("集計に BLOCK があれば Session を1件も作らない（legacy 項目の総走行距離が上限超過）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const ex = await makeExercise({ category: "ENDURANCE" });
    await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: ex.id, distanceMeters: "35000" }));

    const before = await prisma.trainingSession.count();
    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(false);
    expect(await prisma.trainingSession.count()).toBe(before);
    expect(await prisma.sessionItem.count()).toBe(0);
  });

  it("集計に REQUIRE_CONFIRMATION があれば Session を1件も作らない（確認済み扱いに自動変換しない）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const ex = await makeExercise({ category: "ENDURANCE" });
    // ITEM_TOTAL_DISTANCE: confirm max=3000, block max=10000 の間
    await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: ex.id, distanceMeters: "6000" }));

    const before = await prisma.trainingSession.count();
    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(false);
    expect(await prisma.trainingSession.count()).toBe(before);
  });

  it("legacy-only のメニューは B2 前と同じ挙動を維持する（RuleSet loader を一切呼ばない。莫大な legacy distance でも新規 BLOCK を導入しない）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const ex = await makeExercise({ category: "ENDURANCE" });
    // B2 が評価すれば BLOCK になる規模だが、legacy-only なので評価自体をしない
    await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: ex.id, distanceMeters: "50000" }));

    access = spyRuleAccess();
    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(access.spies.getActiveRuleSet).not.toHaveBeenCalled();
    expect(access.spies.getRuleSetByIdentity).not.toHaveBeenCalled();

    const snapshot = await snapshotOf(result.id);
    expect(snapshot.aggregation).toEqual({ status: "NOT_EVALUATED", reasons: ["PLANNING_EVALUATION_NOT_SUPPLIED"] });
  });

  it("RUNNING_V2 + LEGACY の混在メニュー（単一 identity）は、集計に legacy の走行距離も含める", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const ex = await makeExercise({ category: "ENDURANCE" });
    await addMenuItem(block.id, menuItemInputSchema.parse({ exerciseId: ex.id, distanceMeters: "1000" }));

    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const snapshot = await snapshotOf(result.id);
    expect(snapshot.aggregation.status).toBe("EVALUATED");
    if (snapshot.aggregation.status !== "EVALUATED") throw new Error("unreachable");
    // legacy の 1000m 分、下限が 0 より大きく積まれている
    expect(snapshot.aggregation.result.totalRunningDistanceM.lower).toBeGreaterThanOrEqual(1000);
  });

  it("§48: MenuItem → SessionItem の prescriptionJson / provenanceJson / rationale は B2 評価後も一切書き換えない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    const item = await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const stored = await findRunningMenuItem(item.id);
    if (stored?.status !== "VALID") throw new Error("unreachable");

    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const sessionItems = await prisma.sessionItem.findMany({ where: { trainingSessionId: result.id } });
    const v2 = sessionItems.find((i) => i.prescriptionKind === "RUNNING_V2")!;
    expect(v2.plannedPrescriptionJson).toBe(item.prescriptionJson);
    expect(v2.plannedProvenanceJson).toBe(item.provenanceJson);
    expect(v2.plannedRationale).toBe(item.rationale);
  });

  it("§30/§35/§36: 評価した時点と実際にコピーする直前でメニューがズレていたら、repository が transaction ごと中止する（Session を作らない）", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));

    const decision = await sessionPlanningService.buildSessionPlanningEvaluation({ menuTemplateId: menu.id, date: SESSION_DATE });
    if (decision.kind !== "EVALUATED") throw new Error("unreachable");

    // 評価後にメニューが変わる（本番ではここに application service の read と repository の write の間で race が起きうる）
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));

    const input = sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: SESSION_DATE });
    await expect(createSessionFromMenu(input, decision.evaluation)).rejects.toBeInstanceOf(PlanningEvaluationStaleError);
    await expect(createSessionFromMenu(input, decision.evaluation)).rejects.toThrow(/メニュー内容が更新されたため/);
    expect(await prisma.trainingSession.count()).toBe(0);
    expect(await prisma.sessionItem.count()).toBe(0);
  });

  it("§36: stale な評価を Action 経由で渡すと、安全な日本語メッセージで拒否され Session は作られない", async () => {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    await createRunningMenuItem(block.id, persistInputFor(planAcc()));

    const decision = await sessionPlanningService.buildSessionPlanningEvaluation({ menuTemplateId: menu.id, date: SESSION_DATE });
    if (decision.kind !== "EVALUATED") throw new Error("unreachable");
    const tampered = { ...decision.evaluation, sourceMenuFingerprint: `${decision.evaluation.sourceMenuFingerprint}-tampered` };
    vi.spyOn(sessionPlanningService, "buildSessionPlanningEvaluation").mockResolvedValueOnce({ kind: "EVALUATED", evaluation: tampered });

    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/メニュー内容が更新されたため/);
    expect(await prisma.trainingSession.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // [R10-B2.1] competitionDay は competition domain の開催期間 policy で決める
  // -------------------------------------------------------------------------

  async function aggregationCodesFor(competition: { date: string; endDate: string | null }) {
    const { menu, block } = await makeMenuWithBlock();
    await saveMenuRunningContext(menu.id, runningContextJson());
    await createRunningMenuItem(block.id, persistInputFor(planAcc())); // HIGH_NEURAL（race 以外の HIGH_*）
    await createCompetition({ name: "県選手権", priority: "NORMAL", note: null, ...competition });

    const result = await callCreateSessionFromMenuAction(menu.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const snapshot = await snapshotOf(result.id);
    if (snapshot.aggregation.status !== "EVALUATED") throw new Error(`aggregation ${snapshot.aggregation.status}`);
    return snapshot.aggregation.result.findings.map((f) => f.code);
  }

  it("[R10-B2.1] 複数日大会（9/19〜9/21）の2日目に作る Session は competitionDay=true で AGG_COMPETITION_DAY_EXTRA が出る。判定は domain helper に委譲する", async () => {
    const spy = vi.spyOn(competitionWindows, "resolveCompetitionDay");
    try {
      expect(await aggregationCodesFor({ date: "2026-09-19", endDate: "2026-09-21" })).toContain("AGG_COMPETITION_DAY_EXTRA");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(SESSION_DATE, [expect.objectContaining({ date: "2026-09-19", endDate: "2026-09-21" })]);
      expect(spy.mock.results[0]!.value).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("[R10-B2.1] 開催期間外（前日の1日開催 / 前日で終わった複数日開催 / 翌日開始）では AGG_COMPETITION_DAY_EXTRA を出さない", async () => {
    for (const competition of [
      { date: "2026-09-19", endDate: null },
      { date: "2026-09-18", endDate: "2026-09-19" },
      { date: "2026-09-21", endDate: "2026-09-22" },
    ]) {
      await resetDb();
      expect(await aggregationCodesFor(competition), JSON.stringify(competition)).not.toContain("AGG_COMPETITION_DAY_EXTRA");
    }
    await resetDb();
    expect(await aggregationCodesFor({ date: SESSION_DATE, endDate: null })).toContain("AGG_COMPETITION_DAY_EXTRA");
  });

  it("[R10-B2.1] repository adapter は endDate を落とさずに CompetitionRef へ渡す（null は1日開催）", async () => {
    await createCompetition({ name: "1日", date: "2026-09-19", endDate: null, priority: "IMPORTANT", note: null });
    await createCompetition({ name: "2日", date: "2026-10-03", endDate: "2026-10-04", priority: "PEAK", note: null });
    const refs = await listCompetitionRefs();
    expect(refs.map((r) => ({ date: r.date, endDate: r.endDate, priority: r.priority }))).toEqual([
      { date: "2026-09-19", endDate: null, priority: "IMPORTANT" },
      { date: "2026-10-03", endDate: "2026-10-04", priority: "PEAK" },
    ]);
  });

  it("[R10-B2.1] application layer（session 評価）は大会の日付比較を自前で持たない", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/actions/_session-planning-service.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*"); })
      .join("\n");
    expect(code).toMatch(/resolveCompetitionDay\(/);
    expect(code).not.toMatch(/\.date\s*(?:===|!==|<=|>=|<|>)/);
    expect(code).not.toMatch(/\bendDate\b/);
    expect(code).not.toMatch(/listCompetitions\(/);
    expect(code).not.toMatch(/daysUntilCompetition/);
  });
});
