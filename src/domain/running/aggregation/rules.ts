/**
 * Running Prescription Engine v2 — §11.4 判定規則。
 *
 * [R6 pre-commit correction] 同一 Method 内でも template ごとに Envelope 上限が異なりうる
 * （例: TEMPO_INTENSIVE の TI_VITTORI_SE と TI_COACH_DEFINED）。そのため「Method に1個の絶対上限がある」
 * という設計を廃止し、**per-item normalized budget** に一般化する:
 *
 *   itemUsage = item の contribution ÷ その item が実際に使っている template/tier の Envelope 上限
 *   methodBudgetUse = Σ itemUsage（同一 Method 内の全 item）
 *
 * `methodBudgetUse > 1.0` で「1セッション分の Envelope budget を超えた」と判定する。
 * **1.0 は新しい科学的閾値ではなく、「各 item 自身の Envelope 上限を 100% とする」という
 * normalized budget の定義値**（ENGINE-POLICY）。量に掛ける係数ではない（処方値は一切変更しない）。
 *
 * 数値の出どころ:
 *   - 各 item の分母 … **その item が使っている Envelope**（recommended.max / coachEditable.max）。
 *     recommended.max が null の item は coachEditable.max を fallback denominator に使う
 *     （§11.4 の High-intensity budget と同じ policy。「recommended があると偽装する」ことではない）。
 *   - 高強度予算のしきい値・tempo/stride の参照先 … RuleSet の aggregationRules。
 * どの上限も TS 側に複製しない。ルール配列の順序に依存しない（集合と合計だけを使う）。
 */
import type { AggregationRule, AggregationVolumeMetric, RuleSet } from "../rules/schema";
import type { Finding, FindingSeverity } from "../types/findings";
import type { QuantityInterval, Unit } from "../types/primitives";
import type { RunningTrainingMethod } from "../types/method";
import type { RecoveryStructure } from "../types/template";
import type { EnvelopeTier } from "../types/subject";

/**
 * normalized Method budget の定義値（§11.4 [R6 errata]）。「各 item の Envelope 上限を 100% とする」という
 * 定義そのものであり、RuleSet から読む科学的しきい値ではない（High-intensity budget の閾値は引き続き
 * RuleSet 側にある。これと混同しない）。
 */
export const METHOD_BUDGET_LIMIT = 1.0;

