/**
 * Running Prescription Engine v2 — §8.5 output plausibility.
 *
 * F1 keeps every unapproved review finding as a BLOCK. Rule policy and interval certainty
 * are carried as structured data so later review approval cannot confuse a method boundary,
 * product sanity cap, or uncertain interval with a scientific absolute.
 */
import type { PlausibilityRule, RuleSet } from "../rules/schema";
import type { Finding, FindingSeverity, PlausibilityCertainty, PlausibilityPolicy } from "../types/findings";
import type { QuantityInterval, Unit } from "../types/primitives";
import type { RunningPrescriptionValue } from "../types/prescription";
import { itemTotalRunningDistanceM, itemTotalReps, repRunningDistanceM } from "../aggregation/metrics";
import { legacyDistanceInterval, legacyCategoryContribution } from "../aggregation/legacyAdapter";
import type { LegacyItemSummary } from "../aggregation/schema";
import { evaluatePlausibilityThreshold, plausibilityMetadata } from "./input";

export const PLAUSIBILITY_FINDING_CODES = {
  BLOCK: "PLAUSIBILITY_BLOCK",
  CONFIRM: "PLAUSIBILITY_REQUIRE_CONFIRMATION",
  NOT_DETERMINABLE: "PLAUSIBILITY_NOT_DETERMINABLE",
  SESSION_BLOCK: "AGG_TOTAL_RUNNING_BLOCK",
  SESSION_CONFIRM: "AGG_TOTAL_RUNNING_CONFIRM",
} as const;

function finding(
  code: string,
  severity: FindingSeverity,
  scope: "ITEM" | "SESSION",
  metric: string,
  options: {
    value?: Finding["value"];
    unit?: Unit;
    threshold?: number | null;
    certainty?: PlausibilityCertainty;
    policy?: PlausibilityPolicy | "DATA_QUALITY";
    side?: "MIN" | "MAX";
    ruleId?: string;
  } = {},
): Finding {
  const { value, threshold, certainty, policy, side, ruleId = metric } = options;
  return {
    code,
    severity,
    scope,
    metric,
    ...(value !== undefined ? { value } : {}),
    ...(certainty !== undefined && policy !== undefined
      ? { plausibility: plausibilityMetadata(ruleId, policy, certainty, side && threshold !== undefined && threshold !== null ? { side, threshold } : undefined) }
      : {}),
    evidenceIds: [],
  };
}

type ThresholdResult = { certainty: PlausibilityCertainty; side: "MIN" | "MAX" | null; threshold: number | null };

function assess(rule: PlausibilityRule, value: { lower: number | null; upper: number | null }, block: boolean): ThresholdResult {
  const threshold = block ? rule.blockThreshold : rule.confirmThreshold;
  return evaluatePlausibilityThreshold(value, threshold);
}

function policyAt(rule: PlausibilityRule, side: "MIN" | "MAX" | null): PlausibilityPolicy | null {
  if (side === null) return null;
  return rule.boundaryPolicies[side === "MIN" ? "min" : "max"];
}

function blockFromAssessment(
  rule: PlausibilityRule,
  assessment: ThresholdResult,
  scope: "ITEM" | "SESSION",
  code: string,
  value: Finding["value"],
): Finding | null {
  if (assessment.certainty === "CONFIRMED_WITHIN") return null;
  const policy = policyAt(rule, assessment.side);
  if (policy === null) return null;
  const unit = rule.unit as Unit;
  const findingCode = assessment.certainty === "UNEVALUABLE" ? PLAUSIBILITY_FINDING_CODES.NOT_DETERMINABLE : code;
  return finding(findingCode, "BLOCK", scope, rule.ruleId, {
    value,
    unit,
    threshold: assessment.threshold,
    certainty: assessment.certainty,
    policy,
    side: assessment.side ?? undefined,
    ruleId: rule.ruleId,
  });
}

function confirmationFromAssessment(
  rule: PlausibilityRule,
  assessment: ThresholdResult,
  scope: "ITEM" | "SESSION",
  code: string,
  value: Finding["value"],
): Finding | null {
  if (assessment.certainty === "CONFIRMED_WITHIN" || assessment.certainty === "UNEVALUABLE") return null;
  return finding(code, "REQUIRE_CONFIRMATION", scope, rule.ruleId, {
    value,
    unit: rule.unit as Unit,
    threshold: assessment.threshold,
    side: assessment.side ?? undefined,
  });
}

/** A block boundary is not safe when an interval cannot be evaluated. */
function checkRuleValue(rule: PlausibilityRule, value: Finding["value"], bounds: { lower: number | null; upper: number | null }, scope: "ITEM" | "SESSION", code: string) {
  const block = blockFromAssessment(rule, assess(rule, bounds, true), scope, code, value);
  if (block) return { block, confirmation: null };
  return {
    block: null,
    confirmation: confirmationFromAssessment(rule, assess(rule, bounds, false), scope, PLAUSIBILITY_FINDING_CODES.CONFIRM, value),
  };
}

/** Final scalar prescription field. Missing/other-shape fields are outside this rule's target. */
function prescriptionFieldValue(p: RunningPrescriptionValue, field: string): number | null {
  switch (field) {
    case "sets": return p.sets.value;
    case "repsPerSet": return p.repsPerSet.value;
    case "totalReps": return itemTotalReps(p);
    case "repRestS": return p.rest.repRestS.value;
    case "setRestS": return p.rest.setRestS?.value ?? null;
    case "intraRepRestS": return p.rest.intraRepRestS?.value ?? null;
    case "repDurationS": return p.rep.kind === "DURATION" ? p.rep.durationS.value : null;
    case "buildUpM": return p.rep.kind === "FLY" ? p.rep.buildUpDistanceM.value : null;
    case "flyZoneM": return p.rep.kind === "FLY" ? p.rep.flyZoneDistanceM.value : null;
    case "repDistanceM": return p.rep.kind === "DISTANCE" ? p.rep.distanceM.value : null;
    default: return null;
  }
}

