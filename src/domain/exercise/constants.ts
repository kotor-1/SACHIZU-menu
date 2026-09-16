/** 種目カタログの分類軸。検索 UI のフィルタはすべてここから生成する。 */

// --- カテゴリ（練習の局面）--------------------------------------------------
export const EXERCISE_CATEGORIES = [
  "WARM_UP",
  "MOBILITY",
  "DRILL",
  "SPRINT",
  "JUMP",
  "THROW",
  "HURDLE",
  "ENDURANCE",
  "STRENGTH",
  "CORE",
  "COOL_DOWN",
  "OTHER",
] as const;
export type ExerciseCategory = (typeof EXERCISE_CATEGORIES)[number];

export const EXERCISE_CATEGORY_LABEL: Record<ExerciseCategory, string> = {
  WARM_UP: "ウォームアップ",
  MOBILITY: "可動域・体操",
  DRILL: "ドリル",
  SPRINT: "スプリント・走",
  JUMP: "跳躍・プライオ",
  THROW: "投",
  HURDLE: "ハードル",
  ENDURANCE: "持久走",
  STRENGTH: "筋力・ウエイト",
  CORE: "体幹・補強",
  COOL_DOWN: "クールダウン",
  OTHER: "その他",
};

/** 一覧のバッジ色。Tailwind のクラス名を直接持つ。 */
export const EXERCISE_CATEGORY_COLOR: Record<ExerciseCategory, string> = {
  WARM_UP: "bg-amber-100 text-amber-800 border-amber-200",
  MOBILITY: "bg-lime-100 text-lime-800 border-lime-200",
  DRILL: "bg-sky-100 text-sky-800 border-sky-200",
  SPRINT: "bg-red-100 text-red-800 border-red-200",
  JUMP: "bg-violet-100 text-violet-800 border-violet-200",
  THROW: "bg-orange-100 text-orange-800 border-orange-200",
  HURDLE: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  ENDURANCE: "bg-teal-100 text-teal-800 border-teal-200",
  STRENGTH: "bg-indigo-100 text-indigo-800 border-indigo-200",
  CORE: "bg-emerald-100 text-emerald-800 border-emerald-200",
  COOL_DOWN: "bg-cyan-100 text-cyan-800 border-cyan-200",
  OTHER: "bg-slate-100 text-slate-700 border-slate-200",
};

// --- 対象能力（何が鍛えられるか）-------------------------------------------
export const TRAINING_TARGETS = [
  "ACCELERATION",
  "MAX_VELOCITY",
  "SPEED_ENDURANCE",
  "ENDURANCE",
  "POWER",
  "STRENGTH",
  "MOBILITY",
  "TECHNIQUE",
  "COORDINATION",
  "RECOVERY",
] as const;
export type TrainingTarget = (typeof TRAINING_TARGETS)[number];

export const TRAINING_TARGET_LABEL: Record<TrainingTarget, string> = {
  ACCELERATION: "加速",
  MAX_VELOCITY: "最高速",
  SPEED_ENDURANCE: "スピード持久",
  ENDURANCE: "持久力",
  POWER: "パワー",
  STRENGTH: "筋力",
  MOBILITY: "可動域",
  TECHNIQUE: "技術",
  COORDINATION: "調整力",
  RECOVERY: "回復",
};

// --- 練習目的（対象能力=targets とは別軸。より具体的な着目点）-------------
// TRAINING_TARGETS が「鍛えられる能力」なのに対し、こちらは
// 「この種目で選手のどこに意識を向けさせるか」という、より細かいコーチング上の着眼点。
export const EXERCISE_PURPOSES = [
  "ACCELERATION",
  "MAX_VELOCITY",
  "RHYTHM",
  "GROUND_CONTACT",
  "POSTURE",
  "HIP_JOINT",
  "ANKLE_JOINT",
  "ARM_SWING",
  "BALANCE",
  "MOBILITY",
  "STRENGTH",
  "POWER",
  "TECHNIQUE",
  "RECOVERY",
] as const;
export type ExercisePurposeValue = (typeof EXERCISE_PURPOSES)[number];

