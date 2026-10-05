import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export type VideoGuidanceReadMode = "FILE" | "SHADOW" | "SQL";
export type VideoGuidanceReadConfig = {
  version: 1;
  owners: Record<string, VideoGuidanceReadMode>;
};
export type VideoGuidanceReadConfigLoader = () => Promise<VideoGuidanceReadConfig>;

export class VideoGuidanceReadConfigError extends Error {
  constructor(readonly code: "INVALID_VIDEO_GUIDANCE_READ_CONFIG" | "VIDEO_GUIDANCE_READ_CONFIG_READ_FAILURE") {
    super(code);
    this.name = "VideoGuidanceReadConfigError";
  }
}

const ownerIdSchema = z.string().min(1).max(2000).refine((value) => value.trim() === value);
const configSchema = z.object({
  version: z.literal(1),
  owners: z.record(ownerIdSchema, z.enum(["FILE", "SHADOW", "SQL"])),
}).strict();

export function parseVideoGuidanceReadConfig(value: unknown): VideoGuidanceReadConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, value)) {
    throw new VideoGuidanceReadConfigError("INVALID_VIDEO_GUIDANCE_READ_CONFIG");
  }
  return parsed.data;
}

export function resolveVideoGuidanceReadMode(config: VideoGuidanceReadConfig, ownerId: string): VideoGuidanceReadMode {
  if (!ownerIdSchema.safeParse(ownerId).success) throw new VideoGuidanceReadConfigError("INVALID_VIDEO_GUIDANCE_READ_CONFIG");
  const parsed = parseVideoGuidanceReadConfig(config);
  return Object.prototype.hasOwnProperty.call(parsed.owners, ownerId) ? parsed.owners[ownerId] : "FILE";
}

/** Explicit local path only. Reload on each call; no environment changes or remote config service. */
export function createFileVideoGuidanceReadConfigLoader(path: string): VideoGuidanceReadConfigLoader {
  return async () => {
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, owners: {} };
      throw new VideoGuidanceReadConfigError("VIDEO_GUIDANCE_READ_CONFIG_READ_FAILURE");
    }
    if (Buffer.byteLength(raw, "utf8") > 64_000) throw new VideoGuidanceReadConfigError("INVALID_VIDEO_GUIDANCE_READ_CONFIG");
    try { return parseVideoGuidanceReadConfig(JSON.parse(raw)); }
    catch { throw new VideoGuidanceReadConfigError("INVALID_VIDEO_GUIDANCE_READ_CONFIG"); }
  };
}
