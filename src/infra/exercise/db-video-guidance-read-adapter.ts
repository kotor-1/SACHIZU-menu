import type { VideoGuidanceStore } from "./video-guidance-store";
import type { VideoGuidanceRepository } from "@/infra/repositories/video-guidance-repository";
import { VideoGuidancePersistenceError } from "@/domain/exercise/video-guidance-persistence";

/** Opt-in read compatibility only. Production still uses FileVideoGuidanceStore. */
export class DbVideoGuidanceReadAdapter implements VideoGuidanceStore {
  constructor(private readonly repository: Pick<VideoGuidanceRepository, "readEffectiveGuidance">) {}
  async read(ownerId: string, exerciseId: string) {
    try { return (await this.repository.readEffectiveGuidance(ownerId, exerciseId)).guidance; }
    catch (error) {
      if (error instanceof VideoGuidancePersistenceError && error.code === "NOT_FOUND") return null;
      // DB failure/corruption/source mismatch must fail the caller, not look like missing knowledge.
      throw error;
    }
  }
  async write(): Promise<never> { throw new VideoGuidancePersistenceError("WRITE_AUTHORITY_REQUIRED"); }
}
