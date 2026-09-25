import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { buildSessionPlanningEvaluation } from "@/actions/_session-planning-service";
import { createSessionFromMenu } from "@/infra/repositories/session-repository";
import { createRunningMenuItem, saveMenuRunningContext } from "@/infra/repositories/running-item-repository";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { PlanningEvaluationStaleError, planningSnapshotSchema } from "@/domain/running/persistence/sessionSnapshot";
import type { PlausibilityIssue, PlausibilityReviewRequest } from "@/domain/running/types/plausibilityReview";
import * as loader from "@/domain/running/rules/loader";
import { isoDateSchema } from "@/domain/running/types/primitives";
import { makeMenuWithBlock, planAcc, persistInputFor } from "../../repository/running/fixtures";
import { resetDb, makeExercise } from "../../helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((url: string) => { throw new Error(`redirect:${url}`); }) }));
const { createSessionFromMenuAction } = await import("@/actions/session-actions");
const reason = "コーチが元の本数と距離区間を二回確認して今回の実施を承認しました";
const approve = (issues: readonly PlausibilityIssue[]): PlausibilityReviewRequest[] => issues.map((issue) => ({ issueDigest: issue.issueDigest, reason, firstConfirmed: true, secondConfirmed: true }));
const context = { schemaVersion: 1, subject: { kind: "GROUP", label: "group", members: [], allowAdvancedMethods: false }, plannedDate: "2026-09-20", plannedAt: null, availableMinutes: null };
async function mixed() {
  const { menu, block } = await makeMenuWithBlock();
  await saveMenuRunningContext(menu.id, JSON.stringify(context));
  await createRunningMenuItem(block.id, persistInputFor(planAcc()));
  const exercise = await makeExercise({ category: "SPRINT" });
  const legacy = await prisma.menuItem.create({ data: { menuBlockId: block.id, exerciseId: exercise.id, sets: 1, reps: 11, distanceMeters: 1000, sortOrder: 1 } });
  return { menu, block, legacy };
}
const evaluate = (id: string, plausibilityReviewRequests?: PlausibilityReviewRequest[], date = "2026-09-20") => buildSessionPlanningEvaluation({ menuTemplateId: id, date, plausibilityReviewRequests });
const sessionInput = (id: string) => sessionFromMenuSchema.parse({ menuTemplateId: id, date: "2026-09-20" });
async function requestsFor(id: string) {
  const initial = await evaluate(id);
  expect(initial.kind, JSON.stringify(initial)).toBe("REJECT");
  if (initial.kind !== "REJECT" || !initial.reviewIssues?.length) throw new Error("issues missing");
  expect(initial.reviewIssues.every((issue) => issue.ruleId === "PLA_ITEM_TOTAL_DISTANCE")).toBe(true);
  return approve(initial.reviewIssues);
}
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("F3 mixed legacy/v2 Session-only F12", () => {
  it("no approval blocks; current Session-level review succeeds without converting legacy", async () => {
    const { menu, legacy } = await mixed();
    const requests = await requestsFor(menu.id);
    expect(await prisma.trainingSession.count()).toBe(0);
    const decision = await evaluate(menu.id, requests);
    expect(decision.kind, JSON.stringify(decision)).toBe("EVALUATED");
    if (decision.kind !== "EVALUATED") throw new Error("blocked");
    const saved = await createSessionFromMenu(sessionInput(menu.id), decision.evaluation);
    const snapshot = planningSnapshotSchema.parse(JSON.parse(saved.planningSnapshotJson!));
    expect(snapshot.legacyPlausibilityReviews).toEqual([expect.objectContaining({ menuItemId: legacy.id, review: expect.objectContaining({ issueDigest: requests[0]!.issueDigest, actor: { kind: "COACH", ownerId: "default-coach" } }) })]);
    const legacySnapshot = await prisma.sessionItem.findFirstOrThrow({ where: { trainingSessionId: saved.id, prescriptionKind: "LEGACY" } });
    expect(legacySnapshot.plannedProvenanceJson).toBeNull();
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: legacy.id } })).prescriptionKind).toBe("LEGACY");
    // The Menu has no active legacy exception: every new Session requires a request.
    expect((await evaluate(menu.id)).kind).toBe("REJECT");
  });
  it.each(["item", "quantity", "interval", "menu", "RuleSet", "date"])("%s substitution rejects the old review", async (attack) => {
    const { menu, block, legacy } = await mixed();
    const requests = await requestsFor(menu.id);
    let target = menu.id; let date = "2026-09-20";
    if (attack === "item") { await prisma.menuItem.delete({ where: { id: legacy.id } }); const { id: _id, ...data } = legacy; void _id; await prisma.menuItem.create({ data: { ...data, menuBlockId: block.id } }); }
    if (attack === "quantity") await prisma.menuItem.update({ where: { id: legacy.id }, data: { reps: 12 } });
    if (attack === "interval") await prisma.menuItem.update({ where: { id: legacy.id }, data: { sets: null } });
    if (attack === "menu") target = (await mixed()).menu.id;
    if (attack === "date") date = "2026-09-21";
    if (attack === "RuleSet") { const active = loader.getActiveRuleSet(isoDateSchema.parse(date)); vi.spyOn(loader, "getActiveRuleSet").mockReturnValue({ ...active, contentHash: "b".repeat(64) }); }
    expect((await evaluate(target, requests, date)).kind).toBe("REJECT");
    expect(await prisma.trainingSession.count()).toBe(0); expect(await prisma.sessionItem.count()).toBe(0);
  });
  it("duplicate and partial legacy reviews remain blocked", async () => {
    const { menu, block, legacy } = await mixed();
    const { id: _id, ...data } = legacy; void _id;
    await prisma.menuItem.create({ data: { ...data, menuBlockId: block.id, sortOrder: 2 } });
    const requests = await requestsFor(menu.id);
    expect(requests).toHaveLength(2);
    expect((await evaluate(menu.id, requests.slice(0, 1))).kind).toBe("REJECT");
    expect((await evaluate(menu.id, [requests[0]!, requests[0]!])).kind).toBe("REJECT");
  });
  it("legacy source swap after evaluation rolls back before Session/SessionItem writes", async () => {
    const { menu, legacy } = await mixed();
    const decision = await evaluate(menu.id, await requestsFor(menu.id));
    if (decision.kind !== "EVALUATED") throw new Error(JSON.stringify(decision));
    await prisma.menuItem.update({ where: { id: legacy.id }, data: { reps: 12 } });
    await expect(createSessionFromMenu(sessionInput(menu.id), decision.evaluation)).rejects.toBeInstanceOf(PlanningEvaluationStaleError);
    expect(await prisma.trainingSession.count()).toBe(0); expect(await prisma.sessionItem.count()).toBe(0);
  });
  it("legacy-only menus are SKIP, and irrelevant review submission is rejected", async () => {
    const { menu, block } = await makeMenuWithBlock();
    const exercise = await makeExercise({ category: "SPRINT" });
    await prisma.menuItem.create({ data: { menuBlockId: block.id, exerciseId: exercise.id, sets: 1, reps: 11, distanceMeters: 1000, sortOrder: 0 } });
    expect(await evaluate(menu.id)).toEqual({ kind: "SKIP" });
    expect((await evaluate(menu.id, [{ issueDigest: "a".repeat(64), reason, firstConfirmed: true, secondConfirmed: true }])).kind).toBe("REJECT");
  });
  it("Action returns current review issues and rejects client actor/time", async () => {
    const { menu } = await mixed();
    const fd = new FormData(); fd.set("menuTemplateId", menu.id); fd.set("date", "2026-09-20");
    const first = await createSessionFromMenuAction(null, fd);
    expect(first).toMatchObject({ ok: false, kind: "REJECTED", reviewIssues: [expect.objectContaining({ ruleId: "PLA_ITEM_TOTAL_DISTANCE" })] });
    const requests = await requestsFor(menu.id);
    fd.set("plausibilityReviewsJson", JSON.stringify([{ ...requests[0], actor: { kind: "COACH", ownerId: "forged" } }]));
    expect(await createSessionFromMenuAction(null, fd)).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expect(await prisma.trainingSession.count()).toBe(0);
  });
});
