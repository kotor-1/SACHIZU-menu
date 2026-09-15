/**
 * 処方（どれだけやるか）を決めるための分類値。
 *
 * `src/domain/exercise/constants.ts` が「種目そのものの分類」なのに対し、
 * こちらは「その種目をどういう負荷体系で処方するか」の分類。
 * 種目カタログの UI には出さず、処方ロジックの内部でだけ使う。
 */

// --- 選手のレベル区分 -------------------------------------------------------
// 総量（本数・上限）にだけ掛かる係数のキー。強度はレベルで下げない
// （下げると狙うエネルギー系そのものが変わってしまうため）。
export const ATHLETE_LEVELS = [
  "JHS",
  "HS_BEGINNER",
  "HS_ADVANCED",
  "UNIVERSITY_PLUS",
] as const;
export type AthleteLevel = (typeof ATHLETE_LEVELS)[number];

export const ATHLETE_LEVEL_LABEL: Record<AthleteLevel, string> = {
  JHS: "中学",
  HS_BEGINNER: "高校初級",
  HS_ADVANCED: "高校上級",
  UNIVERSITY_PLUS: "大学以上",
};

/** 定数表の基準となるレベル。ここを 1.0 として係数を掛ける。 */
export const BASELINE_LEVEL: AthleteLevel = "HS_ADVANCED";

// --- 処方タイプ -------------------------------------------------------------
// 「同じ SPRINT カテゴリでも 30m 加速走と 300m は別の負荷体系」を表す軸。
// Exercise の category / targets / energySystem から機械的に判定する（classify.ts）。
export const PRESCRIPTION_KINDS = [
  "SPEED_ACCELERATION",
  "SPEED_MAX_VELOCITY",
  "SPEED_ENDURANCE",
  "TEMPO_AEROBIC",
  "DRILL_TECHNICAL",
  "PLYOMETRIC",
  "THROW_POWER",
  "STRENGTH_MAX",
  "STRENGTH_HYPERTROPHY",
  "CORE_CIRCUIT",
  "MOBILITY_WARMUP",
  "COOLDOWN",
] as const;
export type PrescriptionKind = (typeof PRESCRIPTION_KINDS)[number];

export const PRESCRIPTION_KIND_LABEL: Record<PrescriptionKind, string> = {
  SPEED_ACCELERATION: "加速（ATP-CP系）",
  SPEED_MAX_VELOCITY: "最高速（ATP-CP系）",
  SPEED_ENDURANCE: "スピード持久（解糖系）",
  TEMPO_AEROBIC: "テンポ・持久（有酸素系）",
  DRILL_TECHNICAL: "技術ドリル",
  PLYOMETRIC: "跳躍・プライオ",
  THROW_POWER: "投・爆発的パワー",
  STRENGTH_MAX: "最大筋力",
  STRENGTH_HYPERTROPHY: "筋肥大",
  CORE_CIRCUIT: "体幹・補強サーキット",
  MOBILITY_WARMUP: "可動域・ウォームアップ",
  COOLDOWN: "クールダウン",
};

/**
 * 「1 回の練習の高強度走行総量」に数える処方タイプ。
 * ここに含まれる種目の距離だけを足して、上限と突き合わせる。
 */
export const HIGH_INTENSITY_RUN_KINDS: readonly PrescriptionKind[] = [
  "SPEED_ACCELERATION",
  "SPEED_MAX_VELOCITY",
  "SPEED_ENDURANCE",
];
