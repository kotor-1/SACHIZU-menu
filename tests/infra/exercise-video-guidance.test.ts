import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileVideoGuidanceStore } from "@/infra/exercise/video-guidance-store";
import { enrichExerciseVideo, recordVideoGuidanceCoachReview } from "@/application/menu-composition/video-enrichment";
import { videoAnalysisStatus, videoGuidanceObservationSchema } from "@/domain/exercise/video-guidance";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "sachizu-guidance-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const observations = { executionSummary: "壁に手をついて膝を入れ替える", movementPattern: "左右交互", countingUnit: "ALTERNATING_TOTAL" as const,
  bilateralCounting: "左右合計", typicalStructure: "立位", equipment: ["壁"], setup: "壁に手をつく", keyCues: ["姿勢を保つ"], commonErrors: ["腰が反る"], doseObservations: ["動画では10回。毎回10回という指示ではない"] };
const input = { ownerId: "owner-a", exerciseId: "exercise-a", sourceVideoId: "video-a", analysisVersion: "guidance-v1" };
const source = { id: "video-a", ownerId: "owner-a", exerciseId: "exercise-a", localPath: "/offline/mock/local-video.mp4" };

describe("One-time reusable video guidance, injected offline analyzer", () => {
  it("starts NOT_ANALYZED, analyzes once, then reuses cached observations", async () => {
    const store = new FileVideoGuidanceStore(directory);
    expect(videoAnalysisStatus(await store.read(input.ownerId, input.exerciseId))).toBe("NOT_ANALYZED");
    const analyze = vi.fn(async () => observations);
    const deps = { store, analyzer: { analyze }, findLocalVideo: async () => source };
    const first = await enrichExerciseVideo(input, deps);
    const second = await enrichExerciseVideo(input, deps);
    expect(first.reused).toBe(false); expect(second.reused).toBe(true); expect(analyze).toHaveBeenCalledTimes(1);
    expect(first.guidance).toMatchObject({ videoAnalysisStatus: "AI_ANALYZED", sourceVideoId: "video-a", analysisVersion: "guidance-v1", coachReviewedAt: null });
    expect(first.guidance).not.toHaveProperty("plannedReps");
  });
  it("separates explicit coach review from AI analysis and keeps its status on cache reuse", async () => {
    const store = new FileVideoGuidanceStore(directory);
    const analyze = vi.fn(async () => observations);
    const deps = { store, analyzer: { analyze }, findLocalVideo: async () => source };
    await enrichExerciseVideo(input, deps);
    await recordVideoGuidanceCoachReview(input, store);
    expect((await enrichExerciseVideo(input, deps)).guidance.videoAnalysisStatus).toBe("COACH_REVIEWED");
    expect(analyze).toHaveBeenCalledTimes(1);
    await expect(recordVideoGuidanceCoachReview({ ...input, analysisVersion: "other" }, store)).rejects.toThrow("STALE_VIDEO_GUIDANCE");
  });
  it("does not reuse another owner/asset/version and rejects source ownership mismatch before analysis", async () => {
    const store = new FileVideoGuidanceStore(directory);
    const analyze = vi.fn(async () => observations);
    await expect(enrichExerciseVideo({ ...input, ownerId: "other-owner" }, { store, analyzer: { analyze }, findLocalVideo: async () => source })).rejects.toThrow("INVALID_VIDEO_SOURCE");
    expect(analyze).not.toHaveBeenCalled();
    const deps = { store, analyzer: { analyze }, findLocalVideo: async () => source };
    await enrichExerciseVideo(input, deps);
    expect(await store.read("other-owner", input.exerciseId)).toBeNull();
    expect((await enrichExerciseVideo({ ...input, analysisVersion: "guidance-v2" }, deps)).reused).toBe(false);
    expect(analyze).toHaveBeenCalledTimes(2);
  });
  it("allows counting semantics but rejects an analyzer pretending to be coach-reviewed", () => {
    expect(videoGuidanceObservationSchema.safeParse({ ...observations, videoAnalysisStatus: "COACH_REVIEWED" }).success).toBe(false);
    expect(videoGuidanceObservationSchema.safeParse({ ...observations, countingUnit: "UNKNOWN" }).success).toBe(false);
  });
});
