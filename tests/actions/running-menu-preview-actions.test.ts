import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infra/repositories/exercise-repository", () => ({ listExercisesForMenuPlanner: vi.fn() }));
vi.mock("@/infra/running-menu/openai-intent-extractor", () => ({ extractRunningMenuIntent: vi.fn() }));

import { generateRunningMenuPreviewAction } from "@/actions/running-menu-preview-actions";
import { listExercisesForMenuPlanner } from "@/infra/repositories/exercise-repository";
import { extractRunningMenuIntent } from "@/infra/running-menu/openai-intent-extractor";

const list = vi.mocked(listExercisesForMenuPlanner);
const extract = vi.mocked(extractRunningMenuIntent);
const priorFlag = process.env.AI_MENU_PLANNER_ENABLED;

afterEach(() => {
  if (priorFlag === undefined) delete process.env.AI_MENU_PLANNER_ENABLED;
  else process.env.AI_MENU_PLANNER_ENABLED = priorFlag;
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
});
