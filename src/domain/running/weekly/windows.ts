/**
 * Running Prescription Engine v2 — §12.3/§12.4 の時間窓計算。
 *
 * 絶対に current-time を読まない（`Date.now()` / `new Date()`（引数なし）を使わない）。
 * すべて入力された IsoDateTime / IsoDate 文字列だけから計算する。
 * `new Date(isoString)` は「与えられた文字列を解析するだけ」であり、現在時刻の読み取りではない。
 */
import type { IsoDate, IsoDateTime } from "../types/primitives";
import type { DailyActivitySummary, LoadEvent } from "../types/load";
import type { RuleSet, WeeklyRule } from "../rules/schema";

/** ISO 8601 の文字列は先頭10文字が常に YYYY-MM-DD（オフセットの有無に関わらず）。 */
export function calendarDateOf(dt: IsoDateTime): IsoDate {
  return dt.slice(0, 10) as IsoDate;
}

/** 2つの IsoDateTime の絶対時間差（時間）。offset を考慮した正しい経過時間。負値もありうる（未来）。 */
export function hoursBetween(from: IsoDateTime, to: IsoDateTime): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return (b - a) / (1000 * 60 * 60);
}

/** 2つの IsoDate の暦日差（時刻を持たない）。UTC 固定のアンカーで計算するため、実タイムゾーンに依存しない。 */
export function calendarDayDiff(from: IsoDate, to: IsoDate): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const yyyy = t.getUTCFullYear().toString().padStart(4, "0");
  const mm = (t.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = t.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` as IsoDate;
}

/**
 * event が evaluatedAt より未来なら window 集計に入れない（§12.1「未来 event は除外」）。
 * `completion` は問わない（PLANNED_NOT_CONFIRMED でも「過去日付」なら実施したものとして扱うのは
 * §12.2 の規則。ここでは時刻だけを見る）。
 */
function isPastOrNow(event: LoadEvent, evaluatedAt: IsoDateTime): boolean {
  return hoursBetween(event.at, evaluatedAt) >= 0;
}

/** [0, hours] の範囲に入る過去 event（境界は含む。48h ちょうどは 48h 側、72h ちょうどは 72h window 内）。 */
export function eventsWithinHours(events: readonly LoadEvent[], evaluatedAt: IsoDateTime, hours: number): LoadEvent[] {
  return events.filter((e) => isPastOrNow(e, evaluatedAt) && hoursBetween(e.at, evaluatedAt) <= hours);
}

/** (lowerHours, upperHours] の半開区間（48h 超 72h 以下 = 48–72h window）。 */
export function eventsWithinHoursRange(events: readonly LoadEvent[], evaluatedAt: IsoDateTime, lowerHours: number, upperHours: number): LoadEvent[] {
  return events.filter((e) => {
    if (!isPastOrNow(e, evaluatedAt)) return false;
    const elapsed = hoursBetween(e.at, evaluatedAt);
    return elapsed > lowerHours && elapsed <= upperHours;
  });
}

/** 直近 N 日（evaluatedAt を含む [evaluatedAt - N*24h, evaluatedAt]）の過去 event。 */
export function eventsWithinDays(events: readonly LoadEvent[], evaluatedAt: IsoDateTime, days: number): LoadEvent[] {
  return eventsWithinHours(events, evaluatedAt, days * 24);
}

// ---------------------------------------------------------------------------
// RuleSet アクセサ（TS に 48/72/3/2/960 等を複製しない）
// ---------------------------------------------------------------------------

export function windowHoursRule(ruleSet: RuleSet): Extract<WeeklyRule, { kind: "WINDOW_HOURS" }> | null {
  return ruleSet.weeklyRules.find((r): r is Extract<WeeklyRule, { kind: "WINDOW_HOURS" }> => r.kind === "WINDOW_HOURS") ?? null;
}

export function relevantCategoriesRule(ruleSet: RuleSet): Extract<WeeklyRule, { kind: "RELEVANT_CATEGORIES" }> | null {
  return ruleSet.weeklyRules.find((r): r is Extract<WeeklyRule, { kind: "RELEVANT_CATEGORIES" }> => r.kind === "RELEVANT_CATEGORIES") ?? null;
}

export function highSessions7dRule(ruleSet: RuleSet): Extract<WeeklyRule, { kind: "HIGH_SESSIONS_7D" }> | null {
  return ruleSet.weeklyRules.find((r): r is Extract<WeeklyRule, { kind: "HIGH_SESSIONS_7D" }> => r.kind === "HIGH_SESSIONS_7D") ?? null;
}

export function youthRestDaysRule(ruleSet: RuleSet): Extract<WeeklyRule, { kind: "YOUTH_REST_DAYS" }> | null {
  return ruleSet.weeklyRules.find((r): r is Extract<WeeklyRule, { kind: "YOUTH_REST_DAYS" }> => r.kind === "YOUTH_REST_DAYS") ?? null;
}

export function youthMaxMinutesRule(ruleSet: RuleSet): Extract<WeeklyRule, { kind: "YOUTH_MAX_MINUTES_7D" }> | null {
  return ruleSet.weeklyRules.find((r): r is Extract<WeeklyRule, { kind: "YOUTH_MAX_MINUTES_7D" }> => r.kind === "YOUTH_MAX_MINUTES_7D") ?? null;
}

export function historyUnknownPolicyRule(ruleSet: RuleSet): Extract<WeeklyRule, { kind: "HISTORY_UNKNOWN_POLICY" }> | null {
  return (
    ruleSet.weeklyRules.find((r): r is Extract<WeeklyRule, { kind: "HISTORY_UNKNOWN_POLICY" }> => r.kind === "HISTORY_UNKNOWN_POLICY") ?? null
  );
}

// ---------------------------------------------------------------------------
// coverage7d の整合検証（§20: 不足日があるのに COMPLETE は reject 相当に downgrade）
// ---------------------------------------------------------------------------

export type Coverage7dValidation = { effectiveCoverage7d: "COMPLETE" | "PARTIAL" | "NONE"; inconsistent: boolean };

/**
 * `coverage7d="COMPLETE"` の申告を、実際の `dailyActivity7d` と evaluatedAt から機械的に検証する。
 * 対象の7 calendar date（evaluatedAt を含む直近7日）と1対1で揃っていなければ、その申告を信用せず
 * `PARTIAL` へ降格する（「不足日があるのに COMPLETE」を reject する§20 の要件）。timezone 変換はしない
 * （`DailyActivitySummary.date` をそのまま暦日境界として使う）。
 */
export function validateCoverage7d(dailyActivity7d: readonly DailyActivitySummary[], coverage7d: "COMPLETE" | "PARTIAL" | "NONE", evaluatedAt: IsoDateTime): Coverage7dValidation {
  if (coverage7d !== "COMPLETE") return { effectiveCoverage7d: coverage7d, inconsistent: false };
  const today = calendarDateOf(evaluatedAt);
  const expected = new Set<string>();
  for (let i = 0; i < 7; i++) expected.add(addDays(today, -i));
  const actual = new Set(dailyActivity7d.map((d) => d.date as string));
  const matches = expected.size === actual.size && [...expected].every((d) => actual.has(d));
  return matches ? { effectiveCoverage7d: "COMPLETE", inconsistent: false } : { effectiveCoverage7d: "PARTIAL", inconsistent: true };
}
