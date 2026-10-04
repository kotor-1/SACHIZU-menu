import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type ExerciseVideoGuidanceHead, type ExerciseVideoGuidanceRevision } from "@prisma/client";
import { exerciseVideoGuidanceSchema, videoGuidanceObservationSchema, type ExerciseVideoGuidance, type VideoGuidanceObservation } from "@/domain/exercise/video-guidance";
import { VideoGuidancePersistenceError, sourceBindingSchema, fieldAssessmentsSchema, aiMetadataSchema, type SourceBinding, type FieldAssessment, type AIMetadata } from "@/domain/exercise/video-guidance-persistence";

type Db = Prisma.TransactionClient;
export type GuidanceActor = { id: string | null; kind: "AI" | "COACH" | "IMPORT" };
type Scope = { ownerId: string; exerciseId: string };
type Command = Scope & { operationKey: string; actor: GuidanceActor; reason: string };
export type AiGuidanceInput = Command & {
  sourceBinding: SourceBinding; payload: ExerciseVideoGuidance; fieldAssessment: FieldAssessment[];
  aiMetadata: AIMetadata | null; provenance: Record<string, unknown>; parentRevisionId?: string | null;
};
export type LegacyGuidanceInput = Omit<AiGuidanceInput, "parentRevisionId"> & { importSourceHash: string };
export type PublishAiGuidanceInput = Command & {
  candidateRevisionId: string; expectedRowVersion: number; expectedApprovedRevisionId: string | null;
};
export type ReviewGuidanceInput = PublishAiGuidanceInput & {
  observation: VideoGuidanceObservation; fieldAssessment: FieldAssessment[]; provenance: Record<string, unknown>;
};
export type StoredGuidance = {
  revisionId: string; head: ExerciseVideoGuidanceHead; guidance: ExerciseVideoGuidance;
  sourceBinding: SourceBinding; fieldAssessment: FieldAssessment[];
};
export type GuidanceMutationResult = StoredGuidance & { reused: boolean };
export type SourceBindingResolver = (ownerId: string, exerciseId: string, sourceVideoId: string) => Promise<SourceBinding | null>;

/** Stable hashes refer to JSON values, never filesystem paths or object insertion order. */
export function canonicalGuidanceJson(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(canonical);
    if (typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    }
    throw new VideoGuidancePersistenceError("INVALID_PAYLOAD");
  }
  return JSON.stringify(canonical(value));
}
export function guidanceHash(value: unknown) { return createHash("sha256").update(canonicalGuidanceJson(value)).digest("hex"); }
function invalid(): never { throw new VideoGuidancePersistenceError("INVALID_PAYLOAD"); }
function parseExact<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    const parsed = schema.parse(value);
    // Trimming or dropping fields during import would change the legacy read contract.
    if (canonicalGuidanceJson(parsed) !== canonicalGuidanceJson(value)) return invalid();
    return parsed;
  } catch (error) {
    if (error instanceof VideoGuidancePersistenceError) throw error;
    return invalid();
  }
}
function validCommand(input: Command, kind: GuidanceActor["kind"]) {
  if ([input.ownerId, input.exerciseId, input.operationKey, input.reason].some((s) => typeof s !== "string" || !s.trim() || s.length > 2000)) invalid();
  if (!input.actor || input.actor.kind !== kind || (input.actor.id !== null && (typeof input.actor.id !== "string" || !input.actor.id.trim()))) invalid();
  if (kind === "COACH" && input.actor.id === null) invalid();
  canonicalGuidanceJson(input);
}
function validExpectation(input: PublishAiGuidanceInput) {
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0
    || (input.expectedApprovedRevisionId !== null && typeof input.expectedApprovedRevisionId !== "string")) invalid();
}
function typedDbError(error: unknown, reading: boolean): never {
  if (error instanceof VideoGuidancePersistenceError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P1008", "P2028", "P2034"].includes(error.code)) {
    throw new VideoGuidancePersistenceError(reading ? "DB_READ_FAILURE" : "STALE_VIDEO_GUIDANCE");
  }
  throw new VideoGuidancePersistenceError(reading ? "DB_READ_FAILURE" : "DB_WRITE_FAILURE");
}

