/**
 * Running Prescription Engine v2 — R10-B3 日本語ラベル registry（表示専用）。
 *
 * ここに置いてよいのは「内部値 → コーチ向けの日本語」の対応だけ。数値ポリシー（量の上限・rest の式・
 * eligibility・大会 window・年齢制約・loadClass 判定・RuleSet 選択）は一切置かない。
 * すべて `Record<内部enum, string>` で定義し、enum に値が増えたら型エラー＋ coverage test で気づけるようにする。
 *
 * 保存済み rationale の文章（`rationale/render-ja.ts`）とは独立している。あちらは「保存時点の理由文」を作る
 * レンダラで、こちらは画面のラベル。ここを変えても既存 MenuItem.rationale は変わらない（R9 contract）。
 */
import type { SourceType } from "@/domain/running/evidence/schema";
import type { FindingSeverity } from "@/domain/running/types/findings";
import type { IntensityReference } from "@/domain/running/types/intensity";
import type { RunningTrainingMethod } from "@/domain/running/types/method";
import type { PLANNING_NOT_EVALUATED_REASONS } from "@/domain/running/persistence/sessionSnapshot";
import type { RunningMenuContext } from "@/domain/running/persistence/menuContext";
import type { AgeBand, MaturityAssessment, MaturityStatus, TrainingAgeTier } from "@/domain/running/types/subject";
import type { Directness, InputDataConfidence, PrescriptionConfidence, ValueOrigin } from "@/domain/running/types/prescription";
import type { RecoveryStructure } from "@/domain/running/types/template";
import type { EnvelopeField, Judgement, RuleSetStatus } from "@/domain/running/rules/schema";
import type { ConfidenceTone, FindingTone, OverrideLayer } from "./dto";

// ---------------------------------------------------------------------------
// Method（内部分類。template 名より弱く表示する）
// ---------------------------------------------------------------------------

export const METHOD_LABEL_JA: Record<RunningTrainingMethod, string> = {
  ACCELERATION: "加速",
  MAX_VELOCITY: "最高速度",
  SPRINT_ENDURANCE_SHORT: "短時間スプリント持久",
  LONG_SPRINT_RACE_SPECIFIC: "ロングスプリント",
  TEMPO_EXTENSIVE: "テンポ（エクステンシブ）",
  TEMPO_INTENSIVE: "テンポ（インテンシブ）",
  RESISTED_SPRINT: "抵抗走",
  ASSISTED_SPRINT: "アシステッド",
  EVENT_APPROACH_SPEED: "助走・種目特異",
  STRIDE: "流し",
};

export const RECOVERY_STRUCTURE_LABEL_JA: Record<RecoveryStructure, string> = {
  FULL: "完全回復",
  INCOMPLETE: "不完全回復（分割走）",
};

// ---------------------------------------------------------------------------
// Confidence / Directness / Input data
// ---------------------------------------------------------------------------

export const PRESCRIPTION_CONFIDENCE_LABEL_JA: Record<PrescriptionConfidence, string> = {
  HIGH: "確信度 高",
  MODERATE: "確信度 中",
  LOW: "確信度 低",
  POLICY_ONLY: "暫定ルール",
};

export const PRESCRIPTION_CONFIDENCE_DESCRIPTION_JA: Record<PrescriptionConfidence, string> = {
  HIGH: "この対象に近い研究・実践例に基づく処方です。",
  MODERATE: "根拠はありますが、対象や条件が一部異なります。",
  LOW: "根拠や選手の記録データが限られています。コーチの判断で確認してください。",
  POLICY_ONLY: "研究の裏付けではなく、アプリ内の暫定ルールに基づく処方です。",
};

export const PRESCRIPTION_CONFIDENCE_TONE: Record<PrescriptionConfidence, ConfidenceTone> = {
  HIGH: "high",
  MODERATE: "moderate",
  LOW: "low",
  POLICY_ONLY: "policy",
};

export const DIRECTNESS_LABEL_JA: Record<Directness, string> = {
  DIRECT: "直接的",
  PARTIAL: "一部適用",
  INDIRECT: "間接的",
  NOT_APPLICABLE: "適用対象外",
};

