import { access, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { listExercisesForMenuPlanner } from "@/infra/repositories/exercise-repository";
import { prisma } from "@/infra/db/prisma";
import { FileVideoGuidanceStore, type VideoGuidanceStore } from "@/infra/exercise/video-guidance-store";
import type { OwnedVideoSource } from "@/application/menu-composition/video-enrichment";

export async function listComposerCatalog(ownerId: string, store: VideoGuidanceStore = new FileVideoGuidanceStore()): Promise<ComposerCatalogExercise[]> {
  const rows = await listExercisesForMenuPlanner(ownerId);
  const assets = await prisma.videoAsset.findMany({ where: { ownerId, exerciseId: { in: rows.map((row) => row.id) } }, select: { id: true, exerciseId: true } });
  const assetExercises = new Map(assets.map((asset) => [asset.id, asset.exerciseId]));
  return Promise.all(rows.filter((row) => row.status === "REVIEWED").map(async (row) => {
    const cached = await store.read(ownerId, row.id);
    const videoGuidance = cached && assetExercises.get(cached.sourceVideoId) === row.id ? cached : null;
    return {
      id: row.id, ownerId: row.ownerId, status: row.status, name: row.name, category: row.category,
      description: row.description, coachingPoint: row.coachingPoint, commonMistake: row.commonMistake,
      metricType: row.metricType, difficulty: row.difficulty, energySystem: row.energySystem,
      defaultSets: row.defaultSets, defaultReps: row.defaultReps, defaultDurationSeconds: row.defaultDurationSeconds,
      defaultDistanceMeters: row.defaultDistanceMeters, defaultRestSeconds: row.defaultRestSeconds,
      purposes: row.purposes.map((x) => x.purpose), events: row.events.map((x) => x.event),
      targets: row.targets.map((x) => x.target), tags: row.tags.map((x) => x.tag.name),
      videoUrl: row.videoUrl, videoGuidance,
    };
  }));
}

/** Resolve existing local assets; never download a video or contact an external URL. */
export async function findOwnedLocalVideo(id: string, ownerId: string): Promise<OwnedVideoSource | null> {
  const asset = await prisma.videoAsset.findFirst({ where: { id, ownerId }, include: { exercise: { select: { ownerId: true } } } });
  if (!asset?.exerciseId || asset.exercise?.ownerId !== ownerId) return null;
  try {
    const root = await realpath(resolve(process.cwd(), "public"));
    const candidate = resolve(root, asset.storageKey.replace(/^\/+/, ""));
    const localPath = await realpath(candidate);
    const within = relative(root, localPath);
    if (within.startsWith("..") || isAbsolute(within)) return null;
    await access(localPath);
    return { id: asset.id, ownerId: asset.ownerId, exerciseId: asset.exerciseId, localPath };
  } catch { return null; }
}
