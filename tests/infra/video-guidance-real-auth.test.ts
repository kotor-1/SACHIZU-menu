import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadVideoGuidanceReview, submitVideoGuidanceReview, type GuidanceReviewDependencies } from "@/application/menu-composition/video-guidance-review";
import type { SourceBinding } from "@/domain/exercise/video-guidance-persistence";
import { createVideoGuidanceIdentity } from "@/infra/auth/video-guidance-identity";
import { createGuidanceSourceRepository } from "@/infra/repositories/video-guidance-source-repository";
import { guidanceHash, VideoGuidanceRepository, type GuidanceMutationResult } from "@/infra/repositories/video-guidance-repository";
import { createGuidanceAuthFixture, fixtureAuthBaseURL, fixtureAuthPassword, fixtureAuthUser } from "../fixtures/guidance-auth";
import {
  createPersistenceDatabaseTemplate, persistenceAssessments, persistenceBinding, persistenceExercise,
  persistenceNow, persistenceObservation, persistenceOwner, persistencePayload,
} from "../fixtures/video-guidance-persistence";

// Only Next's request wiring/cache is replaced. Authentication, password login,
// session lookup, authorization, application service and SQLite writes are real.
const framework = vi.hoisted(() => ({ dependencies: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/actions/_video-guidance-review-runtime", () => ({ getVideoGuidanceReviewDependencies: framework.dependencies }));
vi.mock("next/cache", () => ({ revalidatePath: framework.revalidate }));
import { videoGuidanceReviewAction } from "@/actions/video-guidance-review-actions";

let template: Awaited<ReturnType<typeof createPersistenceDatabaseTemplate>>;
let db: PrismaClient;
let auth: ReturnType<typeof createGuidanceAuthFixture>;
let repository: VideoGuidanceRepository;
let deps: GuidanceReviewDependencies;
let currentBinding: SourceBinding | null;
let sequence = 0;
const scope = { ownerId: persistenceOwner, exerciseId: persistenceExercise };
const deniedScope = { ownerId: "guidance-owner-b", exerciseId: "guidance-exercise-other-owner" };

function command(candidate: GuidanceMutationResult, operation = "HOLD") {
  return { ...scope, operation, operationKey: `real-auth-review-${++sequence}`, reason: "実セッションのコーチによる確認",
    candidateRevisionId: candidate.revisionId, expectedRowVersion: candidate.head.rowVersion,
    expectedApprovedRevisionId: candidate.head.approvedRevisionId, expectedSourceBindingHash: guidanceHash(persistenceBinding) };
}
async function candidate(partial = false) {
  return repository.appendAiCandidate({
    ...scope, operationKey: `real-auth-ai-${++sequence}`, reason: "Offline isolated candidate", actor: { id: null, kind: "AI" },
    sourceBinding: persistenceBinding, aiMetadata: null, provenance: { source: "isolated auth integration fixture" },
    payload: partial ? { ...persistencePayload, countingUnit: "CUSTOM", bilateralCounting: "UNRESOLVED: 左右は未確定" } : persistencePayload,
    fieldAssessment: persistenceAssessments.map((field) => partial && ["countingUnit", "bilateralCounting"].includes(field.field)
      ? { ...field, state: "UNRESOLVED" as const } : field),
  });
}
function form(payload: unknown) {
  const input = new FormData(); input.set("payload", JSON.stringify(payload)); return input;
}
async function state() {
  return {
    revisions: await db.exerciseVideoGuidanceRevision.findMany({ orderBy: { id: "asc" } }),
    audits: await db.videoGuidanceAuditEvent.findMany({ orderBy: { id: "asc" } }),
    heads: await db.exerciseVideoGuidanceHead.findMany({ orderBy: { exerciseId: "asc" } }),
  };
}
async function login(permissions: readonly string[] = ["VIEW_VIDEO_GUIDANCE", "REVIEW_VIDEO_GUIDANCE", "PUBLISH_VIDEO_GUIDANCE"]) {
  await auth.grant(fixtureAuthUser.id, persistenceOwner, permissions);
  await auth.signIn();
}
const rejectsCode = (result: Promise<unknown>, code: string) => expect(result).rejects.toMatchObject({ code });

beforeAll(async () => { template = await createPersistenceDatabaseTemplate(); }, 90_000);
beforeEach(async () => {
  vi.clearAllMocks();
  db = await template.open();
  auth = createGuidanceAuthFixture(db);
  await auth.bootstrapUser();
  currentBinding = { ...persistenceBinding };
  repository = new VideoGuidanceRepository(db, async () => currentBinding, () => persistenceNow);
  deps = { identity: auth.identity, sources: createGuidanceSourceRepository(db), repository };
  framework.dependencies.mockReturnValue(deps);
});
afterEach(async () => { vi.restoreAllMocks(); await db?.$disconnect(); });
afterAll(async () => { await template?.dispose(); });

describe("Real Better Auth session and video-guidance integration (isolated SQLite)", () => {
  it("keeps public signup closed and issues a real persisted session only after fixture credentials authenticate", async () => {
    const signup = await auth.request("/sign-up/email", { name: "Public visitor", email: "visitor@example.test", password: fixtureAuthPassword });
    expect(signup.ok).toBe(false);
    expect(await db.user.count()).toBe(1);
    expect(await db.session.count()).toBe(0);
    const invalid = await auth.request("/sign-in/email", { email: fixtureAuthUser.email, password: "incorrect-fixture-password" });
    expect(invalid.ok).toBe(false);
    expect(await db.session.count()).toBe(0);
    await login();
    const session = await db.session.findFirstOrThrow();
    expect(session.userId).toBe(fixtureAuthUser.id);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const response = await auth.request("/get-session");
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ user: { id: fixtureAuthUser.id }, session: { id: session.id, userId: fixtureAuthUser.id } });
    expect(await auth.identity.currentIdentity()).toMatchObject({ actorId: fixtureAuthUser.id, ownerIds: [persistenceOwner] });
    expect((await auth.identity.currentIdentity())?.actorId).not.toBe(persistenceOwner);
  });

  it.each(["absent", "invalid", "expired", "deleted", "revoked", "signed-out", "deleted-user"] as const)(
    "denies %s sessions before reading guidance or adding audits", async (kind) => {
      const initial = await candidate();
      await login();
      const issuedCookie = auth.cookie();
      if (kind === "absent") auth.setCookie("");
      if (kind === "invalid") auth.setCookie(issuedCookie.replace(/(session_token=)[^;]+/, "$1invalid-signature"));
      if (kind === "expired") await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
      if (kind === "deleted") await db.session.deleteMany();
      if (kind === "revoked") {
        const session = await db.session.findFirstOrThrow();
        expect((await auth.request("/revoke-session", { token: session.token })).ok).toBe(true);
      }
      if (kind === "signed-out") {
        await auth.signOut();
        // Replaying the original signed cookie must not resurrect the deleted session.
        auth.setCookie(issuedCookie);
      }
      if (kind === "deleted-user") await db.user.delete({ where: { id: fixtureAuthUser.id } });
      const before = await state();
      const lookup = vi.spyOn(deps.sources, "findExercise");
      expect(await auth.identity.currentIdentity()).toBeNull();
      expect(await (await auth.request("/get-session")).json()).toBeNull();
      await rejectsCode(loadVideoGuidanceReview(scope, deps), "UNAUTHENTICATED");
      await rejectsCode(submitVideoGuidanceReview(command(initial), deps), "UNAUTHENTICATED");
      expect(lookup).not.toHaveBeenCalled();
      expect(await state()).toEqual(before);
    },
  );

  it("reads the authorized owner and rejects foreign owner/exercise identifiers with the same real session", async () => {
    const initial = await candidate();
    await login();
    expect((await loadVideoGuidanceReview(scope, deps)).exercise.id).toBe(persistenceExercise);
    const before = await state();
    await rejectsCode(loadVideoGuidanceReview(deniedScope, deps), "FORBIDDEN");
    await rejectsCode(loadVideoGuidanceReview({ ...scope, exerciseId: deniedScope.exerciseId }, deps), "FORBIDDEN");
    await rejectsCode(submitVideoGuidanceReview({ ...command(initial), ...deniedScope }, deps), "FORBIDDEN");
    await rejectsCode(submitVideoGuidanceReview({ ...command(initial), exerciseId: "guidance-exercise-b" }, deps), "CROSS_BOUNDARY");
    expect(await state()).toEqual(before);
  });

  it("denies a separately authenticated user with no owner grant", async () => {
    const initial = await candidate();
    await auth.grant(fixtureAuthUser.id, persistenceOwner);
    const otherUser = { id: "real-session-coach-b", name: "Unassigned coach", email: "unassigned-coach@example.test" };
    await auth.bootstrapUser(otherUser);
    await auth.signIn(otherUser.email);
    expect(await auth.identity.currentIdentity()).toMatchObject({ actorId: otherUser.id, ownerIds: [], ownerPermissions: [] });
    const before = await state();
    const lookup = vi.spyOn(deps.sources, "findExercise");
    await rejectsCode(loadVideoGuidanceReview(scope, deps), "FORBIDDEN");
    const input = { ...command(initial, "APPROVE"), observation: persistenceObservation, resolutions: [] };
    expect(await videoGuidanceReviewAction(null, form(input))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(lookup).not.toHaveBeenCalled();
    expect(framework.revalidate).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it("ignores forged identity and grant headers while recording the signed session user", async () => {
    const initial = await candidate();
    await login();
    const forgedHeaders = auth.headers();
    forgedHeaders.set("x-user-id", "forged-coach");
    forgedHeaders.set("x-actor-id", "forged-coach");
    forgedHeaders.set("x-reviewer-actor-id", "forged-coach");
    forgedHeaders.set("x-owner-id", deniedScope.ownerId);
    forgedHeaders.set("x-guidance-permissions", "VIEW_VIDEO_GUIDANCE,REVIEW_VIDEO_GUIDANCE,PUBLISH_VIDEO_GUIDANCE");
    const identity = createVideoGuidanceIdentity({ auth: auth.auth, db, headers: async () => new Headers(forgedHeaders) });
    expect(await identity.currentIdentity()).toMatchObject({ actorId: fixtureAuthUser.id, ownerIds: [persistenceOwner] });
    const input = command(initial);
    await submitVideoGuidanceReview(input, { ...deps, identity });
    expect(await db.videoGuidanceAuditEvent.findFirstOrThrow({ where: { operationKey: input.operationKey } }))
      .toMatchObject({ actorId: fixtureAuthUser.id, actorKind: "COACH" });
    await rejectsCode(loadVideoGuidanceReview(deniedScope, { ...deps, identity }), "FORBIDDEN");
    forgedHeaders.delete("cookie");
    expect(await identity.currentIdentity()).toBeNull();
  });

  it("rejects the first approval when a previously loaded page's session has since been revoked", async () => {
    const initial = await candidate();
    await login();
    const page = await loadVideoGuidanceReview(scope, deps);
    expect(page.review.candidate?.revisionId).toBe(initial.revisionId);
    const input = { ...command(initial, "APPROVE"), observation: persistenceObservation, resolutions: [] };
    const before = await state();
    const session = await db.session.findFirstOrThrow();
    expect((await auth.request("/revoke-session", { token: session.token })).ok).toBe(true);
    expect(await videoGuidanceReviewAction(null, form(input))).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    expect(framework.revalidate).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it("rejects external-origin sign-in and sign-out through Better Auth's default CSRF checks", async () => {
    const externalRequest = (path: string, body: unknown, cookie?: string) => auth.auth.handler(new Request(
      `${fixtureAuthBaseURL}/api/auth${path}`, {
        method: "POST",
        headers: { origin: "https://external-origin.example.test", "content-type": "application/json",
          "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      },
    ));
    const deniedLogin = await externalRequest("/sign-in/email", { email: fixtureAuthUser.email, password: fixtureAuthPassword });
    expect(deniedLogin.status).toBe(403);
    expect(await db.session.count()).toBe(0);
    await login();
    const issuedSession = await db.session.findFirstOrThrow();
    const deniedLogout = await externalRequest("/sign-out", {}, auth.cookie());
    expect(deniedLogout.status).toBe(403);
    expect(await db.session.findUnique({ where: { id: issuedSession.id } })).not.toBeNull();
    expect((await auth.identity.currentIdentity())?.actorId).toBe(fixtureAuthUser.id);
  });

  it("does not combine one owner's view grant with a different owner's review/publish grant", async () => {
    const initial = await candidate();
    await login(["VIEW_VIDEO_GUIDANCE"]);
    await auth.grant(fixtureAuthUser.id, deniedScope.ownerId, ["REVIEW_VIDEO_GUIDANCE", "PUBLISH_VIDEO_GUIDANCE"]);
    expect((await loadVideoGuidanceReview(scope, deps)).exercise.id).toBe(persistenceExercise);
    const before = await state();
    await rejectsCode(loadVideoGuidanceReview(deniedScope, deps), "FORBIDDEN");
    for (const operation of ["HOLD", "REJECT", "PUBLISH_AI"]) {
      await rejectsCode(submitVideoGuidanceReview(command(initial, operation), deps), "FORBIDDEN");
    }
    await rejectsCode(submitVideoGuidanceReview({ ...command(initial, "APPROVE"), observation: persistenceObservation, resolutions: [] }, deps), "FORBIDDEN");
    expect(await state()).toEqual(before);
  });

  it("requires the distinct publish grant and applies grant revocation to the next request with the same cookie", async () => {
    const initial = await candidate();
    await login(["VIEW_VIDEO_GUIDANCE", "REVIEW_VIDEO_GUIDANCE"]);
    const deniedBefore = await state();
    await rejectsCode(submitVideoGuidanceReview(command(initial, "PUBLISH_AI"), deps), "FORBIDDEN");
    expect(await state()).toEqual(deniedBefore);
    await auth.grant(fixtureAuthUser.id, persistenceOwner, ["PUBLISH_VIDEO_GUIDANCE"]);
    const published = await submitVideoGuidanceReview(command(initial, "PUBLISH_AI"), deps);
    expect(published.head.activeAiRevisionId).toBe(initial.revisionId);
    expect(published.head.approvedRevisionId).toBeNull();
    expect(published.guidance.videoAnalysisStatus).toBe("AI_ANALYZED");
    const publishedAudit = await db.videoGuidanceAuditEvent.findFirstOrThrow({ where: { operation: "PUBLISH_AI_CANDIDATE" } });
    expect(publishedAudit.actorId).toBe(fixtureAuthUser.id);
    const before = await state();
    await db.guidanceOwnerAccess.deleteMany({ where: { userId: fixtureAuthUser.id } });
    expect((await auth.identity.currentIdentity())?.actorId).toBe(fixtureAuthUser.id);
    await rejectsCode(loadVideoGuidanceReview(scope, deps), "FORBIDDEN");
    await rejectsCode(submitVideoGuidanceReview(command(published), deps), "FORBIDDEN");
    expect(await state()).toEqual(before);
  });

  it("rejects forged actor, owner authority and form identifiers without trusting the authenticated browser", async () => {
    const initial = await candidate();
    await login();
    const before = await state();
    for (const extra of [
      { reviewerActorId: "forged-coach" }, { actor: { id: "forged-coach", kind: "COACH" } },
      { ownerIds: [deniedScope.ownerId] }, { permissions: ["PUBLISH_VIDEO_GUIDANCE"] },
      { videoAnalysisStatus: "COACH_REVIEWED" },
    ]) {
      expect(await videoGuidanceReviewAction(null, form({ ...command(initial), ...extra }))).toMatchObject({ ok: false, code: "INVALID_REVIEW" });
    }
    for (const key of ["reviewerActorId", "ownerId", "actorId"]) {
      const forged = form(command(initial)); forged.set(key, "forged-value");
      expect(await videoGuidanceReviewAction(null, forged)).toMatchObject({ ok: false, code: "INVALID_REVIEW" });
    }
    expect(framework.revalidate).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it("approves edited observations through the real-session action and records the authenticated actor and unchanged AI original", async () => {
    const initial = await candidate();
    await login();
    const observation = { ...persistenceObservation, executionSummary: "コーチが修正した着地の説明", keyCues: ["着地の姿勢を確認する"] };
    const input = { ...command(initial, "APPROVE"), observation, resolutions: [] };
    expect(await videoGuidanceReviewAction(null, form(input))).toMatchObject({ ok: true });
    expect(framework.revalidate).toHaveBeenCalledWith(`/video-guidance/${persistenceOwner}/${persistenceExercise}`);
    const page = await loadVideoGuidanceReview(scope, deps);
    expect(page.review.effective).toMatchObject({ reviewerActorId: fixtureAuthUser.id, reviewerIdentity: "COACH",
      guidance: { ...observation, videoAnalysisStatus: "COACH_REVIEWED" } });
    expect(page.review.aiOriginal).toMatchObject({ revisionId: initial.revisionId, guidance: persistencePayload });
    const audit = await db.videoGuidanceAuditEvent.findFirstOrThrow({ where: { operationKey: input.operationKey } });
    expect(audit).toMatchObject({ actorId: fixtureAuthUser.id, actorKind: "COACH", operation: "REVIEW_AND_ACTIVATE", reason: input.reason });
    expect(JSON.parse(audit.afterJson).approvedRevisionId).toBe(page.review.effective?.revisionId);
  });

  it.each(["HOLD", "REJECT"] as const)("records an authorized %s decision with the real session user", async (operation) => {
    const initial = await candidate();
    await login(["VIEW_VIDEO_GUIDANCE", "REVIEW_VIDEO_GUIDANCE"]);
    const input = command(initial, operation);
    await submitVideoGuidanceReview(input, deps);
    const page = await loadVideoGuidanceReview(scope, deps);
    expect(page.review.candidateDecision).toBe(operation === "HOLD" ? "HELD" : "REJECTED");
    expect(page.review.head.approvedRevisionId).toBeNull();
    expect(page.review.candidate?.guidance).toEqual(persistencePayload);
    expect(await db.videoGuidanceAuditEvent.findFirstOrThrow({ where: { operationKey: input.operationKey } }))
      .toMatchObject({ actorId: fixtureAuthUser.id, actorKind: "COACH", operation: `${operation}_CANDIDATE` });
  });

  it("preserves idempotency and stale-head checks and reauthenticates a replay after logout", async () => {
    const initial = await candidate();
    await login();
    const input = { ...command(initial, "APPROVE"), observation: persistenceObservation, resolutions: [] };
    const approved = await submitVideoGuidanceReview(input, deps);
    const before = await state();
    expect(await submitVideoGuidanceReview(input, deps)).toMatchObject({ revisionId: approved.revisionId, reused: true });
    await rejectsCode(submitVideoGuidanceReview({ ...input, reason: "Different operation reusing the same key" }, deps), "OPERATION_KEY_CONFLICT");
    await rejectsCode(submitVideoGuidanceReview(command(initial), deps), "STALE_VIDEO_GUIDANCE");
    expect(await state()).toEqual(before);
    const oldCookie = auth.cookie();
    await auth.signOut();
    auth.setCookie(oldCookie);
    await rejectsCode(submitVideoGuidanceReview(input, deps), "UNAUTHENTICATED");
    expect(await state()).toEqual(before);
  });

  it("rejects a changed submitted source hash or changed media manifest despite a live authorized session", async () => {
    const initial = await candidate();
    await login();
    const before = await state();
    await rejectsCode(submitVideoGuidanceReview({ ...command(initial), expectedSourceBindingHash: "f".repeat(64) }, deps), "SOURCE_MISMATCH");
    currentBinding = { ...persistenceBinding, contentSha256: "e".repeat(64) };
    await rejectsCode(submitVideoGuidanceReview(command(initial), deps), "SOURCE_MISMATCH");
    expect(await state()).toEqual(before);
  });

  it("keeps E-style unresolved evidence unapproved until every unknown has a revised value and explicit resolution", async () => {
    const initial = await candidate(true);
    await login();
    const before = await state();
    const input = { ...command(initial, "APPROVE"), observation: persistenceObservation };
    await rejectsCode(submitVideoGuidanceReview({ ...input, resolutions: [] }, deps), "UNRESOLVED_FIELDS");
    const resolutions = [
      { field: "countingUnit", state: "KNOWN", reason: "コーチの明示決定：片側の1跳躍を1回" },
      { field: "bilateralCounting", state: "KNOWN", reason: "コーチの明示決定：片側完了後に反対側" },
    ];
    await rejectsCode(submitVideoGuidanceReview({ ...input, resolutions: resolutions.slice(0, 1) }, deps), "UNRESOLVED_FIELDS");
    await rejectsCode(submitVideoGuidanceReview({ ...input, resolutions,
      observation: { ...persistenceObservation, countingUnit: "CUSTOM", bilateralCounting: "UNRESOLVED: 左右は未確定" } }, deps), "UNRESOLVED_FIELDS");
    expect(await state()).toEqual(before);
    const approved = await submitVideoGuidanceReview({ ...input, resolutions }, deps);
    expect(approved.guidance.videoAnalysisStatus).toBe("COACH_REVIEWED");
    expect(approved.fieldAssessment.filter((field) => field.state === "UNRESOLVED")).toHaveLength(0);
    expect((await loadVideoGuidanceReview(scope, deps)).review.effective?.reviewerActorId).toBe(fixtureAuthUser.id);
  });

  it("preserves an unknown legacy reviewer while identifying a later real-session reviewer", async () => {
    const imported = await repository.importLegacy({
      ...scope, operationKey: `real-auth-import-${++sequence}`, reason: "Historical fixture without reviewer evidence", actor: { id: null, kind: "IMPORT" },
      sourceBinding: persistenceBinding, payload: { ...persistencePayload, videoAnalysisStatus: "COACH_REVIEWED", coachReviewedAt: persistenceNow.toISOString() },
      fieldAssessment: persistenceAssessments, aiMetadata: null, provenance: { source: "legacy fixture", reviewerIdentity: "LEGACY_UNKNOWN" },
      importSourceHash: "c".repeat(64),
    });
    await login();
    expect((await loadVideoGuidanceReview(scope, deps)).review.effective).toMatchObject({ revisionId: imported.revisionId,
      reviewerActorId: null, reviewerIdentity: "LEGACY_UNKNOWN" });
    const next = await candidate();
    await submitVideoGuidanceReview({ ...command(next, "APPROVE"), observation: persistenceObservation, resolutions: [] }, deps);
    const page = await loadVideoGuidanceReview(scope, deps);
    expect(page.review.effective).toMatchObject({ reviewerActorId: fixtureAuthUser.id, reviewerIdentity: "COACH" });
    expect(page.review.previousApproved).toMatchObject({ revisionId: imported.revisionId, reviewerActorId: null, reviewerIdentity: "LEGACY_UNKNOWN" });
    expect(await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: imported.revisionId } })).toMatchObject({ reviewerActorId: null });
  });
});
