import type { ComposerCatalogExercise, EditableItem } from "@/domain/menu-composition/contracts";
import { trainingReducedLoad, type TrainingConditions } from "./conditions";
import type { TrainingItemAnnotation } from "./contracts";
import { assessExerciseEligibility, trainingStopMarginMeters, trainingUsableMeters, type ExerciseEligibility } from "./eligibility";

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

type Volume = { sets: number; reps: number; seconds: number; meters: number };
/**
 * Starting volumes when the coach has registered nothing, from common coaching ranges for warm-up
 * drills and supporting bodyweight strength. They are editable starting points, not physiological
 * prescriptions: a reduced day lowers the volume, never the intent of the movement. A distance
 * drill counts passes as sets (one pass, then walk back), and the rest covers that walk.
 */
const STARTING_VOLUME = {
  // Mobility flows on: one pass or one set, little rest.
  MOBILITY: { label: "可動域の準備運動", rest: 20, normal: { sets: 1, reps: 8, seconds: 20, meters: 15 }, reduced: { sets: 1, reps: 6, seconds: 15, meters: 10 } },
  DRILL: { label: "姿勢・基本動作のドリル", rest: 30, normal: { sets: 2, reps: 6, seconds: 20, meters: 15 }, reduced: { sets: 1, reps: 4, seconds: 10, meters: 10 } },
  // Skips and switches need room for rhythm and a little longer recovery to keep contacts quick.
  RHYTHM: { label: "リズム・疾走へつなぐドリル", rest: 45, normal: { sets: 2, reps: 6, seconds: 15, meters: 20 }, reduced: { sets: 1, reps: 4, seconds: 10, meters: 15 } },
  // Hops load one or both legs on every contact: short passes and a full walk back.
  HOP: { label: "弾む・跳ねるドリル", rest: 60, normal: { sets: 2, reps: 6, seconds: 10, meters: 10 }, reduced: { sets: 1, reps: 4, seconds: 10, meters: 10 } },
  STRENGTH: { label: "自重の補強", rest: 60, normal: { sets: 2, reps: 10, seconds: 30, meters: 10 }, reduced: { sets: 1, reps: 8, seconds: 20, meters: 10 } },
  JUMP: { label: "跳躍の補強", rest: 90, normal: { sets: 2, reps: 5, seconds: 10, meters: 20 }, reduced: { sets: 1, reps: 4, seconds: 10, meters: 15 } },
} as const satisfies Record<string, { label: string; rest: number; normal: Volume; reduced: Volume }>;
type VolumeKind = keyof typeof STARTING_VOLUME;

function volumeKind(row: ComposerCatalogExercise, eligibility: ExerciseEligibility): VolumeKind {
  const category = row.category.toUpperCase();
  if (eligibility.section === "STRENGTH") return category === "JUMP" ? "JUMP" : "STRENGTH";
  if (category === "MOBILITY" || eligibility.stage === 0) return "MOBILITY";
  if (eligibility.stage >= 3) return /ケンケン|ケンパ|ジャンプ|ホップ|バウンド|バウンディ|跳|踏み切/u.test(row.name) ? "HOP" : "RHYTHM";
  return "DRILL";
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
  // "交互" alone can mean alternating positions (cat & dog, pelvic tilts); only left/right is a two-sided count.
  const alternating = /交互/u.test(description) && /左右/u.test(description);
  const perSide = count === "PER_SIDE" || (!count && !alternating && /片側|反対側|左右.*(?:ずつ|それぞれ)|片脚ずつ/u.test(description));
  const total = count === "ALTERNATING_TOTAL" || count === "TOTAL_REPS" || (!count && alternating);
  const kind = volumeKind(row, eligibility);
  const plan = STARTING_VOLUME[kind];
  const start = light ? plan.reduced : plan.normal;
  // One-sided or alternating strength work is a little shorter per side; a left/right total counts both sides.
  const reps = (volume: Volume) => (kind === "STRENGTH" && (perSide || total) ? volume.reps - 2 : volume.reps) * (total ? 2 : 1);
  // Registered Exercise.default* values are preferred. A reduced day halves registered sets and keeps a
  // registered count or time only up to the ordinary starting volume; a registered distance stays.
  const registeredSets = row.defaultSets !== null && row.defaultSets > 0 ? row.defaultSets : null;
  const registeredQuantity = row.metricType === "TIME" ? row.defaultDurationSeconds : row.metricType === "DISTANCE" ? row.defaultDistanceMeters : row.defaultReps;
  const sets = registeredSets === null ? start.sets : Math.min(light ? Math.max(1, Math.ceil(registeredSets / 2)) : registeredSets, light ? 2 : 4);
  const straight = conditions.environment.straightMeters;
  const usable = trainingUsableMeters(eligibility.stage, straight);
  const wantedMeters = registeredQuantity ?? start.meters;
  const quantity = row.metricType === "TIME" ? Math.min(registeredQuantity ?? start.seconds, light ? 20 : 60)
    : row.metricType === "DISTANCE" ? Math.min(wantedMeters, usable)
      : Math.min(registeredQuantity ?? reps(start), light ? Math.min(reps(plan.normal), 12) : 30);
  // Every number needs a visible basis: the coach's registered value, or the App's starting range.
  const registeredCount = [registeredSets !== null, registeredQuantity !== null].filter(Boolean).length;
  const reduced = (registeredSets !== null && sets !== registeredSets) || (registeredQuantity !== null && row.metricType !== "DISTANCE" && quantity !== registeredQuantity);
  const source = registeredCount === 0 ? `既定量が未登録のため、${plan.label}の一般的な範囲からアプリが決めた初期値（編集可能な仮提案）。`
    : `${registeredCount === 2 ? "登録された既定量" : "登録された既定量（未登録の項目はアプリの初期値）"}をもとにした編集可能な提案。${reduced ? "今日の条件に合わせて控えめに調整。" : ""}`;
  const margin = trainingStopMarginMeters(eligibility.stage);
  const space = row.metricType === "DISTANCE" && quantity > 0 && quantity < wantedMeters
    ? `${margin ? `直線${straight}mのため、止まる余裕${margin}mを残して` : `直線${straight}mに合わせて`}${quantity}m${registeredQuantity !== null ? `（登録は${registeredQuantity}m）` : ""}。` : "";
  const counting = count === "ROUND_TRIP" ? "登録された往復を1回として数える。"
    : count === "ALTERNATING_TOTAL" || count === "TOTAL_REPS" ? "左右合計で数える。"
      : perSide ? "回数欄は片側の回数。左右の順序は登録説明に従う。"
        : alternating ? "回数欄は左右合計。交互に行う登録動作を数える。"
        : "登録説明の動作を1回として数える。";
  const plannedNote = `${source}${space}${row.metricType === "REPS" ? counting : "登録説明どおりの動作を行う。"}疲労や動作の崩れが出たら中止。`;
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
      plannedRestSeconds: Math.min(Math.max(0, row.defaultRestSeconds ?? plan.rest), 300) },
    annotation: { intensity: `${intensity}編集可能な提案値。`,
      stage: eligibility.section === "MOVEMENT" ? eligibility.stage : null, family: eligibility.family,
      relationship: "COMBINABLE", alternativeGroup: null },
  };
}