/** Explicitly injected client and source manifest. No runtime registration/cutover, media reads or AI calls. */
export class VideoGuidanceRepository {
  constructor(private readonly db: PrismaClient, private readonly resolveSourceBinding: SourceBindingResolver,
    private readonly now: () => Date = () => new Date()) {}

  /** Capability handed to an AI worker: it cannot publish or change an approved pointer. */
  aiWriter() { return Object.freeze({ appendAiCandidate: this.appendAiCandidate.bind(this) }); }
  reviewWriter() { return Object.freeze({ publishAiCandidate: this.publishAiCandidate.bind(this), reviewAndActivate: this.reviewAndActivate.bind(this) }); }

  private async ownedExercise(tx: Db, scope: Scope) {
    const exercise = await tx.exercise.findUnique({ where: { id: scope.exerciseId }, select: { ownerId: true } });
    if (!exercise) throw new VideoGuidancePersistenceError("NOT_FOUND");
    if (exercise.ownerId !== scope.ownerId) throw new VideoGuidancePersistenceError("CROSS_BOUNDARY");
  }
  private async binding(tx: Db, scope: Scope, expected: SourceBinding) {
    await this.ownedExercise(tx, scope);
    const source = await tx.videoAsset.findUnique({ where: { id: expected.sourceVideoId }, select: { ownerId: true, exerciseId: true, storageKey: true, sourceUrl: true } });
    if (!source) throw new VideoGuidancePersistenceError("SOURCE_MISMATCH");
    if (source.ownerId !== scope.ownerId || source.exerciseId !== scope.exerciseId) throw new VideoGuidancePersistenceError("CROSS_BOUNDARY");
    const current = await this.resolveSourceBinding(scope.ownerId, scope.exerciseId, expected.sourceVideoId);
    if (!current || guidanceHash(parseExact(sourceBindingSchema, current)) !== guidanceHash(expected)
      || source.storageKey !== expected.storageKey || source.sourceUrl !== expected.sourceUrl) {
      throw new VideoGuidancePersistenceError("SOURCE_MISMATCH");
    }
  }
  private async head(tx: Db, scope: Scope, create = false) {
    const identity = { ownerId: scope.ownerId, exerciseId: scope.exerciseId };
    let head = await tx.exerciseVideoGuidanceHead.findUnique({ where: { ownerId_exerciseId: identity } });
    if (!head && create) head = await tx.exerciseVideoGuidanceHead.create({ data: { ...identity, rowVersion: 0 } });
    if (!head) throw new VideoGuidancePersistenceError("NOT_FOUND");
    return head;
  }
  private async scopedRevision(tx: Db, scope: Scope, id: string) {
    const revision = await tx.exerciseVideoGuidanceRevision.findUnique({ where: { id } });
    if (!revision) throw new VideoGuidancePersistenceError("NOT_FOUND");
    if (revision.ownerId !== scope.ownerId || revision.exerciseId !== scope.exerciseId) throw new VideoGuidancePersistenceError("CROSS_BOUNDARY");
    return revision;
  }
  private decode(revision: ExerciseVideoGuidanceRevision) {
    try {
      const guidance = parseExact(exerciseVideoGuidanceSchema, JSON.parse(revision.payloadJson));
      const sourceBinding = parseExact(sourceBindingSchema, JSON.parse(revision.sourceBindingJson));
      const fieldAssessment = parseExact(fieldAssessmentsSchema, JSON.parse(revision.fieldAssessmentJson));
      if (guidanceHash(guidance) !== revision.payloadHash || guidanceHash(sourceBinding) !== revision.sourceBindingHash
        || sourceBinding.sourceVideoId !== revision.sourceVideoId || guidance.sourceVideoId !== revision.sourceVideoId
        || guidance.videoAnalysisStatus !== revision.authorityStatus
        || new Date(guidance.analyzedAt).getTime() !== revision.analyzedAt.getTime()
        || (guidance.coachReviewedAt ? new Date(guidance.coachReviewedAt).getTime() : null) !== (revision.reviewedAt?.getTime() ?? null)) invalid();
      return { guidance, sourceBinding, fieldAssessment };
    } catch (error) {
      if (error instanceof VideoGuidancePersistenceError) throw error;
      return invalid();
    }
  }
  private async stored(tx: Db, scope: Scope, revisionId: string): Promise<StoredGuidance> {
    const revision = await this.scopedRevision(tx, scope, revisionId);
    const decoded = this.decode(revision);
    await this.binding(tx, scope, decoded.sourceBinding);
    return { revisionId, head: await this.head(tx, scope), ...decoded };
  }
  private async read(scope: Scope, candidate: boolean) {
    try {
      await this.ownedExercise(this.db, scope);
      // The head read is this read's snapshot boundary. Its target revision is
      // immutable and cannot be deleted. Retain this same head/version even if
      // a later review advances it; never mix a new head with an older payload.
      // Catalog loading reads many exercises concurrently, so do not reserve an
      // interactive SQLite transaction/connection for every read-only item.
      const head = await this.head(this.db, scope);
      const id = candidate ? head.latestCandidateRevisionId : (head.approvedRevisionId ?? head.activeAiRevisionId);
      if (!id) throw new VideoGuidancePersistenceError("NOT_FOUND");
      try {
        const revision = await this.scopedRevision(this.db, scope, id);
        const decoded = this.decode(revision);
        await this.binding(this.db, scope, decoded.sourceBinding);
        if (head.approvedRevisionId && !candidate && decoded.guidance.videoAnalysisStatus !== "COACH_REVIEWED") invalid();
        return { revisionId: id, head, ...decoded };
      } catch (error) {
        if (error instanceof VideoGuidancePersistenceError && error.code === "NOT_FOUND") invalid();
        throw error;
      }
    } catch (error) { return typedDbError(error, true); }
  }
  readEffectiveGuidance(ownerId: string, exerciseId: string) { return this.read({ ownerId, exerciseId }, false); }
  readCandidateGuidance(ownerId: string, exerciseId: string) { return this.read({ ownerId, exerciseId }, true); }

