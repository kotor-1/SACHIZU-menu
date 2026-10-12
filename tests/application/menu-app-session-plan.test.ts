import { describe, expect, it } from "vitest";
import { buildAppSessionPlan } from "@/application/menu-composition/session-plan";
import type { VerifiedRunningIntent, VerifiedClaim } from "@/application/running-menu/intent";
import type { ComposeMenuInput } from "@/domain/menu-composition/contracts";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import { catalogFixture } from "../fixtures/menu-composition";

const claim = <T>(value: T): VerifiedClaim<T> => ({ value, sourceText: "確認済みの入力", sourceType: "USER_CONTEXT" });
function intent(patch: Partial<VerifiedRunningIntent> = {}): VerifiedRunningIntent {
  return { runningRequested: true, event: claim("200m"), ageGroup: claim("HIGH_SCHOOL"),
    explicitDistances: [claim(150)], distancePreference: null, loadReductionRequested: null,
    fatigueState: null, purpose: null, intensityPreference: null, competitionDays: claim(21),
    availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [], ...patch };
}
const input: ComposeMenuInput = { requestText: "高校生の200mです。150mの練習を含む全体メニュー。大会は21日後です。", context: { availableTimeSeconds: 5400 } };
const running: RunningPrescription = {
  policyVersion: "test-policy", policyHash: "a".repeat(64), event: "200m", distanceMeters: 150,
  totalReps: 3, totalDistanceMeters: 450, repsPosition: "DEFAULT", repRestSeconds: 1080,
  sets: 1, setReps: null, setRestSeconds: null, intensityPresentation: "PLAIN_LANGUAGE",
  executionInstructionText: null, coachTargetTimeSeconds: null, coachTargetTimeRange: null,
  loadReductionRequested: false, repsReductionApplied: false, minimumKnownRestSeconds: 2160,
  fullSessionTimeGuaranteed: false, decisionReasons: ["HUMAN_EXPLICIT_DISTANCE_SELECTED"],
};
const catalog = [
  catalogFixture({ id: "intro", name: "歩行の準備", category: "WARM_UP", description: "ゆっくり歩く。" }),
  catalogFixture({ id: "technique", name: "その場の接地ドリル", category: "DRILL", description: "その場で脚を入れ替える。", targets: ["TECHNIQUE"] }),
  catalogFixture({ id: "support", name: "体幹の支持", category: "CORE" }),
  catalogFixture({ id: "closing", name: "整理運動", category: "COOL_DOWN", description: "呼吸しながらゆっくり動かす。" }),
];
function total(plan: ReturnType<typeof buildAppSessionPlan>) {
  return plan.blocks.reduce((sum, block) => sum + (block.budgetSeconds ?? 0), 0) + (plan.transitionBudgetSeconds ?? 0);
}

