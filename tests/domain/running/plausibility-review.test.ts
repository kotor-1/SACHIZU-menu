import { describe, expect, it } from "vitest";
import { getRuleSet } from "@/domain/running/rules/loader";
import {
  isReviewEligibleBoundary,
  isReviewablePlausibilityPolicy,
  plausibilityIssueScopeForRule,
  plausibilityIssueTargetKindForRule,
} from "@/domain/running/plausibility/review";

const ruleSet = getRuleSet("rs-2026.09.0")!;
const rule = (ruleId: string) => {
  const value = ruleSet.plausibility.find((candidate) => candidate.ruleId === ruleId);
  if (!value) throw new Error(`missing RuleSet policy ${ruleId}`);
  return value;
};

describe("OPEN20 F2: plausibility review eligibility is bound to RuleSet policy", () => {
  it("allows only coach review boundaries and the date-aware selected height endpoint variant", () => {
    expect(isReviewEligibleBoundary(rule("PLA_REPS_PER_SET"), "MAX")).toBe(true);
    expect(isReviewEligibleBoundary(rule("PLA_INPUT_100M_RECORD"), "MAX")).toBe(true);
    expect(isReviewEligibleBoundary(rule("PLA_INPUT_100M_RECORD"), "MIN")).toBe(false);
    expect(isReviewEligibleBoundary(rule("PLA_INPUT_FLY_10M"), "MIN")).toBe(false);
    expect(isReviewEligibleBoundary(rule("PLA_INPUT_HEIGHT"), "MIN")).toBe(true);
    expect(isReviewEligibleBoundary(rule("PLA_INPUT_HEIGHT"), "MAX")).toBe(true);
    expect(isReviewEligibleBoundary(rule("PLA_ITEM_DISTANCE_STANDARD"), "MAX")).toBe(false);
    expect(isReviewEligibleBoundary(rule("PLA_MENU_TOTAL_DISTANCE"), "MAX")).toBe(false);
  });

  it("defines the complete reviewable policy set once and excludes every hard/data-quality class", () => {
    expect(isReviewablePlausibilityPolicy("COACH_OVERRIDABLE_STRONG_REVIEW")).toBe(true);
    expect(isReviewablePlausibilityPolicy("DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW")).toBe(true);
    for (const policy of ["METHOD_POLICY_HARD", "PRODUCT_DATA_SANITY_HARD", "NON_OVERRIDABLE_DATA_SANITY_HARD", "DATA_QUALITY", "PLAUSIBILITY_NOT_DETERMINABLE"]) {
      expect(isReviewablePlausibilityPolicy(policy)).toBe(false);
    }
  });

  it("maps only supported RuleSet targets to F0 identity kinds", () => {
    expect(plausibilityIssueScopeForRule(rule("PLA_REPS_PER_SET"))).toBe("ITEM");
    expect(plausibilityIssueScopeForRule(rule("PLA_INPUT_100M_RECORD"))).toBe("INPUT");
    expect(plausibilityIssueTargetKindForRule(rule("PLA_REPS_PER_SET"))).toBe("PRESCRIPTION_FIELD");
    expect(plausibilityIssueTargetKindForRule(rule("PLA_ITEM_DISTANCE_STANDARD"))).toBe("REP_DISTANCE");
    expect(plausibilityIssueTargetKindForRule(rule("PLA_ITEM_TOTAL_DISTANCE"))).toBe("ITEM_TOTAL_DISTANCE");
    expect(plausibilityIssueTargetKindForRule(rule("PLA_INPUT_100M_RECORD"))).toBe("TIMED_MARK");
    expect(plausibilityIssueTargetKindForRule(rule("PLA_INPUT_HEIGHT"))).toBe("HEIGHT_POINT");
    expect(plausibilityIssueTargetKindForRule(rule("PLA_MENU_TOTAL_DISTANCE"))).toBeNull();
  });
});