export const DIRECTNESS_DESCRIPTION_JA: Record<Directness, string> = {
  DIRECT: "この選手に近い対象での知見に基づいています。",
  PARTIAL: "競技レベルなどが異なる対象での知見を含みます。",
  INDIRECT: "年齢・成熟度・競技が異なる対象での知見を含みます。",
  NOT_APPLICABLE: "研究ではなくアプリ内ルールに基づくため、対象の近さは評価していません。",
};

export const INPUT_DATA_CONFIDENCE_LABEL_JA: Record<InputDataConfidence, string> = {
  HIGH: "十分",
  MEDIUM: "ある程度",
  LOW: "限られている",
  NONE: "なし",
  NOT_REQUIRED: "不要（この方式では使わない）",
};

// ---------------------------------------------------------------------------
// RuleSet / Evidence
// ---------------------------------------------------------------------------

export const RULE_SET_STATUS_LABEL_JA: Record<RuleSetStatus, string> = {
  DRAFT: "暫定版",
  ACTIVE: "正式版",
  RETIRED: "旧版",
};

/** RuleSet 状態の注意表示。ACTIVE は注意不要（null）。 */
export const RULE_SET_NOTICE_LABEL_JA: Record<RuleSetStatus, string | null> = {
  DRAFT: "ルールセット 暫定版",
  ACTIVE: null,
  RETIRED: "ルールセット 旧版",
};

export const EVIDENCE_SOURCE_TYPE_LABEL_JA: Record<SourceType, string> = {
  META_ANALYSIS: "メタ分析",
  SYSTEMATIC_REVIEW: "システマティックレビュー",
  RCT: "ランダム化比較試験",
  CROSSOVER_REPEATED_MEASURES: "クロスオーバー・反復測定研究",
  QUASI_EXPERIMENTAL: "準実験研究",
  OBSERVATIONAL: "観察研究",
  MECHANISTIC: "メカニズム研究",
  NARRATIVE_REVIEW: "ナラティブレビュー",
  CONSENSUS_STATEMENT: "コンセンサス声明",
  GOVERNING_BODY_GUIDANCE: "競技団体ガイドライン",
  COACHING_BEST_PRACTICE: "コーチング実践",
  ELITE_COACH_PRACTICE: "エリートコーチ実践",
  EXPERT_OPINION: "専門家意見",
  ENGINE_POLICY: "アプリ内ルール",
};

export const JUDGEMENT_LABEL_JA: Record<Judgement, string> = {
  SOURCE_BACKED: "文献・実践例に基づく",
  ENGINE_POLICY: "アプリ内ルール",
  OPEN: "根拠未確定",
};

// ---------------------------------------------------------------------------
// GeneratedBy / planning controls
// ---------------------------------------------------------------------------

export const GENERATED_BY_LABEL_JA: Record<"ENGINE" | "AI_PLANNER", string> = {
  ENGINE: "エンジンで作成",
  AI_PLANNER: "AIの提案",
};

export const POSITION_PREFERENCE_LABEL_JA: Record<"LOWER" | "MIDDLE" | "NONE", string> = {
  LOWER: "控えめ（推奨範囲の下側）",
  MIDDLE: "標準（推奨範囲の中央）",
  NONE: "指定なし",
};

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const FINDING_SEVERITY_LABEL_JA: Record<FindingSeverity, string> = {
  INFO: "情報",
  WARN: "注意",
  REQUIRE_CONFIRMATION: "確認が必要",
  REQUIRE_COACH_REVIEW: "コーチ確認が必要",
  BLOCK_AUTOGEN: "自動作成では制限",
  BLOCK: "作成不可",
};

/**
 * 強い severity の補足文。BLOCK_AUTOGEN は「使用禁止」ではない（コーチの手動選択では保存できる場合がある）。
 * BLOCK に「例外設定で解除できる」とは書かない（解除可否は domain の結果だけが決める）。
 */
export const FINDING_SEVERITY_NOTE_JA: Record<FindingSeverity, string | null> = {
  INFO: null,
  WARN: null,
  REQUIRE_CONFIRMATION: "保存する前に、内容を確認したことを明示してください。",
  REQUIRE_COACH_REVIEW: null,
  BLOCK_AUTOGEN: "自動作成では制限対象です。",
  BLOCK: "この内容では作成できません。",
};

