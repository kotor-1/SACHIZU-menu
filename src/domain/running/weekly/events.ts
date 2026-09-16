/**
 * Running Prescription Engine v2 — LoadEvent の分類・集約ヘルパー（§12.1〜§12.4）。
 *
 * templateId / Method 名の文字列解析はしない。RuleSet の RELEVANT_CATEGORIES と
 * LoadEvent.category / intensityTag の一致だけで判定する。
 */
import type { LoadEvent } from "../types/load";
import type { IsoDate } from "../types/primitives";
import type { RuleSet } from "../rules/schema";
import { calendarDateOf, calendarDayDiff, relevantCategoriesRule } from "./windows";

/**
 * §12.2/§14.1: `DONE` / `PARTIAL` / `PLANNED_NOT_CONFIRMED`（過去日付のまま）はすべて
 * 「実施したもの」として数える。§14.3 の new stimulus 判定でも同じ扱い（§12.2）。
 */
export function isCompletedEnough(event: LoadEvent): boolean {
  return event.completion === "DONE" || event.completion === "PARTIAL" || event.completion === "PLANNED_NOT_CONFIRMED";
}

export function isHigh(event: LoadEvent): boolean {
  return event.intensityTag === "HIGH";
}

export function isUnknownIntensity(event: LoadEvent): boolean {
  return event.intensityTag === "UNKNOWN";
}

/** §12.3 の「走の HIGH_* カテゴリ」（RUNNING_HIGH_INTENSITY / RACE / RELAY）。RuleSet 由来。 */
export function isRunningRelevantCategory(ruleSet: RuleSet, event: LoadEvent): boolean {
  const rule = relevantCategoriesRule(ruleSet);
  return rule !== null && (rule.runningCategories as readonly string[]).includes(event.category);
}

/** §12.3 の「非走の HIGH カテゴリ」（PLYOMETRIC / STRENGTH / JUMPS / HURDLES）。RuleSet 由来。 */
export function isNonRunningRelevantCategory(ruleSet: RuleSet, event: LoadEvent): boolean {
  const rule = relevantCategoriesRule(ruleSet);
  return rule !== null && (rule.nonRunningCategories as readonly string[]).includes(event.category);
}

export function isRelevantCategory(ruleSet: RuleSet, event: LoadEvent): boolean {
  return isRunningRelevantCategory(ruleSet, event) || isNonRunningRelevantCategory(ruleSet, event);
}

/**
 * §12.4 highSessions7d: **session 数**（item 数ではない）。同じ sessionKey は1 session として数える。
 * 未実施（DONE/PARTIAL/PLANNED_NOT_CONFIRMED 以外）は数えない。
 */
export function countHighSessions(events: readonly LoadEvent[]): number {
  const keys = new Set<string>();
  for (const e of events) {
    if (isCompletedEnough(e) && isHigh(e)) keys.add(e.sessionKey);
  }
  return keys.size;
}

/**
 * §14.3 の new stimulus 判定用。28日以内に **exact templateId** が一致する event があるか。
 * templateId が無い（legacy 等）event は対象にならない（何かの証拠にはならない）。
 */
export function hasUsedTemplate(events: readonly LoadEvent[], templateId: string): boolean {
  return events.some((e) => isCompletedEnough(e) && e.templateId === templateId);
}

/**
 * [R7] §14.3 の新規刺激判定は暦日ベース（`plannedAt` を要求しない。§14 は一貫して calendar day
 * で動く）。`referenceDate` を含む直近 `days` 日以内（未来 event は含まない）に、exact templateId
 * が一致する event があるかを見る。
 */
export function hasUsedTemplateWithinDays(events: readonly LoadEvent[], referenceDate: IsoDate, days: number, templateId: string): boolean {
  return events.some((e) => {
    if (!isCompletedEnough(e) || e.templateId !== templateId) return false;
    const daysAgo = calendarDayDiff(calendarDateOf(e.at), referenceDate);
    return daysAgo >= 0 && daysAgo <= days;
  });
}