  private async replay(tx: Db, input: Command, operation: string, operationHash: string): Promise<GuidanceMutationResult | null> {
    const prior = await tx.videoGuidanceAuditEvent.findFirst({ where: { ownerId: input.ownerId, exerciseId: input.exerciseId, operationKey: input.operationKey } });
    if (!prior) return null;
    const after = JSON.parse(prior.afterJson) as { operationHash: string; revisionId: string };
    if (prior.operation !== operation || after.operationHash !== operationHash) throw new VideoGuidancePersistenceError("OPERATION_KEY_CONFLICT");
    return { ...await this.stored(tx, input, after.revisionId), reused: true };
  }
  private async mutation(input: Command, operation: string, apply: (tx: Db, operationHash: string) => Promise<GuidanceMutationResult>) {
    const hash = guidanceHash({ operation, input });
    try {
      return await this.db.$transaction(async (tx) => {
        await this.ownedExercise(tx, input);
        return await this.replay(tx, input, operation, hash) ?? await apply(tx, hash);
      }, { maxWait: 10_000, timeout: 10_000 });
    } catch (error) {
      // A competing identical command may have committed before a uniqueness,
      // append-only trigger or SQLite lock failure. Re-read only; never retry writes.
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        try {
          const prior = await this.db.$transaction((tx) => this.replay(tx, input, operation, hash));
          if (prior) return prior;
        } catch (replayError) { return typedDbError(replayError, false); }
      }
      return typedDbError(error, false);
    }
  }
  private async updateHead(tx: Db, scope: Scope, before: ExerciseVideoGuidanceHead,
    pointers: { approvedRevisionId?: string; activeAiRevisionId?: string; latestCandidateRevisionId?: string }) {
    const result = await tx.exerciseVideoGuidanceHead.updateMany({
      where: { ownerId: scope.ownerId, exerciseId: scope.exerciseId, rowVersion: before.rowVersion, approvedRevisionId: before.approvedRevisionId },
      data: { ...pointers, rowVersion: { increment: 1 }, updatedAt: this.now() },
    });
    if (result.count !== 1) throw new VideoGuidancePersistenceError("STALE_VIDEO_GUIDANCE");
    return this.head(tx, scope);
  }
  private expectation(head: ExerciseVideoGuidanceHead, input: PublishAiGuidanceInput) {
    if (head.rowVersion !== input.expectedRowVersion || head.approvedRevisionId !== input.expectedApprovedRevisionId) {
      throw new VideoGuidancePersistenceError("STALE_VIDEO_GUIDANCE");
    }
  }
  private async audit(tx: Db, input: Command, operation: string, operationHash: string, revisionId: string,
    before: ExerciseVideoGuidanceHead, after: ExerciseVideoGuidanceHead, detail: Record<string, unknown> = {}) {
    await tx.videoGuidanceAuditEvent.create({ data: {
      ownerId: input.ownerId, exerciseId: input.exerciseId, actorId: input.actor.id, actorKind: input.actor.kind,
      operation, reason: input.reason, operationKey: input.operationKey,
      beforeJson: JSON.stringify(before), afterJson: JSON.stringify({ ...after, operationHash, revisionId, ...detail }),
      expectedRowVersion: before.rowVersion, resultingRowVersion: after.rowVersion, timestamp: this.now(),
    } });
  }
  private inputData(input: AiGuidanceInput) {
    const payload = parseExact(exerciseVideoGuidanceSchema, input.payload);
    const source = parseExact(sourceBindingSchema, input.sourceBinding);
    const assessment = parseExact(fieldAssessmentsSchema, input.fieldAssessment);
    const aiMetadata = parseExact(aiMetadataSchema, input.aiMetadata);
    if (payload.sourceVideoId !== source.sourceVideoId) throw new VideoGuidancePersistenceError("SOURCE_MISMATCH");
    return { payload, source, assessment, aiMetadata };
  }
  private async createRevision(tx: Db, input: AiGuidanceInput, operationHash: string, origin: string,
    extras: { parentRevisionId?: string | null; baseAiRevisionId?: string | null; reviewerActorId?: string | null; reviewReason?: string | null; importSourceHash?: string | null } = {}) {
    const { payload, source, assessment, aiMetadata } = this.inputData(input);
    for (const id of [extras.parentRevisionId, extras.baseAiRevisionId]) {
      if (id) await this.scopedRevision(tx, input, id);
    }
    return tx.exerciseVideoGuidanceRevision.create({ data: {
      ownerId: input.ownerId, exerciseId: input.exerciseId, sourceVideoId: source.sourceVideoId,
      sourceBindingJson: canonicalGuidanceJson(source), sourceBindingHash: guidanceHash(source),
      payloadJson: canonicalGuidanceJson(payload), payloadHash: guidanceHash(payload), authorityStatus: payload.videoAnalysisStatus,
      revisionOrigin: origin, fieldAssessmentJson: canonicalGuidanceJson(assessment),
      aiMetadataJson: aiMetadata === null ? null : canonicalGuidanceJson(aiMetadata), provenanceJson: canonicalGuidanceJson(input.provenance),
      analyzedAt: new Date(payload.analyzedAt), reviewedAt: payload.coachReviewedAt ? new Date(payload.coachReviewedAt) : null,
      reviewerActorId: extras.reviewerActorId ?? null, reviewReason: extras.reviewReason ?? null,
      parentRevisionId: extras.parentRevisionId ?? null, baseAiRevisionId: extras.baseAiRevisionId ?? null,
      importSourceHash: extras.importSourceHash ?? null, operationKey: input.operationKey, operationHash,
      createdAt: this.now(),
    } });
  }
  async appendAiCandidate(input: AiGuidanceInput) {
    validCommand(input, "AI"); const { payload } = this.inputData(input);
    if (payload.videoAnalysisStatus !== "AI_ANALYZED") invalid();
    return this.mutation(input, "APPEND_AI_CANDIDATE", async (tx, hash) => {
      await this.binding(tx, input, input.sourceBinding);
      const before = await this.head(tx, input, true);
      const revision = await this.createRevision(tx, input, hash, "AI_ANALYSIS", { parentRevisionId: input.parentRevisionId });
      const after = await this.updateHead(tx, input, before, { latestCandidateRevisionId: revision.id });
      await this.audit(tx, input, "APPEND_AI_CANDIDATE", hash, revision.id, before, after);
      return { ...await this.stored(tx, input, revision.id), reused: false };
    });
  }
  async publishAiCandidate(input: PublishAiGuidanceInput) {
    validCommand(input, "COACH"); validExpectation(input);
    return this.mutation(input, "PUBLISH_AI_CANDIDATE", async (tx, hash) => {
      const before = await this.head(tx, input); this.expectation(before, input);
      if (before.approvedRevisionId !== null) throw new VideoGuidancePersistenceError("STALE_VIDEO_GUIDANCE");
      const candidate = await this.stored(tx, input, input.candidateRevisionId);
      if (candidate.guidance.videoAnalysisStatus !== "AI_ANALYZED") invalid();
      const after = await this.updateHead(tx, input, before, { activeAiRevisionId: candidate.revisionId });
      await this.audit(tx, input, "PUBLISH_AI_CANDIDATE", hash, candidate.revisionId, before, after);
      return { ...candidate, head: after, reused: false };
    });
  }
  async reviewAndActivate(input: ReviewGuidanceInput) {
    validCommand(input, "COACH"); validExpectation(input);
    const observation = parseExact(videoGuidanceObservationSchema, input.observation);
    const assessment = parseExact(fieldAssessmentsSchema, input.fieldAssessment);
    if (assessment.some((field) => field.state === "UNRESOLVED")) invalid();
    return this.mutation(input, "REVIEW_AND_ACTIVATE", async (tx, hash) => {
      const before = await this.head(tx, input); this.expectation(before, input);
      const candidate = await this.scopedRevision(tx, input, input.candidateRevisionId);
      const { guidance, sourceBinding, fieldAssessment: previousAssessment } = await this.stored(tx, input, candidate.id);
      for (const unresolved of previousAssessment.filter((field) => field.state === "UNRESOLVED")) {
        const decision = assessment.find((field) => field.field === unresolved.field);
        if (!decision || !["KNOWN", "NOT_APPLICABLE"].includes(decision.state)) invalid();
      }
      if (guidance.videoAnalysisStatus !== "AI_ANALYZED") invalid();
      const reviewed: ExerciseVideoGuidance = { ...guidance, ...observation, videoAnalysisStatus: "COACH_REVIEWED", coachReviewedAt: this.now().toISOString() };
      const revision = await this.createRevision(tx, { ...input, sourceBinding, payload: reviewed,
        fieldAssessment: assessment, aiMetadata: candidate.aiMetadataJson === null ? null : JSON.parse(candidate.aiMetadataJson) }, hash, "COACH_REVIEW", {
        parentRevisionId: before.approvedRevisionId ?? before.activeAiRevisionId ?? candidate.id,
        baseAiRevisionId: candidate.id, reviewerActorId: input.actor.id, reviewReason: input.reason,
      });
      const after = await this.updateHead(tx, input, before, { approvedRevisionId: revision.id });
      const changes = Object.entries(reviewed).filter(([key, value]) => canonicalGuidanceJson(value) !== canonicalGuidanceJson(guidance[key as keyof ExerciseVideoGuidance]))
        .map(([field, value]) => ({ field, before: guidance[field as keyof ExerciseVideoGuidance], after: value }));
      await this.audit(tx, input, "REVIEW_AND_ACTIVATE", hash, revision.id, before, after, { baseAiRevisionId: candidate.id, changes });
      return { ...await this.stored(tx, input, revision.id), reused: false };
    });
  }
  async importLegacy(input: LegacyGuidanceInput) {
    validCommand(input, "IMPORT"); this.inputData(input);
    if (!/^[a-f0-9]{64}$/.test(input.importSourceHash)) invalid();
    return this.mutation(input, "IMPORT_LEGACY", async (tx, hash) => {
      await this.binding(tx, input, input.sourceBinding);
      const before = await this.head(tx, input, true);
      if (before.approvedRevisionId || before.activeAiRevisionId || before.latestCandidateRevisionId || before.rowVersion !== 0) {
        throw new VideoGuidancePersistenceError("STALE_VIDEO_GUIDANCE");
      }
      const revision = await this.createRevision(tx, input, hash, "LEGACY_IMPORT", { importSourceHash: input.importSourceHash });
      const pointers = input.payload.videoAnalysisStatus === "COACH_REVIEWED"
        ? { approvedRevisionId: revision.id }
        : { activeAiRevisionId: revision.id, latestCandidateRevisionId: revision.id };
      const after = await this.updateHead(tx, input, before, pointers);
      await this.audit(tx, input, "IMPORT_LEGACY", hash, revision.id, before, after);
      return { ...await this.stored(tx, input, revision.id), reused: false };
    });
  }
}
