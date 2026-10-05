import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadVideoGuidanceReview, submitVideoGuidanceReview, type GuidanceReviewDependencies } from "@/application/menu-composition/video-guidance-review";
import type { AuthenticatedGuidanceIdentity } from "@/domain/exercise/video-guidance-review";
import type { SourceBinding } from "@/domain/exercise/video-guidance-persistence";
import { videoGuidanceIdentity } from "@/infra/auth/video-guidance-identity";
import { createGuidanceSourceRepository } from "@/infra/repositories/video-guidance-source-repository";
import { guidanceHash, VideoGuidanceRepository, type GuidanceMutationResult } from "@/infra/repositories/video-guidance-repository";
import {
  createPersistenceDatabaseTemplate, persistenceAssessments, persistenceBinding, persistenceExercise,
  persistenceNow, persistenceObservation, persistenceOwner, persistencePayload,
} from "../fixtures/video-guidance-persistence";

let template: Awaited<ReturnType<typeof createPersistenceDatabaseTemplate>>;
let db: PrismaClient;
let repository: VideoGuidanceRepository;
let sources: ReturnType<typeof createGuidanceSourceRepository>;
let deps: GuidanceReviewDependencies;
let authenticated: AuthenticatedGuidanceIdentity | null;
let currentBinding: SourceBinding | null;
let sequence = 0;
const scope = { ownerId: persistenceOwner, exerciseId: persistenceExercise };
const trustedIdentity: AuthenticatedGuidanceIdentity = {
  actorId: "authenticated-review-coach", ownerIds: [persistenceOwner], permissions: ["REVIEW_VIDEO_GUIDANCE"],
};
const rawCommand = () => ({
  ...scope, operation: "HOLD", operationKey: `app-review-${++sequence}`, reason: "コーチによる明示的な確認",
  candidateRevisionId: "unread-candidate", expectedRowVersion: 0, expectedApprovedRevisionId: null,
  expectedSourceBindingHash: guidanceHash(persistenceBinding),
});
function command(candidate: GuidanceMutationResult, operation = "HOLD") {
  return { ...rawCommand(), operation, candidateRevisionId: candidate.revisionId,
    expectedRowVersion: candidate.head.rowVersion, expectedApprovedRevisionId: candidate.head.approvedRevisionId };
}
async function candidate(partial = false) {
  return repository.appendAiCandidate({
    ...scope, operationKey: `ai-review-${++sequence}`, reason: "Offline AI fixture", actor: { id: null, kind: "AI" },
    sourceBinding: persistenceBinding, aiMetadata: null, provenance: { source: "offline partial-evidence fixture" },
    payload: partial ? { ...persistencePayload, countingUnit: "CUSTOM", bilateralCounting: "UNRESOLVED: 左右は未確定" } : persistencePayload,
    fieldAssessment: persistenceAssessments.map((field) => partial && ["countingUnit", "bilateralCounting"].includes(field.field)
      ? { ...field, state: "UNRESOLVED" as const } : field),
  });
}
const explicitResolutions = [
  { field: "countingUnit", state: "KNOWN", reason: "テスト用の明示決定：片側ごとに数える" },
  { field: "bilateralCounting", state: "KNOWN", reason: "テスト用の明示決定：片側完了後に反対側" },
];
async function writes() {
  return { revisions: await db.exerciseVideoGuidanceRevision.count(), audits: await db.videoGuidanceAuditEvent.count(),
    head: await db.exerciseVideoGuidanceHead.findUnique({ where: { ownerId_exerciseId: scope } }) };
}
const errorCode = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

beforeAll(async () => { template = await createPersistenceDatabaseTemplate(); }, 90_000);
beforeEach(async () => {
  db = await template.open();
  authenticated = trustedIdentity;
  currentBinding = { ...persistenceBinding };
  repository = new VideoGuidanceRepository(db, async () => currentBinding, () => persistenceNow);
  sources = createGuidanceSourceRepository(db);
  deps = { identity: { currentIdentity: vi.fn(async () => authenticated) }, sources, repository };
});
afterEach(async () => { vi.restoreAllMocks(); await db?.$disconnect(); });
afterAll(async () => { await template?.dispose(); });

