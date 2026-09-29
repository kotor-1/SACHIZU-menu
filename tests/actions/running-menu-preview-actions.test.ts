import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infra/repositories/exercise-repository", () => ({ listExercisesForMenuPlanner: vi.fn() }));
vi.mock("@/infra/running-menu/openai-intent-extractor", () => ({ extractRunningMenuIntent: vi.fn() }));

import { generateRunningMenuPreviewAction } from "@/actions/running-menu-preview-actions";
import { listExercisesForMenuPlanner } from "@/infra/repositories/exercise-repository";
import { extractRunningMenuIntent } from "@/infra/running-menu/openai-intent-extractor";
import { verifyRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";

const list = vi.mocked(listExercisesForMenuPlanner);
const extract = vi.mocked(extractRunningMenuIntent);
const priorFlag = process.env.AI_MENU_PLANNER_ENABLED;
const priorSecret = process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;

afterEach(() => {
  if (priorFlag === undefined) delete process.env.AI_MENU_PLANNER_ENABLED;
  else process.env.AI_MENU_PLANNER_ENABLED = priorFlag;
  if (priorSecret === undefined) delete process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;
  else process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = priorSecret;
  vi.clearAllMocks();
});

describe("new Running preview action", () => {
  it("uses REVIEWED exercises and returns an unsaved engine result", async () => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    list.mockResolvedValue([
      { id: "reviewed", name: "ドリル", category: "DRILL", status: "REVIEWED" },
      { id: "draft", name: "未確認", category: "DRILL", status: "DRAFT" },
    ] as Awaited<ReturnType<typeof listExercisesForMenuPlanner>>);
    extract.mockResolvedValue({ ok: true, claims: {
      runningRequested: true,
      event: { value: "100m", sourceText: "100m選手" },
      ageGroup: { value: "JUNIOR_HIGH", sourceText: "中学生" },
      explicitDistances: [], distancePreference: null, loadReductionRequested: null, fatigueState: null,
      availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null,
      exerciseIds: ["reviewed"],
    } });
    const result = await generateRunningMenuPreviewAction({ requestText: "中学生100m選手、今日のメニューを作って", context: {} });
    expect(extract.mock.calls[0]?.[0].exercises).toEqual([{ id: "reviewed", name: "ドリル", category: "DRILL" }]);
    expect(result).toMatchObject({ ok: true, persistable: false, running: { status: "READY", prescription: { distanceMeters: 60, totalReps: 4, repRestSeconds: 240 } }, exercises: [{ id: "reviewed", name: "ドリル" }] });
  });

  it("cannot persist an invented Exercise ID or AI invented distance", async () => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    list.mockResolvedValue([]);
    extract.mockResolvedValue({ ok: true, claims: {
      runningRequested: true, event: { value: "100m", sourceText: "100m選手" }, ageGroup: { value: "JUNIOR_HIGH", sourceText: "中学生" },
      explicitDistances: [{ value: 60, sourceText: "100m選手" }], distancePreference: null, loadReductionRequested: null, fatigueState: null,
      availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
    } });
    const result = await generateRunningMenuPreviewAction({ requestText: "中学生100m選手", context: {} });
    expect(result).toMatchObject({ ok: false });
  });

  it("issues a signed, policy-bound token only for a READY preview", async () => {
    const key = "running-preview-test-secret-with-more-than-32-bytes";
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = key;
    list.mockResolvedValue([]);
    extract.mockResolvedValue({ ok: true, claims: {
      runningRequested: true, event: { value: "100m", sourceText: "100m選手" },
      ageGroup: { value: "JUNIOR_HIGH", sourceText: "中学生" }, explicitDistances: [],
      distancePreference: null, loadReductionRequested: null, fatigueState: null,
      availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
    } });
    const result = await generateRunningMenuPreviewAction({ requestText: "中学生100m選手、今日のメニューを作って", context: {} });
    expect(result).toMatchObject({ ok: true, persistable: true, running: { status: "READY" } });
    if (!result.ok || result.previewToken === null) return;
    expect(verifyRunningMenuPreviewToken(result.previewToken, key)).toMatchObject({
      policyVersion: "rp-2026.09.0", requestText: "中学生100m選手、今日のメニューを作って",
    });
  });

  it("does not issue a save token for explicitly rejected 80m", async () => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = "running-preview-test-secret-with-more-than-32-bytes";
    list.mockResolvedValue([]);
    extract.mockResolvedValue({ ok: true, claims: {
      runningRequested: true, event: { value: "100m", sourceText: "100m選手" },
      ageGroup: { value: "JUNIOR_HIGH", sourceText: "中学生" },
      explicitDistances: [{ value: 80, sourceText: "80mをやりたい" }],
      distancePreference: null, loadReductionRequested: null, fatigueState: null,
      availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
    } });
    const result = await generateRunningMenuPreviewAction({ requestText: "中学生100m選手、今日は80mをやりたい", context: {} });
    expect(result).toMatchObject({ ok: true, persistable: false, previewToken: null, running: { status: "COACH_REVIEW_REQUIRED" } });
  });
  it("accepts race context and recovered fatigue through the production action", async () => {
    process.env.AI_MENU_PLANNER_ENABLED = "true";
    process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = "running-preview-test-secret-with-more-than-32-bytes";
    list.mockResolvedValue([]);
    extract.mockResolvedValue({ ok: true, claims: {
      runningRequested: true, event: { value: "200m", sourceText: "２００mのレース" },
      ageGroup: { value: "JUNIOR_HIGH", sourceText: "中学2年" }, explicitDistances: [],
      distancePreference: null, loadReductionRequested: null, fatigueState: null,
      availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
    } });
    const requestText = "今週に２００mのレースがある。中学2年男子です。あと3日で試合ですが、疲労が抜けすぎています。少し疲労を溜めるメニューを消化したい";
    const result = await generateRunningMenuPreviewAction({ requestText, context: {} });
    expect(result).toMatchObject({ ok: true, persistable: true, running: { status: "READY", prescription: { distanceMeters: 120, totalReps: 3, repRestSeconds: 900 } } });
    if (!result.ok || result.previewToken === null) throw new Error("Expected signed preview");
    // Unmodeled competition/recovery context remains in the signed request;
    // it does not become generated reps, rest, or load-reduction intent.
    expect(verifyRunningMenuPreviewToken(result.previewToken, process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET)).toMatchObject({ requestText });
  });

});
