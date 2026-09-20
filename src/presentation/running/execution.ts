import { TECHNIQUE_JUDGMENTS, type MonitorDecision, type StopReason } from "@/domain/running/monitoring/schema";
import { MONITOR_ACTIONS, type MonitorAction } from "@/domain/running/types/monitoring";
import { STOP_REASONS, REP_QUALITIES, type RepQuality } from "@/domain/running/monitoring/schema";
import {
  BODY_REGIONS,
  PAIN_STATUSES,
  RED_FLAGS,
  SAFETY_OUTCOMES,
  type BodyRegion,
  type PainStatus,
  type RedFlag,
  type SafetyOutcome,
} from "@/domain/running/types/readiness";

export const PAIN_STATUS_LABEL_JA = {
  NONE_REPORTED: "痛みなし",
  PRESENT: "痛みあり",
  NOT_ASKED: "未確認",
} satisfies Record<PainStatus, string>;

export const BODY_REGION_LABEL_JA = {
  HEEL: "かかと",
  KNEE: "膝",
  HIP_PELVIS: "股関節・骨盤周辺",
  HAMSTRING: "もも裏",
  CALF_ACHILLES: "ふくらはぎ・アキレス腱",
  SHIN: "すね",
  FOOT_ANKLE: "足・足首",
  LOWER_BACK: "腰",
  GROIN: "鼠径部",
  OTHER: "その他",
} satisfies Record<BodyRegion, string>;

export const RED_FLAG_LABEL_JA = {
  PAIN_AT_REST_OR_NIGHT: "安静時または夜間にも痛む",
  SWELLING: "腫れがある",
  LIMPING: "足を引きずる",
  PAIN_WORSENING_DURING_SESSION: "実施中に痛みが強くなる",
  SUDDEN_SHARP_PAIN: "急な鋭い痛みがある",
  NUMBNESS_TINGLING: "しびれがある",
  DIZZINESS_OR_BREATHING_DIFFICULTY: "めまい・呼吸のしづらさがある",
  PAIN_PERSISTING_OVER_DAYS: "数日続く痛みがある",
} satisfies Record<RedFlag, string>;

export const TECHNIQUE_JUDGMENT_LABEL_JA = {
  GOOD: "良好",
  ACCEPTABLE: "許容範囲",
  DETERIORATING: "低下が見られる",
  UNSAFE: "安全性を確認できない",
} satisfies Record<(typeof TECHNIQUE_JUDGMENTS)[number], string>;

export const START_QUALITY_LABEL_JA = { GOOD: "良好", POOR: "不良" } as const;

export const MONITOR_ACTION_LABEL_JA = {
  CONTINUE: "次の1本へ進む",
  EXTEND_REST: "休息を延長する",
  END_SET: "このセットを終了する",
  END_SESSION_QUALITY: "この処方を終了する",
  STOP_SAFETY: "安全のためこの処方を中止する",
  COACH_REVIEW: "コーチ確認まで一時停止する",
} satisfies Record<MonitorAction, string>;

export const STOP_REASON_LABEL_JA = {
  SAFETY_STOP_ATHLETE: "選手から安全上の停止サインがあった",
  SAFETY_STOP_TECHNIQUE_UNSAFE: "動作の安全性を確認できない",
  SAFETY_STOP_ENVIRONMENT: "実施環境の安全性を確認できない",
  TIMING_NOT_RECORDED: "タイムが記録されていない",
  TIMING_METHOD_COACH_ONLY: "コーチ判断で確認する計時条件",
  TIMING_VIDEO_FPS_MISSING: "映像のフレームレートが未入力",
  TIMING_TOLERANCE_RATIO_EXCEEDED: "計時誤差が判定範囲を超えている",
  TIMING_POLICY_MISSING: "計時判定条件を確認できない",
  POLICY_COACH_ONLY: "コーチ判断で評価する処方",
  NO_NUMERIC_REFERENCE: "数値評価の基準がない",
  REFERENCE_ESTABLISHED: "この1本を基準として記録した",
  TIMING_FAIL: "基準タイムの許容範囲を外れた",
  CONSECUTIVE_TIMING_FAILURES: "基準タイム外が連続した",
  TEMPO_FASTER_THAN_TARGET_REPEATED: "設定より速い走行が連続した",
  START_QUALITY_POOR_REPEATED: "スタート品質の低下が連続した",
  TECHNIQUE_DETERIORATING: "動作の低下が見られる",
  ASSISTED_TECHNIQUE_NOT_GOOD: "補助走の動作条件を満たしていない",
  TECHNIQUE_NOT_ASSESSED: "動作評価が未入力",
  VELOCITY_DECREMENT_OUT_OF_BAND: "速度低下率が設定範囲外",
  VELOCITY_DECREMENT_BAND_UNAVAILABLE: "速度低下率の基準を確認できない",
  EFFORT_BECAME_MAXIMAL: "全力化したとコーチが判断した",
  REST_EXTENSION_UNAVAILABLE: "これ以上の休息延長余地がない",
  PLANNED_REPS_COMPLETE: "予定本数を完遂した",
  ATTEMPTS_COMPLETE: "予定試技数を完遂した",
} satisfies Record<StopReason, string>;

export const REP_QUALITY_LABEL_JA = {
  PASS: "基準内",
  FAIL: "基準外",
  NOT_EVALUATED_COACH_ONLY: "コーチ判断",
} satisfies Record<RepQuality, string>;

export const EXECUTION_SAFETY_OUTCOME_LABEL_JA = {
  NONE: "追加の安全対応記録なし",
  STOP: "既存の停止状態（確認が必要）",
  COACH_REVIEW: "コーチ確認が必要",
  MEDICAL_EVALUATION_RECOMMENDED: "医療専門職への相談を推奨",
} satisfies Record<SafetyOutcome, string>;

// Compile-time and runtime coverage anchors used by presentation tests.
export const EXECUTION_LABEL_COVERAGE = {
  actions: MONITOR_ACTIONS,
  reasons: STOP_REASONS,
  qualities: REP_QUALITIES,
  safetyOutcomes: SAFETY_OUTCOMES,
  painStatuses: PAIN_STATUSES,
  bodyRegions: BODY_REGIONS,
  redFlags: RED_FLAGS,
  techniqueJudgments: TECHNIQUE_JUDGMENTS,
};

export function presentMonitorDecision(decision: MonitorDecision) {
  return {
    action: decision.action,
    actionLabel: MONITOR_ACTION_LABEL_JA[decision.action],
    quality: decision.quality,
    qualityLabel: REP_QUALITY_LABEL_JA[decision.quality],
    nextRepRestS: decision.nextRepRestS,
    reasons: decision.reasons.map((code) => ({ code, label: STOP_REASON_LABEL_JA[code] })),
    safetyOutcome: decision.safetyOutcome,
    safetyOutcomeLabel: EXECUTION_SAFETY_OUTCOME_LABEL_JA[decision.safetyOutcome],
    completedRepCount: decision.completedRepCount,
    plannedRepCount: decision.plannedRepCount,
    cumulativeHighSpeedExposureM: decision.cumulativeHighSpeedExposureM,
  };
}
