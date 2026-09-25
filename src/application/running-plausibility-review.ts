/** Application boundary for building and validating server-owned plausibility reviews. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import {
  buildPlausibilityReviewContext as buildCanonicalPlausibilityReviewContext,
  canonicalHeightPointRecordIdentity,
  canonicalPlausibilityIssueIdentity,
  canonicalPlausibilityReviewContext,
  canonicalTimedMarkRecordIdentity,
  isReviewablePlausibilityPolicy,
  plausibilityIssueDraftFromFinding,
  plausibilityIssueMatchesCurrentRule,
  type PlausibilityReviewPlanningInput,
} from "@/domain/running/plausibility/review";
import { selectHeightHistoryForGrowth, type HeightHistoryPoint } from "@/domain/running/context/maturity";
import { checkOutputPlausibility } from "@/domain/running/plausibility/output";
import { planWithResolvedRuleSet } from "@/domain/running/planning/build";
import { planRequestSchema } from "@/domain/running/planning/schema";
import type { PlausibilityRule, RuleSet } from "@/domain/running/rules/schema";
import { appliedPlausibilityReviewSchema, plausibilityIssueSchema, plausibilityReviewRequestSchema, sha256DigestSchema,
  type AppliedPlausibilityReview, type PlausibilityIssue, type PlausibilityReviewContext,
} from "@/domain/running/types/plausibilityReview";
import { coachActorSchema, type CoachActor } from "@/domain/running/types/actor";
import type { Finding } from "@/domain/running/types/findings";
import { isoDateTimeSchema, type IsoDateTime } from "@/domain/running/types/primitives";
import type { TimedMark } from "@/domain/running/types/intensity";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";

export type ResolvedPlausibilityReviewRuleSet = { ruleSet: RuleSet; contentHash: string };

const planningInputEnvelopeSchema = z.object({
  request: z.unknown(),
  subjectIdentity: z.string().trim().min(1).max(256),
  itemIdentity: z.string().trim().min(1).max(256),
  prescription: z.unknown().optional(),
}).strict();

function parsePlanningInput(input: unknown): PlausibilityReviewPlanningInput | null {
  const envelope = planningInputEnvelopeSchema.safeParse(input);
  if (!envelope.success) return null;
  const request = planRequestSchema.safeParse(envelope.data.request);
  if (!request.success) return null;
  // PlanRequest rejects duplicate edit fields and override targets before these become
  // canonical sets (FIELD targets are unique by field, even across different layers).
  const prescription = envelope.data.prescription === undefined ? undefined : runningPrescriptionSchema.safeParse(envelope.data.prescription);
  if (prescription && (!prescription.success || prescription.data.method !== request.data.selection.method ||
      prescription.data.templateId !== request.data.selection.templateId)) return null;
  const parsed: PlausibilityReviewPlanningInput = {
    request: request.data,
    subjectIdentity: envelope.data.subjectIdentity,
    itemIdentity: envelope.data.itemIdentity,
    ...(prescription?.success ? { prescription: prescription.data } : {}),
  };
  // Nested legacy interval schemas permit some non-finite values. A review must fail closed,
  // not throw out of the validator or silently serialize Infinity/NaN as null.
  try {
    buildCanonicalPlausibilityReviewContext(parsed);
    return parsed;
  } catch {
    return null;
  }
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

function ruleSetIdentity(resolved: ResolvedPlausibilityReviewRuleSet) {
  return { version: resolved.ruleSet.ruleSetVersion, contentHash: resolved.contentHash };
}

export function buildPlausibilityReviewContext(planningInput: unknown): PlausibilityReviewContext {
  const parsed = parsePlanningInput(planningInput);
  if (!parsed) throw new Error("A complete validated planning context is required");
  return buildCanonicalPlausibilityReviewContext(parsed);
}

/** Only a full PlanRequest plus server-derived logical identities can be digested. */
export function buildPlausibilityReviewContextDigest(planningInput: unknown): string {
  const context = buildPlausibilityReviewContext(planningInput);
  return sha256Canonical(canonicalPlausibilityReviewContext(context));
}

export function buildTimedMarkRecordDigest(mark: TimedMark, subjectIdentity: string): string {
  return sha256Canonical(canonicalTimedMarkRecordIdentity({
    subjectIdentity,
    event: mark.event,
    date: mark.date,
    timeS: mark.timeS,
    timing: mark.timing,
    videoFps: mark.videoFps ?? null,
    wind: mark.wind ?? null,
    startType: mark.startType ?? null,
    surface: mark.surface ?? null,
    spikes: mark.spikes ?? null,
  }));
}

