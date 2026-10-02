import { exerciseVideoGuidanceSchema, videoGuidanceObservationSchema, type VideoGuidanceObservation } from "@/domain/exercise/video-guidance";
import type { VideoGuidanceStore } from "@/infra/exercise/video-guidance-store";

export type OwnedVideoSource = { id: string; ownerId: string; exerciseId: string; localPath: string };
export interface VideoGuidanceAnalyzer {
  analyze(source: OwnedVideoSource): Promise<VideoGuidanceObservation>;
}

/** Explicit one-exercise enrichment only. Not imported by the generation runtime. */
export async function enrichExerciseVideo(input: { ownerId: string; exerciseId: string; sourceVideoId: string; analysisVersion: string }, deps: {
  store: VideoGuidanceStore; findLocalVideo: (id: string) => Promise<OwnedVideoSource | null>;
  analyzer: VideoGuidanceAnalyzer; now?: () => Date;
}) {
  const source = await deps.findLocalVideo(input.sourceVideoId);
  if (!source || source.id !== input.sourceVideoId || source.ownerId !== input.ownerId || source.exerciseId !== input.exerciseId) throw new Error("INVALID_VIDEO_SOURCE");
  const cached = await deps.store.read(input.ownerId, input.exerciseId);
  if (cached?.sourceVideoId === source.id && cached.analysisVersion === input.analysisVersion) return { guidance: cached, reused: true };
  const observations = videoGuidanceObservationSchema.parse(await deps.analyzer.analyze(source));
  const guidance = exerciseVideoGuidanceSchema.parse({ ...observations, videoAnalysisStatus: "AI_ANALYZED",
    sourceVideoId: source.id, analysisVersion: input.analysisVersion,
    analyzedAt: (deps.now?.() ?? new Date()).toISOString(), coachReviewedAt: null });
  await deps.store.write(input.ownerId, input.exerciseId, guidance);
  return { guidance, reused: false };
}

/** Called only after an explicit human review; does not change Exercise.REVIEWED. */
export async function recordVideoGuidanceCoachReview(input: { ownerId: string; exerciseId: string; analysisVersion: string; sourceVideoId: string }, store: VideoGuidanceStore, now = new Date()) {
  const cached = await store.read(input.ownerId, input.exerciseId);
  if (!cached || cached.analysisVersion !== input.analysisVersion || cached.sourceVideoId !== input.sourceVideoId) throw new Error("STALE_VIDEO_GUIDANCE");
  const reviewed = exerciseVideoGuidanceSchema.parse({ ...cached, videoAnalysisStatus: "COACH_REVIEWED", coachReviewedAt: now.toISOString() });
  await store.write(input.ownerId, input.exerciseId, reviewed);
  return reviewed;
}
