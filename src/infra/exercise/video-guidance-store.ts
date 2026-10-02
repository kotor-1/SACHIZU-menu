import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { exerciseVideoGuidanceSchema, type ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";

export interface VideoGuidanceStore {
  read(ownerId: string, exerciseId: string): Promise<ExerciseVideoGuidance | null>;
  write(ownerId: string, exerciseId: string, guidance: ExerciseVideoGuidance): Promise<void>;
}
const entrySchema = z.object({ ownerId: z.string(), exerciseId: z.string(), guidance: exerciseVideoGuidanceSchema }).strict();

/** Private, reusable knowledge cache. No Exercise defaults, AnalysisJob or DB rows are changed. */
export class FileVideoGuidanceStore implements VideoGuidanceStore {
  constructor(private readonly directory = join(process.cwd(), ".data", "exercise-video-guidance")) {}
  private path(ownerId: string, exerciseId: string) {
    const key = createHash("sha256").update(JSON.stringify([ownerId, exerciseId])).digest("hex");
    return join(this.directory, `${key}.json`);
  }
  async read(ownerId: string, exerciseId: string) {
    try {
      const raw = await readFile(this.path(ownerId, exerciseId), "utf8");
      if (raw.length > 32000) return null;
      const entry = entrySchema.parse(JSON.parse(raw));
      return entry.ownerId === ownerId && entry.exerciseId === exerciseId ? entry.guidance : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      // Invalid cached knowledge must never silently inform a new plan.
      return null;
    }
  }
  async write(ownerId: string, exerciseId: string, guidance: ExerciseVideoGuidance) {
    const entry = entrySchema.parse({ ownerId, exerciseId, guidance });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(ownerId, exerciseId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const json = JSON.stringify(entry);
    // Retain every analysis/review revision; the latest pointer is atomic.
    await writeFile(`${destination}.${randomUUID()}.revision`, json, { flag: "wx", mode: 0o600 });
    await writeFile(temporary, json, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }
}
