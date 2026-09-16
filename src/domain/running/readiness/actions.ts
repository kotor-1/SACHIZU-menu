/**
 * Running Prescription Engine v2 — §13.3 Action 選択（数値係数に変換しない）。
 *
 * しきい値（soreness ≥ 4、soreness = 3、fatigue ≥ 4、sleepQuality ≤ 2、signal 2件以上）は
 * すべて RuleSet.readinessRules から読む。TS 側に数値を複製しない。
 *
 * **割合・係数は一切作らない。** 出力は離散 action だけ。
 */
import type { ReadinessRule } from "../rules/schema";
import type { ReadinessActionCode, ReadinessReport } from "../types/readiness";
import type { ReadinessTrigger, ReadinessWindowState } from "./schema";

export type WellnessActionResult = {
  actions: ReadinessActionCode[];
  /** signal 単位の内訳（どの RuleSet 行がどの action を出したか）。 */
  triggers: ReadinessTrigger[];
  /** 数え上げ対象（§13.3 の「2つ以上」）に該当した WELLNESS_SIGNAL ルールの id。 */
  matchedSignalRuleIds: string[];
};

function metricValue(report: ReadinessReport, metric: "SORENESS" | "FATIGUE" | "SLEEP_QUALITY"): number | null {
  switch (metric) {
    case "SORENESS":
      return report.soreness;
    case "FATIGUE":
      return report.fatigue;
    case "SLEEP_QUALITY":
      return report.sleepQuality;
  }
}

function matches(value: number, comparison: "GTE" | "LTE" | "EQ", threshold: number): boolean {
  switch (comparison) {
    case "GTE":
      return value >= threshold;
    case "LTE":
      return value <= threshold;
    case "EQ":
      return value === threshold;
  }
}

/**
 * §13.3 の表を評価する（優先順位の適用は `normalizeReadinessActions` が行うため、ここでは該当する action を集める）。
 *   - performanceStatus のルール（DOWN → SWAP + REVIEW）
 *   - WELLNESS_SIGNAL のうち actions を持つ行（soreness ≥ 4 → SWAP）
 *   - countsTowardSignalCount の行の該当数 → SIGNAL_COUNT（minSignals が大きい行が優先。1件なら LOWER_BOUND + INCREASE_REST）
 *   - readiness 窓が ACTIVE で soreness/fatigue/sleep がすべて null → USE_LOWER_BOUND
 *   - どれにも該当しなければ NO_CHANGE
 * ルール配列の順序に依存しない（該当集合と minSignals の最大値だけを使う）。
 */
export function deriveReadinessActions(args: {
  report: ReadinessReport;
  windowState: ReadinessWindowState;
  rules: readonly ReadinessRule[];
}): WellnessActionResult {
  const { report, windowState, rules } = args;
  const actions = new Set<ReadinessActionCode>();
  const matchedSignalRuleIds: string[] = [];
  const triggers: ReadinessTrigger[] = [];
  const addTrigger = (ruleId: string, ruleActions: readonly ReadinessActionCode[]) => {
    if (ruleActions.length === 0) return;
    for (const a of ruleActions) actions.add(a);
    triggers.push({ ruleId, actions: [...ruleActions] });
  };

  for (const rule of rules) {
    if (rule.kind === "PERFORMANCE_STATUS" && report.performanceStatus === rule.status) {
      addTrigger(rule.id, rule.actions);
    }
    if (rule.kind === "WELLNESS_SIGNAL") {
      const value = metricValue(report, rule.metric);
      if (value === null || !matches(value, rule.comparison, rule.threshold)) continue;
      addTrigger(rule.id, rule.actions);
      if (rule.countsTowardSignalCount) matchedSignalRuleIds.push(rule.id);
    }
  }

  const signalCount = matchedSignalRuleIds.length;
  if (signalCount > 0) {
    const applicable = rules.filter((r) => r.kind === "SIGNAL_COUNT" && r.minSignals <= signalCount);
    if (applicable.length > 0) {
      const strongest = applicable.reduce((a, b) =>
        (b.kind === "SIGNAL_COUNT" ? b.minSignals : 0) > (a.kind === "SIGNAL_COUNT" ? a.minSignals : 0) ? b : a,
      );
      if (strongest.kind === "SIGNAL_COUNT") addTrigger(strongest.id, strongest.actions);
    }
  }

  if (windowState === "ACTIVE" && report.soreness === null && report.fatigue === null && report.sleepQuality === null) {
    for (const rule of rules) {
      if (rule.kind === "MISSING_WELLNESS_IN_ACTIVE_WINDOW") addTrigger(rule.id, rule.actions);
    }
  }

  if (actions.size === 0) actions.add("NO_CHANGE");
  return {
    actions: [...actions],
    // ルール配列の順序に依存させない（id 昇順で固定する）。
    triggers: [...triggers].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)),
    matchedSignalRuleIds: [...matchedSignalRuleIds].sort(),
  };
}