describe("Authenticated video-guidance application boundary (offline isolated SQLite)", () => {
  it("keeps the disconnected runtime identity closed even for a known owner", async () => {
    expect(await videoGuidanceIdentity.currentIdentity()).toBeNull();
    const lookup = vi.spyOn(sources, "findExercise");
    const read = vi.spyOn(repository, "readReviewRevision");
    const runtimeDeps = { ...deps, identity: videoGuidanceIdentity };
    await errorCode(loadVideoGuidanceReview(scope, runtimeDeps), "UNAUTHENTICATED");
    await errorCode(submitVideoGuidanceReview(rawCommand(), runtimeDeps), "UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(await writes()).toEqual({ revisions: 0, audits: 0, head: null });
  });

  it.each([
    { ...trustedIdentity, actorId: " " },
    { ...trustedIdentity, ownerIds: ["different-owner"] },
    { ...trustedIdentity, permissions: [] },
  ])("rejects an unauthenticated or unauthorized identity before database lookup: %j", async (identity) => {
    authenticated = identity;
    const lookup = vi.spyOn(sources, "findExercise");
    await errorCode(submitVideoGuidanceReview(rawCommand(), deps), identity.actorId.trim() ? "FORBIDDEN" : "UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("verifies the returned exercise owner and ID instead of trusting submitted scope alone", async () => {
    const owned = await sources.findExercise(scope.ownerId, scope.exerciseId);
    if (!owned) throw new Error("Missing isolated fixture");
    const lookup = vi.spyOn(sources, "findExercise");
    const read = vi.spyOn(repository, "readReviewData");
    for (const invalid of [null, { ...owned, ownerId: "different-owner" }, { ...owned, id: "different-exercise" }]) {
      lookup.mockResolvedValueOnce(invalid);
      await errorCode(loadVideoGuidanceReview(scope, deps), "FORBIDDEN");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { reviewerActorId: "forged-coach" },
    { actor: { id: "forged-coach", kind: "COACH" } },
    { videoAnalysisStatus: "COACH_REVIEWED" },
  ])("rejects client-supplied reviewer or authority fields: %j", async (extra) => {
    const lookup = vi.spyOn(sources, "findExercise");
    await errorCode(submitVideoGuidanceReview({ ...rawCommand(), ...extra }, deps), "INVALID_REVIEW");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["HOLD", "REJECT", "PUBLISH_AI", "APPROVE"] as const)("routes %s through the server identity and audited repository operation", async (operation) => {
    const initial = await candidate();
    const input = operation === "APPROVE"
      ? { ...command(initial, operation), observation: persistenceObservation, resolutions: [] }
      : command(initial, operation);
    const result = await submitVideoGuidanceReview(input, deps);
    const audit = await db.videoGuidanceAuditEvent.findFirstOrThrow({ where: { operationKey: input.operationKey } });
    expect(audit).toMatchObject({ actorId: trustedIdentity.actorId, actorKind: "COACH", reason: input.reason });
    const expectedAudit = { HOLD: "HOLD_CANDIDATE", REJECT: "REJECT_CANDIDATE", PUBLISH_AI: "PUBLISH_AI_CANDIDATE", APPROVE: "REVIEW_AND_ACTIVATE" }[operation];
    expect(audit.operation).toBe(expectedAudit);
    const page = await loadVideoGuidanceReview(scope, deps);
    expect(page.exercise.id).toBe(scope.exerciseId);
    if (operation === "APPROVE") {
      expect(page.review.effective).toMatchObject({ reviewerActorId: trustedIdentity.actorId, guidance: { videoAnalysisStatus: "COACH_REVIEWED" } });
    } else {
      expect(result.guidance.videoAnalysisStatus).toBe("AI_ANALYZED");
      expect(result.head.approvedRevisionId).toBeNull();
    }
  });

  it("requires a reason for every operation and rejects incomplete approval payloads", async () => {
    const initial = await candidate();
    const before = await writes();
    await errorCode(submitVideoGuidanceReview({ ...command(initial), reason: " " }, deps), "INVALID_REVIEW");
    await errorCode(submitVideoGuidanceReview(command(initial, "APPROVE"), deps), "INVALID_REVIEW");
    expect(await writes()).toEqual(before);
  });

  it("does not resolve partial evidence through an Approve click, unchanged text, or one missing decision", async () => {
    const initial = await candidate(true);
    const before = await writes();
    const approve = { ...command(initial, "APPROVE"), observation: persistenceObservation };
    await errorCode(submitVideoGuidanceReview({ ...approve, resolutions: [] }, deps), "UNRESOLVED_FIELDS");
    await errorCode(submitVideoGuidanceReview({ ...approve,
      observation: { ...persistenceObservation, countingUnit: "CUSTOM", bilateralCounting: "UNRESOLVED: 左右は未確定" },
      resolutions: explicitResolutions }, deps), "UNRESOLVED_FIELDS");
    await errorCode(submitVideoGuidanceReview({ ...approve, resolutions: explicitResolutions.slice(0, 1) }, deps), "UNRESOLVED_FIELDS");
    expect(await writes()).toEqual(before);
  });

  it("requires distinct explicit resolutions and does not accept decisions for already known fields", async () => {
    const initial = await candidate(true);
    const base = { ...command(initial, "APPROVE"), observation: persistenceObservation };
    await errorCode(submitVideoGuidanceReview({ ...base, resolutions: [explicitResolutions[0], explicitResolutions[0]] }, deps), "INVALID_REVIEW");
    await errorCode(submitVideoGuidanceReview({ ...base, resolutions: [...explicitResolutions,
      { field: "setup", state: "KNOWN", reason: "Already known" }] }, deps), "INVALID_REVIEW");
  });

  it("persists explicit revised values, resolution reasons and trusted reviewer while preserving the partial AI original", async () => {
    const initial = await candidate(true);
    const input = { ...command(initial, "APPROVE"), observation: persistenceObservation, resolutions: explicitResolutions };
    const result = await submitVideoGuidanceReview(input, deps);
    expect(result.guidance).toMatchObject({ videoAnalysisStatus: "COACH_REVIEWED", countingUnit: "PER_SIDE", bilateralCounting: persistenceObservation.bilateralCounting });
    for (const resolution of explicitResolutions) {
      expect(result.fieldAssessment.find((field) => field.field === resolution.field)).toMatchObject({
        state: "KNOWN", reason: resolution.reason, evidenceRefs: expect.arrayContaining([`coach-review:${input.operationKey}`]),
      });
    }
    const stored = await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: result.revisionId } });
    expect(stored.reviewerActorId).toBe(trustedIdentity.actorId);
    expect(JSON.parse(stored.provenanceJson)).toMatchObject({
      baseCandidateRevisionId: initial.revisionId, resolutions: explicitResolutions, sourceBindingHashAtSubmit: input.expectedSourceBindingHash,
    });
    const original = await repository.readReviewRevision(scope.ownerId, scope.exerciseId, initial.revisionId);
    expect(original.guidance).toMatchObject({ videoAnalysisStatus: "AI_ANALYZED", countingUnit: "CUSTOM", bilateralCounting: "UNRESOLVED: 左右は未確定" });
    expect(original.fieldAssessment.filter((field) => field.state === "UNRESOLVED")).toHaveLength(2);
  });

  it("accepts an explicit not-applicable resolution with a changed nullable value", async () => {
    const initial = await candidate(true);
    const result = await submitVideoGuidanceReview({ ...command(initial, "APPROVE"),
      observation: { ...persistenceObservation, bilateralCounting: null },
      resolutions: [explicitResolutions[0], { field: "bilateralCounting", state: "NOT_APPLICABLE", reason: "明示的に左右区別を適用しない" }],
    }, deps);
    expect(result.guidance.bilateralCounting).toBeNull();
    expect(result.fieldAssessment.find((field) => field.field === "bilateralCounting")?.state).toBe("NOT_APPLICABLE");
  });

  it("reconstructs the same approval from its immutable candidate even after a newer AI candidate arrives", async () => {
    const initial = await candidate(true);
    const input = { ...command(initial, "APPROVE"), observation: persistenceObservation, resolutions: explicitResolutions };
    const approved = await submitVideoGuidanceReview(input, deps);
    const newer = await candidate();
    const before = await writes();
    const repeated = await submitVideoGuidanceReview(input, deps);
    expect(repeated).toMatchObject({ revisionId: approved.revisionId, reused: true, head: { latestCandidateRevisionId: newer.revisionId } });
    expect(await writes()).toEqual(before);
    await errorCode(submitVideoGuidanceReview({ ...input, reason: "Different intent under the same operation key" }, deps), "OPERATION_KEY_CONFLICT");
    expect(await writes()).toEqual(before);
  });

  it("rechecks authentication before an otherwise valid duplicate operation", async () => {
    const initial = await candidate();
    const input = command(initial);
    await submitVideoGuidanceReview(input, deps);
    const before = await writes();
    authenticated = null;
    await errorCode(submitVideoGuidanceReview(input, deps), "UNAUTHENTICATED");
    expect(await writes()).toEqual(before);
  });

  it("blocks a foreign historical candidate even when the other exercise is owned", async () => {
    const initial = await candidate();
    const before = await writes();
    await errorCode(submitVideoGuidanceReview({ ...command(initial), exerciseId: "guidance-exercise-b" }, deps), "CROSS_BOUNDARY");
    expect(await writes()).toEqual(before);
  });

  it("checks both submitted binding hash and current media freshness before any decision", async () => {
    const initial = await candidate();
    const before = await writes();
    await errorCode(submitVideoGuidanceReview({ ...command(initial), expectedSourceBindingHash: "f".repeat(64) }, deps), "SOURCE_MISMATCH");
    currentBinding = { ...persistenceBinding, contentSha256: "d".repeat(64) };
    await errorCode(submitVideoGuidanceReview(command(initial), deps), "SOURCE_MISMATCH");
    expect(await writes()).toEqual(before);
  });

  it("passes stale-head and rejected-candidate errors through without creating a replacement", async () => {
    const initial = await candidate();
    const held = await submitVideoGuidanceReview(command(initial), deps);
    await errorCode(submitVideoGuidanceReview(command(initial, "REJECT"), deps), "STALE_VIDEO_GUIDANCE");
    const rejected = await submitVideoGuidanceReview(command(held, "REJECT"), deps);
    const before = await writes();
    await errorCode(submitVideoGuidanceReview(command(rejected, "PUBLISH_AI"), deps), "STALE_VIDEO_GUIDANCE");
    expect(await writes()).toEqual(before);
  });
});
