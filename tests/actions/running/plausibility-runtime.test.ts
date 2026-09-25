import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { saveMenuRunningContext, findRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { buildSessionPlanningEvaluation } from "@/actions/_session-planning-service";
import { createSessionFromMenu } from "@/infra/repositories/session-repository";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { planningSnapshotSchema, PlanningEvaluationStaleError } from "@/domain/running/persistence/sessionSnapshot";
import { getActiveRuleSet } from "@/domain/running/rules/loader";
import * as loader from "@/domain/running/rules/loader";
import type { PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import { resetDb } from "../../helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { planRunningItemAction, editRunningItemAction, overrideRunningItemAction } = await import("@/actions/running-actions");
const reason = "コーチが数値と対象者と実施条件を確認して承認しました";
const context = () => ({ schemaVersion: 1, subject: { kind: "GROUP", label: "グループ", members: [{ ageBandOverride: "U18", maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: "2026-09-01" }, trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" }, primaryEvent: "400m" }], allowAdvancedMethods: true }, plannedDate: "2026-09-20", plannedAt: null, availableMinutes: null });
function form(values: Record<string, string | string[]>) { const fd = new FormData(); for (const [key, value] of Object.entries(values)) { for (const entry of Array.isArray(value) ? value : [value]) fd.append(key, entry); } return fd; }
const approve = (issues: readonly PlausibilityIssue[]) => issues.map((issue) => ({ issueDigest: issue.issueDigest, reason, firstConfirmed: true, secondConfirmed: true }));
function fields(reps = 31, sets = 1) {
  return { method: "TEMPO_EXTENSIVE", templateId: "TE_100", positionPreference: "", confirmedFindingCodes: "PLAUSIBILITY_REQUIRE_CONFIRMATION", fieldOverridesJson: JSON.stringify(Object.entries({ sets, repsPerSet: reps, sessionVolumeM: sets * reps * 100 }).map(([field, newValue]) => ({ field, newValue, layer: "COACH_EDITABLE", reason, confirmedTwice: true }))) };
}
async function menu() { const m = await prisma.menuTemplate.create({ data: { name: "F3", blocks: { create: { name: "主運動", sortOrder: 0 } } }, include: { blocks: true } }); await saveMenuRunningContext(m.id, JSON.stringify(context())); return { menuId: m.id, blockId: m.blocks[0]!.id }; }
const plan = (m: Awaited<ReturnType<typeof menu>>, values: Record<string, string | string[]> = fields()) => planRunningItemAction(m.menuId, m.blockId, null, form(values));
function issuesOf(result: import("@/actions/running-actions").RunningActionResult<unknown>) {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: false, kind: "PLAN_BLOCKED", reviewError: "REVIEW_REQUIRED" });
  if (result.ok || result.kind !== "PLAN_BLOCKED" || !result.reviewIssues?.length) throw new Error(JSON.stringify(result));
  return result.reviewIssues;
}
async function savedItem(m: Awaited<ReturnType<typeof menu>>) {
  const issues = issuesOf(await plan(m));
  const saved = await plan(m, { ...fields(), plausibilityReviewsJson: JSON.stringify(approve(issues)) });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  if (!saved.ok) throw new Error("not saved");
  return saved.data.id;
}
const row = (id: string) => prisma.menuItem.findUniqueOrThrow({ where: { id } });
const evaluateSession = (menuId: string) => buildSessionPlanningEvaluation({ menuTemplateId: menuId, date: "2026-09-20" });
const sessionInput = (menuId: string) => sessionFromMenuSchema.parse({ menuTemplateId: menuId, date: "2026-09-20" });
beforeEach(async () => { vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"); await resetDb(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("F3 coach actions, persistence and Session boundary", () => {
  it("new-create no review is DB0; current coach review saves exactly once", async () => {
    const m = await menu();
    const issues = issuesOf(await plan(m));
    expect(await prisma.menuItem.count()).toBe(0);
    const id = await savedItem(m);
    expect(await prisma.menuItem.count()).toBe(1);
    const saved = await findRunningMenuItem(id);
    expect(saved?.status).toBe("VALID");
    if (saved?.status !== "VALID") throw new Error("invalid");
    expect(saved.provenance.plausibilityReviews).toEqual([expect.objectContaining({ issueDigest: issues[0]!.issueDigest, reason, confirmedTwice: true, actor: { kind: "COACH", ownerId: "default-coach" }, at: expect.any(String) })]);
  });
  it.each(["forged", "short reason", "single confirmation", "client actor", "client time", "duplicate", "extra issue"])("new-create %s is DB0", async (attack) => {
    const m = await menu();
    const requests: Record<string, unknown>[] = approve(issuesOf(await plan(m)));
    if (attack === "forged") requests[0]!.issueDigest = "f".repeat(64);
    if (attack === "short reason") requests[0]!.reason = "short";
    if (attack === "single confirmation") requests[0]!.secondConfirmed = false;
    if (attack === "client actor") requests[0]!.actor = { kind: "COACH", ownerId: "attacker" };
    if (attack === "client time") requests[0]!.at = "2000-01-01T00:00:00Z";
    if (attack === "duplicate") requests.push({ ...requests[0] });
    if (attack === "extra issue") requests.push({ ...requests[0], issueDigest: "a".repeat(64) });
    expect((await plan(m, { ...fields(), plausibilityReviewsJson: JSON.stringify(requests) })).ok).toBe(false);
    expect(await prisma.menuItem.count()).toBe(0);
  });
  it("stale values, cross-menu and cross-item requests cannot save", async () => {
    const a = await menu(); const b = await menu();
    const reviews = JSON.stringify(approve(issuesOf(await plan(a))));
    expect((await plan(a, { ...fields(32), plausibilityReviewsJson: reviews })).ok).toBe(false);
    expect((await plan(b, { ...fields(), plausibilityReviewsJson: reviews })).ok).toBe(false);
    await savedItem(a);
    expect((await plan(a, { ...fields(), plausibilityReviewsJson: reviews })).ok).toBe(false);
    expect(await prisma.menuItem.count()).toBe(1);
  });
  it("multiple current issues require all reviews, with other confirmations independently checked", async () => {
    const m = await menu();
    const base = fields(31, 3);
    const initial = issuesOf(await plan(m, base));
    expect(initial.length).toBeGreaterThan(1);
    expect((await plan(m, { ...base, plausibilityReviewsJson: JSON.stringify(approve(initial.slice(0, 1))) })).ok).toBe(false);
    expect(await prisma.menuItem.count()).toBe(0);
  });
  it("FIELD override alone and review alone cannot satisfy each other's gate", async () => {
    const m = await menu();
    const issues = issuesOf(await plan(m));
    const reviews = JSON.stringify(approve(issues));
    const noOverride = { method: "TEMPO_EXTENSIVE", templateId: "TE_100", positionPreference: "", coachEditsJson: JSON.stringify([{ field: "repsPerSet", value: 31, unit: "reps" }]), plausibilityReviewsJson: reviews };
    expect((await plan(m, noOverride)).ok).toBe(false);
    expect(await prisma.menuItem.count()).toBe(0);
  });
  it("edit failure preserves prescription, provenance and history; valid edit replaces active review", async () => {
    const m = await menu(); const id = await savedItem(m); const before = await row(id);
    const edit = { confirmedFindingCodes: "PLAUSIBILITY_REQUIRE_CONFIRMATION", itemId: id, field: "repRestS", value: "100" };
    const first = await editRunningItemAction(m.menuId, null, form(edit));
    const issues = issuesOf(first);
    expect(await row(id)).toEqual(before);
    const old = JSON.parse(before.provenanceJson!).plausibilityReviews;
    expect((await editRunningItemAction(m.menuId, null, form({ ...edit, plausibilityReviewsJson: JSON.stringify(approve(old)) }))).ok).toBe(false);
    expect(await row(id)).toEqual(before);
    const success = await editRunningItemAction(m.menuId, null, form({ ...edit, plausibilityReviewsJson: JSON.stringify(approve(issues)) }));
    expect(success.ok, JSON.stringify(success)).toBe(true);
    const after = await row(id); const p = JSON.parse(after.provenanceJson!);
    expect(p.plausibilityReviews).toHaveLength(1);
    expect(p.plausibilityReviews[0].issueDigest).not.toBe(old[0].issueDigest);
    expect(p.coachEdits).toEqual([expect.objectContaining({ field: "repRestS", to: 100 })]);
    // Same exact material context survives reload and replan without another request.
    const repeat = await editRunningItemAction(m.menuId, null, form(edit));
    expect(repeat.ok, JSON.stringify(repeat)).toBe(true);
    expect(JSON.parse((await row(id)).provenanceJson!).plausibilityReviews).toEqual(p.plausibilityReviews);
  });
  it("a new reviewable edit through FIELD override has no writes until approved", async () => {
    const m = await menu(); const id = await savedItem(m); const before = await row(id);
    const edit = { confirmedFindingCodes: "PLAUSIBILITY_REQUIRE_CONFIRMATION", itemId: id, targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "3601", reason, confirmedTwice: "true" };
    const initial = await overrideRunningItemAction(m.menuId, null, form(edit));
    const issues = issuesOf(initial);
    expect(issues.map((i) => i.ruleId)).toContain("PLA_REP_REST_S");
    expect(await row(id)).toEqual(before);
    const success = await overrideRunningItemAction(m.menuId, null, form({ ...edit, plausibilityReviewsJson: JSON.stringify(approve(issues)) }));
    expect(success.ok, JSON.stringify(success)).toBe(true);
  });
  it("another hard blocker after a valid review leaves edit and all history unchanged", async () => {
    const m = await menu(); const id = await savedItem(m); const before = await row(id);
    const reviews = JSON.parse(before.provenanceJson!).plausibilityReviews;
    const blocked = await overrideRunningItemAction(m.menuId, null, form({ itemId: id, targetKind: "FIELD", field: "repDistanceM", layer: "COACH_EDITABLE", newValue: "1001", reason, confirmedTwice: "true", plausibilityReviewsJson: JSON.stringify(approve(reviews)) }));
    expect(blocked.ok).toBe(false); expect(await row(id)).toEqual(before);
  });
  it("tampered stored review fails before edit and before Session creation", async () => {
    const m = await menu(); const id = await savedItem(m);
    const p = JSON.parse((await row(id)).provenanceJson!); p.plausibilityReviews[0].boundary.threshold++;
    await prisma.menuItem.update({ where: { id }, data: { provenanceJson: JSON.stringify(p) } });
    const before = await row(id);
    expect((await editRunningItemAction(m.menuId, null, form({ itemId: id, field: "repRestS", value: "100" }))).ok).toBe(false);
    expect((await evaluateSession(m.menuId)).kind).toBe("REJECT"); expect(await row(id)).toEqual(before);
    expect(await prisma.trainingSession.count()).toBe(0);
  });
  it("unchanged valid review creates immutable prescription and review snapshots", async () => {
    const m = await menu(); const id = await savedItem(m); const before = await row(id);
    const decision = await evaluateSession(m.menuId);
    expect(decision.kind, JSON.stringify(decision)).toBe("EVALUATED");
    if (decision.kind !== "EVALUATED") throw new Error("blocked");
    const session = await createSessionFromMenu(sessionInput(m.menuId), decision.evaluation);
    const item = await prisma.sessionItem.findFirstOrThrow({ where: { trainingSessionId: session.id } });
    expect(item.plannedPrescriptionJson).toBe(before.prescriptionJson);
    expect(item.plannedProvenanceJson).toBe(before.provenanceJson);
    const snapshot = planningSnapshotSchema.parse(JSON.parse(session.planningSnapshotJson!));
    expect(snapshot.reviewedItemIds).toEqual([id]);
    await saveMenuRunningContext(m.menuId, JSON.stringify({ ...context(), plannedDate: "2026-09-21" }));
    expect((await prisma.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).plannedProvenanceJson).toBe(before.provenanceJson);
  });
  it.each(["provenance", "prescription", "context"])("TOCTOU %s mutation causes Session rows = 0", async (attack) => {
    const m = await menu(); const id = await savedItem(m); const before = await row(id);
    const decision = await evaluateSession(m.menuId);
    expect(decision.kind, JSON.stringify(decision)).toBe("EVALUATED");
    if (decision.kind !== "EVALUATED") throw new Error("blocked");
    if (attack === "provenance") { const p = JSON.parse(before.provenanceJson!); p.plausibilityReviews[0].reason = "別の理由へ内容を差し替えて検出するテストです"; await prisma.menuItem.update({ where: { id }, data: { provenanceJson: JSON.stringify(p) } }); }
    if (attack === "prescription") await prisma.menuItem.update({ where: { id }, data: { prescriptionJson: before.prescriptionJson! + " " } });
    if (attack === "context") await saveMenuRunningContext(m.menuId, JSON.stringify({ ...context(), availableMinutes: 45 }));
    await expect(createSessionFromMenu(sessionInput(m.menuId), decision.evaluation)).rejects.toBeInstanceOf(PlanningEvaluationStaleError);
    expect(await prisma.trainingSession.count()).toBe(0); expect(await prisma.sessionItem.count()).toBe(0);
  });
  it("stale context / RuleSet and omitted evaluation cannot create a reviewed Session", async () => {
    const m = await menu(); const id = await savedItem(m);
    await expect(createSessionFromMenu(sessionInput(m.menuId))).rejects.toBeInstanceOf(PlanningEvaluationStaleError);
    await saveMenuRunningContext(m.menuId, JSON.stringify({ ...context(), availableMinutes: 45 }));
    expect((await evaluateSession(m.menuId)).kind).toBe("REJECT");
    await saveMenuRunningContext(m.menuId, JSON.stringify(context()));
    const active = getActiveRuleSet("2026-09-20" as Parameters<typeof getActiveRuleSet>[0]);
    vi.spyOn(loader, "getActiveRuleSet").mockReturnValue({ ...active, contentHash: "a".repeat(64) });
    expect((await evaluateSession(m.menuId)).kind).toBe("REJECT");
    expect(await prisma.trainingSession.count()).toBe(0); expect(await row(id)).toBeDefined();
  });
});
