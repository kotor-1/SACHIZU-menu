/** Mixed menus only: legacy F12 reviews authorize this Session creation, never a v2 conversion. */
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { checkLegacyItemPlausibility } from "@/domain/running/plausibility/output";
import { plausibilityIssueDraftFromFinding } from "@/domain/running/plausibility/review";
import type { LegacyItemSummary } from "@/domain/running/aggregation/schema";
import { legacyDistanceInterval } from "@/domain/running/aggregation/legacyAdapter";
import type { RunningMenuContext } from "@/domain/running/persistence/menuContext";
import { appliedPlausibilityReviewSchema, type PlausibilityIssue, type AppliedPlausibilityReview } from "@/domain/running/types/plausibilityReview";
import type { CoachActor } from "@/domain/running/types/actor";
import type { Finding } from "@/domain/running/types/findings";
import type { ResolvedPlausibilityReviewRuleSet } from "./running-plausibility-review";
import { buildPlausibilityIssueDigest } from "./running-plausibility-review";
import { plausibilityReviewRequestsSchema } from "./running-review-runtime";

export function evaluateLegacySessionReviews(input: {
  menuId: string; sessionDate: string; context: RunningMenuContext; sourceMenuFingerprint: string;
  items: readonly { id: string; summary: LegacyItemSummary }[];
  resolved: ResolvedPlausibilityReviewRuleSet; requests?: unknown; actor: CoachActor;
}) {
  const bindings: { itemId: string; finding: Finding; issue: PlausibilityIssue | null }[] = [];
  for (const item of input.items) {
    const contextDigest = sha256Utf8Hex(canonicalStringify({
      kind: "LEGACY_SESSION_ONLY", menuId: input.menuId, itemId: item.id, sessionDate: input.sessionDate,
      original: item.summary, interval: legacyDistanceInterval(item.summary), context: input.context,
      sourceMenuFingerprint: input.sourceMenuFingerprint,
    }));
    for (const finding of checkLegacyItemPlausibility(item.summary, input.resolved.ruleSet).findings) {
      const rules = input.resolved.ruleSet.plausibility.filter((rule) => rule.ruleId === finding.plausibility?.ruleId && rule.outputTarget === "ITEM_TOTAL_DISTANCE");
      const draft = rules.length === 1 ? plausibilityIssueDraftFromFinding({ finding, rule: rules[0]!, contextDigest,
        ruleSet: { version: input.resolved.ruleSet.ruleSetVersion, contentHash: input.resolved.contentHash },
      }) : null;
      bindings.push({ itemId: item.id, finding, issue: draft ? { ...draft, issueDigest: buildPlausibilityIssueDigest(draft) } : null });
    }
  }
  const issues = bindings.flatMap(({ issue }) => issue ? [issue] : []);
  const reviews: { menuItemId: string; review: AppliedPlausibilityReview }[] = [];
  const requests = plausibilityReviewRequestsSchema.safeParse(input.requests ?? []);
  if (!requests.success) return { valid: false, issues, reviews, findings: bindings.map((b) => b.finding) };
  for (const request of requests.data) {
    const matching = bindings.filter(({ issue }) => issue?.issueDigest === request.issueDigest);
    if (matching.length !== 1) return { valid: false, issues, reviews: [], findings: bindings.map((b) => b.finding) };
    const binding = matching[0]!;
    const parsed = appliedPlausibilityReviewSchema.safeParse({ ...binding.issue, reason: request.reason,
      confirmedTwice: request.firstConfirmed && request.secondConfirmed, actor: input.actor, at: new Date().toISOString() });
    if (!parsed.success) return { valid: false, issues, reviews: [], findings: bindings.map((b) => b.finding) };
    reviews.push({ menuItemId: binding.itemId, review: parsed.data });
  }
  const satisfied = new Set(reviews.map(({ review }) => review.issueDigest));
  const remaining = bindings.filter(({ finding, issue }) => finding.severity === "BLOCK" && (!issue || !satisfied.has(issue.issueDigest)));
  return { valid: remaining.length === 0, issues, reviews,
    // Preserve the original finding in the snapshot, but satisfied blockers do not gate Session creation.
    findings: bindings.map((b) => b.finding), gateFindings: bindings.filter(({ issue }) => !issue || !satisfied.has(issue.issueDigest)).map((b) => b.finding) };
}
