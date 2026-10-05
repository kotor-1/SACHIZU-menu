import type { PrismaClient } from "@prisma/client";

/** Server-side owned metadata lookup; no catalog mutation and no default-coach fallback. */
export function createGuidanceSourceRepository(db: PrismaClient) {
  return {
    findExercise(ownerId: string, exerciseId: string) {
      return db.exercise.findFirst({ where: { id: exerciseId, ownerId }, select: {
        id: true, ownerId: true, name: true, videoUrl: true, metricType: true,
        defaultSets: true, defaultReps: true, defaultDistanceMeters: true, defaultRestSeconds: true,
      } });
    },
    findVideo(ownerId: string, exerciseId: string, sourceVideoId: string) {
      return db.videoAsset.findFirst({ where: { id: sourceVideoId, ownerId, exerciseId },
        select: { id: true, storageKey: true, sourceUrl: true } });
    },
  };
}
