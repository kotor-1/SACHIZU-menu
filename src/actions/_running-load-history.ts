import type { WeeklyHistoryInput } from "@/domain/running/types/load";
import { listLoadHistory } from "@/infra/repositories/load-history-repository";

const HISTORY_WINDOW_HOURS = 24 * 28;

/**
 * [R10-B1 設計判断] load-history-repository は実際のセッション記録を返すが、
 * 「記録に無い活動が無かった」ことまでは確認できない（§12 の DailyActivitySummary 契約。
 * コーチが「他に活動なし」を明示確認する UI は R11）。そのため、events は実データを渡しつつ、
 * coverage は常に `PARTIAL`（記録はあるが完全性は確認できていない）にする。`dailyActivity7d` は
 * 空のまま（0 埋めで「休養日」を捏造しない）。history=null にはしない（せっかく読めた記録を
 * 無かったことにしない）。
 */
export async function weeklyHistoryAsOf(asOf: Date, excludeSessionId?: string): Promise<WeeklyHistoryInput> {
  const { events } = await listLoadHistory({ asOf, windowHours: HISTORY_WINDOW_HOURS });
  return {
    events: events.filter((event) => event.sessionKey !== excludeSessionId),
    coverage72h: "PARTIAL",
    coverage7d: "PARTIAL",
    coverage28d: "PARTIAL",
    dailyActivity7d: [],
  };
}
