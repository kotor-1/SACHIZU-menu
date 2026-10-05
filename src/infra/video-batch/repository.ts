import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { BatchError, canonical, persistedConfigSchema, contentKey, createBatchSchema, createLunaBatchSchema, digest, neutralObservationSchema,
  totals, usageSchema, workKey, type BatchInput, type LunaBatchInput, type Claim, type Usage } from "@/domain/video-batch/contracts";
import { GuidanceReviewAccessError } from "@/domain/exercise/video-guidance-review";

type Tx = Prisma.TransactionClient;
const busy = (e: unknown) => e instanceof Error && /P1008|P2034|SQLITE_BUSY|database is locked|write conflict|timed out/i.test(`${"code" in e ? e.code : ""} ${e.message}`);
/** Only this explicit table capability reaches the worker. No Guidance write delegate is exposed. */
export class VideoBatchRepository {
  constructor(protected readonly db: PrismaClient, protected readonly now: () => Date = () => new Date()) {}
  protected async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await this.db.$transaction(async tx => {
          // Acquire SQLite's write lock before any reads (avoid deferred read->write upgrades).
          await tx.$executeRaw`UPDATE "VideoGuidanceBatch" SET "rowVersion"="rowVersion" WHERE "id"='__control_plane_lock__'`;
          return fn(tx);
        }, { maxWait: 2000, timeout: 5000 });
      } catch (e) {
        if (busy(e) && n < 3) { await new Promise(r => setTimeout(r, 5 * (n + 1))); continue; }
        if (e instanceof BatchError || e instanceof GuidanceReviewAccessError) throw e;
        throw new BatchError("PERSISTENCE_ERROR");
      }
    }
  }
  protected async source(tx: Tx, ownerId: string, exerciseId: string, bindingJson: string) {
    const binding = JSON.parse(bindingJson);
    const video = await tx.videoAsset.findFirst({ where: { id: binding.sourceVideoId, ownerId, exerciseId },
      select: { storageKey: true, sourceUrl: true } });
    const exercise = await tx.exercise.findFirst({ where: { id: exerciseId, ownerId }, select: { id: true } });
    if (!video || !exercise || video.storageKey !== binding.storageKey || video.sourceUrl !== binding.sourceUrl)
      throw new BatchError("INVALID_VIDEO_SOURCE");
  }
  async create(input: BatchInput | LunaBatchInput, actorId: string) {
    const parsed = input.config.provider === "openai" ? createLunaBatchSchema.safeParse(input) : createBatchSchema.safeParse(input);
    if (!parsed.success) throw new BatchError("INVALID_VIDEO_SOURCE");
    input = parsed.data;
    const targets = [...input.targets].sort((a,b) => workKey(input.ownerId,a,input.config).localeCompare(workKey(input.ownerId,b,input.config)));
    const manifestHash = digest({ ...input, targets });
    return this.tx(async tx => {
      const grant = await tx.guidanceOwnerAccess.findUnique({ where: { userId_ownerId_permission: {
        userId: actorId, ownerId: input.ownerId, permission: "ANALYZE_VIDEO_GUIDANCE" } } });
      if (!grant) throw new GuidanceReviewAccessError("FORBIDDEN");
      if (input.config.provider === "openai") {
        const gate = await tx.videoLunaPreflight.findFirst({ where: { id: input.config.preflightId, ownerId: input.ownerId } });
        if (!gate?.responseApprovalJson || gate.countOutcome !== "SUCCEEDED" || gate.expiresAt <= this.now()) throw new BatchError("RETRY_NOT_ALLOWED");
        const approved = JSON.parse(gate.responseApprovalJson);
        if (approved.batchInputHash !== digest(input)) throw new BatchError("OPERATION_KEY_CONFLICT");
      }
      const existing = await tx.videoGuidanceBatch.findUnique({ where: { ownerId_creationKey: { ownerId: input.ownerId, creationKey: input.creationKey } } });
      if (existing) {
        if (existing.manifestHash !== manifestHash) throw new BatchError("OPERATION_KEY_CONFLICT");
        return existing;
      }
      const batch = await tx.videoGuidanceBatch.create({ data: { id: randomUUID(), ownerId: input.ownerId, actorId,
        creationKey: input.creationKey, manifestHash, configJson: canonical(input.config), requestedAt: this.now(),
        requestBudget: input.budget.requests, tokenBudget: input.budget.tokens, costBudget: input.budget.cost } });
      const seen = new Set<string>();
      for (const target of targets) {
        const key = workKey(input.ownerId, target, input.config);
        if (seen.has(key)) continue; seen.add(key);
        await this.source(tx,input.ownerId,target.exerciseId,canonical(target.sourceBinding));
        const content = contentKey(input.ownerId, target, input.config);
        const work = await tx.videoAnalysisWork.upsert({ where: { ownerId_contentKey: { ownerId: input.ownerId, contentKey: content } },
          create: { id: randomUUID(), ownerId: input.ownerId, contentKey: content }, update: {} });
        await tx.videoGuidanceBatchItem.create({ data: { id: randomUUID(), batchId: batch.id, ownerId: input.ownerId,
          exerciseId: target.exerciseId, sourceBindingJson: canonical(target.sourceBinding), contentKey: content,
          workKey: key, workId: work.id, configHash: digest(input.config) } });
      }
      return batch;
    });
  }
  protected async settle(tx: Tx, batchId: string) {
    const b = await tx.videoGuidanceBatch.findUniqueOrThrow({ where: { id: batchId } });
    if (b.status === "PAUSED" || b.status === "CANCELLED") return;
    const remaining = await tx.videoGuidanceBatchItem.count({ where: { batchId, status: { in: ["PENDING","RUNNING"] } } });
    if (remaining) return;
    const failures = await tx.videoGuidanceBatchItem.count({ where: { batchId, status: "FAILED" } });
    await tx.videoGuidanceBatch.update({ where: { id: batchId }, data: { status: failures ? "FAILED" : "SUCCEEDED", endedAt: this.now(), rowVersion: { increment: 1 } } });
  }
  protected async account(tx: Tx, attemptId: string, usage: Usage) {
    const a = await tx.videoAnalysisAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    if (a.accounted) return;
    const u = totals(usageSchema.parse(usage));
    if (u.requests > a.reservationRequests || u.tokens > a.reservationTokens || u.cost > a.reservationCost)
      throw new BatchError("USAGE_EXCEEDS_RESERVATION");
    await tx.videoGuidanceBatch.update({ where: { id: a.batchId }, data: {
      reservedRequests: { decrement: a.reservationRequests }, reservedTokens: { decrement: a.reservationTokens }, reservedCost: { decrement: a.reservationCost },
      usedRequests: { increment: u.requests }, usedTokens: { increment: u.tokens }, usedCost: { increment: u.cost }, rowVersion: { increment: 1 },
    } });
    await tx.videoAnalysisAttempt.update({ where: { id: a.id }, data: { accounted: true, usageJson: canonical(usage) } });
  }
  private async expire(tx: Tx, workId: string) {
    const w = await tx.videoAnalysisWork.findUniqueOrThrow({ where: { id: workId } });
    if (w.status !== "LEASED" || !w.leaseExpiresAt || w.leaseExpiresAt > this.now()) return;
    const a = await tx.videoAnalysisAttempt.findFirst({ where: { workId, fencingToken: w.fencingToken }, orderBy: { attemptNo: "desc" } });
    if (a?.outcome === "SENT" || a?.outcome === "REQUEST_OUTCOME_UNKNOWN") {
      await tx.videoAnalysisAttempt.update({ where: { id: a.id }, data: { outcome: "REQUEST_OUTCOME_UNKNOWN", reconciliationState: "REQUIRED", errorCode: "REQUEST_OUTCOME_UNKNOWN" } });
      await tx.videoAnalysisWork.update({ where: { id: workId }, data: { status: "UNKNOWN", fencingToken: { increment: 1 }, errorCode: "REQUEST_OUTCOME_UNKNOWN" } });
      if (w.activeItemId) {
        await tx.videoGuidanceBatchItem.update({ where: { id: w.activeItemId }, data: { status: "FAILED", errorCode: "REQUEST_OUTCOME_UNKNOWN", rowVersion: { increment: 1 } } });
        const item = await tx.videoGuidanceBatchItem.findUniqueOrThrow({ where: { id: w.activeItemId } });
        await this.settle(tx,item.batchId);
      }
      return;
    }
    if (a?.outcome === "RESERVED") {
      await this.account(tx,a.id,{ requests:0,inputTokens:0,cachedTokens:0,outputTokens:0,reasoningTokens:0,cost:0 });
      await tx.videoAnalysisAttempt.update({ where: { id: a.id }, data: { outcome:"FAILED_CONFIRMED",retryable:true,errorCode:"CONFIRMED_NOT_SENT",reconciliationState:"CONFIRMED_NOT_SENT" } });
    }
    // A durable RECEIVED raw is recoverable without sending again. Its hash remains immutable.
    await tx.videoAnalysisWork.update({ where:{id:workId},data:{status:"READY",leaseOwner:null,leaseExpiresAt:null} });
    if (w.activeItemId) await tx.videoGuidanceBatchItem.updateMany({where:{id:w.activeItemId,status:"RUNNING"},data:{status:"PENDING",leaseOwner:null,leaseExpiresAt:null,rowVersion:{increment:1}}});
  }
  async claim(itemId: string, workerId: string): Promise<Claim | null> {
    return this.tx(async tx => {
      let item = await tx.videoGuidanceBatchItem.findUniqueOrThrow({ where: { id: itemId } });
      const b = await tx.videoGuidanceBatch.findUniqueOrThrow({ where: { id: item.batchId } });
      if (!["PENDING","RUNNING"].includes(b.status) || !["PENDING","RUNNING"].includes(item.status)) return null;
      await this.expire(tx,item.workId);
      item = await tx.videoGuidanceBatchItem.findUniqueOrThrow({where:{id:itemId}});
      if (item.status !== "PENDING") return null;
      const w = await tx.videoAnalysisWork.findUniqueOrThrow({ where: { id: item.workId } });
      if (w.status === "LEASED" || (w.retryAt && w.retryAt > this.now()) || (item.retryAt && item.retryAt > this.now())) return null;
      try { await this.source(tx,item.ownerId,item.exerciseId,item.sourceBindingJson); }
      catch (e) {
        if (!(e instanceof BatchError)) throw e;
        await tx.videoGuidanceBatchItem.update({where:{id:itemId},data:{status:"FAILED",errorCode:e.code,rowVersion:{increment:1}}});
        await this.settle(tx,b.id); return null;
      }
      if (w.status === "COMPLETE") {
        const observation = await tx.videoObservationResult.findUniqueOrThrow({where:{id:w.observationId!}});
        await tx.videoGuidanceBatchItem.update({where:{id:itemId},data:{status:"SKIPPED",skipReason:"OBSERVATION_REUSED",observationId:observation.id,resultQuality:observation.quality,rowVersion:{increment:1}}});
        await this.settle(tx,b.id); return null;
      }
      if (w.status === "UNKNOWN" || w.status === "FAILED") {
        await tx.videoGuidanceBatchItem.update({where:{id:itemId},data:{status:"FAILED",errorCode:w.errorCode ?? "REQUEST_OUTCOME_UNKNOWN",rowVersion:{increment:1}}});
        await this.settle(tx,b.id); return null;
      }
      const config = persistedConfigSchema.parse(JSON.parse(b.configJson));
      const fence = w.fencingToken + 1, expires = new Date(this.now().getTime()+config.leaseMs);
      await tx.videoAnalysisWork.update({where:{id:w.id},data:{status:"LEASED",leaseOwner:workerId,leaseExpiresAt:expires,fencingToken:fence,activeItemId:itemId}});
      await tx.videoGuidanceBatchItem.update({where:{id:itemId},data:{status:"RUNNING",leaseOwner:workerId,leaseExpiresAt:expires,fencingToken:fence,rowVersion:{increment:1}}});
      await tx.videoGuidanceBatch.update({where:{id:b.id},data:{status:"RUNNING",startedAt:b.startedAt ?? this.now(),heartbeat:this.now(),rowVersion:{increment:1}}});
      return {itemId,workId:w.id,batchId:b.id,ownerId:b.ownerId,workerId,fence};
    });
  }
  protected async fence(tx: Tx, c: Claim, requireRunning = false) {
    const w = await tx.videoAnalysisWork.findUniqueOrThrow({where:{id:c.workId}});
    const i = await tx.videoGuidanceBatchItem.findUniqueOrThrow({where:{id:c.itemId}});
    if (w.status !== "LEASED" || w.ownerId !== c.ownerId || w.fencingToken !== c.fence || w.leaseOwner !== c.workerId || w.activeItemId !== c.itemId
      || !w.leaseExpiresAt || w.leaseExpiresAt <= this.now() || i.workId !== w.id || i.batchId !== c.batchId || i.fencingToken !== c.fence)
      throw new BatchError("LEASE_LOST");
    const b = await tx.videoGuidanceBatch.findUniqueOrThrow({where:{id:c.batchId}});
    if (requireRunning && b.status !== "RUNNING") throw new BatchError("PAUSED");
    return {w,i,b};
  }
  async heartbeat(c: Claim) {
    return this.tx(async tx => {
      const {b} = await this.fence(tx,c);
      const expires = new Date(this.now().getTime()+persistedConfigSchema.parse(JSON.parse(b.configJson)).leaseMs);
      await tx.videoAnalysisWork.update({where:{id:c.workId},data:{leaseExpiresAt:expires}});
      await tx.videoGuidanceBatchItem.update({where:{id:c.itemId},data:{leaseExpiresAt:expires}});
      await tx.videoGuidanceBatch.update({where:{id:c.batchId},data:{heartbeat:this.now()}});
    });
  }
  async reserve(c: Claim, provider: "isolated-fake" | "openai" = "isolated-fake") {
    return this.tx(async tx => {
      const {w,i,b} = await this.fence(tx,c,true);
      await this.source(tx,c.ownerId,i.exerciseId,i.sourceBindingJson);
      const existing = await tx.videoAnalysisAttempt.findFirst({where:{workId:c.workId,fencingToken:c.fence}});
      if (existing) return existing;
      const raw = await tx.videoAnalysisAttempt.findFirst({where:{workId:c.workId,outcome:"RECEIVED",reconciliationState:{in:["NONE","RESOLVED_RAW"]}}});
      if (raw) throw new BatchError("RETRY_NOT_ALLOWED");
      const config = persistedConfigSchema.parse(JSON.parse(b.configJson));
      if (config.provider !== provider) throw new BatchError("RETRY_NOT_ALLOWED");
      const r = config.worstCase;
      if (b.usedRequests+b.reservedRequests+r.requests > b.requestBudget || b.usedTokens+b.reservedTokens+r.tokens > b.tokenBudget || b.usedCost+b.reservedCost+r.cost > b.costBudget)
        throw new BatchError("BUDGET_EXCEEDED");
      await tx.videoGuidanceBatch.update({where:{id:b.id},data:{reservedRequests:{increment:r.requests},reservedTokens:{increment:r.tokens},reservedCost:{increment:r.cost},rowVersion:{increment:1}}});
      await tx.videoAnalysisWork.update({where:{id:w.id},data:{attemptCount:{increment:1}}});
      return tx.videoAnalysisAttempt.create({data:{id:randomUUID(),workId:w.id,itemId:i.id,batchId:b.id,ownerId:b.ownerId,
        attemptNo:w.attemptCount+1,dispatchKey:randomUUID(),fencingToken:c.fence,reservedAt:this.now(),reservationRequests:r.requests,reservationTokens:r.tokens,reservationCost:r.cost}});
    });
  }
  async markSent(c: Claim, attemptId: string): Promise<boolean> {
    return this.tx(async tx => {
      const {i} = await this.fence(tx,c,true);
      await this.source(tx,c.ownerId,i.exerciseId,i.sourceBindingJson);
      const a = await tx.videoAnalysisAttempt.findUniqueOrThrow({where:{id:attemptId}});
      if (a.ownerId !== c.ownerId || a.batchId !== c.batchId || a.workId !== c.workId || a.itemId !== c.itemId || a.fencingToken !== c.fence) throw new BatchError("LEASE_LOST");
      if (a.outcome !== "RESERVED") return false;
      await tx.videoAnalysisAttempt.update({where:{id:attemptId},data:{outcome:"SENT",dispatchStartedAt:this.now()}});
      return true;
    });
  }
  /** Small synthetic raw stored in the isolated SQLite, never in public/uploads. */
  async saveRaw(c: Claim, attemptId: string, raw: string, usage: Usage, requestId: string) {
    if (Buffer.byteLength(raw)>64_000) throw new BatchError("PERSISTENCE_ERROR");
    return this.tx(async tx => {
      const a = await tx.videoAnalysisAttempt.findUniqueOrThrow({where:{id:attemptId}});
      if (a.ownerId !== c.ownerId || a.batchId !== c.batchId || a.workId !== c.workId || a.itemId !== c.itemId || a.fencingToken !== c.fence) throw new BatchError("LEASE_LOST");
      if (a.rawHash) {
        if (a.rawHash !== digest(raw) || a.usageJson !== canonical(usage)) throw new BatchError("OPERATION_KEY_CONFLICT");
        return;
      }
      if (!["SENT","REQUEST_OUTCOME_UNKNOWN"].includes(a.outcome)) throw new BatchError("RETRY_NOT_ALLOWED");
      let stale = false;
      try { await this.fence(tx,c); } catch (e) { if (!(e instanceof BatchError) || e.code !== "LEASE_LOST") throw e; stale=true; }
      await this.account(tx,a.id,usage);
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{rawJson:raw,rawHash:digest(raw),providerRequestId:requestId,responseReceivedAt:this.now(),
        latencyMs: Math.max(0,this.now().getTime()-(a.dispatchStartedAt ?? a.reservedAt).getTime()),outcome:"RECEIVED",reconciliationState:stale?"QUARANTINED":"NONE"}});
      if (stale) {
        await tx.videoAnalysisWork.updateMany({where:{id:c.workId,status:{not:"COMPLETE"}},data:{status:"UNKNOWN",errorCode:"REQUEST_OUTCOME_UNKNOWN"}});
        await tx.videoGuidanceBatchItem.updateMany({where:{id:c.itemId,status:"RUNNING"},data:{status:"FAILED",errorCode:"REQUEST_OUTCOME_UNKNOWN",rowVersion:{increment:1}}});
        await this.settle(tx,c.batchId);
      }
    });
  }
  async recoverRaw(c: Claim): Promise<boolean> {
    return this.tx(async tx => {
      const {w,i} = await this.fence(tx,c);
      const a = await tx.videoAnalysisAttempt.findFirst({where:{workId:w.id,outcome:"RECEIVED",reconciliationState:{in:["NONE","RESOLVED_RAW"]}},orderBy:{attemptNo:"desc"}});
      if (!a?.rawJson || !a.rawHash) return false;
      if (digest(a.rawJson)!==a.rawHash) throw new BatchError("PERSISTENCE_ERROR");
      let payload: unknown;
      try { payload=JSON.parse(a.rawJson); } catch { payload=null; }
      const parsed = neutralObservationSchema.safeParse(payload);
      if (!parsed.success) {
        await tx.videoAnalysisWork.update({where:{id:w.id},data:{status:"FAILED",errorCode:"SCHEMA_INVALID"}});
        await tx.videoGuidanceBatchItem.update({where:{id:i.id},data:{status:"FAILED",errorCode:"SCHEMA_INVALID",rowVersion:{increment:1}}});
        await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{errorCode:"SCHEMA_INVALID",retryable:false,reconciliationState:"SCHEMA_REJECTED"}});
        await this.settle(tx,c.batchId); return true;
      }
      await this.source(tx,i.ownerId,i.exerciseId,i.sourceBindingJson);
      const observation = await tx.videoObservationResult.upsert({where:{ownerId_contentKey:{ownerId:c.ownerId,contentKey:w.contentKey}},
        create:{id:randomUUID(),ownerId:c.ownerId,contentKey:w.contentKey,attemptId:a.id,rawHash:a.rawHash,payloadJson:canonical(parsed.data),quality:parsed.data.quality,createdAt:this.now()},update:{}});
      await tx.videoAnalysisWork.update({where:{id:w.id},data:{status:"COMPLETE",observationId:observation.id,errorCode:null}});
      await tx.videoGuidanceBatchItem.update({where:{id:i.id},data:{status:"SUCCEEDED",resultQuality:observation.quality,observationId:observation.id,errorCode:null,rowVersion:{increment:1}}});
      await this.settle(tx,c.batchId); return true;
    });
  }
  async unknown(c: Claim, attemptId: string) {
    return this.tx(async tx => {
      await this.fence(tx,c);
      const a = await tx.videoAnalysisAttempt.findUniqueOrThrow({where:{id:attemptId}});
      if (a.ownerId!==c.ownerId || a.batchId!==c.batchId || a.workId!==c.workId || a.fencingToken!==c.fence || a.outcome!=="SENT") throw new BatchError("LEASE_LOST");
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{outcome:"REQUEST_OUTCOME_UNKNOWN",errorCode:"REQUEST_OUTCOME_UNKNOWN",reconciliationState:"REQUIRED"}});
      await tx.videoAnalysisWork.update({where:{id:c.workId},data:{status:"UNKNOWN",errorCode:"REQUEST_OUTCOME_UNKNOWN"}});
      await tx.videoGuidanceBatchItem.update({where:{id:c.itemId},data:{status:"FAILED",errorCode:"REQUEST_OUTCOME_UNKNOWN",rowVersion:{increment:1}}});
      await this.settle(tx,c.batchId);
    });
  }
  async confirmedFailure(c: Claim, attemptId: string, code: string, retryable: boolean, usage: Usage, requestId: string | null) {
    return this.tx(async tx => {
      let stale=false;
      try { await this.fence(tx,c); } catch (e) { if (!(e instanceof BatchError) || e.code!=="LEASE_LOST") throw e; stale=true; }
      const a = await tx.videoAnalysisAttempt.findUniqueOrThrow({where:{id:attemptId}});
      if (a.ownerId!==c.ownerId || a.batchId!==c.batchId || a.workId!==c.workId || a.fencingToken!==c.fence || !["SENT","REQUEST_OUTCOME_UNKNOWN"].includes(a.outcome)) throw new BatchError("LEASE_LOST");
      await this.account(tx,a.id,usage);
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{outcome:"FAILED_CONFIRMED",errorCode:code,retryable:retryable && !stale,providerRequestId:requestId,responseReceivedAt:this.now(),latencyMs:Math.max(0,this.now().getTime()-(a.dispatchStartedAt ?? a.reservedAt).getTime()),reconciliationState:stale?"QUARANTINED":"CONFIRMED"}});
      await tx.videoAnalysisWork.update({where:{id:c.workId},data:{status:stale?"UNKNOWN":"FAILED",errorCode:stale?"REQUEST_OUTCOME_UNKNOWN":code}});
      await tx.videoGuidanceBatchItem.update({where:{id:c.itemId},data:{status:"FAILED",errorCode:stale?"REQUEST_OUTCOME_UNKNOWN":code,rowVersion:{increment:1}}});
      await this.settle(tx,c.batchId);
    });
  }
  async pause(batchId: string, ownerId: string, reason: string) {
    return this.tx(async tx => {
      const b=await tx.videoGuidanceBatch.findFirstOrThrow({where:{id:batchId,ownerId}});
      if (!["RUNNING","PENDING","PAUSED"].includes(b.status)) return;
      await tx.videoGuidanceBatch.update({where:{id:batchId},data:{status:"PAUSED",stopReason:reason,rowVersion:{increment:1}}});
    });
  }
  async cancel(batchId: string, ownerId: string) {
    return this.tx(async tx => {
      const b=await tx.videoGuidanceBatch.findFirstOrThrow({where:{id:batchId,ownerId}});
      if (b.status==="CANCELLED") return;
      const running=await tx.videoGuidanceBatchItem.count({where:{batchId,status:"RUNNING"}});
      const unresolved=await tx.videoAnalysisAttempt.count({where:{batchId,accounted:false}});
      if (!["PENDING","PAUSED"].includes(b.status) || running || unresolved) throw new BatchError("RETRY_NOT_ALLOWED");
      await tx.videoGuidanceBatchItem.updateMany({where:{batchId,status:"PENDING"},data:{status:"SKIPPED",skipReason:"CANCELLED_BY_OPERATOR",rowVersion:{increment:1}}});
      await tx.videoGuidanceBatch.update({where:{id:batchId},data:{status:"CANCELLED",stopReason:"CANCELLED_BY_OPERATOR",endedAt:this.now(),rowVersion:{increment:1}}});
    });
  }
  async resume(batchId: string, ownerId: string) {
    return this.tx(async tx => {
      const b=await tx.videoGuidanceBatch.findFirstOrThrow({where:{id:batchId,ownerId}});
      if (b.status!=="PAUSED") return;
      await tx.videoGuidanceBatch.update({where:{id:batchId},data:{status:"RUNNING",stopReason:null,endedAt:null,rowVersion:{increment:1}}});
      await this.settle(tx,batchId);
    });
  }
  async retrySelected(itemId: string, ownerId: string) {
    return this.tx(async tx => {
      const i=await tx.videoGuidanceBatchItem.findFirstOrThrow({where:{id:itemId,ownerId}});
      const b=await tx.videoGuidanceBatch.findUniqueOrThrow({where:{id:i.batchId}});
      const w=await tx.videoAnalysisWork.findUniqueOrThrow({where:{id:i.workId}});
      const a=await tx.videoAnalysisAttempt.findFirst({where:{workId:w.id},orderBy:{attemptNo:"desc"}});
      const config=persistedConfigSchema.parse(JSON.parse(b.configJson));
      if (i.status!=="FAILED" || b.status==="CANCELLED" || w.status!=="FAILED" || a?.outcome!=="FAILED_CONFIRMED" || !a.retryable
        || w.retryCount>=config.maxRetries || i.retryCount>=config.maxRetries) throw new BatchError("RETRY_NOT_ALLOWED");
      const retryAt=new Date(this.now().getTime()+Math.min(30_000,1000*2**w.retryCount));
      await tx.videoAnalysisWork.update({where:{id:w.id},data:{status:"READY",retryAt,retryCount:{increment:1},errorCode:null}});
      await tx.videoGuidanceBatchItem.update({where:{id:i.id},data:{status:"PENDING",retryAt,retryCount:{increment:1},errorCode:null,leaseOwner:null,leaseExpiresAt:null,rowVersion:{increment:1}}});
      await tx.videoGuidanceBatch.update({where:{id:b.id},data:{status:b.status==="PAUSED"?"PAUSED":"PENDING",endedAt:null,rowVersion:{increment:1}}});
    });
  }
  /** Explicit, auditable adoption of already stored late raw. Never authorizes a new send. */
  async reconcileStoredRaw(attemptId: string, ownerId: string, actorId: string, expectedRawHash: string, reason: string) {
    if (!reason.trim() || reason.length>2000) throw new BatchError("RETRY_NOT_ALLOWED");
    return this.tx(async tx => {
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if (!grant) throw new GuidanceReviewAccessError("FORBIDDEN");
      const a=await tx.videoAnalysisAttempt.findFirstOrThrow({where:{id:attemptId,ownerId}});
      const w=await tx.videoAnalysisWork.findUniqueOrThrow({where:{id:a.workId}});
      if (a.reconciliationState==="RESOLVED_RAW" && a.rawHash===expectedRawHash) return;
      if (w.status!=="UNKNOWN" || a.outcome!=="RECEIVED" || a.reconciliationState!=="QUARANTINED" || !a.rawJson || a.rawHash!==expectedRawHash || digest(a.rawJson)!==expectedRawHash)
        throw new BatchError("RETRY_NOT_ALLOWED");
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{reconciliationState:"RESOLVED_RAW",reconciledBy:actorId,reconciledAt:this.now(),reconciliationEvidenceJson:canonical({expectedRawHash,reason})}});
      await tx.videoAnalysisWork.update({where:{id:w.id},data:{status:"READY",errorCode:null,leaseOwner:null,leaseExpiresAt:null}});
      await tx.videoGuidanceBatchItem.update({where:{id:a.itemId},data:{status:"PENDING",errorCode:null,rowVersion:{increment:1}}});
      const b=await tx.videoGuidanceBatch.findUniqueOrThrow({where:{id:a.batchId}});
      await tx.videoGuidanceBatch.update({where:{id:b.id},data:{status:b.status==="PAUSED"?"PAUSED":"PENDING",endedAt:null,rowVersion:{increment:1}}});
    });
  }
  // UNKNOWN without verifiable stored raw stays blocked. No force-retry or assumed-zero-usage API.

}
