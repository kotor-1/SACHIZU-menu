import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoGuidanceRepository, type GuidanceMutationResult, type PublishAiGuidanceInput } from "@/infra/repositories/video-guidance-repository";
import type { SourceBinding } from "@/domain/exercise/video-guidance-persistence";
import {
  createPersistenceDatabaseTemplate, persistenceAssessments, persistenceBinding, persistenceExercise,
  persistenceNow, persistenceObservation, persistenceOwner, persistencePayload,
} from "../fixtures/video-guidance-persistence";

let template: Awaited<ReturnType<typeof createPersistenceDatabaseTemplate>>;
let db: PrismaClient;
let repository: VideoGuidanceRepository;
let sourceBinding: SourceBinding | null;
let operation = 0;
const command = (kind: "AI" | "COACH" | "IMPORT" = "COACH") => ({
  ownerId: persistenceOwner, exerciseId: persistenceExercise, operationKey: `review-operation-${++operation}`,
  actor: { id: kind === "COACH" ? "review-coach" : null, kind }, reason: "Explicit offline review decision",
});
const append = () => repository.appendAiCandidate({
  ...command("AI"), sourceBinding: persistenceBinding, payload: persistencePayload,
  fieldAssessment: persistenceAssessments, aiMetadata: null, provenance: { source: "offline review fixture" },
});
const decision = (candidate: GuidanceMutationResult): PublishAiGuidanceInput => ({
  ...command(), candidateRevisionId: candidate.revisionId, expectedRowVersion: candidate.head.rowVersion,
  expectedApprovedRevisionId: candidate.head.approvedRevisionId,
});
const review = (candidate: GuidanceMutationResult) => ({
  ...decision(candidate), observation: persistenceObservation,
  fieldAssessment: persistenceAssessments, provenance: { coachDecision: "explicit fixture decision" },
});
async function state() {
  return {
    revisions: await db.exerciseVideoGuidanceRevision.findMany({ orderBy: { id: "asc" } }),
    head: await db.exerciseVideoGuidanceHead.findUnique({ where: {
      ownerId_exerciseId: { ownerId: persistenceOwner, exerciseId: persistenceExercise },
    } }),
    audits: await db.videoGuidanceAuditEvent.findMany({ orderBy: { resultingRowVersion: "asc" } }),
  };
}
const rejectsCode = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({
  name: "VideoGuidancePersistenceError", code,
});

beforeAll(async () => { template = await createPersistenceDatabaseTemplate(); }, 90_000);
beforeEach(async () => {
  db = await template.open();
  sourceBinding = { ...persistenceBinding };
  repository = new VideoGuidanceRepository(db, async () => sourceBinding, () => persistenceNow);
});
afterEach(async () => { vi.restoreAllMocks(); await db?.$disconnect(); });
afterAll(async () => { await template?.dispose(); });

