import { planRunningPrescription, type RunningPolicyResult } from "@/domain/running-policy";
import type { VerifiedRunningIntent } from "./intent";
import type { RunningScienceContext } from "@/domain/running-policy/science-contracts";

export type RunningMenuContextInput = {
  event?: string;
  ageGroup?: "ELEMENTARY" | "JUNIOR_HIGH" | "HIGH_SCHOOL" | "ADULT";
  availableTimeSeconds?: number;
  science?: RunningScienceContext;
};

export type RunningMenuPreview =
  | { status: "READY"; prescription: Extract<RunningPolicyResult, { status: "READY" }>["prescription"]; message: string | null }
  | { status: "NEEDS_INPUT" | "NEEDS_POLICY" | "NEEDS_TIME_ADJUSTMENT" | "COACH_REVIEW_REQUIRED" | "BLOCKED"; reason: string; message: string; explicitDistances: number[] };

const REASON_MESSAGE: Record<string, string> = {
  EVENT_REQUIRED: "選手の種目（100mまたは200m）を指定してください。",
  AGE_REQUIRED: "選手の年代を指定してください。",
  EVENT_POLICY_NOT_SUPPORTED: "この種目はまだ自動処方の対象外です。",
  ELEMENTARY_POLICY_NOT_APPROVED: "小学生への自動処方はまだ承認されていません。",
  HUMAN_EXPLICIT_UNSUPPORTED_DISTANCE: "指定された距離は標準処方の対象外です。コーチによる確認が必要です。",
  MULTIPLE_EXPLICIT_DISTANCES: "複数の走距離が指定されています。コーチによる確認が必要です。",
  JUNIOR_HIGH_LONG_DISTANCE_HISTORY_REQUIRED: "この距離は最近の類似距離の実施履歴、またはコーチの確認が必要です。",
  STRONG_FATIGUE_OR_UNWELL: "強い疲労や不調が申告されています。実施前にコーチへ確認してください。",
  HUMAN_EXPLICIT_NUMBERS_REQUIRE_REVIEW: "指定された本数や休憩を保持しました。標準処方との照合にはコーチの確認が必要です。",
  PHASE_A_CONFLICT: "指定条件は標準処方と異なります。コーチの確認が必要です。",
  AVAILABLE_TIME_TOO_SHORT: "指定された時間には必要な休憩だけでも収まりません。時間または内容を確認してください。",
  INVALID_INPUT: "抽出された条件を確認できませんでした。",
  USER_CONTEXT_CONFLICT: "文章と対象グループの指定が異なります。どちらを使うか確認してください。",
  UNSUPPORTED_HUMAN_NUMBERS: "明示された数値やセット分割は今回の自動処方に反映できません。コーチの確認が必要です。",
  RUNNING_INTENT_AMBIGUOUS: "走る練習の指定を確認してください。",
  ACCEL_PURPOSE_NOT_APPROVED: "加速力向上を目的とした処方はまだ承認されていません。コーチに確認してください。",
  MAX_SPEED_PURPOSE_NOT_APPROVED: "最高速度向上を目的とした処方はまだ承認されていません。コーチに確認してください。",
  SPEED_ENDURANCE_PURPOSE_NOT_APPROVED: "スピード持久力向上を目的とした処方はまだ承認されていません。コーチに確認してください。",
  BASIC_PURPOSE_NOT_APPROVED: "基礎走能力向上を目的とした処方はまだ承認されていません。コーチに確認してください。",
  PRECOMP_PURPOSE_NOT_APPROVED: "大会前調整を目的とした処方はまだ承認されていません。コーチに確認してください。",
  RECOVERY_PURPOSE_NOT_APPROVED: "回復を目的とした処方はまだ承認されていません。コーチに確認してください。",
  LOW_INTENSITY_NOT_APPROVED: "低強度の処方はまだ承認されていません。コーチに確認してください。",
  SCIENCE_CONTEXT_REQUIRED: "走の補足情報（年齢・経験・体調・回復状況など）を入力してください。",
  AGE_CONTEXT_CONFLICT: "年齢と選択した年代が一致しません。内容を確認してください。",
  SCIENCE_POPULATION_NOT_SUPPORTED: "この対象条件の暫定処方はまだ用意されていません。コーチに確認してください。",
  SCIENCE_HEALTH_CONFIRMATION_REQUIRED: "現在の痛みや体調を確認できません。症状がある場合は実施せず、コーチに相談してください。",
  SCIENCE_EXPERIENCE_REQUIRED: "走の経験を選択してください。",
  SCIENCE_SUPERVISION_REQUIRED: "この年代では指導者等の見守りが必要です。",
  SCIENCE_FAMILIARITY_REQUIRED: "スプリント練習への慣れを確認してください。",
  SCIENCE_RECOVERY_INTERVAL_REQUIRED: "前後の高強度練習との間隔と直近7日間の回数を入力してください。",
  SCIENCE_RECOVERY_INTERVAL_VIOLATION: "高強度練習の回復間隔が不足しています。予定を見直してください。",
  SCIENCE_FREQUENCY_LIMIT: "直近7日間の高強度練習回数が上限に達しています。コーチに相談してください。",
  SCIENCE_MATURITY_REQUIRED: "成熟度を確認してください。学年からは推定できません。分からない場合は「不明」を選び、高速度・持久の高度な処方は保留します。",
  SCIENCE_ENDURANCE_MODE_REQUIRED: "全力意図のスプリント特異的持久か、同距離平均速度90〜95%の制御走かを選択してください。",
  SCIENCE_REFERENCE_REQUIRED: "制御した90〜95%走には、60mの参照タイムを入力してください。",
  SCIENCE_EXPLICIT_INPUT_REVIEW: "明示された本数・距離・休憩等は暫定処方に自動反映せず、確認が必要です。",
  RECOVERY_REST_PREFERRED: "疲労や回復目的の場合は、走る練習より休息が適切な場合があります。コーチに相談してください。",
  SCIENCE_COMPETITION_CONTEXT_REQUIRED: "大会日程の条件を確認してください。",
  SCIENCE_TAPER_WINDOW_REVIEW: "大会直前の練習は疲労状態と内容のコーチ確認が必要です。",
};

