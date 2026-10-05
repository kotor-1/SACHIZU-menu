import { AnalyzerNotConfiguredError } from "@/domain/ai/ports";
import { GuidanceReviewAccessError, hasGuidancePermission, type GuidanceIdentityPort } from "@/domain/exercise/video-guidance-review";
import { BatchError, type BatchInput, type IsolatedProvider } from "@/domain/video-batch/contracts";
import type { VideoBatchRepository } from "@/infra/video-batch/repository";

export class VideoBatchControlPlane {
  constructor(private readonly identity: GuidanceIdentityPort, private readonly repository: VideoBatchRepository) {}
  private async actor(ownerId: string) {
    const actor = await this.identity.currentIdentity();
    if (!actor) throw new GuidanceReviewAccessError("UNAUTHENTICATED");
    if (!hasGuidancePermission(actor, ownerId, "ANALYZE_VIDEO_GUIDANCE")) throw new GuidanceReviewAccessError("FORBIDDEN");
    return actor.actorId;
  }
  async reconcileStoredRaw(attemptId: string, ownerId: string, rawHash: string, reason: string) { return this.repository.reconcileStoredRaw(attemptId,ownerId,await this.actor(ownerId),rawHash,reason); }
  async create(input: BatchInput) { return this.repository.create(input,await this.actor(input.ownerId)); }
  async pause(batchId: string, ownerId: string, reason = "MANUAL_STOP") { await this.actor(ownerId); return this.repository.pause(batchId,ownerId,reason); }
  async cancel(batchId: string, ownerId: string) { await this.actor(ownerId); return this.repository.cancel(batchId,ownerId); }
  async resume(batchId: string, ownerId: string) { await this.actor(ownerId); return this.repository.resume(batchId,ownerId); }
  async retrySelected(itemId: string, ownerId: string) { await this.actor(ownerId); return this.repository.retrySelected(itemId,ownerId); }
}

/** Explicit test mode only. No Guidance writer, analyzer factory or production transport exists here. */
export class IsolatedVideoBatchWorker {
  constructor(private readonly repository: VideoBatchRepository, private readonly provider: IsolatedProvider | null,
    mode: "isolated-test" | "production", private readonly fault?: (point: "AFTER_CLAIM"|"AFTER_RESERVATION"|"AFTER_SENT"|"AFTER_RAW"|"AFTER_RESULT") => void) {
    if (mode !== "isolated-test" || process.env.NODE_ENV !== "test" || provider?.capability !== "SYNTHETIC_ONLY") throw new AnalyzerNotConfiguredError();
  }
  async run(itemId: string, workerId: string) {
    if (process.env.NODE_ENV !== "test" || !this.provider) throw new AnalyzerNotConfiguredError();
    const claim = await this.repository.claim(itemId,workerId);
    if (!claim) return;
    this.fault?.("AFTER_CLAIM");
    if (await this.repository.recoverRaw(claim)) return;
    let attempt;
    try { attempt=await this.repository.reserve(claim); }
    catch (e) {
      if (e instanceof BatchError && e.code === "BUDGET_EXCEEDED") await this.repository.pause(claim.batchId,claim.ownerId,"BUDGET_EXCEEDED");
      throw e;
    }
    this.fault?.("AFTER_RESERVATION");
    if (!await this.repository.markSent(claim,attempt.id)) return;
    this.fault?.("AFTER_SENT");
    let result;
    try { result=await this.provider.dispatch(attempt.dispatchKey); }
    catch { await this.repository.unknown(claim,attempt.id); return; }
    if (result.kind === "unknown") { await this.repository.unknown(claim,attempt.id); return; }
    if (result.kind === "confirmed-failure") {
      await this.repository.confirmedFailure(claim,attempt.id,result.code,result.retryable,result.usage,result.requestId); return;
    }
    await this.repository.saveRaw(claim,attempt.id,result.raw,result.usage,result.requestId);
    this.fault?.("AFTER_RAW");
    await this.repository.recoverRaw(claim);
    this.fault?.("AFTER_RESULT");
  }
}
