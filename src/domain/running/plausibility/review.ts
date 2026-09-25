/** Pure helpers for the separate OPEN20 plausibility review contract. */
import type { PlausibilityRule } from "../rules/schema";
import type { Finding } from "../types/findings";
import type {
  PlausibilityIssue,
  PlausibilityIssueDraft,
} from "../types/plausibilityReview";
import type { Unit } from "../types/primitives";
import { evaluatePlausibilityBoundary } from "./input";

export type RuleSetReviewIdentity = { version: string; contentHash: string };

export {
  buildPlausibilityReviewContext,
  canonicalPlausibilityReviewContext,
  type PlausibilityReviewPlanningInput,
} from "./review-context";

/** One eligibility predicate shared by finding conversion and current-rule validation. */
export function isReviewablePlausibilityPolicy(policy: string): boolean {
  return policy === "COACH_OVERRIDABLE_STRONG_REVIEW" ||
    policy === "DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW";
}

/** Canonical issue identity excludes issueDigest itself and keeps all review-critical bindings. */
export function canonicalPlausibilityIssueIdentity(issue: PlausibilityIssueDraft | PlausibilityIssue) {
  return {
    ruleId: issue.ruleId,
    findingCode: issue.findingCode,
    scope: issue.scope,
    target: issue.target,
    observation: issue.observation,
    boundary: { side: issue.boundary.side, threshold: issue.boundary.threshold },
    certainty: issue.certainty,
    ruleSet: { version: issue.ruleSet.version, contentHash: issue.ruleSet.contentHash },
    contextDigest: issue.contextDigest,
  } as const;
}

export function canonicalTimedMarkRecordIdentity(input: {
  subjectIdentity: string;
  event: string;
  date: string;
  timeS: number;
  timing: string;
  videoFps: number | null;
  wind: number | null;
  startType: string | null;
  surface: string | null;
  spikes: boolean | null;
}) {
  return {
    kind: "TIMED_MARK" as const,
    subjectIdentity: input.subjectIdentity,
    event: input.event,
    date: input.date,
    value: input.timeS,
    timing: input.timing,
    videoFps: input.videoFps,
    wind: input.wind,
    startType: input.startType,
    surface: input.surface,
    spikes: input.spikes,
  };
}

export function canonicalHeightPointRecordIdentity(input: {
  subjectIdentity: string;
  memberIdentity: string | null;
  date: string;
  heightCm: number;
}) {
  return {
    kind: "HEIGHT_POINT" as const,
    subjectIdentity: input.subjectIdentity,
    memberIdentity: input.memberIdentity,
    date: input.date,
    heightCm: input.heightCm,
  };
}

/** DATE_AWARE is the RuleSet's height-endpoint form of the same coach review class. */
export function isReviewEligibleBoundary(rule: PlausibilityRule, side: "MIN" | "MAX"): boolean {
  const policy = rule.boundaryPolicies[side === "MIN" ? "min" : "max"];
  return (
    policy !== null && isReviewablePlausibilityPolicy(policy) &&
    (policy !== "DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW" || rule.inputTarget?.kind === "HEIGHT_CM")
  );
}

export function plausibilityIssueScopeForRule(rule: PlausibilityRule): PlausibilityIssue["scope"] {
  if (rule.scope === "INPUT") return "INPUT";
  return rule.outputTarget === "SESSION_TOTAL_DISTANCE" ? "SESSION" : "ITEM";
}

/** Only RuleSet targets with a corresponding F0 target shape can enter this review contract. */
export function plausibilityIssueTargetKindForRule(rule: PlausibilityRule): PlausibilityIssue["target"]["kind"] | null {
  if (rule.scope === "INPUT") {
    switch (rule.inputTarget?.kind) {
      case "TIMED_MARK": return "TIMED_MARK";
      case "HEIGHT_CM": return "HEIGHT_POINT";
      case "COACH_EDIT_APPROACH_DISTANCE_M": return "PRESCRIPTION_FIELD";
      default: return null;
    }
  }
  switch (rule.outputTarget) {
    case "PRESCRIPTION_FIELD": return rule.field === null ? null : "PRESCRIPTION_FIELD";
    case "REP_DISTANCE": return "REP_DISTANCE";
    case "ITEM_TOTAL_DISTANCE": return "ITEM_TOTAL_DISTANCE";
    default: return null;
  }
}

function targetForRule(rule: PlausibilityRule, recordDigest: string | null): PlausibilityIssueDraft["target"] | null {
  if (rule.scope === "INPUT") {
    switch (rule.inputTarget?.kind) {
      case "TIMED_MARK":
        return recordDigest === null ? null : { kind: "TIMED_MARK", recordDigest };
      case "HEIGHT_CM":
        return recordDigest === null ? null : { kind: "HEIGHT_POINT", recordDigest };
      case "COACH_EDIT_APPROACH_DISTANCE_M":
        return { kind: "PRESCRIPTION_FIELD", field: "approachDistanceM" };
      default:
        return null;
    }
  }
  switch (rule.outputTarget) {
    case "PRESCRIPTION_FIELD":
      return rule.field === null ? null : { kind: "PRESCRIPTION_FIELD", field: rule.field };
    case "REP_DISTANCE": return { kind: "REP_DISTANCE" };
    case "ITEM_TOTAL_DISTANCE": return { kind: "ITEM_TOTAL_DISTANCE" };
    default: return null;
  }
}

