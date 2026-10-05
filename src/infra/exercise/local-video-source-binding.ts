import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { VideoGuidancePersistenceError, type SourceBinding } from "@/domain/exercise/video-guidance-persistence";
import type { SourceBindingResolver } from "@/infra/repositories/video-guidance-repository";

type VideoLookup = (owner: string, exercise: string, source: string) => Promise<{
  id: string; storageKey: string; sourceUrl: string | null;
} | null>;

/** Review-time freshness check. Reads bytes for SHA only; never decodes or analyzes video. */
export function createLocalVideoSourceBindingResolver(publicDirectory: string, findVideo: VideoLookup): SourceBindingResolver {
  return async (ownerId, exerciseId, sourceVideoId): Promise<SourceBinding | null> => {
    const asset = await findVideo(ownerId, exerciseId, sourceVideoId);
    if (!asset || asset.id !== sourceVideoId) return null;
    const mismatch = () => new VideoGuidancePersistenceError("SOURCE_MISMATCH");
    let path: string;
    try {
      const root = await realpath(publicDirectory);
      path = await realpath(resolve(root, asset.storageKey.replace(/^\/+/, "")));
      const within = relative(root, path);
      if (!within || within.startsWith("..") || isAbsolute(within)) throw mismatch();
    } catch { throw mismatch(); }
    const file = await open(path, "r").catch(() => { throw mismatch(); });
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw mismatch();
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat({ bigint: true });
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw mismatch();
      // Re-resolve the path as well: an atomic file replacement must not bless
      // the old open descriptor as the current source.
      const currentPath = await realpath(resolve(publicDirectory, asset.storageKey.replace(/^\/+/, "")));
      const current = await open(currentPath, "r");
      try {
        const stat = await current.stat({ bigint: true });
        if (currentPath !== path || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) throw mismatch();
      } finally { await current.close(); }
      return { sourceVideoId, storageKey: asset.storageKey, sourceUrl: asset.sourceUrl, contentSha256: hash.digest("hex") };
    } finally { await file.close(); }
  };
}
