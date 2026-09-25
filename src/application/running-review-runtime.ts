/** OPEN20 F3. The only transition from an unapproved candidate to a reviewed plan. */
import { z } from "zod";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import { evaluatePlausibilityCandidate, type ResolvedRuleSet } from "@/domain/running/planning/build";
import type { PlanRequest, PlanResult } from "@/domain/running/planning/schema";
import { evaluateFindingConfirmation, requiredConfirmationCodes } from "@/domain/running/planning/confirmation";
import { canonicalPlausibilityIssueIdentity } from "@/domain/running/plausibility/review";
import { appliedPlausibilityReviewSchema, plausibilityReviewRequestSchema,
  type AppliedPlausibilityReview, type PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import { isoDateTimeSchema } from "@/domain/running/types/primitives";
import { buildPlausibilityIssueDigest, buildPlausibilityIssueFromFinding, validatePlausibilityReviewRequest } from "./running-plausibility-review";

export const plausibilityReviewRequestsSchema = z.array(plausibilityReviewRequestSchema).max(50)
  .refine((reviews) => new Set(reviews.map((review) => review.issueDigest)).size === reviews.length, "Duplicate review request");

export type ReviewedPlan = {
  result: PlanResult;
  issues: PlausibilityIssue[];
  reviews: AppliedPlausibilityReview[];
  reviewError?: "REVIEW_REQUIRED" | "REVIEW_INVALID";
};

export function evaluateReviewedRunningPlan(input: {
  request: PlanRequest;
  resolved: ResolvedRuleSet;
  subjectIdentity: string;
  itemIdentity: string;
  requests?: unknown;
  storedReviews?: readonly unknown[];
}): ReviewedPlan {
  // Always plan first, including on a retry containing review requests.
  const candidate = evaluatePlausibilityCandidate(input.request, input.resolved);
  const prescription = candidate.status === "OK" || candidate.status === "REVIEW_CANDIDATE" ? candidate.prescription : undefined;
  const findings = prescription ? [...prescription.findings, ...("sessionFindings" in candidate ? candidate.sessionFindings : [])] :
    "findings" in candidate ? candidate.findings : [];
  const planningContext = { request: input.request, subjectIdentity: input.subjectIdentity, itemIdentity: input.itemIdentity,
    ...(prescription ? { prescription } : {}) };
  const bindings = findings.map((finding) => ({ finding, issue: buildPlausibilityIssueFromFinding({
    finding, resolvedRuleSet: input.resolved, planningContext,
  }) }));
  const issues = bindings.flatMap(({ issue }) => issue ? [issue] : []).sort((a, b) => a.issueDigest.localeCompare(b.issueDigest));
  const fail = (reviewError?: ReviewedPlan["reviewError"]): ReviewedPlan => ({
    result: candidate.status === "INELIGIBLE" ? candidate : { status: "BLOCKED", findings,
      ...(candidate.status === "BLOCKED" && candidate.confirmationRequired ? { confirmationRequired: candidate.confirmationRequired } : {}) },
    issues, reviews: [], ...(reviewError ? { reviewError } : {}),
  });
  const requests = plausibilityReviewRequestsSchema.safeParse(input.requests ?? []);
  const stored = z.array(appliedPlausibilityReviewSchema).max(50).safeParse(input.storedReviews ?? []);
  if (!requests.success || !stored.success || new Set(issues.map((issue) => issue.issueDigest)).size !== issues.length) return fail("REVIEW_INVALID");
  if (input.request.actor.kind !== "COACH" && (requests.data.length > 0 || stored.data.length > 0)) return fail("REVIEW_INVALID");
  if (new Set(stored.data.map((review) => review.issueDigest)).size !== stored.data.length ||
      stored.data.some((review) => buildPlausibilityIssueDigest(review) !== review.issueDigest)) return fail("REVIEW_INVALID");

  // Stored, self-consistent reviews remain active only for the exact current issue.
  // No history ledger: disappeared / stale reviews are omitted from the next save.
  const active = new Map<string, AppliedPlausibilityReview>();
  for (const review of stored.data) {
    const issue = issues.find((current) => current.issueDigest === review.issueDigest);
    if (issue && canonicalStringify(canonicalPlausibilityIssueIdentity(issue)) === canonicalStringify(canonicalPlausibilityIssueIdentity(review))) {
      active.set(review.issueDigest, review);
    }
  }
  for (const request of requests.data) {
    if (input.request.actor.kind !== "COACH") return fail("REVIEW_INVALID");
    const validation = validatePlausibilityReviewRequest({
      request, currentIssues: issues, resolvedRuleSet: input.resolved, planningContext,
      actor: input.request.actor, at: isoDateTimeSchema.parse(new Date().toISOString()),
    });
    if (!validation.ok) return fail("REVIEW_INVALID");
    // Re-submission of the same current review does not duplicate or rewrite the audit record.
    if (!active.has(request.issueDigest)) active.set(request.issueDigest, validation.appliedReview);
  }
  const unsatisfied = bindings.filter(({ finding, issue }) => finding.severity === "BLOCK" && (!issue || !active.has(issue.issueDigest)));
  if (unsatisfied.length > 0) return fail(unsatisfied.some(({ issue }) => issue !== null) ? "REVIEW_REQUIRED" : undefined);
  if (!prescription || !("sessionFindings" in candidate)) return fail();
  const required = requiredConfirmationCodes(findings);
  const confirmation = evaluateFindingConfirmation(required, input.request.confirmedFindingCodes ?? []);
  if (confirmation.kind === "CONFIRMATION_REQUIRED" || confirmation.kind === "CONFIRMATION_STATE_STALE") return {
    result: { status: "BLOCKED", findings, confirmationRequired: { requiredFindingCodes: required } }, issues, reviews: [],
  };
  return {
    result: { status: "OK", prescription, sessionFindings: candidate.sessionFindings },
    issues, reviews: [...active.values()].sort((a, b) => a.issueDigest.localeCompare(b.issueDigest)),
  };
}
