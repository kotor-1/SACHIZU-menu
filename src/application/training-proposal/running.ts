import { trainingConditionsSchema, trainingConditionLevel, trainingRunningGoal, TRAINING_AGE_GROUP_LABELS, TRAINING_GOAL_LABELS, type TrainingConditions } from "@/domain/training-proposal/conditions";
import { createRunningMenuPreview, type RunningMenuContextInput, type RunningMenuPreview } from "@/application/running-menu/preview";
import type { VerifiedClaim, VerifiedRunningIntent } from "@/application/running-menu/intent";
import type { RunningPurpose } from "@/domain/running-policy/purpose";
import type { RunningPrescription } from "@/domain/running-policy/contracts";

export type StructuredRunningPreview = {
  intent: VerifiedRunningIntent; context: RunningMenuContextInput; requestText: string; running: RunningMenuPreview | null;
};
const sourced = <T>(value: T, sourceText: string): VerifiedClaim<T> => ({ value, sourceText, sourceType: "USER_CONTEXT" });

/**
 * Straight-line space one repetition needs. A fly run already contains its run-up and
 * deceleration (never double-added). Other runs end at full or relaxed speed, so the
 * App keeps a stopping margin beyond the prescribed distance: 10m after relaxed runs,
 * and for fast runs 10/15/20m by distance (20m is about the >=17m run-out a competition
 * straight provides after the finish). These are App safety limits, not prescription values.
 */
export function runningSpaceRequirement(p: Pick<RunningPrescription, "distanceMeters" | "science">) {
  const science = p.science;
  if (science && science.decelerationMeters > 0) {
    const whole = science.buildupMeters + science.flyMeters + science.decelerationMeters;
    return { requiredMeters: Math.max(p.distanceMeters, whole), stoppingMarginMeters: 0 };
  }
  const relaxed = science?.intensityReference === "RELAXED_SUBMAX";
  const stoppingMarginMeters = relaxed || p.distanceMeters <= 20 ? 10 : p.distanceMeters <= 40 ? 15 : 20;
  return { requiredMeters: p.distanceMeters + stoppingMarginMeters, stoppingMarginMeters };
}