/** Envelope recommended.max denominator for the sets/reps mix-up confirmation. */
function recommendedTotalRepsMax(p: RunningPrescriptionValue, ruleSet: RuleSet): number | null {
  const envelope = ruleSet.envelopes.find(
    (e) => e.method === p.method && e.tier === p.tier && e.templateIds.includes(p.templateId) && (e.recoveryStructure ?? null) === (p.recoveryStructure ?? null),
  );
  return envelope?.fields.totalReps?.recommended?.max ?? null;
}

export type OutputPlausibilityResult = {
  findings: Finding[];
  /** Any unapproved hard or review-eligible plausibility finding blocks F1 planning. */
  blocked: boolean;
  requiresConfirmation: boolean;
};

export function checkOutputPlausibility(prescription: RunningPrescriptionValue, ruleSet: RuleSet): OutputPlausibilityResult {
  const findings: Finding[] = [];
  const p = prescription;
  for (const rule of ruleSet.plausibility) {
    if (rule.scope === "INPUT" || rule.outputTarget === null || rule.outputTarget === "SESSION_TOTAL_DISTANCE") continue;
    if (rule.appliesToMethods !== null && !rule.appliesToMethods.includes(p.method)) continue;

    if (rule.outputTarget === "PRESCRIPTION_FIELD") {
      if (rule.field === null) continue;
      const value = prescriptionFieldValue(p, rule.field);
      if (value === null) continue;
      const evaluated = checkRuleValue(rule, { lower: value, upper: value, unit: rule.unit as Unit, source: "PLANNED", confidence: "HIGH" }, { lower: value, upper: value }, "ITEM", PLAUSIBILITY_FINDING_CODES.BLOCK);
      if (evaluated.block) findings.push(evaluated.block);
      else if (evaluated.confirmation) findings.push(evaluated.confirmation);
      continue;
    }

    if (rule.outputTarget === "REP_DISTANCE" || rule.outputTarget === "ITEM_TOTAL_DISTANCE") {
      const value = rule.outputTarget === "REP_DISTANCE" ? repRunningDistanceM(p) : itemTotalRunningDistanceM(p);
      const evaluated = checkRuleValue(rule, value, value, "ITEM", PLAUSIBILITY_FINDING_CODES.BLOCK);
      if (evaluated.block) findings.push(evaluated.block);
      else if (evaluated.confirmation) findings.push(evaluated.confirmation);
      continue;
    }

    if (rule.outputTarget === "TOTAL_REPS_VS_RECOMMENDED") {
      const cap = recommendedTotalRepsMax(p, ruleSet);
      if (cap !== null && rule.ratioMultiplier !== null && itemTotalReps(p) >= cap * rule.ratioMultiplier) {
        findings.push(finding(PLAUSIBILITY_FINDING_CODES.CONFIRM, "REQUIRE_CONFIRMATION", "ITEM", rule.ruleId));
      }
    }
  }
  return {
    findings,
    blocked: findings.some((f) => f.severity === "BLOCK"),
    requiresConfirmation: findings.some((f) => f.severity === "REQUIRE_CONFIRMATION"),
  };
}

export function checkSessionPlausibility(totalRunningDistanceM: QuantityInterval<"m">, ruleSet: RuleSet): OutputPlausibilityResult {
  const findings: Finding[] = [];
  for (const rule of ruleSet.plausibility) {
    if (rule.outputTarget !== "SESSION_TOTAL_DISTANCE") continue;
    const evaluated = checkRuleValue(rule, totalRunningDistanceM, totalRunningDistanceM, "SESSION", PLAUSIBILITY_FINDING_CODES.SESSION_BLOCK);
    if (evaluated.block) {
      findings.push({
        ...evaluated.block,
        code: evaluated.block.plausibility?.certainty === "UNEVALUABLE" ? PLAUSIBILITY_FINDING_CODES.NOT_DETERMINABLE : PLAUSIBILITY_FINDING_CODES.SESSION_BLOCK,
      });
    }
    else if (evaluated.confirmation) findings.push({ ...evaluated.confirmation, code: PLAUSIBILITY_FINDING_CODES.SESSION_CONFIRM });
  }
  return {
    findings,
    blocked: findings.some((f) => f.severity === "BLOCK"),
    requiresConfirmation: findings.some((f) => f.severity === "REQUIRE_CONFIRMATION"),
  };
}

/** Legacy item plausibility retains the same block/review classification and never grants approval. */
export function checkLegacyItemPlausibility(item: LegacyItemSummary, ruleSet: RuleSet): OutputPlausibilityResult {
  const findings: Finding[] = [];
  if (legacyCategoryContribution(ruleSet, item.category) !== "RUNNING_DISTANCE") return { findings, blocked: false, requiresConfirmation: false };
  const distance = legacyDistanceInterval(item);
  for (const rule of ruleSet.plausibility) {
    if (rule.outputTarget !== "ITEM_TOTAL_DISTANCE") continue;
    const evaluated = checkRuleValue(rule, distance, distance, "ITEM", PLAUSIBILITY_FINDING_CODES.BLOCK);
    if (evaluated.block) findings.push(evaluated.block);
    else if (evaluated.confirmation) findings.push(evaluated.confirmation);
  }
  return {
    findings,
    blocked: findings.some((f) => f.severity === "BLOCK"),
    requiresConfirmation: findings.some((f) => f.severity === "REQUIRE_CONFIRMATION"),
  };
}