export const FINDING_SEVERITY_TONE: Record<FindingSeverity, FindingTone> = {
  INFO: "info",
  WARN: "caution",
  REQUIRE_CONFIRMATION: "review",
  REQUIRE_COACH_REVIEW: "review",
  BLOCK_AUTOGEN: "restricted",
  BLOCK: "blocked",
};

export const FINDING_SCOPE_LABEL_JA: Record<"ITEM" | "SESSION" | "WEEK", string> = {
  ITEM: "この項目",
  SESSION: "練習全体",
  WEEK: "直近の練習の流れ",
};

// ---------------------------------------------------------------------------
// Intensity
// ---------------------------------------------------------------------------

export const INTENSITY_REFERENCE_LABEL_JA: Record<IntensityReference["kind"], string> = {
  MAX_INTENT: "全力意図",
  MEASURED_VMAX: "測定した最高速度",
  FLY_SPLIT: "フライ区間の計測タイム",
  SAME_DISTANCE_BEST: "同じ距離の自己ベスト",
  RACE_PACE: "レースペース",
  TARGET_SPLIT: "コーチ設定の目標スプリット",
  VELOCITY_DECREMENT: "速度低下率の目安",
  RELAXED_SUBMAX: "リラックスした準最大",
  COACH_DEFINED: "コーチ設定",
};

export const VELOCITY_DECREMENT_BAND_LABEL_JA: Record<Extract<IntensityReference, { kind: "VELOCITY_DECREMENT" }>["band"], string> = {
  LIGHT: "軽い",
  MODERATE: "中程度",
  HEAVY: "重い",
  VERY_HEAVY: "非常に重い",
};

export const APPROACH_LABEL_JA: Record<"SHORT" | "FULL", string> = {
  SHORT: "短助走",
  FULL: "全助走",
};

// ---------------------------------------------------------------------------
// Editor field（EnvelopeField + 助走距離）
// ---------------------------------------------------------------------------

export type FieldUnitKind = "m" | "cm" | "s" | "reps" | "sets" | "percent";

export const EDITABLE_FIELD_DISPLAY: Record<EnvelopeField | "approachDistanceM", { label: string; unit: FieldUnitKind }> = {
  repDistanceM: { label: "1本の距離", unit: "m" },
  buildUpM: { label: "助走（加速）区間", unit: "m" },
  flyZoneM: { label: "フライ区間", unit: "m" },
  decelerationM: { label: "減速区間", unit: "m" },
  repDurationS: { label: "1本の時間", unit: "s" },
  repsPerSet: { label: "1セットの本数", unit: "reps" },
  sets: { label: "セット数", unit: "sets" },
  totalReps: { label: "総本数", unit: "reps" },
  repRestS: { label: "本間レスト", unit: "s" },
  setRestS: { label: "セット間レスト", unit: "s" },
  intraRepRestS: { label: "分割走の区間休息", unit: "s" },
  sessionVolumeM: { label: "この項目の総距離", unit: "m" },
  flyVolumeM: { label: "フライ区間の合計距離", unit: "m" },
  intensityPercent: { label: "強度（最高速度に対する割合）", unit: "percent" },
  attempts: { label: "試技数", unit: "reps" },
  vdecPercent: { label: "速度低下率", unit: "percent" },
  approachDistanceM: { label: "助走距離", unit: "m" },
};

export const UNIT_LABEL_JA: Record<FieldUnitKind, string> = {
  m: "m",
  cm: "cm",
  s: "秒",
  reps: "本",
  sets: "セット",
  percent: "%",
};

export const VALUE_ORIGIN_LABEL_JA: Record<ValueOrigin, string> = {
  ENGINE_POSITIONED: "推奨範囲から設定",
  SOLVER_DERIVED: "推奨範囲から算出",
  TEMPLATE_FIXED: "練習の型で固定",
  STRUCTURAL_FIXED: "表示上の区切り",
  COACH: "コーチ入力",
  COACH_OVERRIDE: "コーチの例外設定",
};

export const OVERRIDE_LAYER_LABEL_JA: Record<OverrideLayer, string> = {
  COACH_EDITABLE: "コーチ調整可能範囲の外にする",
  HARD_SAFETY: "安全上の範囲の外にする",
};

