import type { ComposerCatalogExercise, EditableItem } from "@/domain/menu-composition/contracts";
import { trainingReducedLoad, type TrainingConditions } from "./conditions";
import type { TrainingItemAnnotation } from "./contracts";
import { assessExerciseEligibility, type ExerciseEligibility } from "./eligibility";

const STAGE_REASONS = [
  "可動域と身体操作を整える準備として選択。",
  "姿勢・支持・協調を確認する練習として選択。",
  "基本的なスプリント動作を身につける練習として選択。",
  "リズムと接地を練習する種目として選択。",
  "実際の疾走動作へつなぐ練習として選択。",
] as const;
const STAGE_INTENSITY = [
  "反動をつけず、痛みのない範囲でゆっくり大きく動かす。",
  "姿勢を保てる範囲で、ゆっくり正確に行う。",
  "力まずに正しい形で行える速さ。動きが崩れる前に終える。",
  "リズムよく軽快に。接地は短く静かに、余裕を残した強さで行う。",
  "リズムよく軽快に。接地は短く静かに、余裕を残した強さで行う。",
] as const;

function suggestedRestSeconds(row: ComposerCatalogExercise, eligibility: ExerciseEligibility): number {
  // A registered coach value wins. Otherwise: mobility flows on, drills walk back, strength/jumps recover.
  if (row.defaultRestSeconds !== null) return Math.min(Math.max(0, row.defaultRestSeconds), 300);
  if (eligibility.section === "STRENGTH") return row.category.toUpperCase() === "JUMP" ? 90 : 60;
  return row.category.toUpperCase() === "MOBILITY" || eligibility.stage === 0 ? 20 : 30;
}

/**
 * Editable starting values for every catalog item: the Composer's picks, the rule-based
 * fallback and a human's addition all receive the same App numbers. Never an Engine dose.
 */
export function suggestCatalogItem(row: ComposerCatalogExercise, conditions: TrainingConditions, id = crypto.randomUUID()): {
  item: Extract<EditableItem, { type: "CATALOG_EXERCISE" }>; annotation: TrainingItemAnnotation;
} {
  const eligibility = assessExerciseEligibility(row, conditions);
  const light = trainingReducedLoad(conditions);
  const count = row.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED" ? row.videoGuidance.countingUnit : null;
  const description = row.description ?? "";
  const alternating = /交互/u.test(description);
  const perSide = count === "PER_SIDE" || (!count && !alternating && /片側|反対側|左右.*(?:ずつ|それぞれ)|片脚ずつ/u.test(description));
  // Registered Exercise.default* values are preferred; a reduced day only scales total volume.
  const registeredSets = row.defaultSets !== null && row.defaultSets > 0 ? row.defaultSets : 2;
  const sets = Math.min(light ? Math.max(1, Math.ceil(registeredSets / 2)) : registeredSets, light ? 2 : 4);
  const quantity = row.metricType === "TIME" ? Math.min(row.defaultDurationSeconds ?? (light ? 10 : 20), light ? 20 : 60)
    : row.metricType === "DISTANCE" ? Math.min(row.defaultDistanceMeters ?? 10, conditions.environment.straightMeters ?? 0)
      : Math.min(row.defaultReps ?? (light ? 4 : 6), light ? 6 : 30);
  // Every number needs a visible basis: the coach's registered value, or the App's conservative start.
  const registeredQuantity = row.metricType === "TIME" ? row.defaultDurationSeconds : row.metricType === "DISTANCE" ? row.defaultDistanceMeters : row.defaultReps;
  const registeredCount = [row.defaultSets !== null && row.defaultSets > 0, registeredQuantity !== null].filter(Boolean).length;
  const adjusted = (row.defaultSets !== null && row.defaultSets > 0 && sets !== row.defaultSets) || (registeredQuantity !== null && quantity !== registeredQuantity);
  const source = registeredCount === 0 ? "既定量が未登録のため、アプリの控えめな初期値による編集可能な仮提案。"
    : `${registeredCount === 2 ? "登録された既定量" : "登録された既定量（未登録の項目はアプリの控えめな初期値）"}をもとにした編集可能な提案。${adjusted ? "今日の条件に合わせて控えめに調整。" : ""}`;
  const counting = count === "ROUND_TRIP" ? "登録された往復を1回として数える。"
    : count === "ALTERNATING_TOTAL" || count === "TOTAL_REPS" ? "左右合計で数える。"
      : perSide ? "回数欄は片側の回数。左右の順序は登録説明に従う。"
        : alternating ? "回数欄は左右合計。交互に行う登録動作を数える。"
        : "登録説明の動作を1回として数える。";
  const plannedNote = `${source}${row.metricType === "REPS" ? counting : "登録説明どおりの動作を行う。"}疲労や動作の崩れが出たら中止。`;
  const strength = eligibility.section === "STRENGTH";
  const jump = row.category.toUpperCase() === "JUMP";
  const intensity = strength
    ? jump ? "着地を静かに安定させ、接地を短く。高さより動作の質を優先し、崩れたら終了する。"
      : "呼吸を止めずに姿勢を保てる範囲。最後の2〜3回に余裕を残す。"
    : STAGE_INTENSITY[Math.min(Math.max(eligibility.stage, 0), 4)];
  const reason = strength ? jump ? "接地と跳躍の補助トレーニングとして選択。" : "姿勢・支持を支える補強として選択。"
    : STAGE_REASONS[Math.min(Math.max(eligibility.stage, 0), 4)];
  return {
    item: { id, type: "CATALOG_EXERCISE", exerciseId: row.id, displayName: row.name,
      executionInstruction: (row.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED" ? row.videoGuidance.executionSummary : description).slice(0, 400), plannedNote,
      reason, plannedSets: sets, plannedReps: row.metricType === "REPS" ? quantity : null,
      plannedDurationSeconds: row.metricType === "TIME" ? quantity : null,
      plannedDistanceMeters: row.metricType === "DISTANCE" && quantity > 0 ? quantity : null,
      plannedRestSeconds: suggestedRestSeconds(row, eligibility) },
    annotation: { intensity: `${intensity}編集可能な提案値。`,
      stage: eligibility.section === "MOVEMENT" ? eligibility.stage : null, family: eligibility.family,
      relationship: "COMBINABLE", alternativeGroup: null },
  };
}
