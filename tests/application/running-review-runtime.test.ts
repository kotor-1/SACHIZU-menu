import { beforeEach, describe, expect, it } from "vitest";
import { evaluateReviewedRunningPlan } from "@/application/running-review-runtime";
import { getActiveRuleSet } from "@/domain/running/rules/loader";
import { planRequestSchema, type PlanRequest } from "@/domain/running/planning/schema";
import { requiredConfirmationCodes } from "@/domain/running/planning/confirmation";
import { isoDateSchema } from "@/domain/running/types/primitives";
import type { PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import { planRunningPrescriptionWithRuleSet } from "@/domain/running/planning";
import { createRunningMenuItem, findRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { athlete, makeRequest, makeMenuWithBlock, persistInputFor, provenanceFor } from "../repository/running/fixtures";
import { resetDb } from "../helpers";

const resolved = getActiveRuleSet(isoDateSchema.parse("2026-09-15"));
const reason = "コーチが今回の対象と数値を二回確認して承認しました";
const identity = { subjectIdentity: "athlete:17", itemIdentity: "menu:4:item:17" };
const approve = (issue: PlausibilityIssue) => ({ issueDigest: issue.issueDigest, reason, firstConfirmed: true as const, secondConfirmed: true as const });
function request() { return planRequestSchema.parse(makeRequest("TEMPO_EXTENSIVE", "TE_100", { subject: athlete({ marks: [{ event: "FLY20", timeS: 2, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" }] }) })); }
function override(req: PlanRequest, field: string, newValue: number) {
  return { target: { kind: "FIELD", field, layer: "COACH_EDITABLE" }, newValue, reason, confirmedTwice: true, actor: req.actor, at: "2026-09-15T00:00:00.000Z" };
}
function outputRequest(sets: number, reps: number, extra: Record<string, number> = {}) {
  const req = request();
  req.overrides = Object.entries({ sets, repsPerSet: reps, sessionVolumeM: sets * reps * 100, ...extra }).map(([field, value]) => override(req, field, value)) as PlanRequest["overrides"];
  const initial = evaluateReviewedRunningPlan({ request: req, resolved, ...identity });
  const findings = initial.result.status === "OK" ? initial.result.prescription.findings : initial.result.findings;
  req.confirmedFindingCodes = requiredConfirmationCodes(findings);
  return req;
}
function evaluate(req: PlanRequest, options: Partial<Parameters<typeof evaluateReviewedRunningPlan>[0]> = {}) {
  return evaluateReviewedRunningPlan({ request: req, resolved, ...identity, ...options });
}
beforeEach(resetDb);

describe("F3 current runtime evaluation", () => {
  it.each([
    ["F07", "PLA_REPS_PER_SET", 1, 31, {}],
    ["F08", "PLA_SETS", 21, 2, {}],
    ["F09", "PLA_TOTAL_REPS", 9, 9, {}],
    ["F10", "PLA_REP_REST_S", 1, 3, { repRestS: 3601 }],
    ["F11", "PLA_SET_REST_S", 2, 2, { setRestS: 5401 }],
    ["F12", "PLA_ITEM_TOTAL_DISTANCE", 4, 26, {}],
  ] as const)("%s unapproved / valid / forged / stale", async (_label, ruleId, sets, reps, extra) => {
    const req = outputRequest(sets, reps, extra);
    const initial = evaluate(req);
    expect(initial.result.status, JSON.stringify(initial)).toBe("BLOCKED");
    expect(initial.issues.map((issue) => issue.ruleId)).toContain(ruleId);
    const requests = initial.issues.map(approve);
    const accepted = evaluate(req, { requests });
    expect(accepted.result.status, JSON.stringify(accepted)).toBe("OK");
    expect(evaluate(req, { requests: [{ ...requests[0], issueDigest: "f".repeat(64) }] }).result.status).toBe("BLOCKED");
    const changed = structuredClone(req); changed.menuContext.availableMinutes = 40;
    expect(evaluate(changed, { storedReviews: accepted.reviews }).result.status).toBe("BLOCKED");
    expect(evaluate(req, { storedReviews: accepted.reviews }).result.status).toBe("OK");
    const { block } = await makeMenuWithBlock();
    if (accepted.result.status !== "OK") throw new Error("review not accepted");
    const p = accepted.result.prescription;
    const saved = await createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: JSON.stringify({ ...provenanceFor(p), plausibilityReviews: accepted.reviews }) }));
    const reloaded = await findRunningMenuItem(saved.id);
    expect(reloaded?.status).toBe("VALID");
    if (reloaded?.status !== "VALID") throw new Error("invalid save");
    expect(evaluate(req, { storedReviews: reloaded.provenance.plausibilityReviews }).result.status).toBe("OK");
  });

  it("partial approvals and duplicate requests stay blocked", () => {
    const req = outputRequest(3, 31);
    const initial = evaluate(req);
    expect(initial.issues.length).toBeGreaterThan(1);
    expect(evaluate(req, { requests: initial.issues.slice(0, 1).map(approve) }).result.status).toBe("BLOCKED");
    expect(evaluate(req, { requests: [approve(initial.issues[0]!), approve(initial.issues[0]!)] }).reviewError).toBe("REVIEW_INVALID");
  });
  it("duplicate submission preserves exactly one original audit record", () => {
    const req = outputRequest(1, 31);
    const requests = evaluate(req).issues.map(approve);
    const accepted = evaluate(req, { requests });
    const repeated = evaluate(req, { requests, storedReviews: accepted.reviews });
    expect(repeated.reviews).toEqual(accepted.reviews);
    expect(repeated.reviews).toHaveLength(1);
  });
  it("RuleSet mismatch and record self-check reject stale/tampered stored reviews", () => {
    const req = outputRequest(1, 31);
    const accepted = evaluate(req, { requests: evaluate(req).issues.map(approve) });
    const mismatched = { ...resolved, contentHash: "a".repeat(64) };
    expect(evaluate(req, { resolved: mismatched, storedReviews: accepted.reviews }).result.status).toBe("BLOCKED");
    const tampered = structuredClone(accepted.reviews); tampered[0]!.boundary.threshold++;
    expect(evaluate(req, { storedReviews: tampered }).reviewError).toBe("REVIEW_INVALID");
  });
  it("disappeared reviews are removed, and never revived on later recurrence", () => {
    const req = outputRequest(1, 31);
    const accepted = evaluate(req, { requests: evaluate(req).issues.map(approve) });
    const cleared = evaluate(request(), { storedReviews: accepted.reviews });
    expect(cleared.result.status).toBe("OK"); expect(cleared.reviews).toEqual([]);
    expect(evaluate(req, { storedReviews: cleared.reviews }).reviewError).toBe("REVIEW_REQUIRED");
    expect(evaluate(request(), { requests: accepted.reviews.map(approve) }).reviewError).toBe("REVIEW_INVALID");
  });

  it("F15 actual selected Fly10 → MEASURED_VMAX supports review, persistence, and exact replan", async () => {
    const req = request();
    if (req.subject.kind !== "ATHLETE") throw new Error("athlete expected");
    req.subject.profile.marks = [{ event: "FLY10", timeS: 5.1, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" }];
    const initial = evaluate(req);
    expect(initial.issues).toEqual([expect.objectContaining({ ruleId: "PLA_INPUT_FLY_10M", target: expect.objectContaining({ kind: "TIMED_MARK" }) })]);
    const accepted = evaluate(req, { requests: initial.issues.map(approve) });
    expect(accepted.result.status, JSON.stringify(accepted)).toBe("OK");
    if (accepted.result.status !== "OK") throw new Error("blocked");
    expect(accepted.result.prescription.intensity.reference.kind).toBe("MEASURED_VMAX");
    const { block } = await makeMenuWithBlock();
    const p = accepted.result.prescription;
    const saved = await createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: JSON.stringify({ ...provenanceFor(p), plausibilityReviews: accepted.reviews }) }));
    const reload = await findRunningMenuItem(saved.id);
    expect(reload?.status).toBe("VALID");
    expect(evaluate(req, { storedReviews: accepted.reviews }).result.status).toBe("OK");
    req.subject.profile.marks[0]!.timing = "HAND";
    expect(evaluate(req, { storedReviews: accepted.reviews }).result.status).toBe("BLOCKED");
    req.subject.profile.marks[0]!.timeS = 0.49;
    expect(evaluate(req, { requests: initial.issues.map(approve) }).result.status).toBe("BLOCKED");
    expect(evaluate(req).issues).toHaveLength(0);
  });

  it.each([49.9, 260.1])("F16 selected endpoint %s requires a date-aware coach review", async (heightCm) => {
    const req = request(); req.selection = { method: "ACCELERATION", templateId: "ACC_BLOCK_20" };
    if (req.subject.kind !== "ATHLETE") throw new Error("athlete expected");
    req.subject.profile.maturity = { status: "POST", confidence: "HIGH", method: "GROWTH_VELOCITY", assessedAt: req.planningDate,
      heightHistory: [{ date: isoDateSchema.parse("2025-01-01"), heightCm }, { date: isoDateSchema.parse("2026-01-01"), heightCm: 170 }] };
    const initial = evaluate(req);
    expect(initial.issues.some((issue) => issue.ruleId === "PLA_INPUT_HEIGHT")).toBe(true);
    const accepted = evaluate(req, { requests: initial.issues.map(approve) });
    expect(accepted.result.status, JSON.stringify(accepted)).toBe("OK");
    if (accepted.result.status !== "OK") throw new Error("blocked");
    const { block } = await makeMenuWithBlock();
    const p = accepted.result.prescription;
    await createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: JSON.stringify({ ...provenanceFor(p), plausibilityReviews: accepted.reviews }) }));
    req.subject.profile.maturity.heightHistory![0]!.date = isoDateSchema.parse("2025-02-01");
    expect(evaluate(req, { storedReviews: accepted.reviews }).result.status).toBe("BLOCKED");
  });
  it("F16 unused outlier is DATA_QUALITY and future height is never selected", () => {
    const req = request(); req.selection = { method: "ACCELERATION", templateId: "ACC_BLOCK_20" };
    if (req.subject.kind !== "ATHLETE") throw new Error("athlete expected");
    req.subject.profile.maturity.heightHistory = [
      { date: isoDateSchema.parse("2024-01-01"), heightCm: 160 },
      { date: isoDateSchema.parse("2025-01-01"), heightCm: 260.1 },
      { date: isoDateSchema.parse("2026-01-01"), heightCm: 170 },
      { date: isoDateSchema.parse("2027-01-01"), heightCm: 49.9 },
    ];
    const evaluated = evaluate(req);
    expect(evaluated.result.status, JSON.stringify(evaluated)).toBe("OK");
    expect(evaluated.issues).toEqual([]);
    if (evaluated.result.status !== "OK") throw new Error("blocked");
    expect(evaluated.result.prescription.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["INPUT_HEIGHT_DATA_QUALITY", "INPUT_HEIGHT_FUTURE_IGNORED"]));
  });
  it("AI cannot create reviews, overrides or numeric edits, including direct planner paths", () => {
    const req = outputRequest(1, 31);
    const requests = evaluate(req).issues.map(approve);
    const ai = { ...req, actor: { kind: "AI_PLANNER", provider: "TEST", model: "test" } } as unknown as PlanRequest;
    expect(evaluate(ai, { requests }).result.status).toBe("BLOCKED");
    expect(planRunningPrescriptionWithRuleSet(ai, resolved).status).toBe("BLOCKED");
    expect(planRequestSchema.safeParse({ ...ai, plausibilityReviewRequests: requests }).success).toBe(false);
    expect(planRequestSchema.safeParse({ ...ai, overrides: [], coachEdits: [{ field: "repsPerSet", value: 31, unit: "reps" }] }).success).toBe(false);
  });
});