export function buildHeightPointRecordDigest(input: {
  point: HeightHistoryPoint;
  subjectIdentity: string;
  memberIdentity?: string;
}): string {
  return sha256Canonical(canonicalHeightPointRecordIdentity({
    subjectIdentity: input.subjectIdentity,
    memberIdentity: input.memberIdentity ?? null,
    date: input.point.date,
    heightCm: input.point.heightCm,
  }));
}

export function buildPlausibilityIssueDigest(issue: Omit<PlausibilityIssue, "issueDigest"> | PlausibilityIssue): string {
  return sha256Canonical(canonicalPlausibilityIssueIdentity(issue));
}

function equalTimedMark(left: TimedMark, right: TimedMark): boolean {
  return left.event === right.event && left.date === right.date && left.timeS === right.timeS &&
    left.timing === right.timing && (left.videoFps ?? null) === (right.videoFps ?? null) &&
    (left.wind ?? null) === (right.wind ?? null) && (left.startType ?? null) === (right.startType ?? null) &&
    (left.surface ?? null) === (right.surface ?? null) && (left.spikes ?? null) === (right.spikes ?? null);
}

/** Resolve only the exact record identity retained by the server-produced finding. */
function recordMatchesFinding(
  finding: Finding,
  rule: PlausibilityRule,
  context: PlausibilityReviewContext,
  planningInput: PlausibilityReviewPlanningInput,
): string | undefined | null {
  if (rule.scope !== "INPUT" || rule.inputTarget === null) return undefined;
  const source = finding.plausibility?.sourceRecord;
  if (rule.inputTarget.kind === "TIMED_MARK") {
    if (source?.kind !== "TIMED_MARK" || context.subject.kind !== "ATHLETE" || planningInput.request.subject.kind !== "ATHLETE") return null;
    const candidates = planningInput.request.subject.profile.marks.filter((mark) => equalTimedMark(mark, source.record));
    if (candidates.length !== 1) return null;
    const mark = candidates[0]!;
    const value = finding.value;
    if (
      mark.date > planningInput.request.planningDate || mark.event !== rule.inputTarget.event ||
      finding.metric !== `selected.${mark.event}@${mark.date}` || value === undefined || value.unit !== "s" ||
      value.lower !== mark.timeS || value.upper !== mark.timeS
    ) return null;
    return buildTimedMarkRecordDigest(mark, context.subject.identity);
  }
  if (rule.inputTarget.kind === "HEIGHT_CM") {
    if (source?.kind !== "HEIGHT_POINT" || source.date > planningInput.request.planningDate) return null;
    const value = finding.value;
    if (value === undefined || value.unit !== "cm" || value.lower !== source.heightCm || value.upper !== source.heightCm) return null;

    let point: HeightHistoryPoint | undefined;
    let expectedMetric: string;
    if (planningInput.request.subject.kind === "ATHLETE") {
      if (source.memberIdentity !== null || context.subject.kind !== "ATHLETE") return null;
      const history = planningInput.request.subject.profile.maturity.heightHistory ?? [];
      const matches = history.filter((candidate) => candidate.date === source.date && candidate.heightCm === source.heightCm);
      const selected = selectHeightHistoryForGrowth(history, planningInput.request.planningDate).endpoints;
      if (matches.length !== 1 || !selected.some((candidate) => candidate.date === source.date && candidate.heightCm === source.heightCm)) return null;
      point = matches[0];
      expectedMetric = `athlete.height@${source.date}`;
    } else {
      if (source.memberIdentity === null || context.subject.kind !== "GROUP") return null;
      const members = planningInput.request.subject.profile.members.filter((member) => member.memberId === source.memberIdentity);
      if (members.length !== 1) return null;
      const history = members[0]!.maturity.heightHistory ?? [];
      const matches = history.filter((candidate) => candidate.date === source.date && candidate.heightCm === source.heightCm);
      const selected = selectHeightHistoryForGrowth(history, planningInput.request.planningDate).endpoints;
      if (matches.length !== 1 || !selected.some((candidate) => candidate.date === source.date && candidate.heightCm === source.heightCm)) return null;
      point = matches[0];
      const memberIndex = planningInput.request.subject.profile.members.findIndex((member) => member.memberId === source.memberIdentity);
      expectedMetric = `members[${memberIndex}].height@${source.date}`;
    }
    if (finding.metric !== expectedMetric || !point) return null;
    return buildHeightPointRecordDigest({
      point,
      subjectIdentity: context.subject.identity,
      ...(source.memberIdentity !== null ? { memberIdentity: source.memberIdentity } : {}),
    });
  }
  if (rule.inputTarget.kind === "COACH_EDIT_APPROACH_DISTANCE_M") {
    if (source !== undefined || finding.metric !== "coachEdits.approachDistanceM" || finding.value?.unit !== "m") return null;
    const edits = planningInput.request.coachEdits.filter((edit) => edit.field === "approachDistanceM" &&
      edit.value === finding.value?.lower && finding.value?.lower === finding.value?.upper);
    return edits.length === 1 ? undefined : null;
  }
  return null;
}