function review(reason: string, explicitDistances: number[] = []): RunningMenuPreview {
  return { status: "COACH_REVIEW_REQUIRED", reason, message: REASON_MESSAGE[reason] ?? "処方の条件を確認してください。", explicitDistances };
}

/** Application adapter: verified facts + user context -> pure engine -> unsaved UI DTO. */
export function createRunningMenuPreview(
  intent: VerifiedRunningIntent,
  context: RunningMenuContextInput,
  originalText: string,
): RunningMenuPreview | null {
  if (!intent.runningRequested) return null;
  const distances = intent.explicitDistances.map((claim) => claim.value);
  if (intent.event !== null && context.event && context.event !== intent.event.value) return review("USER_CONTEXT_CONFLICT", distances);
  if (intent.ageGroup !== null && context.ageGroup && context.ageGroup !== intent.ageGroup.value) return review("USER_CONTEXT_CONFLICT", distances);
  if (intent.availableTimeSeconds !== null && context.availableTimeSeconds && context.availableTimeSeconds !== intent.availableTimeSeconds.value) return review("USER_CONTEXT_CONFLICT", distances);
  // This phase does not authenticate a coach split or target-time edit, so keep such
  // explicit text for review instead of feeding it through a coach-only engine field.
  if (/\d+\s*セット|\d+\s*set\b|目標(?:タイム|時間)\s*\d/iu.test(originalText)) return review("UNSUPPORTED_HUMAN_NUMBERS", distances);
  const result = planRunningPrescription({
    event: intent.event?.value ?? context.event,
    ageGroup: intent.ageGroup?.value ?? context.ageGroup ?? "UNKNOWN",
    humanExplicitDistances: distances,
    distancePreference: intent.distancePreference?.value ?? "NONE",
    loadReductionRequested: intent.loadReductionRequested?.value ?? false,
    fatigueState: intent.fatigueState?.value ?? "NONE",
    purpose: intent.purpose?.value,
    intensityPreference: intent.intensityPreference?.value,
    competitionDays: intent.competitionDays?.value,
    similarDistanceHistoryStatus: "UNKNOWN",
    availableTimeSeconds: intent.availableTimeSeconds?.value ?? context.availableTimeSeconds,
    science: context.science,
    humanExplicitNumbers: intent.humanExplicitReps || intent.humanExplicitRestSeconds ? {
      ...(intent.humanExplicitReps ? { totalReps: intent.humanExplicitReps.value } : {}),
      ...(intent.humanExplicitRestSeconds ? { repRestSeconds: intent.humanExplicitRestSeconds.value } : {}),
    } : undefined,
  });
  if (result.status === "READY") {
    return { status: "READY", prescription: result.prescription, message: result.prescription.science
      ? "科学的根拠を参考にした暫定処方です。コーチ承認済みではありません。"
      : result.prescription.repsReductionApplied ? "本数を少なめに設定しました。" : null };
  }
  return {
    status: result.status,
    reason: result.reason,
    message: REASON_MESSAGE[result.reason] ?? "この条件は自動処方できません。コーチに確認してください。",
    explicitDistances: result.humanExplicitDistances,
  };
}
