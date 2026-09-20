import type { ReadinessActionCode } from "@/domain/running/types/readiness";
import type { ReadinessExecutionGate, ReadinessExecutionReadResult } from "@/domain/running/readiness/execution";

export const READINESS_ACTION_LABEL_JA = {
  NO_CHANGE: "追加の体調調整指示なし",
  USE_LOWER_BOUND: "推奨範囲の下限側で実施",
  INCREASE_REST: "休息を長めに取る",
  SWAP_TO_LOWER_LOAD_METHOD: "負荷の低い練習への変更を検討",
  CANCEL_HIGH_INTENSITY: "高強度の練習は実施しない",
  REQUIRE_COACH_REVIEW: "コーチによる確認が必要",
} satisfies Record<ReadinessActionCode, string>;

export const READINESS_SAFETY_LABEL_JA = {
  NONE: "追加の安全対応指示なし",
  COACH_REVIEW: "コーチによる確認が必要",
  MEDICAL_EVALUATION_RECOMMENDED: "医療機関への相談を推奨",
} as const;

export const READINESS_GATE_LABEL_JA = {
  YES: "当日の体調確認による追加の実施停止なし",
  NO: "この処方は当日の体調確認上、そのまま実施しない",
  REQUIRES_COACH_DECISION: "実施前にコーチ判断が必要",
} satisfies Record<ReadinessExecutionGate, string>;

export function readinessStateMessageJa(state: ReadinessExecutionReadResult): string {
  switch (state.kind) {
    case "NOT_EVALUATED": return "当日の体調確認は未評価です";
    case "LEGACY_UNVERSIONED": return "実施前に体調の再評価が必要です。すでに実施を開始している場合はコーチに確認してください";
    case "UNREADABLE": return "当日の体調確認情報を確認できません";
    case "READY_V1": return READINESS_GATE_LABEL_JA[state.executionDirective.executionGate];
  }
}
