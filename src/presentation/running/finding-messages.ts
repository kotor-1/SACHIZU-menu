/**
 * Running Prescription Engine v2 — R10-B3 Finding / EligibilityReason のユーザー向け日本語 message registry。
 *
 * - key は domain が出す Finding code（R1〜R10 の planning / aggregation / plausibility / weekly / competition /
 *   readiness / snapshot / session planning、および RuleSet JSON の `*FindingCode`）。
 * - 文言は「何が起きているか」だけを書く。数値の閾値・解除可否・override の可否はここに書かない
 *   （それらは severity と domain の結果が決める。BLOCK に「例外設定で解除できます」とは書かない）。
 * - 未知の code は `UNKNOWN_FINDING_MESSAGE_JA` に落とし、code 自体は DOM に出さない。
 * - 網羅性は `tests/presentation/running/labels.test.ts` がソースを走査して検査する。
 */
import type { EligibilityReasonCode } from "@/domain/running/planning/schema";

export const UNKNOWN_FINDING_MESSAGE_JA = "確認が必要な情報があります。";

export const FINDING_MESSAGE_JA: Readonly<Record<string, string>> = {
  // ---- RuleSet / 版 -------------------------------------------------------
  RULESET_DRAFT: "この処方は、正式版として確定していない暫定版のルールセットに基づいています。",
  RULESET_VERSION_UNAVAILABLE: "保存時のルールの版を確認できないため、練習全体の合計と直近の練習の流れを評価していません。",
  MIXED_RULESET_VERSIONS: "異なる版のルールで作られた項目が混在しているため、練習全体の合計と直近の練習の流れを評価していません。",
  RULESET_TEMPLATE_METADATA_INCONSISTENT: "ルールセットの練習の型の情報に不整合があるため、処方を作成できません。",
  RULESET_TEMPLATE_METADATA_MISSING: "ルールセットに練習の型の情報が不足しているため、処方を作成できません。",
  ELIGIBILITY_RULESET_INCONSISTENT: "ルールセットの内容に不整合があるため、この練習の型を選べるか判定できません。",
  METHOD_META_MISSING: "練習の分類情報がルールセットに見つかりません。",
  TEMPLATE_NOT_IN_RULESET: "選んだ練習の型がルールセットに見つかりません。",
  TEMPLATE_METHOD_MISMATCH: "選んだ練習の型と分類が一致しません。",
  STOP_POLICY_UNRESOLVED: "この練習の中止基準を決められないため、処方を作成できません。",
  MONITORING_SAFETY_POLICY_UNRESOLVED: "実施中の安全確認の基準を決められないため、処方を作成できません。",
  READINESS_RULESET_MISMATCH: "当日の体調確認と処方で使ったルールの版が一致しません。",

  // ---- 入力・計画リクエスト ----------------------------------------------------
  PLAN_REQUEST_INVALID: "入力内容に不備があるため、処方を作成できません。",
  INPUT_BIRTHDATE_IN_FUTURE: "生年月日が未来の日付になっています。",
  INPUT_MARK_IN_FUTURE_IGNORED: "計画日より後の日付の記録があったため、その記録は使っていません。",
  INPUT_PLAUSIBILITY_BLOCK: "入力された記録の値がありえない範囲のため、この内容では作成できません。",
  INPUT_PLAUSIBILITY_CONFIRM: "入力された記録の値が通常と大きく異なります。値を確認してください。",
  COACH_REFERENCE_INVALID: "入力した強度の基準は、この練習の型では使えません。",
  LONG_SPLIT_REQUIRES_TARGET_SPLIT: "分割走には、区間ごとの目標タイムの入力が必要です。",
  RECOVERY_STRUCTURE_REQUIRED: "この練習の型では、回復の構成（完全回復・分割走）の指定が必要です。",
  RECOVERY_STRUCTURE_NOT_ALLOWED: "この練習の型では、回復の構成は指定できません。",
  INTERNAL_PRESCRIPTION_INVALID: "処方の内部データに不整合があるため、保存できません。",

  // ---- 選択条件（eligibility / constraint）------------------------------------
  ELIGIBILITY_MANUAL_SELECTION: "この練習の型は、コーチが選んだ場合にだけ使える扱いです。",
  ELIGIBILITY_MANUAL_REVIEW: "この練習の型はコーチの選択で使っています。実施前に内容を確認してください。",
  ELIGIBILITY_OVERRIDDEN: "本来は選べない条件ですが、コーチが理由を記録して例外として選んでいます。",
  ELIGIBILITY_OVERRIDE_WITHOUT_RECORD: "例外として選ぶための記録が見つかりません。",
  OVERRIDE_TARGET_INVALID: "指定された例外設定の対象が正しくありません。",

  // ---- 数値（Envelope）-------------------------------------------------------
  ENVELOPE_INFEASIBLE: "この条件に合う推奨範囲が見つからないため、数値を自動では決められません。",
  OUTSIDE_RECOMMENDED: "推奨範囲の外の値があります（コーチ調整可能範囲の中です）。",
  TEMPLATE_FIXED_OUTSIDE_RECOMMENDED: "練習の型で決まっている値が、推奨範囲の外にあります。",
  STRUCTURAL_VALUE_OUTSIDE_RECOMMENDED: "セットに分けた結果、1セットあたりの本数が推奨範囲の外になっています。",
  TEMPLATE_FIXED_FIELD_EDIT: "練習の型で決まっている値は変更できません。",
  MANUAL_INPUT_REQUIRED: "コーチが値を入力する必要がある項目があります。",
  ENGINE_VALUE_FOR_MANUAL_CELL: "コーチが入力するべき項目に、自動で値が入っています。",
  COACH_EDIT_INVALID: "入力した値をこの項目に反映できません。値を見直してください。",
  COACH_EDIT_NOT_APPLICABLE: "この練習の型では使わない項目に値が入力されています。",
  COACH_EDITABLE_OVERRIDE_REQUIRED: "入力した値はコーチ調整可能範囲の外です。理由を記録した例外設定が必要です。",
  COACH_OVERRIDE_APPLIED: "コーチが理由を記録したうえで、通常の範囲の外の値を設定しています。",
  COACH_OVERRIDE_WITHOUT_RECORD: "範囲の外の値に対応する例外設定の記録がありません。",
  HARD_SAFETY_OVERRIDE_REQUIRED: "入力した値は安全上の範囲の外です。",
  HARD_SAFETY_VIOLATION: "安全上の範囲を超える値があります。",
  AUTO_GENERATION_LIMIT_EXCEEDED: "総本数が、自動作成で扱う本数を超えています。",
  VOLUME_NOT_DETERMINABLE: "総距離を確定できないため、量の判定に不明な部分があります。",
  SET_REST_NOT_DEFINED: "この練習の型にはセット間レストの推奨がありません。",
  REST_INFEASIBLE_FOR_PRACTICE: "必要なレストだけで、予定の練習時間を超える可能性があります（レストは短くしません）。",

  // ---- 確信度 --------------------------------------------------------------
  CONFIDENCE_MODERATE: "処方の確信度は中程度です。",
  CONFIDENCE_LOW: "処方の確信度が低いため、コーチの確認が必要です。",
  CONFIDENCE_POLICY_ONLY: "この処方は研究の裏付けではなく、アプリ内の暫定ルールに基づいています。",
  PROVISIONAL_RULE_ONLY: "この処方には、まだ根拠が確定していない暫定のルールが含まれています。",

  // ---- 期分け・大会 ----------------------------------------------------------
  PHASE_COMPETITION_NOT_EVALUATED: "期分けや大会日程による調整は、この処方にはまだ反映していません。",
  PHASE_RULE_MISSING: "この期分けに対応するルールが見つからないため、期分けによる調整をしていません。",
  PHASE_AUTOGEN_BLOCKED: "現在の期分けでは、この強度の練習を自動作成では扱いません。",
  PHASE_PRE_COMPETITION_INJURY_TRANSITION: "試合期に向けて強度の高い練習の割合が増える時期です。けがに注意して移行してください。",
  COMPETITION_AUTOGEN_BLOCKED: "大会が近いため、この強度の練習を自動作成では扱いません。",
  COMPETITION_DAY_NON_RACE_HIGH: "大会期間中の日に、レース以外の強度の高い練習を行う内容です。",
  COMPETITION_NEW_STIMULUS: "大会が近い時期に、直近で行っていない新しい練習を入れる内容です。",
  COMPETITION_NEW_STIMULUS_NOT_DETERMINABLE: "大会が近い時期ですが、直近の練習記録が十分でないため、新しい刺激かどうかを判断できません。",
  COMPETITION_TAPER_GUIDANCE: "大会に向けて練習量を減らしていく時期です。量の調整を検討してください。",

  // ---- 練習全体（aggregation / plausibility）-----------------------------------
  AGG_TOTAL_RUNNING_BLOCK: "練習全体の総走行距離が上限を超えています。",
  AGG_TOTAL_RUNNING_CONFIRM: "練習全体の総走行距離が非常に多くなっています。",
  AGG_METHOD_BUDGET_OVER_RECOMMENDED: "同じ種類の練習の合計量が、推奨の目安を超えています。",
  AGG_METHOD_BUDGET_OVER_EDITABLE: "同じ種類の練習の合計量が、コーチ調整可能範囲の上限を超えています。",
  AGG_METHOD_CAP_NOT_DETERMINABLE: "上限の基準を確認できない項目があるため、同じ種類の練習の合計量を判定できません。",
  AGG_METHOD_METADATA_MISSING: "分類情報が不足している項目があり、合計量の判定に含められていません。",
  AGG_HIGH_INTENSITY_BUDGET: "練習全体の強度の高い練習の量が、推奨の目安を超えています。",
  AGG_HIGH_INTENSITY_BUDGET_EDITABLE: "練習全体の強度の高い練習の量が、コーチ調整可能範囲の上限を超えています。",
  AGG_TEMPO_OVER: "テンポ走の合計距離が、推奨の目安を超えています。",
  AGG_STRIDE_OVER: "流しの合計距離が、上限の目安を超えています。",
  AGG_COMPETITION_DAY_EXTRA: "大会期間中の練習に、レース以外の強度の高い項目が含まれています。",
  AGG_REST_INFEASIBLE: "必要なレストを含めると、予定の練習時間に収まらない可能性があります（レストは短くしません）。",
  AGG_ACCEL_INTERVAL_MISSING: "加速区間の目安が無いため、高速で走る距離の推定に不明な部分があります。",
  AGG_INCOMPLETE_DATA: "量が不明な項目があるため、練習全体の合計は目安です。",
  AGG_NOT_DETERMINABLE: "量が不明な項目があるため、合計の判定ができません。",
  AGG_LEGACY_CATEGORY_UNKNOWN: "分類を判定できない従来形式の項目があり、合計への反映が不確かです。",
  PLAUSIBILITY_BLOCK: "値がありえない範囲です。",
  PLAUSIBILITY_REQUIRE_CONFIRMATION: "値が通常と大きく異なります。",
  PLAUSIBILITY_NOT_DETERMINABLE: "値が不明な部分があるため、妥当性を確認できません。",

  // ---- 直近の練習の流れ（weekly）----------------------------------------------
  WEEKLY_HIGH_WITHIN_48H: "48時間以内に、強度の高い走練習やレースがあります。",
  WEEKLY_NONRUN_HIGH_WITHIN_48H: "48時間以内に、跳躍・筋力トレーニングなど強度の高い走以外の練習があります。",
  WEEKLY_UNKNOWN_WITHIN_48H: "48時間以内に、強度が分からない練習や試合の記録があります。",
  READINESS_CHECK_REQUIRED: "直近に強度の高い練習や試合があるため、当日の体調確認が必要です。",
  HISTORY_UNKNOWN: "直近の練習・試合の記録が十分でないため、負荷の流れを完全には確認できていません。",
  HISTORY_UNKNOWN_HIGH_METABOLIC: "直近の記録が十分でない状態で、負担の大きい持久系の高強度練習を行う内容です。",
  WEEKLY_HIGH_SESSIONS: "直近7日間の強度の高い練習・試合の回数が多くなっています。",
  WEEKLY_JHS_REST_DAYS: "直近7日間の休養日が、中学生の目安より少なくなっています。",
  WEEKLY_JHS_HOURS: "直近7日間の練習時間が、中学生の目安を超えています。",
  WEEKLY_REST_DAYS_NOT_DETERMINABLE: "直近7日間の休養日の数を確認できません。",
  WEEKLY_HOURS_NOT_DETERMINABLE: "直近7日間の練習時間の合計を確認できません。",
  WEEKLY_CONTEXT_NOT_EVALUATED: "直近の練習・試合による調整は、まだ評価していません。",
  WEEKLY_COVERAGE7D_INCONSISTENT: "直近7日間の記録の状態に矛盾があるため、判定は目安です。",
  WEEKLY_WINDOW_RULE_MISSING: "直近の練習の流れを判定するルールが見つからないため、一部を評価していません。",

  // ---- 当日の体調（readiness）--------------------------------------------------
  READINESS_PAIN_PRESENT: "痛みの報告があります。実施前にコーチの確認が必要です。",
  READINESS_STOP_SAFETY: "安全のため、今日のこの練習は中止してください。",
  READINESS_COACH_REVIEW_REQUIRED: "当日の体調確認の結果、実施前にコーチの確認が必要です。",
  READINESS_CANCEL_OVERRIDDEN: "当日の体調確認では見送りの判断でしたが、コーチの判断で実施します。",
  READINESS_CANCEL_NOT_APPLICABLE: "当日の体調確認による見送りは、この練習には該当しません。",
  READINESS_SWAP_KEEP_CURRENT: "負荷の低い練習への変更が提案されましたが、現在の内容のままにしています。",
  PAIN_CHECK_REQUIRED: "実施前に、痛みの有無を確認してください。",
  GROWTH_PERIOD_PAIN_GUIDANCE: "成長期の痛みは休養を優先し、改善しない場合は受診を検討してください。",
  MEDICAL_EVALUATION_RECOMMENDED: "医療機関での確認を検討してください。",

  // ---- セッション作成（R9 snapshot / R10-B2）------------------------------------
  RUNNING_CONTEXT_UNAVAILABLE: "対象グループや計画日の設定を確認できないため、練習全体の合計と直近の練習の流れを評価していません。",
  SESSION_DATE_CONTEXT_MISMATCH: "練習日とメニューの計画日時が一致しないため、直近の練習の流れを評価していません。",
  SNAPSHOT_JSON_INVALID: "記録用にコピーした処方データを読み込めない項目があります。",
  SNAPSHOT_LOAD_CATEGORY_UNRESOLVED: "負荷の分類を確認できない項目があります。",
};