export const EXERCISE_PURPOSE_LABEL: Record<ExercisePurposeValue, string> = {
  ACCELERATION: "加速",
  MAX_VELOCITY: "最高速度",
  RHYTHM: "リズム",
  GROUND_CONTACT: "接地",
  POSTURE: "姿勢",
  HIP_JOINT: "股関節",
  ANKLE_JOINT: "足関節",
  ARM_SWING: "腕振り",
  BALANCE: "バランス",
  MOBILITY: "可動域",
  STRENGTH: "筋力",
  POWER: "パワー",
  TECHNIQUE: "技術",
  RECOVERY: "疲労回復",
};

// --- 対象競技種目（この種目がどの種目の選手向けか）-------------------------
export const TRACK_FIELD_EVENTS = [
  "SPRINT",
  "HURDLE",
  "LONG_JUMP",
  "HIGH_JUMP",
  "TRIPLE_JUMP",
  "THROW",
  "MIDDLE_DISTANCE",
  "COMMON",
] as const;
export type TrackFieldEvent = (typeof TRACK_FIELD_EVENTS)[number];

export const TRACK_FIELD_EVENT_LABEL: Record<TrackFieldEvent, string> = {
  SPRINT: "短距離",
  HURDLE: "ハードル",
  LONG_JUMP: "走幅跳",
  HIGH_JUMP: "走高跳",
  TRIPLE_JUMP: "三段跳",
  THROW: "投擲",
  MIDDLE_DISTANCE: "中長距離",
  COMMON: "共通",
};

// --- 主として使うエネルギー供給系 -------------------------------------------
// category / targets だけでは「30m 加速走」と「300m」を処方上で区別できない。
// レスト（完全回復か不完全回復か）と 1 回の総量上限は、どのエネルギー系に
// 効かせたい種目なのかで決まるため、処方ロジックに必要な最小の 1 軸として持つ。
// 1 種目 1 値なのでスカラー（中間テーブルにしない）。
export const ENERGY_SYSTEMS = [
  "ALACTIC",
  "GLYCOLYTIC",
  "AEROBIC",
  "NEURAL",
  "NONE",
] as const;
export type EnergySystem = (typeof ENERGY_SYSTEMS)[number];

export const ENERGY_SYSTEM_LABEL: Record<EnergySystem, string> = {
  ALACTIC: "非乳酸系（ATP-CP）",
  GLYCOLYTIC: "乳酸系（解糖）",
  AEROBIC: "有酸素系",
  NEURAL: "神経系・技術",
  NONE: "負荷管理の対象外",
};

/** 一覧バッジ用。カテゴリと同じく Tailwind クラスを直接持つ。 */
export const ENERGY_SYSTEM_COLOR: Record<EnergySystem, string> = {
  ALACTIC: "bg-rose-100 text-rose-800 border-rose-200",
  GLYCOLYTIC: "bg-amber-100 text-amber-800 border-amber-200",
  AEROBIC: "bg-teal-100 text-teal-800 border-teal-200",
  NEURAL: "bg-sky-100 text-sky-800 border-sky-200",
  NONE: "bg-slate-100 text-slate-700 border-slate-200",
};

// --- 負荷の測り方（入力 UI の出し分けに使う）-------------------------------
export const METRIC_TYPES = ["REPS", "DISTANCE", "TIME"] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export const METRIC_TYPE_LABEL: Record<MetricType, string> = {
  REPS: "回数",
  DISTANCE: "距離",
  TIME: "時間",
};

// --- タグの種別 -------------------------------------------------------------
export const TAG_KINDS = ["GENERAL", "EQUIPMENT", "BODY_PART"] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const TAG_KIND_LABEL: Record<TagKind, string> = {
  GENERAL: "タグ",
  EQUIPMENT: "使用器具",
  BODY_PART: "部位",
};

// --- 難易度 -----------------------------------------------------------------
export const DIFFICULTY_LEVELS = [1, 2, 3, 4, 5] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

export const DIFFICULTY_LABEL: Record<number, string> = {
  1: "入門",
  2: "初級",
  3: "標準",
  4: "上級",
  5: "高難度",
};