function sameReviewFinding(candidate: Finding, finding: Finding): boolean {
  return (
    candidate.code === finding.code && candidate.severity === finding.severity && candidate.scope === finding.scope &&
    candidate.metric === finding.metric && candidate.value?.lower === finding.value?.lower &&
    candidate.value?.upper === finding.value?.upper && candidate.value?.unit === finding.value?.unit &&
    candidate.value?.source === finding.value?.source && candidate.value?.confidence === finding.value?.confidence &&
    candidate.plausibility?.ruleId === finding.plausibility?.ruleId &&
    candidate.plausibility?.policy === finding.plausibility?.policy &&
    candidate.plausibility?.certainty === finding.plausibility?.certainty &&
    candidate.plausibility?.boundary?.side === finding.plausibility?.boundary?.side &&
    candidate.plausibility?.boundary?.threshold === finding.plausibility?.boundary?.threshold &&
    canonicalStringify(candidate.plausibility?.sourceRecord ?? null) === canonicalStringify(finding.plausibility?.sourceRecord ?? null)
  );
}

/** Re-use the planner's selection policy; presence in the mark list alone does not mean selected. */
function currentInputFindings(planningInput: PlausibilityReviewPlanningInput, resolved: ResolvedPlausibilityReviewRuleSet): readonly Finding[] {
  const result = planWithResolvedRuleSet(planningInput.request, { ...resolved, isDraftFallback: resolved.ruleSet.status === "DRAFT" });
  return result.status === "OK" ? result.prescription.findings : result.findings;
}

/** Build a digest-bearing issue only from a current server finding and full current planning state. */
export function buildPlausibilityIssueFromFinding(input: {
  finding: Finding;
  resolvedRuleSet: ResolvedPlausibilityReviewRuleSet;
  planningContext: unknown;
}): PlausibilityIssue | null {
  const planningInput = parsePlanningInput(input.planningContext);
  if (!planningInput) return null;
  const context = buildCanonicalPlausibilityReviewContext(planningInput);
  const { finding, resolvedRuleSet } = input;
  const ruleId = finding.plausibility?.ruleId;
  if (!ruleId) return null;
  const matchingRules = resolvedRuleSet.ruleSet.plausibility.filter((candidate) => candidate.ruleId === ruleId);
  if (matchingRules.length !== 1) return null;
  const rule = matchingRules[0]!;
  if (rule.appliesToMethods !== null && !rule.appliesToMethods.includes(context.selection.method)) return null;
  if (!isReviewablePlausibilityPolicy(finding.plausibility?.policy ?? "")) return null;
  if (planningInput.prescription && (
    planningInput.prescription.ruleSet.version !== resolvedRuleSet.ruleSet.ruleSetVersion ||
    planningInput.prescription.ruleSet.contentHash !== resolvedRuleSet.contentHash
  )) return null;
  const currentFindings = rule.scope === "INPUT"
    ? currentInputFindings(planningInput, resolvedRuleSet)
    : planningInput.prescription ? checkOutputPlausibility(planningInput.prescription, resolvedRuleSet.ruleSet).findings : [];
  if (currentFindings.filter((candidate) => sameReviewFinding(candidate, finding)).length !== 1) return null;
  const recordDigest = recordMatchesFinding(finding, rule, context, planningInput);
  if (recordDigest === null) return null;
  const contextDigest = sha256Canonical(canonicalPlausibilityReviewContext(context));
  const draft = plausibilityIssueDraftFromFinding({
    finding,
    rule,
    ruleSet: ruleSetIdentity(resolvedRuleSet),
    contextDigest,
    ...(typeof recordDigest === "string" ? { recordDigest } : {}),
  });
  if (draft === null) return null;
  const issueDigest = buildPlausibilityIssueDigest(draft);
  const parsedIssue = plausibilityIssueSchema.safeParse({ ...draft, issueDigest });
  return parsedIssue.success ? parsedIssue.data : null;
}

/** Build issues and sort by digest so planner finding order cannot affect review order. */
export function buildPlausibilityIssuesFromFindings(input: {
  findings: readonly Finding[];
  resolvedRuleSet: ResolvedPlausibilityReviewRuleSet;
  planningContext: unknown;
}): PlausibilityIssue[] {
  const issues: PlausibilityIssue[] = [];
  for (const finding of input.findings) {
    const issue = buildPlausibilityIssueFromFinding({
      finding,
      resolvedRuleSet: input.resolvedRuleSet,
      planningContext: input.planningContext,
    });
    if (issue) issues.push(issue);
  }
  return issues.sort((left, right) => left.issueDigest < right.issueDigest ? -1 : left.issueDigest > right.issueDigest ? 1 : 0);
}

