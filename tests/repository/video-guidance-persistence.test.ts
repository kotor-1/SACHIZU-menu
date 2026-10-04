import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoGuidanceRepository } from "@/infra/repositories/video-guidance-repository";
import { DbVideoGuidanceReadAdapter } from "@/infra/exercise/db-video-guidance-read-adapter";
import { VideoGuidancePersistenceError, type SourceBinding } from "@/domain/exercise/video-guidance-persistence";
import {
  createPersistenceDatabaseTemplate, persistenceAssessments, persistenceBinding, persistenceExercise,
  persistenceNow, persistenceObservation, persistenceOwner, persistencePayload,
} from "../fixtures/video-guidance-persistence";

let template: Awaited<ReturnType<typeof createPersistenceDatabaseTemplate>>;
let db: PrismaClient;
let repository: VideoGuidanceRepository;
let currentBinding: SourceBinding | null;
let operation = 0;
const common = (kind: "AI" | "COACH" | "IMPORT" = "AI") => ({
  ownerId: persistenceOwner, exerciseId: persistenceExercise, operationKey: `offline-operation-${++operation}`,
  actor: { id: kind === "COACH" ? "coach-a" : null, kind }, reason: "Offline persistence regression",
});
const appendInput = (overrides: Partial<Parameters<VideoGuidanceRepository["appendAiCandidate"]>[0]> = {}) => ({
  ...common(), sourceBinding: persistenceBinding, payload: persistencePayload,
  fieldAssessment: persistenceAssessments, aiMetadata: null, provenance: { evidence: "offline fixture" }, ...overrides,
});
type Stored = Awaited<ReturnType<VideoGuidanceRepository["appendAiCandidate"]>>;
const publishInput = (candidate: Stored) => ({
  ...common("COACH"), candidateRevisionId: candidate.revisionId,
  expectedRowVersion: candidate.head.rowVersion, expectedApprovedRevisionId: candidate.head.approvedRevisionId,
});
const reviewInput = (candidate: Stored) => ({
  ...publishInput(candidate), observation: persistenceObservation, fieldAssessment: persistenceAssessments,
  provenance: { coachDecision: "Offline explicit review" },
});
const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ name: "VideoGuidancePersistenceError", code });
};
async function counts() {
  return {
    revisions: await db.exerciseVideoGuidanceRevision.count(), heads: await db.exerciseVideoGuidanceHead.count(),
    audit: await db.videoGuidanceAuditEvent.count(),
  };
}

beforeAll(async () => { template = await createPersistenceDatabaseTemplate(); }, 90_000);
beforeEach(async () => {
  db = await template.open();
  currentBinding = { ...persistenceBinding };
  repository = new VideoGuidanceRepository(db, async (owner, exercise, source) =>
    owner === persistenceOwner && exercise === persistenceExercise && source === persistenceBinding.sourceVideoId ? currentBinding : null,
  () => persistenceNow);
});
afterEach(async () => { vi.restoreAllMocks(); await db?.$disconnect(); });
afterAll(async () => { await template?.dispose(); });

