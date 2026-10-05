import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";
import type { StoredGuidance } from "@/infra/repositories/video-guidance-repository";
import { createVideoGuidanceReadSession, ShadowVideoGuidanceStore } from "@/infra/exercise/shadow-video-guidance-store";
import { createFileVideoGuidanceReadConfigLoader, VideoGuidanceReadConfigError, type VideoGuidanceReadConfig } from "@/infra/exercise/video-guidance-read-config";
import { FileVideoGuidanceStore } from "@/infra/exercise/video-guidance-store";

const catalog = vi.hoisted(() => ({ rows: vi.fn(), assets: vi.fn() }));
vi.mock("@/infra/repositories/exercise-repository", () => ({ listExercisesForMenuPlanner: catalog.rows }));
vi.mock("@/infra/db/prisma", () => ({ prisma: { videoAsset: { findMany: catalog.assets } } }));
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";

const owner = "read-session-owner";
const exercise = "read-session-exercise";
const fileGuidance: ExerciseVideoGuidance = {
  executionSummary: "ファイル側の実施説明", movementPattern: "脚の上げ下げ", countingUnit: "CUSTOM",
  bilateralCounting: null, typicalStructure: null, equipment: [], setup: null, keyCues: [], commonErrors: [], doseObservations: [],
  videoAnalysisStatus: "AI_ANALYZED", sourceVideoId: "read-session-video", analysisVersion: "offline-fixture-v1",
  analyzedAt: "2026-10-04T00:00:00.000Z", coachReviewedAt: null,
};
const sqlGuidance = { ...fileGuidance, executionSummary: "SQL側の実施説明" };
function setup() {
  const fileRead = vi.fn(async () => fileGuidance);
  const sqlRead = vi.fn(async (ownerId: string, exerciseId: string): Promise<StoredGuidance> => ({
    revisionId: "read-session-revision", guidance: sqlGuidance, fieldAssessment: [],
    sourceBinding: { sourceVideoId: fileGuidance.sourceVideoId, contentSha256: "a".repeat(64), storageKey: "uploads/offline.mp4", sourceUrl: null },
    head: { ownerId, exerciseId, rowVersion: 1, approvedRevisionId: null, activeAiRevisionId: "read-session-revision",
      latestCandidateRevisionId: "read-session-revision", updatedAt: new Date("2026-10-04T00:00:00.000Z") },
  }));
  return { fileRead, sqlRead, options: {
    fileStore: { read: fileRead }, sqlRepository: { readEffectiveGuidance: sqlRead }, legacyEvidence: async () => null,
  } };
}
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Request-scoped video-guidance read mode", () => {
  it("clones an owner map once for all 157 item reads and applies changes only to the next session", async () => {
    const t = setup();
    const config: VideoGuidanceReadConfig = { version: 1, owners: { [owner]: "FILE" } };
    const configLoader = vi.fn(async () => config);
    const session = await createVideoGuidanceReadSession({ ...t.options, configLoader });
    expect(await session.read(owner, exercise)).toBe(fileGuidance);
    config.owners[owner] = "SQL";
    config.owners["new-owner"] = "SQL";
    const results = await Promise.all(Array.from({ length: 157 }, (_, index) => session.read(owner, `item-${index}`)));
    expect(results.every((result) => result === fileGuidance)).toBe(true);
    expect(await session.read("new-owner", exercise)).toBe(fileGuidance);
    expect(t.sqlRead).not.toHaveBeenCalled();
    expect(configLoader).toHaveBeenCalledTimes(1);
    const next = await createVideoGuidanceReadSession({ ...t.options, configLoader });
    expect(await next.read(owner, exercise)).toBe(sqlGuidance);
    expect(await next.read("new-owner", exercise)).toBe(sqlGuidance);
    expect(configLoader).toHaveBeenCalledTimes(2);
  });

  it("retains the file configuration snapshot while a later session sees a file update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sachizu-guidance-read-session-"));
    directories.push(directory);
    const path = join(directory, "read-config.json");
    const t = setup();
    await writeFile(path, JSON.stringify({ version: 1, owners: { [owner]: "FILE" } }));
    const configLoader = vi.fn(createFileVideoGuidanceReadConfigLoader(path));
    const session = await createVideoGuidanceReadSession({ ...t.options, configLoader });
    await writeFile(path, JSON.stringify({ version: 1, owners: { [owner]: "SQL" } }));
    expect(await session.read(owner, exercise)).toBe(fileGuidance);
    expect(configLoader).toHaveBeenCalledTimes(1);
    const next = await createVideoGuidanceReadSession({ ...t.options, configLoader });
    expect(await next.read(owner, exercise)).toBe(sqlGuidance);
    expect(configLoader).toHaveBeenCalledTimes(2);
  });

  it.each([{ version: 2, owners: {} }, { version: 1, owners: { [owner]: "UNKNOWN" } }])("rejects invalid configuration before reading guidance: %j", async (value) => {
    const t = setup();
    await expect(createVideoGuidanceReadSession({ ...t.options, configLoader: async () => value as VideoGuidanceReadConfig }))
      .rejects.toMatchObject({ code: "INVALID_VIDEO_GUIDANCE_READ_CONFIG" });
    expect(t.fileRead).not.toHaveBeenCalled();
    expect(t.sqlRead).not.toHaveBeenCalled();
  });

  it("does not conceal configuration read failure as an implicit FILE fallback", async () => {
    const t = setup();
    await expect(createVideoGuidanceReadSession({ ...t.options, configLoader: async () => {
      throw new VideoGuidanceReadConfigError("VIDEO_GUIDANCE_READ_CONFIG_READ_FAILURE");
    } })).rejects.toMatchObject({ code: "VIDEO_GUIDANCE_READ_CONFIG_READ_FAILURE" });
    expect(t.fileRead).not.toHaveBeenCalled();
    expect(t.sqlRead).not.toHaveBeenCalled();
  });

  it("keeps existing direct-store reload behavior available", async () => {
    const t = setup();
    const config: VideoGuidanceReadConfig = { version: 1, owners: { [owner]: "FILE" } };
    const configLoader = vi.fn(async () => config);
    const direct = new ShadowVideoGuidanceStore({ ...t.options, configLoader });
    expect(await direct.read(owner, exercise)).toBe(fileGuidance);
    config.owners[owner] = "SQL";
    expect(await direct.read(owner, exercise)).toBe(sqlGuidance);
    expect(configLoader).toHaveBeenCalledTimes(2);
  });

  it("defaults a new session to FILE without reading SQL", async () => {
    const t = setup();
    const session = await createVideoGuidanceReadSession(t.options);
    expect(await session.read(owner, exercise)).toBe(fileGuidance);
    expect(t.sqlRead).not.toHaveBeenCalled();
  });

  it("leaves the production Composer catalog's omitted-store default on FileVideoGuidanceStore", async () => {
    catalog.rows.mockResolvedValueOnce([{
      id: exercise, ownerId: owner, status: "REVIEWED", name: "Offline fixture", category: "DRILL",
      description: "Offline description", coachingPoint: null, commonMistake: null, metricType: "REPS", difficulty: 1,
      energySystem: null, defaultSets: null, defaultReps: null, defaultDurationSeconds: null,
      defaultDistanceMeters: null, defaultRestSeconds: null, purposes: [], events: [], targets: [], tags: [], videoUrl: null,
    }]);
    catalog.assets.mockResolvedValueOnce([{ id: fileGuidance.sourceVideoId, exerciseId: exercise }]);
    const fileRead = vi.spyOn(FileVideoGuidanceStore.prototype, "read").mockResolvedValueOnce(fileGuidance);
    const result = await listComposerCatalog(owner);
    expect(fileRead).toHaveBeenCalledExactlyOnceWith(owner, exercise);
    expect(result[0].videoGuidance).toBe(fileGuidance);
  });
});