export type PlausibilityReviewValidationCode =
  | "INVALID_REQUEST"
  | "INVALID_SERVER_CONTEXT"
  | "ISSUE_NOT_CURRENT"
  | "ISSUE_AMBIGUOUS"
  | "ISSUE_NOT_REVIEWABLE"
  | "SERVER_ACTOR_INVALID"
  | "SERVER_TIME_INVALID";

export type PlausibilityReviewValidationResult =
  | { ok: true; appliedReview: AppliedPlausibilityReview }
  | { ok: false; code: PlausibilityReviewValidationCode };

/** Re-check current server-calculated issue identity; actor/time are server-only arguments. */
export function validatePlausibilityReviewRequest(input: {
  currentIssues: readonly unknown[];
  request: unknown;
  resolvedRuleSet: ResolvedPlausibilityReviewRuleSet;
  planningContext: unknown;
  actor: CoachActor;
  at: IsoDateTime;
}): PlausibilityReviewValidationResult {
  const request = plausibilityReviewRequestSchema.safeParse(input.request);
  if (!request.success) return { ok: false, code: "INVALID_REQUEST" };
  const planningInput = parsePlanningInput(input.planningContext);
  if (!planningInput) return { ok: false, code: "INVALID_SERVER_CONTEXT" };
  const actor = coachActorSchema.safeParse(input.actor);
  if (!actor.success) return { ok: false, code: "SERVER_ACTOR_INVALID" };
  const at = isoDateTimeSchema.safeParse(input.at);
  if (!at.success) return { ok: false, code: "SERVER_TIME_INVALID" };
  const ruleSetIdentityCurrent = ruleSetIdentity(input.resolvedRuleSet);
  if (!sha256DigestSchema.safeParse(ruleSetIdentityCurrent.contentHash).success) return { ok: false, code: "INVALID_SERVER_CONTEXT" };

  const issues = input.currentIssues.map((issue) => plausibilityIssueSchema.safeParse(issue));
  if (issues.some((issue) => !issue.success)) return { ok: false, code: "INVALID_SERVER_CONTEXT" };
  const currentIssues = issues.map((issue) => issue.success ? issue.data : null).filter((issue): issue is PlausibilityIssue => issue !== null);
  const matching = currentIssues.filter((issue) => issue.issueDigest === request.data.issueDigest);
  if (matching.length === 0) return { ok: false, code: "ISSUE_NOT_CURRENT" };
  if (matching.length !== 1) return { ok: false, code: "ISSUE_AMBIGUOUS" };

  const issue = matching[0]!;
  const context = buildCanonicalPlausibilityReviewContext(planningInput);
  const expectedContextDigest = sha256Canonical(canonicalPlausibilityReviewContext(context));
  const recomputedIssueDigest = buildPlausibilityIssueDigest(issue);
  const rules = input.resolvedRuleSet.ruleSet.plausibility.filter((rule) => rule.ruleId === issue.ruleId);
  const issueRule = rules[0];
  if (
    issue.issueDigest !== recomputedIssueDigest || issue.contextDigest !== expectedContextDigest || rules.length !== 1 ||
    (issueRule !== undefined && !isReviewablePlausibilityPolicy(issueRule.boundaryPolicies[issue.boundary.side === "MIN" ? "min" : "max"] ?? "")) ||
    (issueRule !== undefined && issueRule.scope !== "INPUT" && !planningInput.prescription) ||
    (issueRule !== undefined && !plausibilityIssueMatchesCurrentRule(issue, issueRule, ruleSetIdentityCurrent))
  ) return { ok: false, code: "ISSUE_NOT_REVIEWABLE" };

  {
    const regenerated = buildPlausibilityIssuesFromFindings({
      findings: issueRule?.scope === "INPUT" ? currentInputFindings(planningInput, input.resolvedRuleSet)
        : planningInput.prescription ? checkOutputPlausibility(planningInput.prescription, input.resolvedRuleSet.ruleSet).findings : [],
      resolvedRuleSet: input.resolvedRuleSet,
      planningContext: input.planningContext,
    });
    if (regenerated.filter((candidate) => candidate.issueDigest === issue.issueDigest).length !== 1) {
      return { ok: false, code: "ISSUE_NOT_REVIEWABLE" };
    }
  }

  const applied = appliedPlausibilityReviewSchema.safeParse({
    ...issue,
    reason: request.data.reason,
    confirmedTwice: true,
    actor: actor.data,
    at: at.data,
  });
  if (!applied.success) return { ok: false, code: "INVALID_SERVER_CONTEXT" };
  return { ok: true, appliedReview: applied.data };
}