describe("Video guidance revisions and compare-and-swap heads (migrated isolated SQLite)", () => {
  it("keeps candidate and active pointers separate until explicit publication", async () => {
    await expectCode(repository.readEffectiveGuidance(persistenceOwner, persistenceExercise), "NOT_FOUND");
    const candidate = await repository.appendAiCandidate(appendInput());
    expect(candidate.head.latestCandidateRevisionId).toBe(candidate.revisionId);
    expect(candidate.head.activeAiRevisionId).toBeNull();
    expect(candidate.head.approvedRevisionId).toBeNull();
    expect((await repository.readCandidateGuidance(persistenceOwner, persistenceExercise)).guidance).toEqual(persistencePayload);
    await expectCode(repository.readEffectiveGuidance(persistenceOwner, persistenceExercise), "NOT_FOUND");
    const active = await repository.publishAiCandidate(publishInput(candidate));
    expect(active.head.activeAiRevisionId).toBe(candidate.revisionId);
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).revisionId).toBe(candidate.revisionId);
    expect(await db.exerciseVideoGuidanceRevision.count()).toBe(1);
    expect(await db.videoGuidanceAuditEvent.count()).toBe(2);
  });

  it("creates immutable coach revisions with the previous effective parent and AI base", async () => {
    const first = await repository.appendAiCandidate(appendInput());
    const active = await repository.publishAiCandidate(publishInput(first));
    const reviewed = await repository.reviewAndActivate(reviewInput(active));
    expect(reviewed.guidance).toMatchObject({ videoAnalysisStatus: "COACH_REVIEWED", coachReviewedAt: persistenceNow.toISOString() });
    const revision = await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: reviewed.revisionId } });
    expect(revision).toMatchObject({ parentRevisionId: first.revisionId, baseAiRevisionId: first.revisionId, reviewerActorId: "coach-a" });
    expect((await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: first.revisionId } })).payloadJson).toContain("AI_ANALYZED");
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).revisionId).toBe(reviewed.revisionId);
  });

  it("allows a late AI candidate without replacing or publishing over approved guidance", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    const reviewed = await repository.reviewAndActivate(reviewInput(candidate));
    const late = await repository.appendAiCandidate(appendInput({ payload: { ...persistencePayload, analysisVersion: "new-ai-version" } }));
    expect(late.head.approvedRevisionId).toBe(reviewed.revisionId);
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).revisionId).toBe(reviewed.revisionId);
    expect((await repository.readCandidateGuidance(persistenceOwner, persistenceExercise)).revisionId).toBe(late.revisionId);
    const before = await counts();
    await expect(repository.publishAiCandidate(publishInput(late))).rejects.toBeInstanceOf(VideoGuidancePersistenceError);
    expect(await counts()).toEqual(before);
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).revisionId).toBe(reviewed.revisionId);
  });

  it("requires current row version and approved pointer for reviews without orphan revisions", async () => {
    const initial = await repository.appendAiCandidate(appendInput());
    const reviewed = await repository.reviewAndActivate(reviewInput(initial));
    const before = await counts();
    await expectCode(repository.reviewAndActivate(reviewInput(initial)), "STALE_VIDEO_GUIDANCE");
    await expectCode(repository.reviewAndActivate({ ...reviewInput(initial), expectedRowVersion: reviewed.head.rowVersion, expectedApprovedRevisionId: null }), "STALE_VIDEO_GUIDANCE");
    expect(await counts()).toEqual(before);
  });

  it("admits exactly one of two concurrent reviews using the same expected head", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    const peer = template.peer(db);
    try {
      await peer.$connect();
      const competitor = new VideoGuidanceRepository(peer, async () => persistenceBinding, () => persistenceNow);
      const results = await Promise.allSettled([
        repository.reviewAndActivate(reviewInput(candidate)),
        competitor.reviewAndActivate({ ...reviewInput(candidate), observation: { ...persistenceObservation, keyCues: ["別の明示レビュー"] } }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "STALE_VIDEO_GUIDANCE" });
    } finally { await peer.$disconnect(); }
    expect(await db.exerciseVideoGuidanceRevision.count()).toBe(2);
    expect(await db.videoGuidanceAuditEvent.count()).toBe(2);
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).guidance.videoAnalysisStatus).toBe("COACH_REVIEWED");
  });

  it("reuses an identical operation but rejects the same key with a different payload", async () => {
    const input = appendInput();
    const first = await repository.appendAiCandidate(input);
    const second = await repository.appendAiCandidate(input);
    expect(second.revisionId).toBe(first.revisionId);
    expect(second.reused).toBe(true);
    await expectCode(repository.appendAiCandidate({ ...input, payload: { ...input.payload, executionSummary: "異なる動作" } }), "OPERATION_KEY_CONFLICT");
    expect(await counts()).toEqual({ revisions: 1, heads: 1, audit: 1 });
  });

  it("never duplicates an operation when two database clients submit it concurrently", async () => {
    const input = appendInput();
    const peer = template.peer(db);
    try {
      await peer.$connect();
      const competitor = new VideoGuidanceRepository(peer, async () => persistenceBinding, () => persistenceNow);
      const outcomes = await Promise.allSettled([
        repository.appendAiCandidate(input), competitor.appendAiCandidate(input),
      ]);
      const completed = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(completed.length).toBeGreaterThanOrEqual(1);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "STALE_VIDEO_GUIDANCE" });
      }
      const retry = await repository.appendAiCandidate(input);
      expect(retry.reused).toBe(true);
      for (const outcome of completed) {
        if (outcome.status === "fulfilled") expect(outcome.value.revisionId).toBe(retry.revisionId);
      }
      expect(await counts()).toEqual({ revisions: 1, heads: 1, audit: 1 });
    } finally { await peer.$disconnect(); }
  });

  it("makes completed publication and review retries idempotent despite their old expected version", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    const publication = publishInput(candidate);
    const active = await repository.publishAiCandidate(publication);
    expect((await repository.publishAiCandidate(publication)).reused).toBe(true);
    const review = reviewInput(active);
    const approved = await repository.reviewAndActivate(review);
    const replay = await repository.reviewAndActivate(review);
    expect(replay).toMatchObject({ revisionId: approved.revisionId, reused: true });
    expect(await counts()).toEqual({ revisions: 2, heads: 1, audit: 3 });
  });

  it("rejects operation-key reuse when provenance or expected state is changed", async () => {
    const input = appendInput();
    const candidate = await repository.appendAiCandidate(input);
    await expectCode(repository.appendAiCandidate({ ...input, provenance: { evidence: "changed" } }), "OPERATION_KEY_CONFLICT");
    const publication = publishInput(candidate);
    await repository.publishAiCandidate(publication);
    await expectCode(repository.publishAiCandidate({ ...publication, expectedRowVersion: publication.expectedRowVersion + 1 }), "OPERATION_KEY_CONFLICT");
  });

  it("requires an identified coach and resolved field assessment for promotion", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    for (const actor of [{ id: null, kind: "COACH" as const }, { id: "model", kind: "AI" as const }]) {
      await expectCode(repository.reviewAndActivate({ ...reviewInput(candidate), actor }), "INVALID_PAYLOAD");
    }
    await expectCode(repository.reviewAndActivate({ ...reviewInput(candidate), fieldAssessment: [{ ...persistenceAssessments[0], state: "UNRESOLVED" }] }), "INVALID_PAYLOAD");
    expect(await db.exerciseVideoGuidanceRevision.count()).toBe(1);
  });

  it("rejects a forged AI candidate carrying coach authority", async () => {
    await expectCode(repository.appendAiCandidate(appendInput({ payload: {
      ...persistencePayload, videoAnalysisStatus: "COACH_REVIEWED", coachReviewedAt: persistenceNow.toISOString(),
    } })), "INVALID_PAYLOAD");
    expect(await counts()).toEqual({ revisions: 0, heads: 0, audit: 0 });
  });

  it("rejects cross-owner, cross-exercise, and mismatched source bindings before writes", async () => {
    await expect(repository.appendAiCandidate(appendInput({ ownerId: "guidance-owner-b" }))).rejects.toBeInstanceOf(VideoGuidancePersistenceError);
    await expect(repository.appendAiCandidate(appendInput({ exerciseId: "guidance-exercise-b" }))).rejects.toBeInstanceOf(VideoGuidancePersistenceError);
    await expectCode(repository.appendAiCandidate(appendInput({ sourceBinding: { ...persistenceBinding, sourceVideoId: "guidance-video-b" } })), "SOURCE_MISMATCH");
    expect(await counts()).toEqual({ revisions: 0, heads: 0, audit: 0 });
  });

  it("prevents cross-exercise parent and candidate references", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    const otherBinding = { ...persistenceBinding, sourceVideoId: "guidance-video-b", storageKey: "uploads/guidance-video-b.mp4", sourceUrl: null };
    const other = new VideoGuidanceRepository(db, async () => otherBinding, () => persistenceNow);
    await expectCode(other.appendAiCandidate(appendInput({ exerciseId: "guidance-exercise-b", sourceBinding: otherBinding,
      payload: { ...persistencePayload, sourceVideoId: otherBinding.sourceVideoId }, parentRevisionId: candidate.revisionId })), "CROSS_BOUNDARY");
    await expect(other.publishAiCandidate({ ...publishInput(candidate), exerciseId: "guidance-exercise-b" })).rejects.toBeInstanceOf(VideoGuidancePersistenceError);
    expect(await db.exerciseVideoGuidanceRevision.count()).toBe(1);
  });

  it("keeps approval bound to its original bytes when the same asset receives new AI evidence", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    const approved = await repository.reviewAndActivate(reviewInput(candidate));
    const approvedRevision = await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: approved.revisionId } });
    currentBinding = { ...persistenceBinding, contentSha256: "b".repeat(64) };
    await expectCode(repository.readEffectiveGuidance(persistenceOwner, persistenceExercise), "SOURCE_MISMATCH");
    await expectCode(repository.readCandidateGuidance(persistenceOwner, persistenceExercise), "SOURCE_MISMATCH");
    await expectCode(repository.reviewAndActivate(reviewInput({ ...candidate, head: approved.head })), "SOURCE_MISMATCH");
    const newCandidate = await repository.appendAiCandidate(appendInput({
      sourceBinding: currentBinding, payload: { ...persistencePayload, analysisVersion: "new-video-bytes-v2" },
    }));
    expect(newCandidate.head.approvedRevisionId).toBe(approved.revisionId);
    expect((await repository.readCandidateGuidance(persistenceOwner, persistenceExercise)).sourceBinding).toEqual(currentBinding);
    await expectCode(repository.readEffectiveGuidance(persistenceOwner, persistenceExercise), "SOURCE_MISMATCH");
    expect(await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: approved.revisionId } })).toEqual(approvedRevision);
    expect(await db.exerciseVideoGuidanceRevision.count()).toBe(3);
  });

  it("distinguishes a missing record from database read failures", async () => {
    await expectCode(repository.readEffectiveGuidance(persistenceOwner, persistenceExercise), "NOT_FOUND");
    const broken = new VideoGuidanceRepository(db, async () => { throw new Error("private storage outage"); }, () => persistenceNow);
    const candidate = await repository.appendAiCandidate(appendInput());
    await repository.publishAiCandidate(publishInput(candidate));
    await expectCode(broken.readEffectiveGuidance(persistenceOwner, persistenceExercise), "DB_READ_FAILURE");
    vi.spyOn(db.exerciseVideoGuidanceHead, "findUnique").mockRejectedValueOnce(new Error("private database failure"));
    await expectCode(repository.readEffectiveGuidance(persistenceOwner, persistenceExercise), "DB_READ_FAILURE");
  });

  it("reads a 157-exercise catalog concurrently without SQLite transaction queue failures", async () => {
    const additionalIds = Array.from({ length: 155 }, (_, index) => `concurrent-catalog-${index}`);
    await db.exercise.createMany({ data: additionalIds.map((id) => ({
      id, ownerId: persistenceOwner, name: `Offline ${id}`, category: "DRILL",
    })) });
    const enrichedIds = [persistenceExercise, ...additionalIds.slice(0, 4)];
    const bindings = new Map<string, SourceBinding>([[persistenceExercise, persistenceBinding]]);
    for (const [index, exerciseId] of additionalIds.slice(0, 4).entries()) {
      const binding: SourceBinding = {
        ...persistenceBinding, sourceVideoId: `concurrent-video-${index}`, storageKey: `uploads/concurrent-${index}.mp4`, sourceUrl: null,
      };
      await db.videoAsset.create({ data: {
        id: binding.sourceVideoId, exerciseId, ownerId: persistenceOwner,
        storageKey: binding.storageKey, sourceUrl: null, filename: `concurrent-${index}.mp4`,
      } });
      bindings.set(exerciseId, binding);
    }
    const catalogRepository = new VideoGuidanceRepository(db, async (ownerId, exerciseId, sourceVideoId) => {
      const binding = bindings.get(exerciseId);
      return ownerId === persistenceOwner && binding?.sourceVideoId === sourceVideoId ? binding : null;
    }, () => persistenceNow);
    for (const [index, exerciseId] of enrichedIds.entries()) {
      const sourceBinding = bindings.get(exerciseId)!;
      await catalogRepository.importLegacy({
        ...common("IMPORT"), exerciseId, sourceBinding, fieldAssessment: persistenceAssessments,
        aiMetadata: null, provenance: { fixture: "concurrent-catalog" }, importSourceHash: "d".repeat(64),
        payload: {
          ...persistencePayload, sourceVideoId: sourceBinding.sourceVideoId,
          videoAnalysisStatus: index < 4 ? "COACH_REVIEWED" : "AI_ANALYZED",
          coachReviewedAt: index < 4 ? persistenceNow.toISOString() : null,
        },
      });
    }
    const before = await counts();
    const reader = new DbVideoGuidanceReadAdapter(catalogRepository);
    const results = await Promise.all([persistenceExercise, "guidance-exercise-b", ...additionalIds]
      .map((exerciseId) => reader.read(persistenceOwner, exerciseId)));
    expect(results).toHaveLength(157);
    expect(results.filter((guidance) => guidance === null)).toHaveLength(152);
    expect(results.filter((guidance) => guidance?.videoAnalysisStatus === "COACH_REVIEWED")).toHaveLength(4);
    expect(results.filter((guidance) => guidance?.videoAnalysisStatus === "AI_ANALYZED")).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });

  it("returns the captured head and its immutable payload when a coach activates during a read", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    const active = await repository.publishAiCandidate(publishInput(candidate));
    let captured!: () => void;
    const headCaptured = new Promise<void>((resolve) => { captured = resolve; });
    let release!: (head: typeof active.head) => void;
    const pendingHead = new Promise<typeof active.head>((resolve) => { release = resolve; });
    vi.spyOn(db.exerciseVideoGuidanceHead, "findUnique").mockImplementationOnce(() => {
      captured();
      // The repository awaits this read; relation-access methods are not used.
      return pendingHead as unknown as ReturnType<typeof db.exerciseVideoGuidanceHead.findUnique>;
    });
    const reading = repository.readEffectiveGuidance(persistenceOwner, persistenceExercise);
    await headCaptured;
    let approved: Stored;
    try { approved = await repository.reviewAndActivate(reviewInput(active)); }
    finally { release(active.head); }
    const snapshot = await reading;
    expect(snapshot.head).toEqual(active.head);
    expect(snapshot.revisionId).toBe(active.revisionId);
    expect(snapshot.guidance.videoAnalysisStatus).toBe("AI_ANALYZED");
    const subsequent = await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise);
    expect(subsequent.head.approvedRevisionId).toBe(approved.revisionId);
    expect(subsequent.revisionId).toBe(approved.revisionId);
    expect(subsequent.guidance.videoAnalysisStatus).toBe("COACH_REVIEWED");
  });

  it("read compatibility returns null only for absence and exposes source/corruption errors", async () => {
    const reader = new DbVideoGuidanceReadAdapter(repository);
    expect(await reader.read(persistenceOwner, persistenceExercise)).toBeNull();
    const candidate = await repository.appendAiCandidate(appendInput());
    await repository.publishAiCandidate(publishInput(candidate));
    expect(await reader.read(persistenceOwner, persistenceExercise)).toEqual(persistencePayload);
    currentBinding = null;
    await expectCode(reader.read(persistenceOwner, persistenceExercise), "SOURCE_MISMATCH");
    currentBinding = persistenceBinding;
    const previous = await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: candidate.revisionId } });
    // An invalid legacy/admin insert must not silently disappear at the read boundary.
    const corrupt = await db.exerciseVideoGuidanceRevision.create({ data: {
      ...previous, id: "corrupt-offline-fixture", operationKey: "corrupt-offline-fixture",
      payloadJson: JSON.stringify({ ...persistencePayload, executionSummary: 7 }),
    } });
    await db.exerciseVideoGuidanceHead.update({
      where: { ownerId_exerciseId: { ownerId: persistenceOwner, exerciseId: persistenceExercise } },
      data: { activeAiRevisionId: corrupt.id, rowVersion: { increment: 1 } },
    });
    await expectCode(reader.read(persistenceOwner, persistenceExercise), "INVALID_PAYLOAD");
    await expectCode(reader.write(), "WRITE_AUTHORITY_REQUIRED");
  });

  it("does not expose publication capabilities to the AI writer", () => {
    expect(Object.keys(repository.aiWriter())).toEqual(["appendAiCandidate"]);
    expect(repository.aiWriter()).not.toHaveProperty("reviewAndActivate");
    expect(repository.aiWriter()).not.toHaveProperty("publishAiCandidate");
    expect(Object.isFrozen(repository.aiWriter())).toBe(true);
  });

  it("requires an explicit decision for every unresolved candidate field", async () => {
    // E-like partial audio evidence remains distinct from an actual coach decision.
    // These are synthetic review decisions, not an approval of the real E exercise.
    const candidate = await repository.appendAiCandidate(appendInput({
      payload: { ...persistencePayload, countingUnit: "CUSTOM", bilateralCounting: "UNRESOLVED: 左右の扱いは音声から確定できない" },
      fieldAssessment: persistenceAssessments.map((assessment) =>
        ["countingUnit", "bilateralCounting"].includes(assessment.field) ? { ...assessment, state: "UNRESOLVED" as const,
          reason: "部分的なASRにより回数と左右は未確定", evidenceRefs: ["fixture:asr-partial-1"] } : assessment),
    }));
    const published = await repository.publishAiCandidate(publishInput(candidate));
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).fieldAssessment
      .filter((field) => field.state === "UNRESOLVED").map((field) => field.field)).toEqual(["countingUnit", "bilateralCounting"]);
    for (const omitted of ["countingUnit", "bilateralCounting"]) {
      await expectCode(repository.reviewAndActivate({ ...reviewInput(published),
        fieldAssessment: persistenceAssessments.filter((field) => field.field !== omitted) }), "INVALID_PAYLOAD");
    }
    const review = { ...reviewInput(published), reason: "Synthetic coach resolved counting and bilateral structure",
      provenance: { source: "explicit-test-coach-decision", resolvedFields: ["countingUnit", "bilateralCounting"],
        priorEvidence: "fixture:asr-partial-1" } };
    const reviewed = await repository.reviewAndActivate(review);
    expect(reviewed.guidance.videoAnalysisStatus).toBe("COACH_REVIEWED");
    const revision = await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: reviewed.revisionId } });
    expect(JSON.parse(revision.provenanceJson)).toEqual(review.provenance);
    const audit = await db.videoGuidanceAuditEvent.findFirstOrThrow({ where: { operationKey: review.operationKey } });
    expect(audit).toMatchObject({ actorId: "coach-a", reason: review.reason });
    expect(JSON.parse(audit.afterJson).changes).toEqual(expect.arrayContaining([
      { field: "countingUnit", before: "CUSTOM", after: persistenceObservation.countingUnit },
      { field: "bilateralCounting", before: "UNRESOLVED: 左右の扱いは音声から確定できない", after: persistenceObservation.bilateralCounting },
    ]));
    expect((await repository.readCandidateGuidance(persistenceOwner, persistenceExercise)).fieldAssessment
      .filter((field) => field.state === "UNRESOLVED")).toHaveLength(2);
  });

  it("links a later coach revision to both the previous approval and new AI evidence", async () => {
    const initial = await repository.appendAiCandidate(appendInput());
    const firstApproval = await repository.reviewAndActivate(reviewInput(initial));
    const candidate = await repository.appendAiCandidate(appendInput({ payload: { ...persistencePayload, analysisVersion: "ai-v2" } }));
    const reviewed = await repository.reviewAndActivate(reviewInput(candidate));
    const revision = await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: reviewed.revisionId } });
    expect(revision).toMatchObject({ parentRevisionId: firstApproval.revisionId, baseAiRevisionId: candidate.revisionId });
    const audit = await db.videoGuidanceAuditEvent.findFirstOrThrow({ where: { operationKey: revision.operationKey } });
    expect(audit).toMatchObject({ actorId: "coach-a", actorKind: "COACH", reason: "Offline persistence regression" });
    expect(JSON.parse(audit.afterJson).baseAiRevisionId).toBe(candidate.revisionId);
  });

  it("enforces append-only revisions and audit events through migration SQL triggers", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    const audit = await db.videoGuidanceAuditEvent.findFirstOrThrow();
    await expect(db.exerciseVideoGuidanceRevision.update({ where: { id: candidate.revisionId }, data: { reviewReason: "rewrite" } })).rejects.toThrow();
    await expect(db.exerciseVideoGuidanceRevision.delete({ where: { id: candidate.revisionId } })).rejects.toThrow();
    await expect(db.videoGuidanceAuditEvent.update({ where: { id: audit.id }, data: { reason: "rewrite" } })).rejects.toThrow();
    await expect(db.videoGuidanceAuditEvent.delete({ where: { id: audit.id } })).rejects.toThrow();
    // SQLite REPLACE must not bypass history protection via its implicit delete/insert.
    await expect(db.$executeRawUnsafe(
      'INSERT OR REPLACE INTO "ExerciseVideoGuidanceRevision" SELECT * FROM "ExerciseVideoGuidanceRevision" WHERE "id" = ?', candidate.revisionId,
    )).rejects.toThrow();
    await expect(db.$executeRawUnsafe(
      'INSERT OR REPLACE INTO "VideoGuidanceAuditEvent" SELECT * FROM "VideoGuidanceAuditEvent" WHERE "id" = ?', audit.id,
    )).rejects.toThrow();
    await expect(db.exercise.delete({ where: { id: persistenceExercise } })).rejects.toThrow();
    await expect(db.videoAsset.delete({ where: { id: persistenceBinding.sourceVideoId } })).rejects.toThrow();
    expect(await counts()).toEqual({ revisions: 1, heads: 1, audit: 1 });
  });

  it("rolls back a new revision and pointer together if audit insertion fails", async () => {
    await db.$executeRawUnsafe(`CREATE TRIGGER offline_reject_guidance_audit BEFORE INSERT ON VideoGuidanceAuditEvent BEGIN SELECT RAISE(ABORT, 'offline audit failure'); END`);
    await expect(repository.appendAiCandidate(appendInput())).rejects.toThrow();
    expect(await counts()).toEqual({ revisions: 0, heads: 0, audit: 0 });
  });

  it("rolls back coach activation and its revision when the audit cannot be written", async () => {
    const candidate = await repository.appendAiCandidate(appendInput());
    await db.$executeRawUnsafe(`CREATE TRIGGER offline_reject_guidance_audit BEFORE INSERT ON VideoGuidanceAuditEvent BEGIN SELECT RAISE(ABORT, 'offline audit failure'); END`);
    await expect(repository.reviewAndActivate(reviewInput(candidate))).rejects.toThrow();
    expect(await counts()).toEqual({ revisions: 1, heads: 1, audit: 1 });
    expect(await db.exerciseVideoGuidanceHead.findUniqueOrThrow({ where: { ownerId_exerciseId: { ownerId: persistenceOwner, exerciseId: persistenceExercise } } })).toMatchObject(candidate.head);
  });

  it("imports reviewed legacy payloads without inventing their unknown reviewer or AI provider", async () => {
    const input = {
      ...common("IMPORT"), sourceBinding: persistenceBinding,
      payload: { ...persistencePayload, videoAnalysisStatus: "COACH_REVIEWED" as const, coachReviewedAt: "2026-10-02T02:00:00.000Z" },
      fieldAssessment: persistenceAssessments, aiMetadata: null, provenance: { source: "legacy file" }, importSourceHash: "c".repeat(64),
    };
    const imported = await repository.importLegacy(input);
    expect((await repository.readEffectiveGuidance(persistenceOwner, persistenceExercise)).guidance).toEqual(input.payload);
    const revision = await db.exerciseVideoGuidanceRevision.findUniqueOrThrow({ where: { id: imported.revisionId } });
    expect(revision).toMatchObject({ reviewerActorId: null, aiMetadataJson: null, importSourceHash: input.importSourceHash, revisionOrigin: "LEGACY_IMPORT" });
    expect((await repository.importLegacy(input)).reused).toBe(true);
    expect(await counts()).toEqual({ revisions: 1, heads: 1, audit: 1 });
  });
});
