/**
 * Running Prescription Engine v2 — §12.3/§12.4 の Finding 生成（週次ガード）。
 *
 * しきい値は一切ハードコードしない（すべて `RuleSet.weeklyRules`）。
 * Method 別の回復時間は絶対に持たない（48h/72h は HIGH_NEURAL / HIGH_METABOLIC 全体で共通）。
 */
import type { RuleSet } from "../rules/schema";
import type { DailyActivitySummary, HistoryCoverageLevel, LoadEvent } from "../types/load";
import type { Finding, FindingSeverity } from "../types/findings";
import type { ResolvedAgeBand } from "../context/ageBand";
import { historyUnknownPolicyRule, youthMaxMinutesRule, youthRestDaysRule, highSessions7dRule } from "./windows";
import { isCompletedEnough, isHigh, isNonRunningRelevantCategory, isRunningRelevantCategory, isUnknownIntensity } from "./events";

export function weekFinding(code: string, severity: FindingSeverity, extra: Partial<Pick<Finding, "metric" | "value" | "limit">> = {}): Finding {
  return {
    code,
    severity,
    scope: "ITEM",
    ...(extra.metric !== undefined ? { metric: extra.metric } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
    ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
    evidenceIds: [],
  };
}

const HIGH_LOAD_CLASSES = ["HIGH_NEURAL", "HIGH_METABOLIC"] as const;

export type HighIntensityGuardResult = {
  findings: Finding[];
  readinessRequired: boolean;
  /** readiness が無い場合の代替位置上限（health data を偽造しない。§13 の ReadinessReport は作らない）。 */
  weeklyPositionCap: "LOWER_BOUND" | null;
  /** true = HIGH_NEURAL / HIGH_METABOLIC 全体の自動生成を止める（§12.3。current Method に限らない）。 */
  blockAllHighIntensityAutogen: boolean;
};

/**
 * §12.3 の48h/72h ガードをまとめて評価する。current の loadClass が HIGH_* のときだけ意味を持つ
 * （TEMPO_EXTENSIVE / STRIDE は §12.3 の対象外。呼び出し側で loadClass を渡す前に絞り込む）。
 */
export function evaluateHighIntensityGuards(args: {
  ruleSet: RuleSet;
  events48h: readonly LoadEvent[];
  events4872h: readonly LoadEvent[];
  hasExistingReadinessDecision: boolean;
}): HighIntensityGuardResult {
  const { ruleSet, events48h, events4872h, hasExistingReadinessDecision } = args;
  const findings: Finding[] = [];
  let readinessRequired = false;
  let weeklyPositionCap: "LOWER_BOUND" | null = null;
  let blockAllHighIntensityAutogen = false;

  const relevant48h = events48h.filter((e) => isCompletedEnough(e) && (isRunningRelevantCategory(ruleSet, e) || isNonRunningRelevantCategory(ruleSet, e)));
  const high48hRunning = relevant48h.filter((e) => isHigh(e) && isRunningRelevantCategory(ruleSet, e));
  const high48hNonRunning = relevant48h.filter((e) => isHigh(e) && isNonRunningRelevantCategory(ruleSet, e));
  const unknown48h = relevant48h.filter((e) => isUnknownIntensity(e));

  if (high48hRunning.length > 0) {
    findings.push(
      weekFinding("WEEKLY_HIGH_WITHIN_48H", "BLOCK_AUTOGEN"),
      weekFinding("WEEKLY_HIGH_WITHIN_48H", "REQUIRE_COACH_REVIEW"),
    );
    blockAllHighIntensityAutogen = true;
  }
  if (high48hNonRunning.length > 0) {
    findings.push(
      weekFinding("WEEKLY_NONRUN_HIGH_WITHIN_48H", "BLOCK_AUTOGEN"),
      weekFinding("WEEKLY_NONRUN_HIGH_WITHIN_48H", "REQUIRE_COACH_REVIEW"),
    );
    blockAllHighIntensityAutogen = true;
  }
  if (unknown48h.length > 0) {
    findings.push(weekFinding("WEEKLY_UNKNOWN_WITHIN_48H", "REQUIRE_COACH_REVIEW"));
    readinessRequired = true;
    if (!hasExistingReadinessDecision) weeklyPositionCap = "LOWER_BOUND";
  }

  const relevant4872h = events4872h.filter((e) => isCompletedEnough(e) && isHigh(e) && (isRunningRelevantCategory(ruleSet, e) || isNonRunningRelevantCategory(ruleSet, e)));
  if (relevant4872h.length > 0) {
    findings.push(weekFinding("READINESS_CHECK_REQUIRED", "REQUIRE_COACH_REVIEW"));
    readinessRequired = true;
    if (!hasExistingReadinessDecision) weeklyPositionCap = "LOWER_BOUND";
  }

  return { findings, readinessRequired, weeklyPositionCap, blockAllHighIntensityAutogen };
}

/** §12.3 HISTORY_UNKNOWN（72h カバレッジが無い/未確認）。 */
export function evaluateHistoryUnknown(ruleSet: RuleSet, coverage72h: HistoryCoverageLevel | "NOT_EVALUATED", loadClass: RuleSet["methods"][number]["loadClass"]): Finding[] {
  if (coverage72h !== "NONE") return [];
  const rule = historyUnknownPolicyRule(ruleSet);
  const findings: Finding[] = [weekFinding("HISTORY_UNKNOWN", "INFO")];
  if (rule && (rule.affectedLoadClasses as readonly string[]).includes(loadClass)) {
    findings.push(weekFinding(rule.findingCode, "REQUIRE_COACH_REVIEW"));
  }
  return findings;
}

/** §12.4 WEEKLY_HIGH_SESSIONS。 */
export function evaluateHighSessions7d(ruleSet: RuleSet, highSessions7d: number): Finding[] {
  const rule = highSessions7dRule(ruleSet);
  if (!rule || highSessions7d < rule.threshold) return [];
  return [weekFinding(rule.findingCode, "WARN", { metric: `count=${highSessions7d}` })];
}

/**
 * §12.4 WEEKLY_JHS_REST_DAYS。`coverage7d=COMPLETE` のときだけ評価する（不完全なら「安全」と判定しない）。
 */
export function evaluateYouthRestDays(args: {
  ruleSet: RuleSet;
  ageBand: ResolvedAgeBand;
  coverage7d: "COMPLETE" | "PARTIAL" | "NONE";
  dailyActivity7d: readonly DailyActivitySummary[];
}): Finding[] {
  const { ruleSet, ageBand, coverage7d, dailyActivity7d } = args;
  const rule = youthRestDaysRule(ruleSet);
  if (!rule || rule.ageBand !== ageBand) return [];
  if (coverage7d !== "COMPLETE") {
    return [weekFinding("WEEKLY_REST_DAYS_NOT_DETERMINABLE", "INFO")];
  }
  const restDays = dailyActivity7d.filter((d) => !d.hadActivity).length;
  if (restDays < rule.minRestDays) {
    return [weekFinding(rule.findingCode, "REQUIRE_COACH_REVIEW", { metric: `restDays=${restDays}` })];
  }
  return [];
}

/**
 * §12.4 WEEKLY_JHS_HOURS。`coverage7d=COMPLETE` かつ7日全日の `trainingMinutes` が確定しているときだけ評価。
 * 時間不明の日があれば 0 で埋めず、判定不能として扱う。
 */
export function evaluateYouthHours(args: {
  ruleSet: RuleSet;
  ageBand: ResolvedAgeBand;
  coverage7d: "COMPLETE" | "PARTIAL" | "NONE";
  dailyActivity7d: readonly DailyActivitySummary[];
}): Finding[] {
  const { ruleSet, ageBand, coverage7d, dailyActivity7d } = args;
  const rule = youthMaxMinutesRule(ruleSet);
  if (!rule || rule.ageBand !== ageBand) return [];
  if (coverage7d !== "COMPLETE") {
    return [weekFinding("WEEKLY_HOURS_NOT_DETERMINABLE", "INFO")];
  }
  const hasUnknownMinutes = dailyActivity7d.some((d) => d.hadActivity && d.trainingMinutes === null);
  if (hasUnknownMinutes) {
    return [weekFinding("WEEKLY_HOURS_NOT_DETERMINABLE", "INFO")];
  }
  const totalMinutes = dailyActivity7d.reduce((sum, d) => sum + (d.trainingMinutes ?? 0), 0);
  if (totalMinutes > rule.maxMinutes) {
    return [weekFinding(rule.findingCode, "REQUIRE_COACH_REVIEW", { metric: `minutes=${totalMinutes}` })];
  }
  return [];
}

export { HIGH_LOAD_CLASSES };