/** INELIGIBLE の理由（EligibilityReason.code）。picker の restrictionMessage 等で使う。 */
export const ELIGIBILITY_REASON_MESSAGE_JA: Record<EligibilityReasonCode, string> = {
  ELIGIBILITY_RULE_INELIGIBLE: "この対象の年齢・成熟度・トレーニング歴では、この練習の型は選べません。",
  CONSTRAINT_DISALLOWED: "この対象の条件では、この練習の型は選べません。",
  ELIGIBILITY_CONDITIONS_UNMET: "この練習の型を選ぶための条件を満たしていません。",
  ADVANCED_ONLY_NOT_PERMITTED: "上級者向けの練習の型のため、この対象では選べません。",
  AUTOGEN_NOT_ALLOWED_FOR_MANUAL_MODE: "この練習の型は、コーチの選択が必要です（自動作成では扱いません）。",
  CONDITIONAL_AUTO_REQUIRES_PHASE: "自動作成の条件の判定に、期分けの設定が必要です。",
  CONDITIONAL_AUTO_NOT_MET: "自動作成の条件を満たしていません。",
  COMPLEXITY_ABOVE_AUTO_CAP: "技術的に複雑な練習の型のため、この対象では自動作成では扱いません。",
  OVERRIDE_REQUIRED: "この練習の型を選ぶには、理由を記録した例外設定が必要です。",
  OVERRIDE_NOT_ALLOWED: "この条件は例外設定では解除できません。",
  REFERENCE_UNAVAILABLE: "この練習には強度の基準（コーチが入力する目標スプリットや、選手の記録など）が必要です。",
  LOW_CONFIDENCE_HIGH_METABOLIC_AUTOGEN_BLOCKED: "記録データが不足しているため、負担の大きい持久系の高強度練習は自動作成では扱いません。",
  READINESS_CHECK_REQUIRED: "当日の体調確認が取れていないため、強度の高い練習は選べません。",
  READINESS_HIGH_INTENSITY_CANCELLED: "当日の体調確認の結果、強度の高い練習は今日は行いません。",
  READINESS_SWAP_RECOMMENDED: "当日の体調から、負荷の低い練習への変更をおすすめします。",
  COMPETITION_LONG_INCOMPLETE_BLOCKED: "重要な大会が近いため、回復が不完全な分割走は選べません。",
  WEEKLY_PHASE_COMPETITION_AUTOGEN_BLOCKED: "直近の練習・大会・期分けの状況から、この練習を自動作成では扱いません。",
};

export function findingMessageJa(code: string): { message: string; known: boolean } {
  const message = Object.prototype.hasOwnProperty.call(FINDING_MESSAGE_JA, code) ? FINDING_MESSAGE_JA[code] : undefined;
  return message === undefined ? { message: UNKNOWN_FINDING_MESSAGE_JA, known: false } : { message, known: true };
}

export function eligibilityReasonMessageJa(code: string): string {
  return Object.prototype.hasOwnProperty.call(ELIGIBILITY_REASON_MESSAGE_JA, code)
    ? ELIGIBILITY_REASON_MESSAGE_JA[code as EligibilityReasonCode]
    : UNKNOWN_FINDING_MESSAGE_JA;
}
