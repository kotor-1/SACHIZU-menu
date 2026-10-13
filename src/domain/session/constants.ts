/** トレーニングセッション（実施記録）の状態。 */

export const SESSION_STATUSES = [
  "PLANNED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  PLANNED: "予定",
  IN_PROGRESS: "実施中",
  COMPLETED: "完了",
  CANCELLED: "中止",
};

export const SESSION_STATUS_COLOR: Record<SessionStatus, string> = {
  PLANNED: "bg-white text-slate-700 border-slate-300",
  IN_PROGRESS: "bg-indigo-600 text-white border-indigo-600",
  COMPLETED: "bg-emerald-50 text-emerald-800 border-emerald-300",
  CANCELLED: "bg-white text-rose-700 border-rose-300",
};

/** よく使う天候の候補（自由入力も許可する）。 */
export const WEATHER_PRESETS = ["晴れ", "曇り", "雨", "強風", "室内"] as const;
