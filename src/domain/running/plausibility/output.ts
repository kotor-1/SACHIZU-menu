/**
 * Running Prescription Engine v2 — §8.5 の出力 plausibility（step 14 の最後の防波堤）。
 *
 * **コーチ編集・override をすべて適用した後の最終値**を検査する。plausibility は「入力の訂正・確認」の層で
 * あり、hardSafety override とは別物なので **CoachOverride では消えない**（§8.5・§11.4）。
 *
 * どの行がどの量を見るかは RuleSet の `outputTarget` / `field` / `appliesToMethods` だけで決める
 * （ruleId・targetLabel・template 名を解析しない）。閾値も RuleSet の値をそのまま使う。
 */
import type { PlausibilityRule, RuleSet } from "../rules/schema";
import type { Finding, FindingSeverity } from "../types/findings";
import type { QuantityInterval } from "../types/primitives";
import type { RunningPrescriptionValue } from "../types/prescription";
import { itemTotalRunningDistanceM, itemTotalReps, repRunningDistanceM } from "../aggregation/metrics";
import { legacyDistanceInterval } from "../aggregation/legacyAdapter";
import { legacyCategoryContribution } from "../aggregation/legacyAdapter";
import type { LegacyItemSummary } from "../aggregation/schema";

export const PLAUSIBILITY_FINDING_CODES = {
  BLOCK: "PLAUSIBILITY_BLOCK",
  CONFIRM: "PLAUSIBILITY_REQUIRE_CONFIRMATION",
  NOT_DETERMINABLE: "PLAUSIBILITY_NOT_DETERMINABLE",
  SESSION_BLOCK: "AGG_TOTAL_RUNNING_BLOCK",
  SESSION_CONFIRM: "AGG_TOTAL_RUNNING_CONFIRM",
} as const;

function finding(code: string, severity: FindingSeverity, scope: "ITEM" | "SESSION", metric: string, limit?: { min: number; max: number; unit: string }): Finding {
  return {
    code,
    severity,
    scope,
    metric,
    ...(limit ? { limit: { min: limit.min, max: limit.max, unit: limit.unit as Finding["limit"] extends undefined ? never : "m" } } : {}),
    evidenceIds: [],
  } as Finding;
}

function exceeds(value: number, threshold: { min: number | null; max: number | null } | null): boolean {
  if (!threshold) return false;
  if (threshold.min !== null && value < threshold.min) return true;
  if (threshold.max !== null && value > threshold.max) return true;
  return false;
}

/** 区間で比較する（upper があれば upper、無ければ lower。lower も超えていなければ「断定しない」）。 */
type IntervalVerdict = "BLOCK" | "CONFIRM" | "OK" | "NOT_DETERMINABLE";

function judgeInterval(value: QuantityInterval, rule: PlausibilityRule): IntervalVerdict {
  const probe = value.upper ?? value.lower;
  if (probe === null) return "NOT_DETERMINABLE";
  if (exceeds(probe, rule.blockThreshold)) return "BLOCK";
  if (exceeds(probe, rule.confirmThreshold)) return "CONFIRM";
  return value.upper === null ? "NOT_DETERMINABLE" : "OK";
}

function judgeScalar(value: number, rule: PlausibilityRule): IntervalVerdict {
  if (exceeds(value, rule.blockThreshold)) return "BLOCK";
  if (exceeds(value, rule.confirmThreshold)) return "CONFIRM";
  return "OK";
}

/** 処方の1フィールドの最終値（存在しないフィールドは null）。 */
function prescriptionFieldValue(p: RunningPrescriptionValue, field: string): number | null {
  switch (field) {
    case "sets":
      return p.sets.value;
    case "repsPerSet":
      return p.repsPerSet.value;
    case "totalReps":
      return itemTotalReps(p);
    case "repRestS":
      return p.rest.repRestS.value;
    case "setRestS":
      return p.rest.setRestS?.value ?? null;
    case "intraRepRestS":
      return p.rest.intraRepRestS?.value ?? null;
    case "repDurationS":
      return p.rep.kind === "DURATION" ? p.rep.durationS.value : null;
    case "buildUpM":
      return p.rep.kind === "FLY" ? p.rep.buildUpDistanceM.value : null;
    case "flyZoneM":
      return p.rep.kind === "FLY" ? p.rep.flyZoneDistanceM.value : null;
    case "repDistanceM":
      return p.rep.kind === "DISTANCE" ? p.rep.distanceM.value : null;
    default:
      return null;
  }
}

/** Envelope の totalReps recommended.max（sets/reps 取り違え判定の分母）。無ければ null。 */
function recommendedTotalRepsMax(p: RunningPrescriptionValue, ruleSet: RuleSet): number | null {
  const envelope = ruleSet.envelopes.find(
    (e) =>
      e.method === p.method &&
      e.tier === p.tier &&
      e.templateIds.includes(p.templateId) &&
      (e.recoveryStructure ?? null) === (p.recoveryStructure ?? null),
  );
  const cell = envelope?.fields.totalReps;
  return cell?.recommended?.max ?? null;
}

export type OutputPlausibilityResult = {
  findings: Finding[];
  /** BLOCK が1つでもあれば true（どの actor でも、どの override でも解除できない）。 */
  blocked: boolean;
  /** REQUIRE_CONFIRMATION が1つでもあれば true。 */
  requiresConfirmation: boolean;
};

/**
 * 1項目（最終処方）の出力 plausibility。§8.5 の ITEM_FIELD / RATIO 行だけを見る。
 */