describe("Coach video-guidance review operations (isolated migrated SQLite)", () => {
  it("records hold separately while retaining the approved guidance and original candidate", async () => {
    const original = await append();
    const approved = await repository.reviewAndActivate(review(original));
    const candidate = await append();
    const before = await state();
    const held = await repository.holdCandidate(decision(candidate));
    expect(held.head).toMatchObject({
      approvedRevisionId: approved.revisionId, activeAiRevisionId: candidate.head.activeAiRevisionId,
      latestCandidateRevisionId: candidate.revisionId, rowVersion: candidate.head.rowVersion + 1,
    });
    expect((await state()).revisions).toEqual(before.revisions);
    await rejectsCode(repository.rejectCandidate(decision(candidate)), "STALE_VIDEO_GUIDANCE");
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).revisionId).toBe(approved.revisionId);
    const page = await repository.readReviewData(persistenceOwner, persistenceExercise);
    expect(page.candidateDecision).toBe("HELD");
    expect(page.candidate?.revisionId).toBe(candidate.revisionId);
    expect(page.auditEvents[0]).toMatchObject({
      actorId: "review-coach", actorKind: "COACH", operation: "HOLD_CANDIDATE", reason: "Explicit offline review decision",
      after: { candidateRevisionId: candidate.revisionId, candidateDecision: "HELD" },
    });
  });

  it("keeps rejected evidence and effective approval, and requires a new AI revision to proceed", async () => {
    const initial = await append();
    const approved = await repository.reviewAndActivate(review(initial));
    const candidate = await append();
    const before = await state();
    const rejected = await repository.rejectCandidate(decision(candidate));
    expect((await state()).revisions).toEqual(before.revisions);
    expect(rejected.head.approvedRevisionId).toBe(approved.revisionId);
    expect(rejected.head.latestCandidateRevisionId).toBe(candidate.revisionId);
    expect((await repository.readReviewData(persistenceOwner, persistenceExercise)).candidateDecision).toBe("REJECTED");
    const afterRejection = await state();
    await rejectsCode(repository.publishAiCandidate(decision(rejected)), "STALE_VIDEO_GUIDANCE");
    await rejectsCode(repository.reviewAndActivate(review(rejected)), "STALE_VIDEO_GUIDANCE");
    await rejectsCode(repository.holdCandidate(decision(rejected)), "STALE_VIDEO_GUIDANCE");
    expect(await state()).toEqual(afterRejection);
    const replacement = await append();
    expect(replacement.revisionId).not.toBe(candidate.revisionId);
    expect((await repository.readReviewData(persistenceOwner, persistenceExercise)).candidateDecision).toBe("PENDING");
    const replacementApproval = await repository.reviewAndActivate(review(replacement));
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).revisionId).toBe(replacementApproval.revisionId);
    expect(await db.exerciseVideoGuidanceRevision.findUnique({ where: { id: candidate.revisionId } })).not.toBeNull();
  });

  it("cannot publish a rejected AI candidate when no approval exists", async () => {
    const candidate = await append();
    const rejected = await repository.rejectCandidate(decision(candidate));
    await rejectsCode(repository.publishAiCandidate(decision(rejected)), "STALE_VIDEO_GUIDANCE");
    await rejectsCode(repository.readEffectiveGuidance(persistenceOwner, persistenceExercise), "NOT_FOUND");
    expect(rejected.head.activeAiRevisionId).toBeNull();
  });

  it.each([false, true])("does not reject active AI knowledge or silently withdraw it (approved=%s)", async (withApproval) => {
    const initial = await append();
    const publishInput = decision(initial);
    const published = await repository.publishAiCandidate(publishInput);
    const current = withApproval ? await repository.reviewAndActivate(review(published)) : published;
    const activeCandidate = { ...published, head: current.head };
    const before = await state();
    const effective = await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise);
    await rejectsCode(repository.rejectCandidate(decision(activeCandidate)), "INVALID_PAYLOAD");
    expect(await state()).toEqual(before);
    expect(await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).toEqual(effective);
    expect((await repository.publishAiCandidate(publishInput)).reused).toBe(true);
    const held = await repository.holdCandidate(decision(activeCandidate));
    expect(held.head.activeAiRevisionId).toBe(initial.revisionId);
    const reviewInput = review(held);
    const approved = await repository.reviewAndActivate(reviewInput);
    expect(approved.guidance.videoAnalysisStatus).toBe("COACH_REVIEWED");
    expect((await repository.reviewAndActivate(reviewInput)).reused).toBe(true);
  });

  it("requires the current candidate even when supplied row version and approval are current", async () => {
    const oldCandidate = await append();
    const current = await append();
    const staleCandidate = { ...oldCandidate, head: current.head };
    const before = await state();
    await rejectsCode(repository.publishAiCandidate(decision(staleCandidate)), "STALE_VIDEO_GUIDANCE");
    await rejectsCode(repository.reviewAndActivate(review(staleCandidate)), "STALE_VIDEO_GUIDANCE");
    await rejectsCode(repository.holdCandidate(decision(staleCandidate)), "STALE_VIDEO_GUIDANCE");
    await rejectsCode(repository.rejectCandidate(decision(staleCandidate)), "STALE_VIDEO_GUIDANCE");
    expect(await state()).toEqual(before);
  });

  it("replays an identical hold before stale-candidate checks but rejects changed command data", async () => {
    const candidate = await append();
    const input = decision(candidate);
    await repository.holdCandidate(input);
    const newer = await append();
    const beforeReplay = await state();
    const repeated = await repository.holdCandidate(input);
    expect(repeated.reused).toBe(true);
    expect(repeated.revisionId).toBe(candidate.revisionId);
    expect(repeated.head.latestCandidateRevisionId).toBe(newer.revisionId);
    await rejectsCode(repository.holdCandidate({ ...input, reason: "Changed review decision" }), "OPERATION_KEY_CONFLICT");
    await rejectsCode(repository.rejectCandidate(input), "OPERATION_KEY_CONFLICT");
    expect(await state()).toEqual(beforeReplay);
  });

  it("replays a completed rejection without appending another audit event", async () => {
    const candidate = await append();
    const input = decision(candidate);
    await repository.rejectCandidate(input);
    const before = await state();
    expect((await repository.rejectCandidate(input)).reused).toBe(true);
    expect(await state()).toEqual(before);
  });

  it("shows completed publication and review instead of leaving an old hold pending", async () => {
    const candidate = await append();
    const published = await repository.publishAiCandidate(decision(candidate));
    expect((await repository.readReviewData(persistenceOwner, persistenceExercise)).candidateDecision).toBe("PUBLISHED");
    const held = await repository.holdCandidate(decision(published));
    expect((await repository.readReviewData(persistenceOwner, persistenceExercise)).candidateDecision).toBe("HELD");
    await repository.reviewAndActivate(review(held));
    expect((await repository.readReviewData(persistenceOwner, persistenceExercise)).candidateDecision).toBe("REVIEWED");
  });

  it.each(["holdCandidate", "rejectCandidate"] as const)("rolls back %s when the audit insert fails", async (method) => {
    const candidate = await append();
    const before = await state();
    await db.$executeRawUnsafe(`CREATE TRIGGER offline_review_audit_failure BEFORE INSERT ON VideoGuidanceAuditEvent BEGIN SELECT RAISE(ABORT, 'offline audit failure'); END`);
    await rejectsCode(repository[method](decision(candidate)), "DB_WRITE_FAILURE");
    expect(await state()).toEqual(before);
  });

  it("shows stale evidence for review but rejects hold/reject and all effective use", async () => {
    const candidate = await append();
    await repository.publishAiCandidate(decision(candidate));
    const before = await state();
    sourceBinding = { ...persistenceBinding, contentSha256: "b".repeat(64) };
    const page = await repository.readReviewData(persistenceOwner, persistenceExercise);
    expect(page.effective?.sourceStatus).toBe("SOURCE_MISMATCH");
    expect(page.candidate?.sourceStatus).toBe("SOURCE_MISMATCH");
    expect(page.candidate?.guidance).toEqual(persistencePayload);
    const currentCandidate = { ...candidate, head: page.head };
    await rejectsCode(repository.holdCandidate(decision(currentCandidate)), "SOURCE_MISMATCH");
    await rejectsCode(repository.rejectCandidate(decision(currentCandidate)), "SOURCE_MISMATCH");
    await rejectsCode(repository.readEffectiveGuidance(persistenceOwner, persistenceExercise), "SOURCE_MISMATCH");
    expect(await state()).toEqual(before);
  });

  it("returns the original AI, current coach edit, prior approval and explicit provenance", async () => {
    const firstCandidate = await append();
    const firstApproval = await repository.reviewAndActivate(review(firstCandidate));
    const secondCandidate = await append();
    const secondReview = { ...review(secondCandidate), observation: { ...persistenceObservation, keyCues: ["明示的なコーチ編集"] },
      provenance: { coachDecision: "Second explicit decision", evidence: ["fixture:coach-review-2"] } };
    const secondApproval = await repository.reviewAndActivate(secondReview);
    const page = await repository.readReviewData(persistenceOwner, persistenceExercise);
    expect(page.effective).toMatchObject({ revisionId: secondApproval.revisionId, reviewerIdentity: "COACH", reviewerActorId: "review-coach", provenance: secondReview.provenance });
    expect(page.aiOriginal).toMatchObject({ revisionId: secondCandidate.revisionId, reviewerIdentity: "NOT_REVIEWED", guidance: persistencePayload });
    expect(page.previousApproved?.revisionId).toBe(firstApproval.revisionId);
    expect(page.auditEvents[0].after).toMatchObject({ baseAiRevisionId: secondCandidate.revisionId });
    expect((await repository.readReviewRevision(persistenceOwner, persistenceExercise, firstCandidate.revisionId)).guidance).toEqual(persistencePayload);
  });

  it("labels an imported unknown reviewer honestly without inventing AI metadata", async () => {
    const imported = await repository.importLegacy({
      ...command("IMPORT"), sourceBinding: persistenceBinding,
      payload: { ...persistencePayload, videoAnalysisStatus: "COACH_REVIEWED", coachReviewedAt: persistenceNow.toISOString() },
      fieldAssessment: persistenceAssessments, aiMetadata: null, provenance: { source: "legacy file" }, importSourceHash: "c".repeat(64),
    });
    const page = await repository.readReviewData(persistenceOwner, persistenceExercise);
    expect(page.effective).toMatchObject({ revisionId: imported.revisionId, reviewerActorId: null, reviewerIdentity: "LEGACY_UNKNOWN", aiMetadata: null });
    expect(page.candidate).toBeNull();
    expect(page.aiOriginal).toBeNull();
    expect(page.candidateDecision).toBeNull();
  });

  it("never converts storage/database failures into a source-mismatch warning", async () => {
    await append();
    const unavailable = new VideoGuidanceRepository(db, async () => { throw new Error("private offline storage failure"); }, () => persistenceNow);
    await rejectsCode(unavailable.readReviewData(persistenceOwner, persistenceExercise), "DB_READ_FAILURE");
    vi.spyOn(db.videoGuidanceAuditEvent, "findMany").mockRejectedValueOnce(new Error("private offline DB failure"));
    await rejectsCode(repository.readReviewData(persistenceOwner, persistenceExercise), "DB_READ_FAILURE");
  });

  it("rejects malformed stored review metadata rather than displaying fabricated values", async () => {
    const candidate = await append();
    const original = await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: candidate.revisionId } });
    const malformed = await db.exerciseVideoGuidanceRevision.create({ data: {
      ...original, id: "invalid-review-metadata", operationKey: "invalid-review-metadata", aiMetadataJson: '{"provider":42}',
    } });
    await rejectsCode(repository.readReviewRevision(persistenceOwner, persistenceExercise, malformed.id), "INVALID_PAYLOAD");
  });

  it("enforces ownership for both page reads and historical revision reads", async () => {
    const candidate = await append();
    await rejectsCode(repository.readReviewData("guidance-owner-b", persistenceExercise), "CROSS_BOUNDARY");
    await rejectsCode(repository.readReviewRevision("guidance-owner-b", persistenceExercise, candidate.revisionId), "CROSS_BOUNDARY");
    await rejectsCode(repository.readReviewRevision(persistenceOwner, "guidance-exercise-b", candidate.revisionId), "CROSS_BOUNDARY");
  });

  it("requires an identified coach and a reason for hold and reject", async () => {
    const candidate = await append();
    const before = await state();
    await rejectsCode(repository.holdCandidate({ ...decision(candidate), actor: { id: null, kind: "COACH" } }), "INVALID_PAYLOAD");
    await rejectsCode(repository.rejectCandidate({ ...decision(candidate), actor: { id: "model", kind: "AI" } }), "INVALID_PAYLOAD");
    await rejectsCode(repository.rejectCandidate({ ...decision(candidate), reason: " " }), "INVALID_PAYLOAD");
    expect(await state()).toEqual(before);
    expect(repository.aiWriter()).not.toHaveProperty("holdCandidate");
    expect(repository.aiWriter()).not.toHaveProperty("rejectCandidate");
  });
});
