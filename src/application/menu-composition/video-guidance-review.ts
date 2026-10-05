import {
  GuidanceReviewAccessError, guidanceReviewCommandSchema, guidanceReviewScopeSchema,
  hasGuidancePermission, type GuidanceIdentityPort, type GuidancePermission, type GuidanceReviewOperation,
} from "@/domain/exercise/video-guidance-review";
import { VideoGuidancePersistenceError } from "@/domain/exercise/video-guidance-persistence";
import { guidanceHash, type VideoGuidanceRepository } from "@/infra/repositories/video-guidance-repository";
import type { createGuidanceSourceRepository } from "@/infra/repositories/video-guidance-source-repository";

export type GuidanceReviewDependencies = {
  identity: GuidanceIdentityPort;
  repository: Pick<VideoGuidanceRepository, "readReviewData" | "readReviewRevision" | "reviewAndActivate" | "publishAiCandidate" | "holdCandidate" | "rejectCandidate">;
  sources: Pick<ReturnType<typeof createGuidanceSourceRepository>, "findExercise">;
};

async function authenticate(identity: GuidanceIdentityPort) {
  const actor = await identity.currentIdentity();
  if (!actor || typeof actor.actorId !== "string" || !actor.actorId.trim()) {
    throw new GuidanceReviewAccessError("UNAUTHENTICATED");
  }
  return actor;
}
async function authorize(input: { ownerId: string; exerciseId: string }, actor: Awaited<ReturnType<typeof authenticate>>, deps: GuidanceReviewDependencies, permission: GuidancePermission) {
  if (!hasGuidancePermission(actor, input.ownerId, permission)) {
    throw new GuidanceReviewAccessError("FORBIDDEN");
  }
  const exercise = await deps.sources.findExercise(input.ownerId, input.exerciseId);
  if (!exercise || exercise.ownerId !== input.ownerId || exercise.id !== input.exerciseId) {
    throw new GuidanceReviewAccessError("FORBIDDEN");
  }
  return exercise;
}

export type VideoGuidanceReviewPageData = {
  exercise: NonNullable<Awaited<ReturnType<GuidanceReviewDependencies["sources"]["findExercise"]>>>;
  review: Awaited<ReturnType<GuidanceReviewDependencies["repository"]["readReviewData"]>>;
  allowedOperations?: GuidanceReviewOperation[];
};
export async function loadVideoGuidanceReview(input: unknown, deps: GuidanceReviewDependencies): Promise<VideoGuidanceReviewPageData> {
  const actor = await authenticate(deps.identity);
  const parsed = guidanceReviewScopeSchema.safeParse(input);
  if (!parsed.success) throw new GuidanceReviewAccessError("INVALID_REVIEW");
  const exercise = await authorize(parsed.data, actor, deps, "VIEW_VIDEO_GUIDANCE");
  const review = await deps.repository.readReviewData(parsed.data.ownerId, parsed.data.exerciseId);
  const allowedOperations: GuidanceReviewOperation[] = [];
  if (hasGuidancePermission(actor, parsed.data.ownerId, "REVIEW_VIDEO_GUIDANCE")) allowedOperations.push("HOLD", "REJECT", "APPROVE");
  if (hasGuidancePermission(actor, parsed.data.ownerId, "PUBLISH_VIDEO_GUIDANCE")) allowedOperations.push("PUBLISH_AI");
  return { exercise, review, allowedOperations };
}

export async function submitVideoGuidanceReview(input: unknown, deps: GuidanceReviewDependencies) {
  const actor = await authenticate(deps.identity);
  // strict schemas deliberately reject reviewerActorId / actor / authority supplied by the browser.
  const parsed = guidanceReviewCommandSchema.safeParse(input);
  if (!parsed.success) throw new GuidanceReviewAccessError("INVALID_REVIEW");
  const command = parsed.data;
  await authorize(command, actor, deps, command.operation === "PUBLISH_AI" ? "PUBLISH_VIDEO_GUIDANCE" : "REVIEW_VIDEO_GUIDANCE");
  const candidate = await deps.repository.readReviewRevision(command.ownerId, command.exerciseId, command.candidateRevisionId);
  if (candidate.sourceStatus !== "CURRENT" || guidanceHash(candidate.sourceBinding) !== command.expectedSourceBindingHash) {
    throw new VideoGuidancePersistenceError("SOURCE_MISMATCH");
  }
  const common = {
    ownerId: command.ownerId, exerciseId: command.exerciseId, operationKey: command.operationKey,
    reason: command.reason, actor: { id: actor.actorId, kind: "COACH" as const },
    candidateRevisionId: command.candidateRevisionId, expectedRowVersion: command.expectedRowVersion,
    expectedApprovedRevisionId: command.expectedApprovedRevisionId,
  };
  if (command.operation === "HOLD") return deps.repository.holdCandidate(common);
  if (command.operation === "REJECT") return deps.repository.rejectCandidate(common);
  if (command.operation === "PUBLISH_AI") return deps.repository.publishAiCandidate(common);

  const unresolved = candidate.fieldAssessment.filter((field) => field.state === "UNRESOLVED");
  for (const field of unresolved) {
    const resolution = command.resolutions.find((value) => value.field === field.field);
    // Each unknown requires a deliberate decision plus a revised field value.
    // An Approve click, a checkbox default or copying the old text cannot resolve it.
    if (!resolution || JSON.stringify(command.observation[field.field]) === JSON.stringify(candidate.guidance[field.field])) {
      throw new GuidanceReviewAccessError("UNRESOLVED_FIELDS");
    }
  }
  if (command.resolutions.some((resolution) => !unresolved.some((field) => field.field === resolution.field))) {
    throw new GuidanceReviewAccessError("INVALID_REVIEW");
  }
  const fieldAssessment = candidate.fieldAssessment.map((field) => {
    const resolution = command.resolutions.find((value) => value.field === field.field);
    return resolution ? { ...field, state: resolution.state, reason: resolution.reason,
      evidenceRefs: [...field.evidenceRefs, `coach-review:${command.operationKey}`].slice(-32) } : field;
  });
  return deps.repository.reviewAndActivate({ ...common, observation: command.observation, fieldAssessment,
    provenance: { reviewOperation: command.operationKey, baseCandidateRevisionId: command.candidateRevisionId,
      resolutions: command.resolutions, sourceBindingHashAtSubmit: command.expectedSourceBindingHash },
  });
}
