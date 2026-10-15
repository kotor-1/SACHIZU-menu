import type { ParsedRunningPolicyInput, RunningFailureReason, RunningPolicyResult, RunningPrescription } from "./contracts";
import { SCIENCE_POLICY, SCIENCE_POLICY_HASH, SCIENCE_POLICY_VERSION, type ScienceRuleId } from "./science-policy";
import type { RunningSciencePrescription } from "./science-contracts";

/** Purpose branch of the existing finite Engine; no model or database authority. */
export function planScienceRunning(request: ParsedRunningPolicyInput): RunningPolicyResult {
  const identity = { policyVersion: SCIENCE_POLICY_VERSION, policyHash: SCIENCE_POLICY_HASH,
    humanExplicitDistances: request.humanExplicitDistances.slice(), selectedDistanceMeters: null };
  const stop = (reason: Exclude<RunningFailureReason, "AVAILABLE_TIME_TOO_SHORT">,
    status: "NEEDS_INPUT" | "NEEDS_POLICY" | "COACH_REVIEW_REQUIRED" | "BLOCKED" = "NEEDS_INPUT"): RunningPolicyResult =>
    ({ ...identity, status, reason, humanExplicitNumbers: request.humanExplicitNumbers ?? null });
  const c = request.science;
  if (!c) return stop("SCIENCE_CONTEXT_REQUIRED");
  if (request.ageGroup === undefined || request.ageGroup === "UNKNOWN") return stop("AGE_REQUIRED");
  if (c.ageYears !== undefined && ((request.ageGroup === "ELEMENTARY" && c.ageYears > 12)
    || (request.ageGroup === "JUNIOR_HIGH" && (c.ageYears < 12 || c.ageYears > 15))
    || (request.ageGroup === "HIGH_SCHOOL" && (c.ageYears < 15 || c.ageYears > 18))
    || (request.ageGroup === "ADULT" && c.ageYears < 18))) return stop("AGE_CONTEXT_CONFLICT", "COACH_REVIEW_REQUIRED");
  if (c.symptomFree !== true) return stop("SCIENCE_HEALTH_CONFIRMATION_REQUIRED", c.symptomFree === false ? "COACH_REVIEW_REQUIRED" : "NEEDS_INPUT");
  if (!c.experience) return stop("SCIENCE_EXPERIENCE_REQUIRED");
  const child = request.ageGroup === "ELEMENTARY";
  if (child && c.ageYears === undefined) return stop("SCIENCE_CONTEXT_REQUIRED");
  if (child && c.maturity === undefined) return stop("SCIENCE_MATURITY_REQUIRED");
  if (request.ageGroup !== "ADULT" && c.supervised !== true) return stop("SCIENCE_SUPERVISION_REQUIRED");
  const purpose = request.competitionDays === 1 ? "PRECOMP" : request.purpose;
  if (request.competitionDays === 0) return stop("SCIENCE_TAPER_WINDOW_REVIEW", "COACH_REVIEW_REQUIRED");
  const low = request.intensityPreference === "LOW";
  // A fatigue report alone keeps the chosen run at its usual starting dose (already the low initial
  // value) and adds a check before every rep. Strong fatigue or illness is held by the Engine first.
  const fatigueReported = request.fatigueState === "REPORTED";
  // Rest is an appropriate outcome. Tempo is never assumed to provide recovery.
  if (purpose === "RECOVERY" || (low && request.fatigueState !== "NONE")) return stop("RECOVERY_REST_PREFERRED", "COACH_REVIEW_REQUIRED");
  if (request.standardPolicyConflict || request.humanExplicitNumbers?.totalReps !== undefined
    || request.humanExplicitNumbers?.repRestSeconds !== undefined || request.coachSetSplit
    || request.coachTargetTimeSeconds !== undefined || request.coachTargetTimeRange !== undefined) {
    return stop("SCIENCE_EXPLICIT_INPUT_REVIEW", "COACH_REVIEW_REQUIRED");
  }
  let id: ScienceRuleId;
  let highIntensity = false;
  let instruction: string;
  let rationale: string;
  if (purpose === "PRECOMP") {
    if (request.competitionDays !== 1) return stop("SCIENCE_COMPETITION_CONTEXT_REQUIRED");
    if (child) return stop("SCIENCE_TAPER_WINDOW_REVIEW", "COACH_REVIEW_REQUIRED");
    if (c.familiarWithSprint !== true || c.experience !== "EXPERIENCED") return stop("SCIENCE_FAMILIARITY_REQUIRED");
    id = "SCI_PRECOMP_FAMILIAR";
    instruction = "大会前日の慣れた軽い流し。速度を競わず楽に動く。速い刺激や新しい動きは加えず、疲労感があれば中止する。";
    rationale = "既存STRIDEの距離下限80m・休息上限180秒を利用し、本数は暫定的に2本へ抑制。前日用量を直接実証した研究値ではなく、疲労を残さないための設計値。長距離taper率は転用しない。";
  } else if (purpose === "BASIC" || low) {
    id = child ? "SCI_BASIC_CHILD" : "SCI_BASIC_INITIAL";
    instruction = "楽な速さで姿勢・腕振り・接地を練習する。競走や全力走にはしない。会話できる余裕を保ち、形が崩れたら終了する。";
    rationale = "NSCAの運動技能・個別化の原則に基づく技術練習。距離・本数・休息は短い活動と十分な確認時間を確保する暫定設計値で、研究が最適用量を証明した値ではない。";
  } else if (purpose === "ACCEL") {
    highIntensity = true;
    if (child && (c.ageYears! < 10 || c.experience !== "EXPERIENCED")) return stop("SCIENCE_POPULATION_NOT_SUPPORTED", "NEEDS_POLICY");
    if (c.familiarWithSprint !== true) return stop("SCIENCE_FAMILIARITY_REQUIRED");
    id = child ? "SCI_ACC_CHILD_EXPOSURE" : c.experience === "BEGINNER" ? "SCI_ACC_INITIAL" : "SCI_ACC_EXPERIENCED";
    instruction = child ? "指導者の監督下で立位から短い加速を練習する。力任せに走らず、姿勢と接地の質を優先。各本で十分に休み、痛み・動作の乱れで終了する。"
      : "立位から滑らかに加速する。全力意図は速度の百分率ではない。各本を回復してから行い、速度・動作の質が落ちたら終了する。";
    rationale = child ? "10–12歳で経験・監督・準備状態を確認した初期接触量。4×10mは小学生で直接実証された用量ではなく、LTADと若年短距離研究を参考にした保守的設計値。成熟度を学年から推定しない。"
      : "Haugenの短距離加速・十分な回復の実践例を採用。本数4と経験別の固定初期値は暫定設計。疲労の蓄積で質を落とす反復を目的としない。";
  } else if (purpose === "MAX_SPEED" || purpose === "SPEED_ENDURANCE") {
    highIntensity = true;
    if (child || c.experience !== "EXPERIENCED") return stop("SCIENCE_POPULATION_NOT_SUPPORTED", "NEEDS_POLICY");
    if (c.maturity !== "POST") return stop("SCIENCE_MATURITY_REQUIRED");
    if (c.familiarWithSprint !== true) return stop("SCIENCE_FAMILIARITY_REQUIRED");
    if (request.event !== "100m" && request.event !== "200m") return stop(request.event ? "EVENT_POLICY_NOT_SUPPORTED" : "EVENT_REQUIRED");
    if (purpose === "MAX_SPEED") {
      id = "SCI_MV_INITIAL";
      instruction = "1本は助走20m＋最高速度を狙うfly区間10m＋減速20m。50m全体を全力走にしない。全力意図と実測最高速度の百分率は別。休息4分を確保する。";
      rationale = "Haugenの若年・比較的未訓練選手例（助走20m、fly10m、回復約4分）を利用。本数2と減速20mは低量から始める設計値。距離総量には助走と減速を含め、fly総量と区別する。";
    } else if (c.speedEnduranceMode === "CONTROLLED_90_95") {
      id = "SCI_SE_CONTROLLED";
      if (c.referenceDistanceMeters !== 60 || !c.referenceTimeSeconds) return stop("SCIENCE_REFERENCE_REQUIRED");
      instruction = "60m同距離自己ベストの平均速度を100%とした90–95%で走る。これは実測最高速度Vmaxの90–95%ではない。スプリント特異的持久の全力意図とは別メニュー。";
      rationale = "90–95%帯の速度持久を独立モードとする。エリート実践のVmax帯を同距離タイムへ直接換算せず、同距離平均速度を別の暫定運用基準として明示。60m×4・休息240秒は初期設計値。";
    } else if (c.speedEnduranceMode === "SPRINT_SPECIFIC") {
      id = "SCI_SES_INITIAL";
      instruction = "全力意図で100mを走り、1本ごとに10分休む。95%超のスプリント特異的持久を狙うが、実測なしに達成速度%を断定しない。速度低下や姿勢の崩れがあれば終了。";
      rationale = "Haugenの若年junior例2–3×100m・回復10分から最少本数2を採用。成人・高校生を一律ADVとせず、経験・成熟・慣れ・回復を確認。90–95%の制御走とは区別する。";
    } else return stop("SCIENCE_ENDURANCE_MODE_REQUIRED");
  } else return stop("SCIENCE_POPULATION_NOT_SUPPORTED", "NEEDS_POLICY");
  if (highIntensity) {
    if (request.fatigueState === "STRONG_OR_UNWELL") return stop("STRONG_FATIGUE_OR_UNWELL", "COACH_REVIEW_REQUIRED");
    if (c.hoursSinceHighIntensity === undefined || c.hoursUntilNextHighIntensity === undefined
      || c.highIntensitySessionsLast7Days === undefined) return stop("SCIENCE_RECOVERY_INTERVAL_REQUIRED");
    if (c.hoursSinceHighIntensity < 48 || c.hoursUntilNextHighIntensity < 48
      || (request.competitionDays !== undefined && request.competitionDays < 2)) return stop("SCIENCE_RECOVERY_INTERVAL_VIOLATION", "COACH_REVIEW_REQUIRED");
    if (c.highIntensitySessionsLast7Days >= 2) return stop("SCIENCE_FREQUENCY_LIMIT", "COACH_REVIEW_REQUIRED");
  }
  const rule = SCIENCE_POLICY.rules[id];
  if (request.humanExplicitDistances.length && request.humanExplicitDistances.some(v => v !== rule.distanceMeters)) return stop("SCIENCE_EXPLICIT_INPUT_REVIEW", "COACH_REVIEW_REQUIRED");
  const controlled = id === "SCI_SE_CONTROLLED";
  const science: RunningSciencePrescription = {
    source: "SCIENCE_INFORMED_DEFAULT", coachApproval: "NOT_COACH_APPROVED", provisional: true,
    ruleId: id, purpose: purpose ?? "LOW_INTENSITY", method: rule.method,
    evidenceIds: [...rule.evidence],
    intensityReference: controlled ? "SAME_DISTANCE_AVERAGE_SPEED" : highIntensity && !child ? "MAX_INTENT" : "RELAXED_SUBMAX",
    intensityPercent: controlled ? { min: 90, max: 95 } : null,
    targetTimeRangeSeconds: controlled ? { min: c.referenceTimeSeconds! / 0.95, max: c.referenceTimeSeconds! / 0.90 } : null,
    buildupMeters: id === "SCI_MV_INITIAL" ? 20 : 0,
    flyMeters: id === "SCI_MV_INITIAL" ? 10 : 0,
    decelerationMeters: id === "SCI_MV_INITIAL" ? 20 : 0,
    minHighIntensitySeparationHours: highIntensity ? 48 : 0,
    maxHighIntensitySessionsPer7Days: highIntensity ? 2 : null,
    rationale, stopInstruction: `${fatigueReported ? "疲れの申告あり。1本ごとに動きと速さを確かめ、いつもより重い・遅いと感じたら残りは行わない。" : ""}痛み・不調・動作の乱れ・回復不足で中止。高強度の間隔と頻度は他競技も含めて確認し、量を埋めるために続行しない。`,
  };
  const totalReps = request.loadReductionRequested ? Math.max(1, Math.ceil(rule.totalReps / 2)) : rule.totalReps;
  const p: RunningPrescription = {
    policyVersion: SCIENCE_POLICY_VERSION, policyHash: SCIENCE_POLICY_HASH,
    event: request.event === "100m" || request.event === "200m" ? request.event : "GENERAL",
    science, distanceMeters: rule.distanceMeters, totalReps, totalDistanceMeters: rule.distanceMeters * totalReps,
    repsPosition: request.loadReductionRequested ? "MIN" : "DEFAULT", sets: 1, setReps: null, setRestSeconds: null,
    repRestSeconds: totalReps > 1 ? rule.repRestSeconds : null,
    intensityPresentation: "PLAIN_LANGUAGE", executionInstructionText: instruction,
    coachTargetTimeSeconds: null, coachTargetTimeRange: null,
    loadReductionRequested: request.loadReductionRequested, repsReductionApplied: totalReps < rule.totalReps,
    minimumKnownRestSeconds: (totalReps - 1) * rule.repRestSeconds,
    fullSessionTimeGuaranteed: false, decisionReasons: ["SCIENCE_DEFAULT_SELECTED",
      ...(purpose === "PRECOMP" ? ["COMPETITION_CONTEXT_APPLIED" as const] : []),
      ...(low ? ["LOW_INTENSITY_CONTEXT_APPLIED" as const] : []),
      ...(fatigueReported ? ["FATIGUE_REPORT_PRESERVED" as const] : []),
      ...(totalReps < rule.totalReps ? ["LOAD_REDUCTION_APPLIED" as const] : [])],
  };
  if (request.availableTimeSeconds !== undefined && request.availableTimeSeconds <= p.minimumKnownRestSeconds) {
    return { ...identity, selectedDistanceMeters: p.distanceMeters, status: "NEEDS_TIME_ADJUSTMENT", reason: "AVAILABLE_TIME_TOO_SHORT", candidate: p };
  }
  return { ...identity, selectedDistanceMeters: p.distanceMeters, status: "READY", prescription: p };
}