/** Explicit form values -> existing Engine. Optional prose has no dose or safety authority. */
export function buildStructuredRunningPreview(rawConditions: TrainingConditions): StructuredRunningPreview {
  const conditions = trainingConditionsSchema.parse(rawConditions);
  const a = conditions.athlete;
  const c = conditions.condition;
  const e = conditions.environment;
  const ageGroup = a.ageGroup === "UNIVERSITY" ? "ADULT" : a.ageGroup;
  // The primary goal leads; when it is not a running goal, the first selected running goal is used alone.
  const runningGoal = trainingRunningGoal(conditions);
  const runningRequested = runningGoal !== null;
  const ageText = `年代：${TRAINING_AGE_GROUP_LABELS[a.ageGroup]}`;
  const eventText = `種目：${a.event}`;
  const purposeText = runningGoal === null || runningGoal === conditions.primaryGoal
    ? `主目的：${TRAINING_GOAL_LABELS[conditions.primaryGoal]}`
    : `主目的：${TRAINING_GOAL_LABELS[conditions.primaryGoal]}。走の目的：${TRAINING_GOAL_LABELS[runningGoal]}`;
  const fatigueText = `疲労の自己評価：10段階の${c.fatigue}`;
  // These are conservative App hold thresholds, not a physiological conversion.
  const level = trainingConditionLevel(c);
  const severe = level === "HOLD" || level === "STRONG_FATIGUE";
  const reportedFatigue = level === "REPORTED";
  const loadText = `希望する負荷：${{ LIGHT: "軽め", NORMAL: "通常", HIGH: "高め" }[c.load]}`;
  const competitionText = c.competitionDays === null ? "大会までの日数：未指定" : `大会までの日数：${c.competitionDays}日`;
  const conditionText = `筋肉痛：${{ NONE: "なし", MILD: "軽い", STRONG: "強い" }[c.soreness]}。痛み：${c.pain === "NONE" ? "なし" : "あり"}。体調：${{ GOOD: "良い", FAIR: "やや不調", POOR: "不調" }[c.health]}`;
  const requestText = [ageText, eventText, purposeText, fatigueText, loadText, competitionText,
    conditionText].join("。") + "。";
  const intent: VerifiedRunningIntent = {
    runningRequested, event: sourced(a.event, eventText), ageGroup: sourced(ageGroup, ageText), explicitDistances: [],
    distancePreference: null, loadReductionRequested: c.load === "LIGHT" ? sourced(true, loadText) : null,
    fatigueState: severe ? sourced("STRONG_OR_UNWELL", `${fatigueText}／${conditionText}`)
      : reportedFatigue ? sourced("REPORTED", `${fatigueText}／${conditionText}`) : null,
    purpose: runningGoal !== null ? sourced(runningGoal as RunningPurpose, purposeText) : null,
    intensityPreference: c.load === "LIGHT" ? sourced("LOW", loadText) : null,
    competitionDays: c.competitionDays === null ? null : sourced(c.competitionDays, competitionText),
    availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
  };
  const context: RunningMenuContextInput = { event: a.event, ageGroup, science: {
    ...(a.ageYears !== null ? { ageYears: a.ageYears } : {}),
    ...(a.experience !== "UNKNOWN" ? { experience: a.experience } : {}),
    ...(a.maturity !== null ? { maturity: a.maturity } : {}),
    ...(a.supervised !== null ? { supervised: a.supervised } : {}),
    ...(a.familiarWithSprint !== null ? { familiarWithSprint: a.familiarWithSprint } : {}),
    symptomFree: c.pain === "NONE" && c.health === "GOOD" && c.soreness === "NONE",
    ...(c.hoursSinceHighIntensity !== null ? { hoursSinceHighIntensity: c.hoursSinceHighIntensity } : {}),
    ...(c.hoursUntilNextHighIntensity !== null ? { hoursUntilNextHighIntensity: c.hoursUntilNextHighIntensity } : {}),
    ...(c.highIntensitySessionsLast7Days !== null ? { highIntensitySessionsLast7Days: c.highIntensitySessionsLast7Days } : {}),
    ...(c.speedEnduranceMode != null ? { speedEnduranceMode: c.speedEnduranceMode } : {}),
    ...(c.referenceDistanceMeters != null ? { referenceDistanceMeters: c.referenceDistanceMeters } : {}),
    ...(c.referenceTimeSeconds != null ? { referenceTimeSeconds: c.referenceTimeSeconds } : {}),
  } };
  const hold = (reason: string, message: string): StructuredRunningPreview => ({ intent, context, requestText,
    running: { status: "COACH_REVIEW_REQUIRED", reason, message, explicitDistances: [] } });
  if (!runningRequested) return { intent, context, requestText, running: null };
  if (level === "HOLD") return hold("STRUCTURED_CONDITION_REQUIRES_REVIEW", "痛みまたは体調不良が選択されています。走の量を作らず、実施前の確認を優先してください。");
  if (level === "STRONG_FATIGUE") return hold("STRUCTURED_CONDITION_REQUIRES_REVIEW", "強い疲労または強い筋肉痛が選択されています。走の量を作らず、回復を優先してください。");
  const running = createRunningMenuPreview(intent, context, requestText);
  if (running && running.status !== "READY") {
    // Clarify Engine holds in this screen's terms without changing the Engine decision.
    // The screen asks only five things, so each hold says which of those choices would allow running.
    const explain = (message: string) => ({ intent, context, requestText, running: { ...running, message } });
    const newOrChild = a.experience === "BEGINNER" || a.ageGroup === "ELEMENTARY";
    if (running.reason === "STRONG_FATIGUE_OR_UNWELL" && reportedFatigue) return explain("疲れがあるため、高強度の走（加速・最高速度・スピード持久）は出していません。軽い走練習を行うときは、目的を「基礎の走力」にしてください。");
    if (running.reason === "EVENT_POLICY_NOT_SUPPORTED") return explain("最高速度・スピード持久力の走処方は、現在100m・200mの選手だけに対応しています。");
    if ((running.reason === "SCIENCE_FAMILIARITY_REQUIRED" || running.reason === "SCIENCE_POPULATION_NOT_SUPPORTED") && newOrChild) {
      return explain("小学生と始めたばかりの選手には、走練習は「基礎の走力」だけを出しています。目的を「基礎の走力」にすると、走練習も提案します。");
    }
    if (running.reason === "SCIENCE_MATURITY_REQUIRED" && a.ageGroup === "JUNIOR_HIGH") return explain("中学生には、最高速度・スピード持久の走練習は出していません。目的を「加速」か「基礎の走力」にすると提案します。");
    if (running.reason === "RECOVERY_REST_PREFERRED") return explain("疲労回復の日は、休養を優先して走練習を出していません。");
    if (running.reason === "SCIENCE_TAPER_WINDOW_REVIEW") return explain("大会前日の走練習は、小学生や疲れのある選手には自動で出していません。内容はコーチが決めてください。");
    return { intent, context, requestText, running };
  }
  if (running?.status !== "READY") return { intent, context, requestText, running };
  if (e.flatSafe !== true || e.trafficFree !== true || e.obstacleFree !== true || e.straightMeters === null || e.surface === null || e.surface === "OTHER") {
    return hold("RUNNING_SPACE_UNCONFIRMED", "走路の路面、安全な平地・交通・障害物と、利用できる直線距離の確認が必要です。未確認の場所へ走処方を確定しません。");
  }
  const p = running.prescription;
  const space = runningSpaceRequirement(p);
  const dose = `${p.distanceMeters}m×${p.totalReps}本`;
  if (e.straightMeters < p.distanceMeters || (space.stoppingMarginMeters === 0 && e.straightMeters < space.requiredMeters)) {
    return hold("RUNNING_DISTANCE_EXCEEDS_SPACE", `既存処方（${dose}）には、助走・主区間・減速を含めて少なくとも${space.requiredMeters}mの直線が必要です。選択した直線は${e.straightMeters}mのため、走練習は未処方です。距離・本数・休息を短くした処方には置き換えていません。`);
  }
  if (e.straightMeters < space.requiredMeters) {
    return hold("RUNNING_STOPPING_SPACE_UNCONFIRMED", `既存処方（${dose}）は、走り終えた後に安全に止まる余裕として${space.stoppingMarginMeters}m以上が必要です（合計${space.requiredMeters}m）。選択した直線は${e.straightMeters}mのため、走練習は未処方です。距離を短くした処方には置き換えていません。`);
  }
  return { intent, context, requestText, running };
}
