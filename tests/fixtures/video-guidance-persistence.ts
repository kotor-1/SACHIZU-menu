import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { ExerciseVideoGuidance, VideoGuidanceObservation } from "@/domain/exercise/video-guidance";
import { VIDEO_GUIDANCE_FIELDS, type FieldAssessment, type SourceBinding } from "@/domain/exercise/video-guidance-persistence";

export const persistenceOwner = "guidance-owner-a";
export const persistenceExercise = "guidance-exercise-a";
export const persistenceNow = new Date("2026-10-03T01:00:00.000Z");
export const persistenceBinding: SourceBinding = {
  sourceVideoId: "guidance-video-a", contentSha256: "a".repeat(64),
  storageKey: "uploads/guidance-video-a.mp4", sourceUrl: "https://example.test/video-a",
};
export const persistenceObservation: VideoGuidanceObservation = {
  executionSummary: "片脚で跳び、着地する", movementPattern: "片脚の連続跳躍", countingUnit: "PER_SIDE",
  bilateralCounting: "片側を完了してから反対側", typicalStructure: "片側10回、その後反対側10回",
  equipment: [], setup: "動ける場所を確保する", keyCues: ["姿勢を保つ"], commonErrors: [],
  doseObservations: ["COACH_DEFINED: 1跳躍を1回として片側10回ずつ"],
};
export const persistencePayload: ExerciseVideoGuidance = {
  ...persistenceObservation, videoAnalysisStatus: "AI_ANALYZED", sourceVideoId: persistenceBinding.sourceVideoId,
  analysisVersion: "test-analysis-v1", analyzedAt: "2026-10-02T01:00:00.000Z", coachReviewedAt: null,
};
export const persistenceAssessments: FieldAssessment[] = VIDEO_GUIDANCE_FIELDS.map((field) => ({
  field, state: "KNOWN", reason: "Offline fixture evidence", evidenceRefs: ["fixture:visual-sequence-1"],
}));

/** Every test uses a copied, migrated temporary database; neither repo DB is opened. */
export async function createPersistenceDatabaseTemplate() {
  const directory = await mkdtemp(join(tmpdir(), "sachizu-guidance-persistence-"));
  const prismaDirectory = join(directory, "prisma");
  await mkdir(prismaDirectory);
  await copyFile(resolve("prisma/schema.prisma"), join(prismaDirectory, "schema.prisma"));
  await cp(resolve("prisma/migrations"), join(prismaDirectory, "migrations"), { recursive: true });
  const templatePath = join(directory, "template.db");
  try {
    execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", join(prismaDirectory, "schema.prisma")], {
      cwd: directory,
      env: { ...process.env, DATABASE_URL: `file:${templatePath}`, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
      stdio: "pipe", timeout: 60_000,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let sequence = 0;
  const databasePaths = new WeakMap<PrismaClient, string>();
  return {
    async open() {
      const databasePath = join(directory, `case-${++sequence}.db`);
      await copyFile(templatePath, databasePath);
      const db = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
      databasePaths.set(db, databasePath);
      await db.$connect();
      await db.exercise.createMany({ data: [
        { id: persistenceExercise, ownerId: persistenceOwner, name: "Guidance fixture A", category: "DRILL" },
        { id: "guidance-exercise-b", ownerId: persistenceOwner, name: "Guidance fixture B", category: "DRILL" },
        { id: "guidance-exercise-other-owner", ownerId: "guidance-owner-b", name: "Other owner", category: "DRILL" },
      ] });
      await db.videoAsset.createMany({ data: [
        { id: persistenceBinding.sourceVideoId, ownerId: persistenceOwner, exerciseId: persistenceExercise,
          storageKey: persistenceBinding.storageKey, sourceUrl: persistenceBinding.sourceUrl, filename: "video-a.mp4" },
        { id: "guidance-video-b", ownerId: persistenceOwner, exerciseId: "guidance-exercise-b",
          storageKey: "uploads/guidance-video-b.mp4", filename: "video-b.mp4" },
      ] });
      return db;
    },
    peer(db: PrismaClient) {
      const databasePath = databasePaths.get(db);
      if (!databasePath) throw new Error("Unknown temporary test database");
      return new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
