import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infra/repositories/exercise-repository", () => ({ listExercisesForMenuPlanner: vi.fn() }));
vi.mock("@/infra/running-menu/openai-semantic-intent-v2", () => ({ extractRunningSemanticIntentV2: vi.fn() }));

import { generateRunningMenuPreviewAction } from "@/actions/running-menu-preview-actions";
import { listExercisesForMenuPlanner } from "@/infra/repositories/exercise-repository";
import { extractRunningSemanticIntentV2, type SemanticExtractionResult } from "@/infra/running-menu/openai-semantic-intent-v2";
import { verifyRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";
import type { RunningSemanticIntentV2 } from "@/application/running-menu/semantic-intent-v2";

const list = vi.mocked(listExercisesForMenuPlanner);
const extract = vi.mocked(extractRunningSemanticIntentV2);
const priorFlag = process.env.AI_MENU_PLANNER_ENABLED;
const priorSecret = process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;
type Field = RunningSemanticIntentV2["claims"][number]["field"];
function claim(field: Field, value: string | number | boolean, sourceText: string, rawText?: string, unit: "METER" | "DAY" | "NONE" = "NONE"): RunningSemanticIntentV2["claims"][number] {
  return { field, value, sourceText, polarity: "AFFIRMED", temporalScope: "CURRENT", status: "ACTIVE", numericParts: rawText ? [{ rawText, unit }] : [] };
}
function extraction(claims: RunningSemanticIntentV2["claims"], extras: Partial<RunningSemanticIntentV2> = {}) {
  const payload: Extract<SemanticExtractionResult, { ok: true }> = { ok: true, interpretation: {
    interpreterVersion: "running-intent-v2", requestKind: "RUNNING", claims, corrections: [], unsupportedIntents: [], ambiguity: null, exerciseIds: [], ...extras,
  }, review: { assessments: claims.map((_, index) => ({ index, supported: true })), requestKindSupported: true,
    activeClaimIndexes: claims.map((_, index) => index), missingCriticalClaim: false, ambiguityCorrect: true, unsupportedIntentsSupported: true, correctionsSupported: true },
  numericRoleReview: { roles: claims.flatMap((item) => {
    const role = item.field;
    return role === "EVENT" || role === "TRAINING_DISTANCE"
      ? item.numericParts.filter((part) => part.unit === "NONE").map((part) => ({ sourceText: item.sourceText, rawText: part.rawText, role }))
      : [];
  }) } };
  extract.mockResolvedValue(payload);
  return payload;
}
const event = (value: "100m" | "200m") => claim("EVENT", value, `${value}選手`, value.slice(0, -1), "METER");
const age = claim("AGE_GROUP", "JUNIOR_HIGH", "中学生");
function enable() {
  process.env.AI_MENU_PLANNER_ENABLED = "true";
  process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = "running-preview-test-secret-with-more-than-32-bytes";
  list.mockResolvedValue([]);
}
afterEach(() => {
  if (priorFlag === undefined) delete process.env.AI_MENU_PLANNER_ENABLED;
  else process.env.AI_MENU_PLANNER_ENABLED = priorFlag;
  if (priorSecret === undefined) delete process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;
  else process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = priorSecret;
  vi.clearAllMocks();
});

describe("semantic Running preview action", () => {
  it("uses REVIEWED exercises and the engine's 100m default", async () => {
    enable();
    list.mockResolvedValue([
      { id: "reviewed", name: "ドリル", category: "DRILL", status: "REVIEWED" },
      { id: "draft", name: "未確認", category: "DRILL", status: "DRAFT" },
    ] as Awaited<ReturnType<typeof listExercisesForMenuPlanner>>);
    extraction([event("100m"), age], { exerciseIds: ["reviewed"] });
    const result = await generateRunningMenuPreviewAction({ requestText: "中学生100m選手、今日のメニューを作って", context: {} });
    expect(extract.mock.calls[0]?.[0].exercises).toEqual([{ id: "reviewed", name: "ドリル", category: "DRILL" }]);
    expect(result).toMatchObject({ ok: true, running: { status: "READY", prescription: { distanceMeters: 60, totalReps: 4, repRestSeconds: 240 } }, exercises: [{ id: "reviewed" }] });
  });

  it("rejects invented Exercise IDs and numeric claims", async () => {
    enable();
    extraction([event("100m"), age], { exerciseIds: ["invented"] });
    expect(await generateRunningMenuPreviewAction({ requestText: "中学生100m選手", context: {} })).toMatchObject({ ok: false });
    extraction([event("100m"), age, claim("TRAINING_DISTANCE", 60, "100m選手", "100", "METER")]);
    expect(await generateRunningMenuPreviewAction({ requestText: "中学生100m選手", context: {} })).toMatchObject({ ok: false });
  });

  it("issues a signed policy-bound token for READY only", async () => {
    enable(); extraction([event("100m"), age]);
    const result = await generateRunningMenuPreviewAction({ requestText: "中学生100m選手、今日のメニューを作って", context: {} });
    expect(result).toMatchObject({ ok: true, persistable: true, running: { status: "READY" } });
    if (!result.ok || result.previewToken === null) return;
    expect(verifyRunningMenuPreviewToken(result.previewToken, process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET!)).toMatchObject({ policyVersion: "rp-2026.09.0" });
  });

  it("preserves explicit 80m for review without a save token", async () => {
    enable(); extraction([event("100m"), age, claim("TRAINING_DISTANCE", 80, "80mをやりたい", "80", "METER")]);
    const result = await generateRunningMenuPreviewAction({ requestText: "中学生100m選手、今日は80mをやりたい", context: {} });
    expect(result).toMatchObject({ ok: true, persistable: false, previewToken: null, running: { status: "COACH_REVIEW_REQUIRED" } });
  });

  it("retains unsupported wishes and reaches the existing 200m policy", async () => {
    enable();
    const requestText = "今週に２００mのレースがある。中学2年男子です。あと3日で試合ですが、疲労が抜けすぎています。少し疲労を溜めるメニューを消化したい";
    extraction([
      claim("EVENT", "200m", "２００mのレース", "２００", "METER"),
      claim("AGE_GROUP", "JUNIOR_HIGH", "中学2年"),
      claim("COMPETITION_DAYS", 3, "あと3日で試合", "3", "DAY"),
    ], { unsupportedIntents: [{ meaning: "少し疲労を溜めたい", sourceText: "少し疲労を溜めるメニューを消化したい" }] });
    const result = await generateRunningMenuPreviewAction({ requestText, context: {} });
    expect(result).toMatchObject({ ok: true, persistable: true, unsupportedIntents: ["少し疲労を溜めたい"], running: { status: "READY", prescription: { distanceMeters: 120, totalReps: 3, repRestSeconds: 900 } } });
    if (!result.ok || result.previewToken === null) return;
    expect(verifyRunningMenuPreviewToken(result.previewToken, process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET!)).toMatchObject({ requestText });
  });

  it("asks only the ambiguous question", async () => {
    enable(); extraction([], { requestKind: "AMBIGUOUS", ambiguity: { question: "種目の200mですか、今日走る200mですか？", sourceText: "200" } });
    expect(await generateRunningMenuPreviewAction({ requestText: "200", context: {} })).toEqual({ ok: false, message: "種目の200mですか、今日走る200mですか？" });
  });

  it("does not retry semantic verification failure or issue a token", async () => {
    enable();
    const good = extraction([event("100m"), age]);
    extract.mockResolvedValueOnce({ ...good, interpretation: { ...good.interpretation, claims: [
      claim("EVENT", "200m", "100m選手", "100", "METER"), age,
    ] } });
    const result = await generateRunningMenuPreviewAction({ requestText: "中学生100m選手、今日のメニューを作って", context: {} });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false });
  });

  it("treats exhausted malformed responses as a service failure without blaming the input", async () => {
    enable();
    extract.mockResolvedValue({ ok: false, reason: "INVALID_OUTPUT" });
    expect(await generateRunningMenuPreviewAction({ requestText: "100m選手。フォームをきれいにしたい", context: {} }))
      .toEqual({ ok: false, message: "AIから有効な応答を取得できませんでした。時間をおいて再度お試しください。" });
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
