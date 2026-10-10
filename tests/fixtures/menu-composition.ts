import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { EMPTY_EXERCISE_DOSE, type ComposerCatalogExercise, type CompositionItem, type ExercisePlanItem } from "@/domain/menu-composition/contracts";
import type { VerifiedRunningIntent } from "@/application/running-menu/intent";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { issueRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";
import type { RunningMenuPreviewActionResult } from "@/actions/running-menu-preview-actions";

export const COMPOSITION_TEST_KEY = "offline-menu-composition-test-key-with-over-32-bytes";
export const compositionRequest = "中学生200m選手。メニューを作って。プランクと、壁に手をついて膝を入れ替える練習を入れたい";
export function catalogFixture(patch: Partial<ComposerCatalogExercise> = {}): ComposerCatalogExercise {
  return { id: "exercise-a", ownerId: DEFAULT_OWNER_ID, status: "REVIEWED", name: "プランク", category: "CORE", description: "肘をついて身体をまっすぐ保つ。",
    coachingPoint: "腰を反らさない", commonMistake: "息を止める", metricType: "TIME", difficulty: 2, energySystem: "NONE",
    defaultSets: 3, defaultReps: null, defaultDurationSeconds: 40, defaultDistanceMeters: null, defaultRestSeconds: 60,
    purposes: ["POSTURE"], events: ["COMMON"], targets: ["STRENGTH"], tags: ["体幹"], videoUrl: "https://www.youtube.com/watch?v=abcdefghijk", videoGuidance: null, ...patch };
}
export function catalogPlan(patch: Partial<ExercisePlanItem> = {}): ExercisePlanItem {
  return { type: "CATALOG_EXERCISE", exerciseId: "exercise-a", displayName: "プランク", ...EMPTY_EXERCISE_DOSE,
    plannedSets: 2, plannedDurationSeconds: 30, plannedRestSeconds: 45,
    executionInstruction: "肘をついて身体をまっすぐ保つ", plannedNote: "息を止めない", reason: "姿勢を意識するため", ...patch } as ExercisePlanItem;
}
export function freeformPlan(patch: Partial<ExercisePlanItem> = {}): ExercisePlanItem {
  return { type: "FREEFORM", category: "DRILL", displayName: "壁で膝を入れ替える", originalUserInstruction: "壁に手をついて膝を入れ替える練習", ...EMPTY_EXERCISE_DOSE,
    plannedReps: 10, plannedSets: 2, executionInstruction: "壁に手をついて、左右合計10回膝を入れ替える", plannedNote: "左右合計で数える", reason: "希望した動きを入れるため", ...patch } as ExercisePlanItem;
}
export const runningPlan: CompositionItem = { type: "RUNNING_POLICY" };
export function interpretedFixture(runningRequested = true, requestText = compositionRequest): Extract<RunningMenuPreviewActionResult, { ok: true }> {
  const intent: VerifiedRunningIntent = { runningRequested, event: runningRequested ? { value: "200m", sourceText: "200m選手", sourceType: "USER_TEXT" } : null,
    ageGroup: runningRequested ? { value: "JUNIOR_HIGH", sourceText: "中学生", sourceType: "USER_TEXT" } : null,
    explicitDistances: [], distancePreference: null, loadReductionRequested: null, fatigueState: null,
    purpose: null, intensityPreference: null, competitionDays: null,
    availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [] };
  const running = createRunningMenuPreview(intent, {}, requestText);
  const previewToken = running?.status === "READY" ? issueRunningMenuPreviewToken({ ownerId: DEFAULT_OWNER_ID, requestText, context: {}, intent, prescription: running.prescription }, COMPOSITION_TEST_KEY) : null;
  return { ok: true, intent, running, previewToken, exercises: [], unsupportedIntents: [], persistable: previewToken !== null };
}