export const OVERRIDE_TARGET_LABEL_JA = {
  FIELD_COACH_EDITABLE: "コーチ調整可能範囲の外",
  FIELD_HARD_SAFETY: "安全上の範囲の外",
  ELIGIBILITY: "選択条件の例外",
  READINESS: "当日の体調確認による見送りを解除",
} as const;

// ---------------------------------------------------------------------------
// [R10-B4B] メニューの対象グループ設定（RunningMenuContext）の入力ラベル
// ---------------------------------------------------------------------------

/** 保存できる member の型から導く（ここで新しい enum を作らない）。 */
type PersistedMember = RunningMenuContext["subject"]["members"][number];
type PersistedPrimaryEvent = PersistedMember["primaryEvent"];
type MaturityConfidence = MaturityAssessment["confidence"];
type MaturityAssessmentMethod = MaturityAssessment["method"];
type PlanningNotEvaluatedReason = (typeof PLANNING_NOT_EVALUATED_REASONS)[number];

export const AGE_BAND_LABEL_JA: Record<AgeBand, string> = {
  U12: "小学生年代（U12）",
  U15: "中学生年代（U15）",
  U18: "高校生年代（U18）",
  ADULT: "成人",
};

export const MATURITY_STATUS_LABEL_JA: Record<MaturityStatus, string> = {
  PRE: "成長期の前",
  CIRCA: "成長期のただ中",
  POST: "成長期の後",
  UNKNOWN: "わからない",
};

export const MATURITY_CONFIDENCE_LABEL_JA: Record<MaturityConfidence, string> = {
  LOW: "確からしさ 低い",
  MEDIUM: "確からしさ ふつう",
  HIGH: "確からしさ 高い",
};

export const MATURITY_METHOD_LABEL_JA: Record<MaturityAssessmentMethod, string> = {
  NONE: "判断していない",
  COACH_OBSERVATION: "コーチの観察",
  PARENT_REPORT: "保護者からの申告",
  GROWTH_VELOCITY: "身長の伸び方",
  MATURITY_OFFSET_EQUATION: "推定式",
};

export const TRAINING_AGE_TIER_LABEL_JA: Record<TrainingAgeTier, string> = {
  BEGINNER: "初心者",
  DEVELOPING: "育成段階",
  TRAINED: "鍛錬を積んでいる",
  ADVANCED: "熟練",
};

export const PRIMARY_EVENT_LABEL_JA: Record<PersistedPrimaryEvent, string> = {
  "100m": "100m",
  "200m": "200m",
  "400m": "400m",
  "400mH": "400mH",
  HURDLES: "ハードル",
  LJ: "走幅跳",
  TJ: "三段跳",
  HJ: "走高跳",
  PV: "棒高跳",
  OTHER: "その他",
};

// ---------------------------------------------------------------------------
// [R10-B4B] メニュー全体の集計（R6）で「評価しなかった理由」
// ---------------------------------------------------------------------------

/**
 * 集計できなかった理由のコーチ向け説明。**理由コードをそのまま画面へ出さない**。
 * 「自動で直す」とは書かない（版の統一・context の入力はコーチの明示操作）。
 */
export const MENU_AGGREGATION_NOT_EVALUATED_MESSAGE_JA: Record<PlanningNotEvaluatedReason, string> = {
  PLANNING_EVALUATION_NOT_SUPPLIED: "このメニューの合計はまだ計算していません。",
  PLANNED_AT_UNAVAILABLE: "開始予定時刻が設定されていないため、直近の練習との間隔は見ていません。",
  MIXED_RULESET_VERSIONS:
    "このメニューの走トレーニングに、作成時期の違う複数のルールセットが混ざっているため、合計を計算できません。各項目を現行ルールで再計算すると揃います。",
  RULESET_VERSION_UNAVAILABLE: "保存されている処方の版を確認できないため、合計を計算できません。",
  RUNNING_CONTEXT_UNAVAILABLE: "対象グループ・計画日の設定が無いため、合計を計算できません。先に設定してください。",
  SESSION_DATE_CONTEXT_MISMATCH: "設定した計画日と練習日が違うため、直近の練習との間隔は見ていません。",
  SNAPSHOT_JSON_INVALID: "読み込めない処方データがあるため、合計を計算できません。",
};