export function checkOutputPlausibility(prescription: RunningPrescriptionValue, ruleSet: RuleSet): OutputPlausibilityResult {
  const p = prescription;
  const findings: Finding[] = [];

  for (const rule of ruleSet.plausibility) {
    if (rule.scope === "INPUT" || rule.outputTarget === null) continue;
    if (rule.outputTarget === "SESSION_TOTAL_DISTANCE") continue;
    if (rule.appliesToMethods !== null && !rule.appliesToMethods.includes(p.method)) continue;

    const metric = `${rule.ruleId}`;
    if (rule.outputTarget === "PRESCRIPTION_FIELD") {
      if (rule.field === null) continue;
      const value = prescriptionFieldValue(p, rule.field);
      if (value === null) continue; // 存在しないフィールドは検査対象外
      const verdict = judgeScalar(value, rule);
      if (verdict === "BLOCK") findings.push(finding(PLAUSIBILITY_FINDING_CODES.BLOCK, "BLOCK", "ITEM", metric));
      else if (verdict === "CONFIRM") findings.push(finding(PLAUSIBILITY_FINDING_CODES.CONFIRM, "REQUIRE_CONFIRMATION", "ITEM", metric));
      continue;
    }

    if (rule.outputTarget === "REP_DISTANCE" || rule.outputTarget === "ITEM_TOTAL_DISTANCE") {
      const value = rule.outputTarget === "REP_DISTANCE" ? repRunningDistanceM(p) : itemTotalRunningDistanceM(p);
      const verdict = judgeInterval(value, rule);
      if (verdict === "BLOCK") findings.push(finding(PLAUSIBILITY_FINDING_CODES.BLOCK, "BLOCK", "ITEM", metric));
      else if (verdict === "CONFIRM") findings.push(finding(PLAUSIBILITY_FINDING_CODES.CONFIRM, "REQUIRE_CONFIRMATION", "ITEM", metric));
      else if (verdict === "NOT_DETERMINABLE") findings.push(finding(PLAUSIBILITY_FINDING_CODES.NOT_DETERMINABLE, "WARN", "ITEM", metric));
      continue;
    }

    if (rule.outputTarget === "TOTAL_REPS_VS_RECOMMENDED") {
      const cap = recommendedTotalRepsMax(p, ruleSet);
      if (cap === null || rule.ratioMultiplier === null) continue;
      if (itemTotalReps(p) >= cap * rule.ratioMultiplier) {
        findings.push(finding(PLAUSIBILITY_FINDING_CODES.CONFIRM, "REQUIRE_CONFIRMATION", "ITEM", metric));
      }
    }
  }

  return {
    findings,
    blocked: findings.some((f) => f.severity === "BLOCK"),
    requiresConfirmation: findings.some((f) => f.severity === "REQUIRE_CONFIRMATION"),
  };
}

/**
 * メニュー全体の総走行距離（§8.5 の MENU_TOTAL 行 / §11.4 の AGG_TOTAL_RUNNING_*）。
 * 監査 C-1 の「80km」は項目 BLOCK と Session BLOCK の二重で止まる。
 */
export function checkSessionPlausibility(totalRunningDistanceM: QuantityInterval<"m">, ruleSet: RuleSet): OutputPlausibilityResult {
  const findings: Finding[] = [];
  for (const rule of ruleSet.plausibility) {
    if (rule.outputTarget !== "SESSION_TOTAL_DISTANCE") continue;
    const verdict = judgeInterval(totalRunningDistanceM, rule);
    if (verdict === "BLOCK") findings.push(finding(PLAUSIBILITY_FINDING_CODES.SESSION_BLOCK, "BLOCK", "SESSION", rule.ruleId));
    else if (verdict === "CONFIRM") findings.push(finding(PLAUSIBILITY_FINDING_CODES.SESSION_CONFIRM, "REQUIRE_CONFIRMATION", "SESSION", rule.ruleId));
    else if (verdict === "NOT_DETERMINABLE") findings.push(finding(PLAUSIBILITY_FINDING_CODES.NOT_DETERMINABLE, "WARN", "SESSION", rule.ruleId));
  }
  return {
    findings,
    blocked: findings.some((f) => f.severity === "BLOCK"),
    requiresConfirmation: findings.some((f) => f.severity === "REQUIRE_CONFIRMATION"),
  };
}

/**
 * [R6] legacy 項目（v2 ではない MenuItem）の総走行距離を §8.5 の ITEM_TOTAL_DISTANCE 行で検査する。
 *
 * legacy エンジンの**数値は一切変えない**。監査 C-1 の2事例（ペース走 80km / インターバル 25.6km）を
 * legacy 経路でも検出できるようにするための、警告専用のフック。
 * 走かどうかは RuleSet の LEGACY_CATEGORY が決める（category 名を TS 側で解釈しない）。
 */
export function checkLegacyItemPlausibility(item: LegacyItemSummary, ruleSet: RuleSet): OutputPlausibilityResult {
  const findings: Finding[] = [];
  if (legacyCategoryContribution(ruleSet, item.category) !== "RUNNING_DISTANCE") {
    return { findings, blocked: false, requiresConfirmation: false };
  }
  const distance = legacyDistanceInterval(item);
  for (const rule of ruleSet.plausibility) {
    if (rule.outputTarget !== "ITEM_TOTAL_DISTANCE") continue;
    const verdict = judgeInterval(distance, rule);
    if (verdict === "BLOCK") findings.push(finding(PLAUSIBILITY_FINDING_CODES.BLOCK, "BLOCK", "ITEM", rule.ruleId));
    else if (verdict === "CONFIRM") findings.push(finding(PLAUSIBILITY_FINDING_CODES.CONFIRM, "REQUIRE_CONFIRMATION", "ITEM", rule.ruleId));
  }
  return {
    findings,
    blocked: findings.some((f) => f.severity === "BLOCK"),
    requiresConfirmation: findings.some((f) => f.severity === "REQUIRE_CONFIRMATION"),
  };
}