export function sessionFinding(
  code: string,
  severity: FindingSeverity,
  extra: Partial<Pick<Finding, "metric" | "value" | "limit">> = {},
): Finding {
  return {
    code,
    severity,
    scope: "SESSION",
    ...(extra.metric !== undefined ? { metric: extra.metric } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
    ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
    evidenceIds: [],
  };
}

// ---------------------------------------------------------------------------
// 上限との比較（§11.3）
// ---------------------------------------------------------------------------

export type LimitComparison = "OVER" | "WITHIN" | "NOT_DETERMINABLE";

/**
 * upper があれば upper で比較する。upper が null のときは lower で比較し、
 * 超えていなければ「安全」と断定せず NOT_DETERMINABLE を返す（null を 0 にしない）。
 */
export function compareToLimit(value: QuantityInterval, limit: number): LimitComparison {
  if (value.upper !== null) return value.upper > limit ? "OVER" : "WITHIN";
  if (value.lower !== null && value.lower > limit) return "OVER";
  return "NOT_DETERMINABLE";
}

// ---------------------------------------------------------------------------
// item ごとの上限（Envelope が single source of truth）
// ---------------------------------------------------------------------------

export type ItemCap =
  | { kind: "RESOLVED"; recommendedMax: number | null; coachEditableMax: number }
  /** その item が実際に使っている template/tier/recoveryStructure に、metric の Envelope セルが無い
   * （aggregation metric に対応するセルが無い・malformed RuleSet 等）。「denominator を取得できない」場合だけ。 */
  | { kind: "NOT_DETERMINABLE" };

/**
 * **1 item が実際に使っている template** の Envelope 行から上限を引く（Method 全体の1個の上限ではない）。
 * 同じ template × tier × recoveryStructure の行が複数あって上限が食い違う場合（本来あってはならない
 * malformed RuleSet）だけ NOT_DETERMINABLE にする。勝手に max/min/平均を採らない。
 */
export function resolveItemCap(args: {
  ruleSet: RuleSet;
  method: RunningTrainingMethod;
  tier: EnvelopeTier;
  metric: AggregationVolumeMetric;
  templateId: string;
  recoveryStructure: RecoveryStructure | null;
}): ItemCap {
  const { ruleSet, method, tier, metric, templateId, recoveryStructure } = args;
  const rows = ruleSet.envelopes.filter(
    (e) =>
      e.method === method &&
      e.tier === tier &&
      (e.recoveryStructure ?? null) === (recoveryStructure ?? null) &&
      e.templateIds.includes(templateId) &&
      e.fields[metric] !== undefined,
  );
  if (rows.length === 0) return { kind: "NOT_DETERMINABLE" };

  const candidates = rows.map((e) => {
    const cell = e.fields[metric]!;
    return { recommendedMax: cell.recommended === null ? null : cell.recommended.max, coachEditableMax: cell.coachEditable.max };
  });
  const distinct = new Map(candidates.map((c) => [`${c.recommendedMax}/${c.coachEditableMax}`, c]));
  if (distinct.size > 1) return { kind: "NOT_DETERMINABLE" };
  return { kind: "RESOLVED", ...candidates[0] };
}

// ---------------------------------------------------------------------------
// RuleSet アクセサ
// ---------------------------------------------------------------------------

export function methodAggregationRule(
  ruleSet: RuleSet,
  method: RunningTrainingMethod,
): Extract<AggregationRule, { kind: "METHOD_AGGREGATION" }> | null {
  return (
    ruleSet.aggregationRules.find(
      (r): r is Extract<AggregationRule, { kind: "METHOD_AGGREGATION" }> => r.kind === "METHOD_AGGREGATION" && r.method === method,
    ) ?? null
  );
}

export function highIntensityBudgetRule(ruleSet: RuleSet): Extract<AggregationRule, { kind: "HIGH_INTENSITY_BUDGET" }> | null {
  return (
    ruleSet.aggregationRules.find(
      (r): r is Extract<AggregationRule, { kind: "HIGH_INTENSITY_BUDGET" }> => r.kind === "HIGH_INTENSITY_BUDGET",
    ) ?? null
  );
}

export function sessionVolumeLimitRules(ruleSet: RuleSet): Extract<AggregationRule, { kind: "SESSION_VOLUME_LIMIT" }>[] {
  return ruleSet.aggregationRules.filter(
    (r): r is Extract<AggregationRule, { kind: "SESSION_VOLUME_LIMIT" }> => r.kind === "SESSION_VOLUME_LIMIT",
  );
}

/** tempo/stride の SESSION_VOLUME_LIMIT（Method 単位の単一上限でよい判定）用の template 上限引き。 */
export function resolveTemplateCap(args: {
  ruleSet: RuleSet;
  method: RunningTrainingMethod;
  tier: EnvelopeTier;
  metric: AggregationVolumeMetric;
}): { recommendedMax: number | null; coachEditableMax: number } | null {
  const { ruleSet, method, tier, metric } = args;
  const rows = ruleSet.envelopes.filter((e) => e.method === method && e.tier === tier && e.fields[metric] !== undefined);
  if (rows.length === 0) return null;
  const candidates = rows.map((e) => {
    const cell = e.fields[metric]!;
    return { recommendedMax: cell.recommended === null ? null : cell.recommended.max, coachEditableMax: cell.coachEditable.max };
  });
  const distinct = new Map(candidates.map((c) => [`${c.recommendedMax}/${c.coachEditableMax}`, c]));
  if (distinct.size > 1) return null;
  return candidates[0];
}

// ---------------------------------------------------------------------------
// per-item budget usage（§11.4 の中心）
// ---------------------------------------------------------------------------

/** 1 item ぶんの「Envelope budget 使用量」を計算するための最小入力。 */
export type ItemBudgetInput = {
  method: RunningTrainingMethod;
  metric: AggregationVolumeMetric;
  templateId: string;
  /** その item の実際の量（sessionVolumeM 等）。unit は metric に対応。 */
  contribution: QuantityInterval<Unit>;
  cap: ItemCap;
};

type BudgetAccumulation = {
  /** 分母が判明した item だけの合計（upper を使う）。 */
  recommendedSum: number;
  editableSum: number;
  /** true = 1件以上 cap を解決できなかった item がある（denominator 不明）。 */
  capNotDeterminable: boolean;
  /** true = 1件以上 contribution の upper が不明な item がある（値そのものが不明）。 */
  contributionNotDeterminable: boolean;
};

function accumulate(items: readonly ItemBudgetInput[], fallbackToCoachEditable: boolean): BudgetAccumulation {
  let recommendedSum = 0;
  let editableSum = 0;
  let capNotDeterminable = false;
  let contributionNotDeterminable = false;
  for (const item of items) {
    if (item.cap.kind !== "RESOLVED") {
      capNotDeterminable = true;
      continue;
    }
    if (item.contribution.upper === null) {
      contributionNotDeterminable = true;
      continue;
    }
    const editableDenom = item.cap.coachEditableMax;
    // recommended.max が null の item は coachEditable.max を fallback denominator に使う
    // （「recommended があると偽装する」のではなく、recommended-level 判定の代替分母として使うだけ）。
    const recommendedDenom = item.cap.recommendedMax ?? (fallbackToCoachEditable ? editableDenom : null);
    if (editableDenom > 0) editableSum += item.contribution.upper / editableDenom;
    if (recommendedDenom !== null && recommendedDenom > 0) recommendedSum += item.contribution.upper / recommendedDenom;
  }
  return { recommendedSum, editableSum, capNotDeterminable, contributionNotDeterminable };
}

/**
 * §11.4 AGG_METHOD_BUDGET_OVER_RECOMMENDED / _OVER_EDITABLE。
 * 1項目ずつでは合法でも、同じ Method の normalized budget 使用量の合計が 1.0 を超えたら検出する（監査 H-5）。
 * DEV ACC を3項目並べる従来ケースは、全 item が同じ cap を持つため
 * `Σ(120/cap)` = `(120+120+120)/cap` と数学的に一致し、旧方式と同じ結果になる。
 *
 * [R6 errata] `_OVER_EDITABLE` は「REQUIRE_COACH_REVIEW + BLOCK_AUTOGEN」の2つの意味を持つ。
 * Finding は severity を1つしか持てないため、**同じ code の Finding を2件**出して両方の意味を保つ。
 */
export function evaluateMethodVolume(args: { items: readonly ItemBudgetInput[] }): Finding[] {
  const findings: Finding[] = [];
  const byMethod = new Map<RunningTrainingMethod, ItemBudgetInput[]>();
  for (const item of args.items) {
    const list = byMethod.get(item.method);
    if (list) list.push(item);
    else byMethod.set(item.method, [item]);
  }

  for (const method of [...byMethod.keys()].sort()) {
    const items = byMethod.get(method)!;
    const metric = items[0].metric;
    const acc = accumulate(items, true);

    if (acc.capNotDeterminable) {
      // 真に denominator を取得できない item がある（metric に対応する Envelope セルが無い等）。
      // 判定できないことを1件だけ報告する（optimistic に PASS 扱いしない）。
      findings.push(sessionFinding("AGG_METHOD_CAP_NOT_DETERMINABLE", "WARN", { metric: `${method}:${metric}` }));
    }
    if (acc.contributionNotDeterminable) {
      findings.push(sessionFinding("AGG_NOT_DETERMINABLE", "WARN", { metric: `${method}:${metric}` }));
    }

    // 判明した分だけの合計が既に閾値を超えていれば、不明な item を足しても増えることはあっても減らない
    // （非負の比率の総和）ので OVER と断定してよい。超えていなければ、不明な item がある間は「範囲内」と断定しない。
    if (acc.editableSum > METHOD_BUDGET_LIMIT) {
      const usage = { lower: acc.editableSum, upper: acc.editableSum, unit: "percent" as const, source: "ESTIMATED" as const, confidence: "LOW" as const };
      findings.push(
        sessionFinding("AGG_METHOD_BUDGET_OVER_EDITABLE", "REQUIRE_COACH_REVIEW", { metric: `${method}:${metric}`, value: usage }),
        sessionFinding("AGG_METHOD_BUDGET_OVER_EDITABLE", "BLOCK_AUTOGEN", { metric: `${method}:${metric}`, value: usage }),
      );
    }
    if (acc.recommendedSum > METHOD_BUDGET_LIMIT) {
      const usage = { lower: acc.recommendedSum, upper: acc.recommendedSum, unit: "percent" as const, source: "ESTIMATED" as const, confidence: "LOW" as const };
      findings.push(sessionFinding("AGG_METHOD_BUDGET_OVER_RECOMMENDED", "WARN", { metric: `${method}:${metric}`, value: usage }));
    }
  }
  return findings;
}

export type BudgetResult = { recommended: number; coachEditable: number; findings: Finding[]; highIntensityMethods: RunningTrainingMethod[] };

/**
 * §11.4 高強度予算。loadClass が HIGH_* の Method の**全 item**について `contribution ÷ その item の上限` を
 * 足し合わせる（Method 単位で1回まとめて割るのではない。heterogeneous な template を持つ Method でも一意）。
 * 量に掛ける係数ではなく、Envelope 上限の按分による判定。閾値は RuleSet 側の値（§11.4 の科学的しきい値ではなく
 * ENGINE-POLICY・provisional だが、Method budget の 1.0 とは異なり RuleSet 管理下にある）。
 */
export function evaluateHighIntensityBudget(args: { ruleSet: RuleSet; items: readonly ItemBudgetInput[] }): BudgetResult {
  const { ruleSet, items } = args;
  const rule = highIntensityBudgetRule(ruleSet);
  const findings: Finding[] = [];
  const highIntensityMethods = new Set<RunningTrainingMethod>();
  if (rule === null) return { recommended: 0, coachEditable: 0, findings, highIntensityMethods: [] };

  const highIntensityItems: ItemBudgetInput[] = [];
  for (const item of items) {
    const meta = ruleSet.methods.find((m) => m.method === item.method);
    if (!meta || (meta.loadClass !== "HIGH_NEURAL" && meta.loadClass !== "HIGH_METABOLIC")) continue;
    highIntensityMethods.add(item.method);
    highIntensityItems.push(item);
  }

  const acc = accumulate(highIntensityItems, rule.fallbackBound === "COACH_EDITABLE_MAX");
  if (acc.capNotDeterminable || acc.contributionNotDeterminable) {
    findings.push(sessionFinding("AGG_NOT_DETERMINABLE", "WARN", { metric: "highIntensityBudget" }));
  }
  if (acc.recommendedSum > rule.threshold) {
    findings.push(sessionFinding(rule.findingCode, "WARN", { metric: `budget:recommended=${acc.recommendedSum.toFixed(2)}` }));
  }
  if (acc.editableSum > rule.threshold) {
    findings.push(
      sessionFinding(rule.editableFindingCode, "REQUIRE_COACH_REVIEW", { metric: `budget:coachEditable=${acc.editableSum.toFixed(2)}` }),
      sessionFinding(rule.editableFindingCode, "BLOCK_AUTOGEN", { metric: `budget:coachEditable=${acc.editableSum.toFixed(2)}` }),
    );
  }
  return {
    recommended: acc.recommendedSum,
    coachEditable: acc.editableSum,
    findings,
    highIntensityMethods: [...highIntensityMethods].sort(),
  };
}

/** §11.4 AGG_TEMPO_OVER / AGG_STRIDE_OVER（上限値そのものは Envelope から読む）。 */
export function evaluateSessionVolumeLimits(args: {
  ruleSet: RuleSet;
  tier: EnvelopeTier;
  volumes: { TEMPO: QuantityInterval<"m">; STRIDE: QuantityInterval<"m">; LONG_SPRINT: QuantityInterval<"m"> };
}): Finding[] {
  const { ruleSet, tier, volumes } = args;
  const findings: Finding[] = [];
  for (const rule of sessionVolumeLimitRules(ruleSet)) {
    const value = volumes[rule.metric];
    if (value === undefined) continue;
    const cap = resolveTemplateCap({ ruleSet, method: rule.capMethod, tier, metric: rule.capField });
    if (cap === null) continue;
    const limit = rule.capBound === "RECOMMENDED_MAX" ? cap.recommendedMax : cap.coachEditableMax;
    if (limit === null) continue;
    const verdict = compareToLimit(value, limit);
    if (verdict === "OVER") {
      findings.push(sessionFinding(rule.findingCode, "WARN", { metric: rule.metric, value, limit: { min: 0, max: limit, unit: "m" } }));
    } else if (verdict === "NOT_DETERMINABLE") {
      findings.push(sessionFinding("AGG_NOT_DETERMINABLE", "WARN", { metric: rule.metric, value }));
    }
  }
  return findings;
}

const SECONDS_PER_MINUTE = 60;

/**
 * §11.4 AGG_REST_INFEASIBLE。必ず取る休息（＋時間が確定している走行時間）だけで練習時間を超えるときに出す。
 * 収まっているように見えても、走行時間が不明な項目が残る場合は「OK」と断定しない（Finding を出さないだけ）。
 */
export function evaluateRestFeasibility(args: {
  availableMinutes: number | null;
  mandatoryRestS: number;
  knownRunningS: number;
}): Finding[] {
  const { availableMinutes, mandatoryRestS, knownRunningS } = args;
  if (availableMinutes === null) return [];
  const budgetS = availableMinutes * SECONDS_PER_MINUTE;
  if (mandatoryRestS + knownRunningS > budgetS) {
    return [
      sessionFinding("AGG_REST_INFEASIBLE", "WARN", {
        metric: `minimumSeconds=${Math.round(mandatoryRestS + knownRunningS)}`,
        limit: { min: 0, max: budgetS, unit: "s" },
      }),
    ];
  }
  return [];
}
