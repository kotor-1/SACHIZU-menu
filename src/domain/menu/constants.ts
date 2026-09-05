/** 練習メニュー（テンプレート）側の分類値。 */

// --- 期分け -----------------------------------------------------------------
export const TRAINING_PHASES = [
  "PREPARATION",
  "PRE_COMPETITION",
  "COMPETITION",
  "TRANSITION",
] as const;
export type TrainingPhase = (typeof TRAINING_PHASES)[number];

export const TRAINING_PHASE_LABEL: Record<TrainingPhase, string> = {
  PREPARATION: "準備期",
  PRE_COMPETITION: "試合前期",
  COMPETITION: "試合期",
  TRANSITION: "移行期",
};

/**
 * 新規メニュー作成時に用意する既定ブロック。
 * 陸上の一般的な練習構成をそのまま雛形にしている。
 */
export const DEFAULT_BLOCK_NAMES = [
  "ウォームアップ",
  "ドリル",
  "主運動",
  "補強",
  "クールダウン",
] as const;