function observationFromFinding(finding: Finding): PlausibilityIssueDraft["observation"] | null {
  const value = finding.value;
  if (!value) return null;
  if (value.lower !== null && value.lower === value.upper) {
    return { kind: "SCALAR", value: value.lower, unit: value.unit as Unit };
  }
  return {
    kind: "INTERVAL",
    lower: value.lower,
    upper: value.upper,
    unit: value.unit as Unit,
    source: value.source,
    confidence: value.confidence,
  };
}

/**
 * Convert only a server-produced blocking Finding into a review issue draft.
 * The caller supplies recordDigest for record-backed input targets and calculates
 * contextDigest from the server-resolved current context.
 */
export function plausibilityIssueDraftFromFinding(input: {
  finding: Finding;
  rule: PlausibilityRule;
  ruleSet: RuleSetReviewIdentity;
  contextDigest: string;
  recordDigest?: string;
}): PlausibilityIssueDraft | null {
  const { finding, rule, ruleSet, contextDigest } = input;
  const metadata = finding.plausibility;
  if (
    finding.severity !== "BLOCK" ||
    metadata === undefined ||
    metadata.ruleId !== rule.ruleId ||
    metadata.boundary === undefined ||
    (metadata.certainty !== "CONFIRMED_EXCEED" && metadata.certainty !== "POSSIBLE_EXCEED") ||
    !isReviewEligibleBoundary(rule, metadata.boundary.side) ||
    !/^[a-f0-9]{64}$/u.test(ruleSet.contentHash)
  ) {
    return null;
  }

  const expectedThreshold = rule.blockThreshold?.[metadata.boundary.side === "MIN" ? "min" : "max"];
  if (expectedThreshold === null || expectedThreshold === undefined || expectedThreshold !== metadata.boundary.threshold) return null;
  if (rule.boundaryPolicies[metadata.boundary.side === "MIN" ? "min" : "max"] !== metadata.policy) return null;

  const expectedCode = rule.scope === "INPUT" ? "INPUT_PLAUSIBILITY_BLOCK" : "PLAUSIBILITY_BLOCK";
  if (finding.code !== expectedCode) return null;

  const target = targetForRule(rule, input.recordDigest ?? null);
  const observation = observationFromFinding(finding);
  if (target === null || observation === null || observation.unit !== rule.unit) return null;

  const assessed = evaluatePlausibilityBoundary(
    observation.kind === "SCALAR"
      ? { lower: observation.value, upper: observation.value }
      : { lower: observation.lower, upper: observation.upper },
    metadata.boundary.threshold,
    metadata.boundary.side,
  );
  if (assessed !== metadata.certainty) return null;

  return {
    ruleId: rule.ruleId,
    findingCode: finding.code,
    scope: plausibilityIssueScopeForRule(rule),
    target,
    observation,
    boundary: { side: metadata.boundary.side, threshold: metadata.boundary.threshold },
    certainty: metadata.certainty,
    ruleSet: { version: ruleSet.version, contentHash: ruleSet.contentHash },
    contextDigest,
  };
}

/** Revalidate issue semantics against the current RuleSet at the application boundary. */
export function plausibilityIssueMatchesCurrentRule(
  issue: PlausibilityIssue,
  rule: PlausibilityRule,
  currentRuleSet: RuleSetReviewIdentity,
): boolean {
  if (
    issue.ruleId !== rule.ruleId ||
    issue.ruleSet.version !== currentRuleSet.version ||
    issue.ruleSet.contentHash !== currentRuleSet.contentHash ||
    issue.scope !== plausibilityIssueScopeForRule(rule) ||
    issue.observation.unit !== rule.unit ||
    !isReviewEligibleBoundary(rule, issue.boundary.side) ||
    issue.boundary.threshold !== rule.blockThreshold?.[issue.boundary.side === "MIN" ? "min" : "max"]
  ) {
    return false;
  }
  const expectedKind = plausibilityIssueTargetKindForRule(rule);
  if (issue.target.kind !== expectedKind) return false;
  if (issue.target.kind === "PRESCRIPTION_FIELD") {
    const expectedField = rule.scope === "INPUT" ? "approachDistanceM" : rule.field;
    if (issue.target.field !== expectedField) return false;
  }
  const expectedCode = rule.scope === "INPUT" ? "INPUT_PLAUSIBILITY_BLOCK" : "PLAUSIBILITY_BLOCK";
  if (issue.findingCode !== expectedCode) return false;
  const bounds = issue.observation.kind === "SCALAR"
    ? { lower: issue.observation.value, upper: issue.observation.value }
    : { lower: issue.observation.lower, upper: issue.observation.upper };
  return evaluatePlausibilityBoundary(bounds, issue.boundary.threshold, issue.boundary.side) === issue.certainty;
}
