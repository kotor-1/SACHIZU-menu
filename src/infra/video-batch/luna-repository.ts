import { createHash, randomUUID } from "node:crypto";
import { VideoBatchRepository } from "./repository";
import { BatchError, canonical, digest, lunaConfigSchema, type Claim, type LunaBatchInput, type Usage } from "@/domain/video-batch/contracts";
import { GuidanceReviewAccessError } from "@/domain/exercise/video-guidance-review";
import type { RawRead } from "./private-raw-store";
import { LUNA_MODEL, LUNA_SCHEMA_VERSION, LUNA_PROMPT_VERSION, lunaObservationSchema } from "@/domain/video-batch/luna-schema";
import { tokenReceiptSchema, evaluateLunaCostGate, LUNA_MAX_OUTPUT_TOKENS, type PriceSnapshot, type PriceVerification } from "@/domain/video-batch/luna-cost";

export type LunaOperation = "countInputTokens" | "createResponse";
export type LunaDispatchTicket = Readonly<{ operation: LunaOperation; dispatchKey: string; payloadHash: string; expiresAt: number }>;
const issuedTickets = new WeakSet<object>();
function issue(ticket: LunaDispatchTicket) { const result=Object.freeze(ticket); issuedTickets.add(result); return result; }
/** Only a committed repository reservation can mint a ticket. A ticket can be used once in this process. */
export function consumeLunaTicket(ticket: LunaDispatchTicket, operation: LunaOperation, hash: string, now = Date.now()) {
  if (!issuedTickets.has(ticket) || ticket.operation !== operation || ticket.payloadHash !== hash || ticket.expiresAt <= now) throw new BatchError("RETRY_NOT_ALLOWED");
  issuedTickets.delete(ticket);
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const clientRequestId = (operation: LunaOperation, dispatchKey: string) => `vg-${createHash("sha256").update(`${operation}:${dispatchKey}`).digest("hex")}`;
function verifyRaw(raw: RawRead): boolean {
  return !!raw && raw.receipt?.durable === true && raw.receipt.byteLength === raw.bytes?.byteLength
    && raw.receipt.sha256 === sha256(raw.bytes) && !!raw.metadata;
}
function verifyCountBody(raw: RawRead, inputTokens: number): boolean {
  try {
    const body=JSON.parse(Buffer.from(raw.bytes).toString("utf8")) as Record<string, unknown>;
    return Number.isSafeInteger(body.input_tokens) && body.input_tokens === inputTokens;
  } catch { return false; }
}
function verifyResponseRaw(raw: RawRead, payloadHash: string, dispatchKey: string): boolean {
  if (!verifyRaw(raw) || raw.metadata?.operation!=="createResponse" || raw.metadata.payloadHash!==payloadHash
    || raw.metadata.clientRequestId!==clientRequestId("createResponse",dispatchKey)) return false;
  // This validates storage and dispatch provenance only. Status/body/model/schema parsing is
  // deliberately downstream of durable raw attachment so malformed/error responses survive.
  return Number.isInteger(raw.metadata.status) && raw.metadata.status>=100 && raw.metadata.status<=599;
}
export type LunaPlan = { ownerId: string; payloadHash: string; frameManifestHash: string; manifestHash: string;
  manifestJson: string; expiresAt: Date; runId?: string; previousPreflightId?: string | null };

/** Extends the SAME Phase3 work, item, attempt and budget transactions; has no Guidance writer. */
export class LunaBatchRepository extends VideoBatchRepository {
  private async grant(actorId: string, ownerId: string) {
    const grant=await this.db.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
    if (!grant) throw new GuidanceReviewAccessError("FORBIDDEN");
  }
  async plan(plan: LunaPlan, actorId: string) {
    if (plan.expiresAt <= this.now()) throw new BatchError("RETRY_NOT_ALLOWED");
    const runId=plan.runId ?? `legacy:${plan.payloadHash}`;
    if(!runId.trim() || runId.length>200 || (plan.previousPreflightId!==undefined && plan.previousPreflightId!==null && !plan.previousPreflightId.trim()))throw new BatchError("RETRY_NOT_ALLOWED");
    return this.tx(async tx=>{
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId:plan.ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if(!grant)throw new GuidanceReviewAccessError("FORBIDDEN");
      if(!/^[a-f0-9]{64}$/.test(plan.payloadHash)||!/^[a-f0-9]{64}$/.test(plan.frameManifestHash)||!/^[a-f0-9]{64}$/.test(plan.manifestHash)||!plan.manifestJson)throw new BatchError("RETRY_NOT_ALLOWED");
      const previousPreflightId=plan.previousPreflightId ?? null;
      const existing=await tx.videoLunaPreflight.findFirst({where:{ownerId:plan.ownerId,runId}});
      if(existing){
        if(existing.payloadHash!==plan.payloadHash || existing.frameManifestHash!==plan.frameManifestHash || existing.manifestHash!==plan.manifestHash
          || existing.manifestJson!==plan.manifestJson || existing.previousPreflightId!==previousPreflightId)throw new BatchError("OPERATION_KEY_CONFLICT");
        return existing;
      }
      const history=await tx.videoLunaPreflight.findMany({where:{ownerId:plan.ownerId,payloadHash:plan.payloadHash}});
      if(history.length===0){
        if(previousPreflightId!==null)throw new BatchError("RETRY_NOT_ALLOWED");
      }else{
        if(previousPreflightId===null)throw new BatchError("RETRY_NOT_ALLOWED");
        const previous=await tx.videoLunaPreflight.findFirst({where:{id:previousPreflightId,ownerId:plan.ownerId}});
        if(!previous || previous.payloadHash!==plan.payloadHash || previous.frameManifestHash!==plan.frameManifestHash
          || previous.manifestHash!==plan.manifestHash || previous.manifestJson!==plan.manifestJson
          || previous.countOutcome!=="SUCCEEDED" || previous.expiresAt>this.now())throw new BatchError("RETRY_NOT_ALLOWED");
        const successor=await tx.videoLunaPreflight.findFirst({where:{ownerId:plan.ownerId,previousPreflightId}});
        if(successor)throw new BatchError("RETRY_NOT_ALLOWED");
        const active=await tx.videoLunaPreflight.findFirst({where:{ownerId:plan.ownerId,payloadHash:plan.payloadHash,
          countOutcome:{in:["PENDING","SENT","REQUEST_OUTCOME_UNKNOWN","CONFIRMED_NOT_SENT"]}}});
        if(active)throw new BatchError("RETRY_NOT_ALLOWED");
      }
      return tx.videoLunaPreflight.create({data:{id:randomUUID(),ownerId:plan.ownerId,actorId,runId,previousPreflightId,
        payloadHash:plan.payloadHash,frameManifestHash:plan.frameManifestHash,manifestHash:plan.manifestHash,manifestJson:plan.manifestJson,
        expiresAt:plan.expiresAt,requestedAt:this.now(),countDispatchKey:randomUUID()}});
    });
  }
  async context(id: string, ownerId: string, actorId: string) {
    await this.grant(actorId,ownerId);
    return this.db.videoLunaPreflight.findFirstOrThrow({where:{id,ownerId}});
  }
  async beginCount(id: string, ownerId: string, actorId: string, payloadHash: string) {
    const row=await this.tx(async tx=>{
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if(!grant)throw new GuidanceReviewAccessError("FORBIDDEN");
      const g=await tx.videoLunaPreflight.findFirstOrThrow({where:{id,ownerId}});
      if(g.payloadHash!==payloadHash || g.expiresAt<=this.now() || g.countOutcome!=="PENDING")throw new BatchError("RETRY_NOT_ALLOWED");
      return tx.videoLunaPreflight.update({where:{id},data:{countOutcome:"SENT",countSentAt:this.now()}});
    });
    return issue({operation:"countInputTokens",dispatchKey:row.countDispatchKey,payloadHash,expiresAt:row.expiresAt.getTime()});
  }
  async countHeaders(id: string, ownerId:string, dispatchKey:string, requestId: string|null) {
    await this.tx(async tx=>{
      const g=await tx.videoLunaPreflight.findFirstOrThrow({where:{id,ownerId,countDispatchKey:dispatchKey}});
      if(!["SENT","REQUEST_OUTCOME_UNKNOWN","SUCCEEDED"].includes(g.countOutcome))throw new BatchError("RETRY_NOT_ALLOWED");
      if(g.countRequestId!==null && g.countRequestId!==requestId)throw new BatchError("OPERATION_KEY_CONFLICT");
      if(requestId!==null && (!requestId.length||requestId.length>200))throw new BatchError("RETRY_NOT_ALLOWED");
      await tx.videoLunaPreflight.update({where:{id},data:{countRequestId:requestId}});
    });
  }
  async countFailure(id: string, ownerId:string, dispatchKey:string, confirmedNotSent: boolean, code: string) {
    const result=await this.db.videoLunaPreflight.updateMany({where:{id,ownerId,countDispatchKey:dispatchKey,countOutcome:"SENT"},data:{countOutcome:confirmedNotSent?"CONFIRMED_NOT_SENT":"REQUEST_OUTCOME_UNKNOWN",countError:code}});
    if(result.count!==1)throw new BatchError("RETRY_NOT_ALLOWED");
  }
  async completeCount(id: string, ownerId:string, actorId:string, raw: RawRead, receipt: unknown | null, error: string|null) {
    return this.tx(async tx=>{
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if(!grant)throw new GuidanceReviewAccessError("FORBIDDEN");
      const g=await tx.videoLunaPreflight.findFirstOrThrow({where:{id,ownerId}});
      if(!verifyRaw(raw)||raw.receipt.dispatchKey!==g.countDispatchKey || raw.metadata?.operation!=="countInputTokens" || raw.metadata.payloadHash!==g.payloadHash
        || raw.metadata.clientRequestId!==clientRequestId("countInputTokens",g.countDispatchKey))throw new BatchError("OPERATION_KEY_CONFLICT");
      if(g.countOutcome==="SUCCEEDED") {if(g.countRawHash!==raw.receipt.sha256)throw new BatchError("OPERATION_KEY_CONFLICT");return g;}
      if(!["SENT","REQUEST_OUTCOME_UNKNOWN"].includes(g.countOutcome))throw new BatchError("RETRY_NOT_ALLOWED");
      const parsed=receipt===null?null:tokenReceiptSchema.safeParse(receipt);
      if(receipt!==null && (!parsed?.success || parsed.data.model!==LUNA_MODEL || parsed.data.payloadHash!==g.payloadHash || parsed.data.frameManifestHash!==g.frameManifestHash || parsed.data.schemaVersion!==LUNA_SCHEMA_VERSION || parsed.data.promptVersion!==LUNA_PROMPT_VERSION || parsed.data.detail!=="high" || parsed.data.frameCount!==12 || !verifyCountBody(raw,parsed.data.inputTokens)))throw new BatchError("OPERATION_KEY_CONFLICT");
      if(parsed?.success && raw.metadata.status!==200)throw new BatchError("OPERATION_KEY_CONFLICT");
      if(raw.metadata.requestId!==null && g.countRequestId!==null && raw.metadata.requestId!==g.countRequestId)throw new BatchError("OPERATION_KEY_CONFLICT");
      return tx.videoLunaPreflight.update({where:{id},data:{countOutcome:receipt?"SUCCEEDED":"FAILED_CONFIRMED",countReceiptJson:receipt?canonical(receipt):null,
        countError:error,countRawRef:raw.receipt.rawPath,countRawHash:raw.receipt.sha256,countRequestId:raw.metadata.requestId ?? g.countRequestId}});
    });
  }
  async retryUnsentCount(id:string,ownerId:string,actorId:string) {
    return this.tx(async tx=>{
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if(!grant)throw new GuidanceReviewAccessError("FORBIDDEN");
      const result=await tx.videoLunaPreflight.updateMany({where:{id,ownerId,countOutcome:"CONFIRMED_NOT_SENT"},data:{countOutcome:"PENDING",countSentAt:null,countError:null}});
      if(result.count!==1)throw new BatchError("RETRY_NOT_ALLOWED");
    });
  }
  async approveResponse(id:string,ownerId:string,actorId:string,input:LunaBatchInput,approval:unknown) {
    if(input.ownerId!==ownerId || input.config.preflightId!==id)throw new BatchError("OPERATION_KEY_CONFLICT");
    await this.tx(async tx=>{
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if(!grant)throw new GuidanceReviewAccessError("FORBIDDEN");
      const g=await tx.videoLunaPreflight.findFirstOrThrow({where:{id,ownerId}});
      if(g.countOutcome!=="SUCCEEDED" || g.expiresAt<=this.now())throw new BatchError("RETRY_NOT_ALLOWED");
      const json=canonical({batchInputHash:digest(input),approval});
      if(g.responseApprovalJson && g.responseApprovalJson!==json)throw new BatchError("OPERATION_KEY_CONFLICT");
      await tx.videoLunaPreflight.update({where:{id},data:{responseApprovalJson:json}});
    });
    const batch=await this.create(input,actorId);
    await this.tx(async tx=>{
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if(!grant)throw new GuidanceReviewAccessError("FORBIDDEN");
      const gate=await tx.videoLunaPreflight.findFirstOrThrow({where:{id,ownerId}});
      if(gate.expiresAt<=this.now() || gate.countOutcome!=="SUCCEEDED" || gate.responseApprovalJson!==canonical({batchInputHash:digest(input),approval})
        || (gate.responseBatchId!==null && gate.responseBatchId!==batch.id))throw new BatchError("OPERATION_KEY_CONFLICT");
      await tx.videoLunaPreflight.update({where:{id},data:{responseBatchId:batch.id}});
    });
    return {batch,item:await this.db.videoGuidanceBatchItem.findFirstOrThrow({where:{batchId:batch.id}})};
  }
  async execution(itemId:string,ownerId:string,actorId:string) {
    await this.grant(actorId,ownerId);
    const item=await this.db.videoGuidanceBatchItem.findFirstOrThrow({where:{id:itemId,ownerId}});
    const batch=await this.db.videoGuidanceBatch.findUniqueOrThrow({where:{id:item.batchId}});
    const config=lunaConfigSchema.parse(JSON.parse(batch.configJson));
    const gate=await this.context(config.preflightId,ownerId,actorId);
    if(gate.responseBatchId!==batch.id || !gate.responseApprovalJson)throw new BatchError("RETRY_NOT_ALLOWED");
    return {item,batch,config,gate};
  }
  async responseTicket(c:Claim,attemptId:string,payloadHash:string,actorId:string) {
    const row=await this.tx(async tx=>{
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId:c.ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if(!grant)throw new GuidanceReviewAccessError("FORBIDDEN");
      const {b}=await this.fence(tx,c,true);
      const config=lunaConfigSchema.parse(JSON.parse(b.configJson));
      const g=await tx.videoLunaPreflight.findFirstOrThrow({where:{id:config.preflightId,ownerId:c.ownerId}});
      if(g.payloadHash!==payloadHash || g.countOutcome!=="SUCCEEDED" || !g.responseApprovalJson || g.responseBatchId!==b.id || g.expiresAt<=this.now())throw new BatchError("RETRY_NOT_ALLOWED");
      const approval=JSON.parse(g.responseApprovalJson).approval as {priceSnapshot:PriceSnapshot;currentPriceVerification:PriceVerification;costCapUsd:string};
      evaluateLunaCostGate({...approval,tokenReceipt:JSON.parse(g.countReceiptJson!),expectedPayloadHash:payloadHash,
        expectedFrameManifestHash:g.frameManifestHash,maxOutputTokens:LUNA_MAX_OUTPUT_TOKENS,now:this.now()});
      const a=await tx.videoAnalysisAttempt.findUniqueOrThrow({where:{id:attemptId}});
      if(a.itemId!==c.itemId || a.workId!==c.workId || a.batchId!==c.batchId || a.ownerId!==c.ownerId || a.fencingToken!==c.fence || a.outcome!=="RESERVED")throw new BatchError("LEASE_LOST");
      // The hard cap counts held unknown requests; no new attempt can erase this reservation.
      if(a.reservationRequests!==1 || b.requestBudget!==1)throw new BatchError("BUDGET_EXCEEDED");
      await this.source(tx,c.ownerId,(await tx.videoGuidanceBatchItem.findUniqueOrThrow({where:{id:c.itemId}})).exerciseId,
        (await tx.videoGuidanceBatchItem.findUniqueOrThrow({where:{id:c.itemId}})).sourceBindingJson);
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{outcome:"SENT",dispatchStartedAt:this.now()}});
      return {a,g};
    });
    return issue({operation:"createResponse",dispatchKey:row.a.dispatchKey,payloadHash,expiresAt:row.g.expiresAt.getTime()});
  }
  async responseHeaders(c:Claim,attemptId:string,requestId:string|null) {
    if(requestId!==null && (!requestId.length||requestId.length>200))throw new BatchError("RETRY_NOT_ALLOWED");
    await this.tx(async tx=>{
      const a=await tx.videoAnalysisAttempt.findFirstOrThrow({where:{id:attemptId,ownerId:c.ownerId,workId:c.workId,itemId:c.itemId,batchId:c.batchId,fencingToken:c.fence}});
      if(!["SENT","REQUEST_OUTCOME_UNKNOWN","RECEIVED"].includes(a.outcome))throw new BatchError("RETRY_NOT_ALLOWED");
      if(a.providerRequestId!==null && a.providerRequestId!==requestId)throw new BatchError("OPERATION_KEY_CONFLICT");
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{providerRequestId:requestId}});
    });
  }
  async attachRaw(c:Claim,attemptId:string,raw:RawRead) {
    return this.tx(async tx=>{
      const a=await tx.videoAnalysisAttempt.findUniqueOrThrow({where:{id:attemptId}});
      if(a.ownerId!==c.ownerId || a.workId!==c.workId || a.itemId!==c.itemId || a.fencingToken!==c.fence || a.dispatchKey!==raw.receipt.dispatchKey)throw new BatchError("LEASE_LOST");
      if(!["SENT","REQUEST_OUTCOME_UNKNOWN","RECEIVED"].includes(a.outcome))throw new BatchError("RETRY_NOT_ALLOWED");
      const batch=await tx.videoGuidanceBatch.findUniqueOrThrow({where:{id:a.batchId}});
      const config=lunaConfigSchema.parse(JSON.parse(batch.configJson));
      const gate=await tx.videoLunaPreflight.findFirstOrThrow({where:{id:config.preflightId,ownerId:a.ownerId}});
      if(gate.responseBatchId!==batch.id || !gate.responseApprovalJson || (!raw.metadata || !verifyResponseRaw(raw,gate.payloadHash,a.dispatchKey)))throw new BatchError("OPERATION_KEY_CONFLICT");
      if(a.providerRequestId!==null && raw.metadata!.requestId!==null && a.providerRequestId!==raw.metadata!.requestId)throw new BatchError("OPERATION_KEY_CONFLICT");
      if(a.rawHash){if(a.rawHash!==raw.receipt.sha256)throw new BatchError("OPERATION_KEY_CONFLICT");return;}
      let stale=false;try{await this.fence(tx,c);}catch(e){if(!(e instanceof BatchError)||e.code!=="LEASE_LOST")throw e;stale=true;}
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{rawRef:raw.receipt.rawPath,rawHash:raw.receipt.sha256,
        responseMetadataJson:canonical(raw.metadata),providerRequestId:raw.metadata.requestId ?? a.providerRequestId,responseReceivedAt:this.now(),latencyMs:Math.round(raw.metadata.latencyMs),
        outcome:"RECEIVED",reconciliationState:stale?"QUARANTINED":"NONE"}});
      if(stale){
        const work=await tx.videoAnalysisWork.updateMany({where:{id:c.workId,status:"LEASED",fencingToken:c.fence,activeItemId:c.itemId},data:{status:"UNKNOWN",leaseOwner:null,leaseExpiresAt:null,errorCode:"REQUEST_OUTCOME_UNKNOWN"}});
        if(work.count===1)await tx.videoGuidanceBatchItem.updateMany({where:{id:c.itemId,batchId:c.batchId,status:"RUNNING",fencingToken:c.fence},data:{status:"FAILED",errorCode:"REQUEST_OUTCOME_UNKNOWN",rowVersion:{increment:1}}});
        if(work.count===1)await this.settle(tx,c.batchId);
      }
    });
  }
  async pendingRaw(c:Claim) {return this.db.videoAnalysisAttempt.findFirst({where:{workId:c.workId,outcome:"RECEIVED",rawRef:{not:null},reconciliationState:{in:["NONE","RESOLVED_RAW"]}},orderBy:{attemptNo:"desc"}});}
  async saveUsage(c:Claim,attemptId:string,providerUsage:unknown,usage:Usage) {
    return this.tx(async tx=>{
      await this.fence(tx,c);
      const a=await tx.videoAnalysisAttempt.findFirstOrThrow({where:{id:attemptId,workId:c.workId,ownerId:c.ownerId,itemId:c.itemId,batchId:c.batchId,outcome:"RECEIVED"}});
      const usageJson=canonical(usage),providerUsageJson=canonical(providerUsage);
      if(a.accounted){if(a.usageJson!==usageJson||a.providerUsageJson!==providerUsageJson)throw new BatchError("OPERATION_KEY_CONFLICT");return;}
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{providerUsageJson:providerUsageJson}});
      await this.account(tx,a.id,usage);
    });
  }
  async persistObservation(c:Claim,attemptId:string,rawHash:string,neutral:unknown,candidate:unknown,quality:"COMPLETE"|"PARTIAL") {
    return this.tx(async tx=>{
      const {w,i}=await this.fence(tx,c);
      const a=await tx.videoAnalysisAttempt.findFirstOrThrow({where:{id:attemptId,workId:w.id,ownerId:c.ownerId,itemId:i.id,batchId:c.batchId,outcome:"RECEIVED",accounted:true,rawHash}});
      if(!["NONE","RESOLVED_RAW"].includes(a.reconciliationState))throw new BatchError("LEASE_LOST");
      if(!/^[a-f0-9]{64}$/.test(rawHash))throw new BatchError("PERSISTENCE_ERROR");
      const parsedNeutral=lunaObservationSchema.shape.neutralObservation.safeParse(neutral);
      const parsedCandidate=lunaObservationSchema.shape.guidanceCandidate.safeParse(candidate);
      if(!parsedNeutral.success||!parsedCandidate.success||parsedCandidate.data.resultQuality!==quality)throw new BatchError("SCHEMA_INVALID");
      await this.source(tx,c.ownerId,i.exerciseId,i.sourceBindingJson);
      const neutralJson=canonical(parsedNeutral.data);
      const prior=await tx.videoObservationResult.findUnique({where:{ownerId_contentKey:{ownerId:c.ownerId,contentKey:w.contentKey}}});
      if(prior && (prior.rawHash!==rawHash||prior.payloadJson!==neutralJson||prior.quality!==quality))throw new BatchError("OPERATION_KEY_CONFLICT");
      const observation=prior??await tx.videoObservationResult.create({data:{id:randomUUID(),ownerId:c.ownerId,contentKey:w.contentKey,attemptId:a.id,rawHash,payloadJson:neutralJson,quality,createdAt:this.now()}});
      // Candidate proposal is staged on its per-Exercise attempt, NEVER on a Guidance Head.
      const candidateJson=canonical(parsedCandidate.data);
      if(a.candidateJson!==null&&a.candidateJson!==candidateJson)throw new BatchError("OPERATION_KEY_CONFLICT");
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{candidateJson:candidateJson}});
      await tx.videoAnalysisWork.update({where:{id:w.id},data:{status:"COMPLETE",observationId:observation.id,errorCode:null}});
      await tx.videoGuidanceBatchItem.update({where:{id:i.id},data:{status:"SUCCEEDED",observationId:observation.id,resultQuality:quality,errorCode:null,rowVersion:{increment:1}}});
      await this.settle(tx,c.batchId);
    });
  }
  async rejectReceived(c:Claim,attemptId:string,code:string,providerUsage?:unknown) {
    return this.tx(async tx=>{
      const {w,i}=await this.fence(tx,c);
      const a=await tx.videoAnalysisAttempt.findFirstOrThrow({where:{id:attemptId,workId:w.id,ownerId:c.ownerId,itemId:i.id,batchId:c.batchId,outcome:"RECEIVED"}});
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{errorCode:code,retryable:false,reconciliationState:"REQUIRED",...(providerUsage!==undefined?{providerUsageJson:canonical(providerUsage)}:{})}});
      await tx.videoAnalysisWork.update({where:{id:c.workId},data:{status:"FAILED",errorCode:code}});
      await tx.videoGuidanceBatchItem.update({where:{id:c.itemId},data:{status:"FAILED",errorCode:code,rowVersion:{increment:1}}});
      await tx.videoGuidanceBatch.update({where:{id:c.batchId},data:{status:"PAUSED",stopReason:code,rowVersion:{increment:1}}});
    });
  }
  async attemptContext(attemptId:string,ownerId:string,actorId:string){await this.grant(actorId,ownerId);return this.db.videoAnalysisAttempt.findFirstOrThrow({where:{id:attemptId,ownerId}});}
  /** Explicit adoption of immutable local bytes only; cannot send or grant another response request. */
  async adoptRaw(attemptId:string,ownerId:string,actorId:string,raw:RawRead,reason:string) {
    if(!reason.trim()||reason.length>2000)throw new BatchError("RETRY_NOT_ALLOWED");
    return this.tx(async tx=>{
      const grant=await tx.guidanceOwnerAccess.findUnique({where:{userId_ownerId_permission:{userId:actorId,ownerId,permission:"ANALYZE_VIDEO_GUIDANCE"}}});
      if(!grant)throw new GuidanceReviewAccessError("FORBIDDEN");
      const a=await tx.videoAnalysisAttempt.findFirstOrThrow({where:{id:attemptId,ownerId}});
      const w=await tx.videoAnalysisWork.findUniqueOrThrow({where:{id:a.workId}});
      if(w.ownerId!==ownerId||a.ownerId!==w.ownerId)throw new BatchError("INVALID_VIDEO_SOURCE");
      if(w.status==="COMPLETE")return;
      const batch=await tx.videoGuidanceBatch.findUniqueOrThrow({where:{id:a.batchId}});
      const config=lunaConfigSchema.parse(JSON.parse(batch.configJson));
      const gate=await tx.videoLunaPreflight.findFirstOrThrow({where:{id:config.preflightId,ownerId}});
      if(gate.responseBatchId!==batch.id || !gate.responseApprovalJson || a.dispatchKey!==raw.receipt.dispatchKey || raw.orphan
        || (!raw.metadata || !verifyResponseRaw(raw,gate.payloadHash,a.dispatchKey)) || !["SENT","RECEIVED","REQUEST_OUTCOME_UNKNOWN"].includes(a.outcome))throw new BatchError("RETRY_NOT_ALLOWED");
      if(w.status==="LEASED" && w.leaseExpiresAt && w.leaseExpiresAt>this.now())throw new BatchError("LEASE_LOST");
      if(a.rawHash && a.rawHash!==raw.receipt.sha256)throw new BatchError("OPERATION_KEY_CONFLICT");
      if(a.providerRequestId!==null && raw.metadata.requestId!==null && a.providerRequestId!==raw.metadata.requestId)throw new BatchError("OPERATION_KEY_CONFLICT");
      await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{rawRef:raw.receipt.rawPath,rawHash:raw.receipt.sha256,responseMetadataJson:canonical(raw.metadata),providerRequestId:raw.metadata.requestId ?? a.providerRequestId,
        outcome:"RECEIVED",reconciliationState:"RESOLVED_RAW",reconciledBy:actorId,reconciledAt:this.now(),reconciliationEvidenceJson:canonical({reason,rawHash:raw.receipt.sha256})}});
      await tx.videoAnalysisWork.update({where:{id:w.id},data:{status:"READY",leaseOwner:null,leaseExpiresAt:null,errorCode:null,fencingToken:{increment:1}}});
      await tx.videoGuidanceBatchItem.update({where:{id:a.itemId},data:{status:"PENDING",leaseOwner:null,leaseExpiresAt:null,errorCode:null,rowVersion:{increment:1}}});
      await tx.videoGuidanceBatch.update({where:{id:a.batchId},data:{status:"PENDING",endedAt:null,stopReason:null,rowVersion:{increment:1}}});
    });
  }

  /** Record an ambiguous send even after lease expiry. A stale caller cannot publish over a newer fence. */
  async markLunaUnknown(c:Claim,attemptId:string) {
    return this.tx(async tx=>{
      const a=await tx.videoAnalysisAttempt.findFirstOrThrow({where:{id:attemptId,ownerId:c.ownerId,workId:c.workId,itemId:c.itemId,batchId:c.batchId,fencingToken:c.fence}});
      if(!["SENT","REQUEST_OUTCOME_UNKNOWN"].includes(a.outcome))throw new BatchError("RETRY_NOT_ALLOWED");
      if(a.outcome==="SENT")await tx.videoAnalysisAttempt.update({where:{id:a.id},data:{outcome:"REQUEST_OUTCOME_UNKNOWN",errorCode:"REQUEST_OUTCOME_UNKNOWN",reconciliationState:"REQUIRED"}});
      const current=await tx.videoAnalysisWork.findFirst({where:{id:c.workId,status:"LEASED",fencingToken:c.fence,activeItemId:c.itemId}});
      if(!current)return; // The request is recorded, while a newer owner keeps control of publication.
      await tx.videoAnalysisWork.update({where:{id:c.workId},data:{status:"UNKNOWN",leaseOwner:null,leaseExpiresAt:null,errorCode:"REQUEST_OUTCOME_UNKNOWN"}});
      await tx.videoGuidanceBatchItem.updateMany({where:{id:c.itemId,batchId:c.batchId,status:"RUNNING",fencingToken:c.fence},data:{status:"FAILED",errorCode:"REQUEST_OUTCOME_UNKNOWN",rowVersion:{increment:1}}});
      await this.settle(tx,c.batchId);
    });
  }
}
