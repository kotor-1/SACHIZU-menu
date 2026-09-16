/**
 * Running Prescription Engine v2 — §12 Weekly context の公開 API。
 *
 * `evaluateWeeklyContext(history, ctx)` は §9.2 step 5 が呼ぶ。R7 の責務外
 * （ここでは評価しない）: phase・大会近接（§14 は competition/ の責務）・実測 rep・taper。
 */
import { weeklyHistoryInputSchema, type WeeklyHistoryInput } from "../types/load";
import type { Finding } from "../types/findings";
import type { RunningTrainingMethod } from "../types/method";
import {
  evaluateHighIntensityGuards,
  evaluateHighSessions7d,
  evaluateHistoryUnknown,
  evaluateYouthHours,
  evaluateYouthRestDays,
  weekFinding,
} from "./guards";
import { countHighSessions } from "./events";
import { eventsWithinHours, eventsWithinHoursRange, validateCoverage7d, windowHoursRule } from "./windows";
import type { WeeklyContextResult, WeeklyEvaluationContext } from "./schema";

export type { WeeklyContextResult, WeeklyEvaluationContext } from "./schema";

const HIGH_LOAD_CLASSES = ["HIGH_NEURAL", "HIGH_METABOLIC"] as const;

function isHighIntensityLoadClass(loadClass: string): boolean {
  return (HIGH_LOAD_CLASSES as readonly string[]).includes(loadClass);
}

export function evaluateWeeklyContext(history: WeeklyHistoryInput | null, ctx: WeeklyEvaluationContext): WeeklyContextResult {
  const { ruleSet, evaluatedAt, loadClass, ageBand, hasExistingReadinessDecision } = ctx;

  if (evaluatedAt === null) {
    // plannedAt が無いメニュー（§12.3 末尾）。評価自体をしない（false と推測しない）。
    return {
      evaluatedAt: null,
      coverage72h: "NOT_EVALUATED",
      events48h: [],
      events72h: [],
      highSessions7d: 0,
      readinessRequired: false,
      weeklyPositionCap: null,
      autogenBlockedMethods: [],
      findings: [weekFinding("WEEKLY_CONTEXT_NOT_EVALUATED", "INFO")],
    };
  }

  const parsed = history === null ? null : weeklyHistoryInputSchema.parse(history);
  const events = parsed?.events ?? [];
  const coverage72hClaimed = parsed?.coverage72h ?? "NONE";
  const coverage7dClaimed = parsed?.coverage7d ?? "NONE";

  // [R7] window 時間は RuleSet だけが持つ（TS にフォールバック値も複製しない）。
  // WINDOW_HOURS 行が無い（malformed RuleSet）場合は「判定できない」として空集合にする。
  const windowRule = windowHoursRule(ruleSet);
  const events48h = windowRule ? eventsWithinHours(events, evaluatedAt, windowRule.highWindowHours) : [];
  const events4872h = windowRule ? eventsWithinHoursRange(events, evaluatedAt, windowRule.highWindowHours, windowRule.readinessWindowHours) : [];
  const events72h = windowRule ? eventsWithinHours(events, evaluatedAt, windowRule.readinessWindowHours) : [];
  const findingsPrefix: Finding[] = windowRule ? [] : [weekFinding("WEEKLY_WINDOW_RULE_MISSING", "WARN")];

  const findings: Finding[] = [...findingsPrefix];
  let readinessRequired = false;
  let weeklyPositionCap: "LOWER_BOUND" | null = null;
  let autogenBlockedMethods: RunningTrainingMethod[] = [];

  if (isHighIntensityLoadClass(loadClass)) {
    const guard = evaluateHighIntensityGuards({ ruleSet, events48h, events4872h, hasExistingReadinessDecision });
    findings.push(...guard.findings);
    readinessRequired = guard.readinessRequired;
    weeklyPositionCap = guard.weeklyPositionCap;
    if (guard.blockAllHighIntensityAutogen) {
      autogenBlockedMethods = ruleSet.methods.filter((m) => isHighIntensityLoadClass(m.loadClass)).map((m) => m.method);
    }
  }

  findings.push(...evaluateHistoryUnknown(ruleSet, coverage72hClaimed, loadClass));

  const highSessions7d = countHighSessions(eventsWithinHours(events, evaluatedAt, 7 * 24));
  findings.push(...evaluateHighSessions7d(ruleSet, highSessions7d));

  const coverage7dValidation =
    parsed === null ? { effectiveCoverage7d: "NONE" as const, inconsistent: false } : validateCoverage7d(parsed.dailyActivity7d, coverage7dClaimed, evaluatedAt);
  if (coverage7dValidation.inconsistent) {
    findings.push(weekFinding("WEEKLY_COVERAGE7D_INCONSISTENT", "WARN"));
  }
  const dailyActivity7d = parsed?.dailyActivity7d ?? [];
  findings.push(
    ...evaluateYouthRestDays({ ruleSet, ageBand, coverage7d: coverage7dValidation.effectiveCoverage7d, dailyActivity7d }),
    ...evaluateYouthHours({ ruleSet, ageBand, coverage7d: coverage7dValidation.effectiveCoverage7d, dailyActivity7d }),
  );

  return {
    evaluatedAt,
    coverage72h: coverage72hClaimed,
    events48h,
    events72h,
    highSessions7d,
    readinessRequired,
    weeklyPositionCap,
    autogenBlockedMethods,
    findings,
  };
}