describe("App scheduling plan (offline; no generated exercise doses)", () => {
  it("reserves the unchanged 36 minutes of fixed rest inside a 40-minute MAIN ceiling and budgets every requested second", () => {
    const snapshots = structuredClone({ input, intent: intent(), catalog, running });
    const plan = buildAppSessionPlan(input, snapshots.intent, catalog, running);
    expect(plan.scope).toBe("WHOLE_SESSION");
    expect(plan.blocks.map(block => block.role)).toEqual(["WARM_UP", "TECHNIQUE", "MAIN", "SUPPORT", "COOL_DOWN"]);
    expect(plan.blocks.map(block => block.budgetSeconds)).toEqual([900, 600, 2400, 900, 360]);
    expect(plan.transitionBudgetSeconds).toBe(240);
    expect(total(plan)).toBe(5400);
    expect(plan.constraints).toEqual([]);
    expect({ input, intent: snapshots.intent, catalog, running }).toEqual(snapshots);
    expect(JSON.stringify(plan)).not.toContain("plannedReps");
    expect(plan.rationale.join(" ")).toContain("時間上限");
  });

  it.each([2701, 3600, 5401, 7200])("keeps integer accounting exact for a %i-second whole-session request", seconds => {
    const plan = buildAppSessionPlan({ ...input, context: { availableTimeSeconds: seconds } }, intent(), catalog, running);
    expect(total(plan)).toBe(seconds);
    expect(plan.blocks.every(block => Number.isInteger(block.budgetSeconds) && block.budgetSeconds! >= 0)).toBe(true);
    expect(plan.blocks.find(block => block.role === "MAIN")!.budgetSeconds).toBeGreaterThanOrEqual(2160);
  });

  it("protects fixed rest when the requested session is impossible, reporting the conflict without shortening Engine rest", () => {
    const plan = buildAppSessionPlan({ ...input, context: { availableTimeSeconds: 1800 } }, intent(), catalog, running);
    expect(total(plan)).toBe(2160);
    expect(plan.blocks.find(block => block.role === "MAIN")!.budgetSeconds).toBe(2160);
    expect(plan.constraints.map(row => row.code)).toContain("FIXED_RUNNING_EXCEEDS_REQUESTED_TIME");
    expect(running.repRestSeconds).toBe(1080);
  });

  it("preserves an explicit running-only scope even when the requested time is long", () => {
    const plan = buildAppSessionPlan({ ...input, requestText: "走練習だけを90分の枠で確認したい" }, intent(), catalog, running);
    expect(plan.scope).toBe("FOCUSED");
    expect(plan.blocks.map(block => block.role)).toEqual(["MAIN"]);
    expect(plan.transitionBudgetSeconds).toBe(0);
    expect(total(plan)).toBe(5400);
  });

  it("does not treat a negated running-only request as a restricted session", () => {
    const plan = buildAppSessionPlan({ ...input, requestText: "走だけではなく、導入や補強も含めて練習したい" }, intent(), catalog, running);
    expect(plan.scope).toBe("WHOLE_SESSION");
    expect(plan.blocks).toHaveLength(5);
  });

  it("preserves short support-only and exact selected-exercise scopes without inserting a running block", () => {
    const support = buildAppSessionPlan({ requestText: "補強だけを行いたい", context: { availableTimeSeconds: 1200 } },
      intent({ runningRequested: false }), catalog, null);
    expect(support.blocks).toHaveLength(1);
    expect(support.blocks[0]).toMatchObject({ role: "FOCUSED", candidateIds: ["support"], budgetSeconds: 1200 });
    const selected = buildAppSessionPlan({ requestText: "このドリルだけを行いたい", context: { availableTimeSeconds: 5400 } },
      intent({ runningRequested: false, exerciseIds: ["technique"] }), catalog, null);
    expect(selected.blocks[0].candidateIds).toEqual(["technique"]);
  });

  it("keeps an unqualified short running request focused instead of inventing a full-session template", () => {
    const shortRunning = { ...running, distanceMeters: 60, totalReps: 4, repRestSeconds: 240, minimumKnownRestSeconds: 720 };
    const plan = buildAppSessionPlan({ requestText: "100mの練習", context: { availableTimeSeconds: 1200 } }, intent(), catalog, shortRunning);
    expect(plan.scope).toBe("FOCUSED");
    expect(plan.blocks.map(block => block.role)).toEqual(["MAIN"]);
    expect(total(plan)).toBe(1200);
  });

  it("reports missing required role candidates and excludes all Running and unreviewed catalog rows", () => {
    const plan = buildAppSessionPlan(input, intent(), [catalog[0], catalog[1],
      catalogFixture({ id: "unreviewed", status: "DRAFT", category: "COOL_DOWN" }),
      catalogFixture({ id: "running-catalog", category: "RUNNING", name: "150m走" })], running);
    expect(plan.constraints.map(row => row.code)).toEqual(expect.arrayContaining(["MISSING_SUPPORT_CANDIDATES", "MISSING_COOL_DOWN_CANDIDATES"]));
    expect(plan.blocks.flatMap(block => block.candidateIds)).not.toContain("running-catalog");
    expect(plan.blocks.flatMap(block => block.candidateIds)).not.toContain("unreviewed");
  });

  it("leaves fatigue 1/10 and next weekend unresolved without turning either into a low-load decision", () => {
    const text = "高校生の100mです。来週末の試合に向けて少し疲労をためたいです。今は10が一番疲労が強いとしたら1です。";
    const verified = intent({ event: claim("100m"), explicitDistances: [], competitionDays: null });
    const before = structuredClone(verified);
    const plan = buildAppSessionPlan({ ...input, requestText: text }, verified, catalog, running);
    expect(plan.constraints.map(row => row.code)).toEqual(expect.arrayContaining(["FATIGUE_GOAL_UNRESOLVED", "FATIGUE_SCALE_UNRESOLVED", "COMPETITION_DATE_UNRESOLVED"]));
    expect(plan.allowsLowLoadShortening).toBe(false);
    expect(verified).toEqual(before);
    expect(plan.rationale.join(" ")).not.toContain("大会まで9日");
  });

  it("uses explicit low-load purpose to make support optional without changing fixed Running or claiming recovered physiology", () => {
    const normal = buildAppSessionPlan(input, intent(), catalog, running);
    const recovery = buildAppSessionPlan(input, intent({ purpose: claim("RECOVERY") }), catalog, running);
    expect(recovery.allowsLowLoadShortening).toBe(true);
    expect(recovery.blocks.find(block => block.role === "SUPPORT")!.required).toBe(false);
    expect(recovery.blocks.find(block => block.role === "SUPPORT")!.budgetSeconds).toBeLessThan(normal.blocks.find(block => block.role === "SUPPORT")!.budgetSeconds!);
    expect(total(recovery)).toBe(5400);
    expect(recovery.blocks.find(block => block.role === "MAIN")!.budgetSeconds).toBe(2400);
  });

  it("uses confirmed days, fatigue, age and experience to vary scheduling priorities without inferring a taper", () => {
    const normal = buildAppSessionPlan(input, intent(), catalog, running);
    const near = buildAppSessionPlan(input, intent({ competitionDays: claim(3) }), catalog, running);
    expect(near.blocks.find(block => block.role === "SUPPORT")!.required).toBe(false);
    expect(near.allowsLowLoadShortening).toBe(false);
    const beginner = buildAppSessionPlan({ ...input, context: { ...input.context, science: { experience: "BEGINNER" } } },
      intent({ ageGroup: claim("JUNIOR_HIGH"), purpose: claim("BASIC"), fatigueState: claim("REPORTED") }), catalog, running);
    expect(beginner.blocks.find(block => block.role === "WARM_UP")!.budgetSeconds).toBeGreaterThan(normal.blocks.find(block => block.role === "WARM_UP")!.budgetSeconds!);
    expect(beginner.blocks.find(block => block.role === "SUPPORT")!.required).toBe(false);
    expect(total(beginner)).toBe(5400);
  });

  it("keeps unspecified time null and makes missing Running prescription an explicit limitation", () => {
    const plan = buildAppSessionPlan({ ...input, context: {} }, intent(), catalog, null);
    expect(plan.blocks.every(block => block.budgetSeconds === null)).toBe(true);
    expect(plan.transitionBudgetSeconds).toBeNull();
    expect(plan.requestedSeconds).toBeNull();
    expect(plan.constraints.map(row => row.code)).toContain("RUNNING_PRESCRIPTION_UNAVAILABLE");
  });

  it("binds deterministic plan and block identities to the original input, verified facts, candidate details and Running prescription", () => {
    const base = buildAppSessionPlan(input, intent(), catalog, running);
    expect(buildAppSessionPlan(structuredClone(input), intent(), structuredClone(catalog), structuredClone(running))).toEqual(base);
    const changed = [
      buildAppSessionPlan({ ...input, requestText: `${input.requestText} 普段の練習。` }, intent(), catalog, running),
      buildAppSessionPlan(input, intent({ competitionDays: claim(20) }), catalog, running),
      buildAppSessionPlan(input, intent(), [{ ...catalog[0], description: "新しい登録説明" }, ...catalog.slice(1)], running),
      buildAppSessionPlan(input, intent(), catalog, { ...running, repRestSeconds: 1140, minimumKnownRestSeconds: 2280 }),
    ];
    expect(changed.every(plan => plan.id !== base.id)).toBe(true);
    expect(base.blocks.every(block => block.id.startsWith(base.id.slice(0, 16)))).toBe(true);
  });
});
