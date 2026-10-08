import { z } from "zod";
import { GuidanceReviewAccessError, hasGuidancePermission, type GuidanceIdentityPort } from "@/domain/exercise/video-guidance-review";
import { BatchError, canonical, digest, targetSchema, type Claim, type LunaBatchInput, type Target } from "@/domain/video-batch/contracts";
import { assertBuiltLunaRequest, CANARY_0_EXERCISE_ID, LUNA_MAX_OUTPUT_TOKENS, type BuiltLunaRequest } from "@/domain/video-batch/luna-request";
import { LUNA_MODEL, LUNA_SCHEMA_VERSION, LUNA_PROMPT_VERSION, parseLunaObservation } from "@/domain/video-batch/luna-schema";
import { evaluateLunaCostGate, parseLunaUsageBody, calculateLunaActualCost, type PriceSnapshot, type PriceVerification, type TokenReceipt } from "@/domain/video-batch/luna-cost";
import { LunaBatchRepository } from "@/infra/video-batch/luna-repository";
import { OpenAiLunaProvider } from "@/infra/video-batch/luna-provider";
import { LunaTransportError } from "@/infra/video-batch/luna-transport";
import type { RawRead } from "@/infra/video-batch/private-raw-store";

export type CanaryApproval = { manifestHash:string; expiresAt:Date; requestCap:1; runId?:string; previousPreflightId?:string|null };
export type ResponseApproval = { priceSnapshot:PriceSnapshot; currentPriceVerification:PriceVerification; costCapUsd:string; manifestHash:string; requestCap:1 };
export type SourceVerifier = (ownerId:string,target:Target)=>Promise<boolean>;
export const lunaCanaryManifestHash=(ownerId:string,target:Target,request:BuiltLunaRequest)=>digest({version:"luna-canary-preflight-v1",ownerId,target,payloadHash:request.requestHash,frameManifestHash:request.frameManifestHash});
type Fault = (point:"AFTER_RESERVATION"|"AFTER_SENT"|"AFTER_RAW_FILE"|"AFTER_RAW_LEDGER"|"AFTER_USAGE"|"AFTER_RESULT")=>void;
const countBody=z.object({object:z.literal("response.input_tokens"),input_tokens:z.number().int().min(0).max(1_050_000)}).strict();
const codeOf=(error:unknown)=>error instanceof Error && "code" in error?String(error.code):"PERSISTENCE_ERROR";

/** Trusted server entrypoint. No route/CLI enables it by default; identity is the Phase2 session port. */
export class LunaCanaryControlPlane {
  constructor(private readonly identity:GuidanceIdentityPort,private readonly repo:LunaBatchRepository,private readonly provider:OpenAiLunaProvider,
    private readonly verifySource:SourceVerifier,private readonly now:()=>Date=()=>new Date(),private readonly fault?:Fault) {}
  private async actor(ownerId:string){
    const actor=await this.identity.currentIdentity();
    if(!actor)throw new GuidanceReviewAccessError("UNAUTHENTICATED");
    if(!hasGuidancePermission(actor,ownerId,"ANALYZE_VIDEO_GUIDANCE"))throw new GuidanceReviewAccessError("FORBIDDEN");
    return actor.actorId;
  }
  private assertRequest(request:BuiltLunaRequest,gate:{payloadHash:string;frameManifestHash:string}) {
    assertBuiltLunaRequest(request);
    if(request.requestHash!==gate.payloadHash || request.frameManifestHash!==gate.frameManifestHash)throw new BatchError("OPERATION_KEY_CONFLICT");
  }
  private async source(ownerId:string,target:Target){if(!await this.verifySource(ownerId,target))throw new BatchError("STALE_VIDEO_GUIDANCE");}
  async plan(ownerId:string,target:Target,request:BuiltLunaRequest,approval:CanaryApproval){
    const actor=await this.actor(ownerId);assertBuiltLunaRequest(request);target=targetSchema.parse(target);
    if(target.exerciseId!==CANARY_0_EXERCISE_ID || approval.requestCap!==1 || approval.expiresAt.getTime()-this.now().getTime()>24*60*60*1000)throw new BatchError("RETRY_NOT_ALLOWED");
    const manifestHash=lunaCanaryManifestHash(ownerId,target,request);
    if(manifestHash!==approval.manifestHash)throw new BatchError("OPERATION_KEY_CONFLICT");
    await this.source(ownerId,target);
    return this.repo.plan({ownerId,payloadHash:request.requestHash,frameManifestHash:request.frameManifestHash,manifestHash,
      manifestJson:canonical({target,inspection:request.inspectionPayload}),expiresAt:approval.expiresAt,
      runId:approval.runId,previousPreflightId:approval.previousPreflightId},actor);
  }
  private tokenReceipt(raw:RawRead,request:BuiltLunaRequest):TokenReceipt {
    if(!raw.metadata || raw.metadata.status!==200 || raw.orphan)throw new Error("TOKEN_COUNT_HTTP_OR_RAW_ERROR");
    const body=countBody.parse(JSON.parse(Buffer.from(raw.bytes).toString("utf8")));
    return {model:LUNA_MODEL,payloadHash:request.requestHash,frameManifestHash:request.frameManifestHash,inputTokens:body.input_tokens,
      countedAt:this.now().toISOString(),schemaVersion:LUNA_SCHEMA_VERSION,promptVersion:LUNA_PROMPT_VERSION,detail:"high",frameCount:12};
  }
  async countInputTokens(id:string,ownerId:string,request:BuiltLunaRequest){
    const actor=await this.actor(ownerId),gate=await this.repo.context(id,ownerId,actor);this.assertRequest(request,gate);
    if(gate.expiresAt<=this.now())throw new BatchError("RETRY_NOT_ALLOWED");
    if(gate.countOutcome==="SUCCEEDED")return JSON.parse(gate.countReceiptJson!) as TokenReceipt;
    await this.source(ownerId,JSON.parse(gate.manifestJson).target);
    this.provider.assertEnabled("countInputTokens");
    const ticket=await this.repo.beginCount(id,ownerId,actor,request.requestHash);
    let raw:RawRead;
    try{raw=await this.provider.countInputTokens(request,ticket,requestId=>this.repo.countHeaders(id,ownerId,ticket.dispatchKey,requestId));}
    catch(error){await this.repo.countFailure(id,ownerId,ticket.dispatchKey,error instanceof LunaTransportError && error.stage==="BEFORE_SEND",codeOf(error));throw error;}
    let receipt:TokenReceipt;
    try{receipt=this.tokenReceipt(raw,request);}catch{await this.repo.completeCount(id,ownerId,actor,raw,null,"TOKEN_COUNT_FAILED");throw new BatchError("RETRY_NOT_ALLOWED");}
    await this.repo.completeCount(id,ownerId,actor,raw,receipt,null);return receipt;
  }
  async recoverTokenCount(id:string,ownerId:string,request:BuiltLunaRequest){
    const actor=await this.actor(ownerId),gate=await this.repo.context(id,ownerId,actor);this.assertRequest(request,gate);
    if(gate.countOutcome==="SUCCEEDED")return JSON.parse(gate.countReceiptJson!) as TokenReceipt;
    const raw=await this.provider.raw.read(gate.countDispatchKey);if(!raw)throw new BatchError("RETRY_NOT_ALLOWED");
    // Original count time is retained; recovery must never refresh a stale preflight into validity.
    const receipt={...this.tokenReceipt(raw,request),countedAt:(gate.countSentAt ?? gate.requestedAt).toISOString()};
    await this.repo.completeCount(id,ownerId,actor,raw,receipt,null);return receipt;
  }
  async retryUnsentTokenCount(id:string,ownerId:string){return this.repo.retryUnsentCount(id,ownerId,await this.actor(ownerId));}
  async authorizeCanary(id:string,ownerId:string,request:BuiltLunaRequest,approval:ResponseApproval){
    const actor=await this.actor(ownerId),gate=await this.repo.context(id,ownerId,actor);this.assertRequest(request,gate);
    if(approval.requestCap!==1 || approval.manifestHash!==gate.manifestHash || gate.countOutcome!=="SUCCEEDED")throw new BatchError("RETRY_NOT_ALLOWED");
    const receipt=JSON.parse(gate.countReceiptJson!) as TokenReceipt;
    this.assertReceipt(receipt,request);
    const result=evaluateLunaCostGate({...approval,tokenReceipt:receipt,expectedPayloadHash:request.requestHash,expectedFrameManifestHash:request.frameManifestHash,maxOutputTokens:LUNA_MAX_OUTPUT_TOKENS,now:this.now()});
    const target=JSON.parse(gate.manifestJson).target as Target;await this.source(ownerId,target);
    const input:LunaBatchInput={ownerId,creationKey:`luna-${gate.id}`,targets:[target],budget:{requests:1,tokens:receipt.inputTokens+LUNA_MAX_OUTPUT_TOKENS,cost:result.capMicroUsd},
      config:{provider:"openai",model:LUNA_MODEL,schemaVersion:LUNA_SCHEMA_VERSION,promptVersion:LUNA_PROMPT_VERSION,
        configVersion:request.requestHash,recipe:"luna-temporal-quantiles-v1",inputManifest:request.frameManifestHash,segment:{startMs:0,endMs:16132},
        worstCase:{requests:1,tokens:receipt.inputTokens+LUNA_MAX_OUTPUT_TOKENS,cost:result.upperBoundMicroUsd},maxRetries:0,leaseMs:180000,preflightId:id}};
    return this.repo.approveResponse(id,ownerId,actor,input,approval);
  }
  private assertReceipt(receipt:TokenReceipt,request:BuiltLunaRequest){
    if(receipt.frameManifestHash!==request.frameManifestHash || receipt.schemaVersion!==LUNA_SCHEMA_VERSION || receipt.promptVersion!==LUNA_PROMPT_VERSION || receipt.frameCount!==12 || receipt.detail!=="high")throw new BatchError("OPERATION_KEY_CONFLICT");
  }
  private async persistRaw(c:Claim,attempt:{id:string;rawHash:string|null;dispatchKey:string},approval:ResponseApproval,receipt:TokenReceipt){
    const raw=await this.provider.raw.read(attempt.dispatchKey);
    if(!raw || raw.orphan || raw.receipt.sha256!==attempt.rawHash)throw new BatchError("PERSISTENCE_ERROR");
    let body:Record<string,unknown>,actual;
    try{
      body=JSON.parse(Buffer.from(raw.bytes).toString("utf8"));
      actual=calculateLunaActualCost(parseLunaUsageBody(body),approval.priceSnapshot);
    }catch(error){await this.repo.rejectReceived(c,attempt.id,codeOf(error)==="PERSISTENCE_ERROR"?"USAGE_UNKNOWN":codeOf(error));return;}
    if(actual.inputTokens!==receipt.inputTokens || actual.outputTokens>LUNA_MAX_OUTPUT_TOKENS || actual.cachedTokens!==0 || actual.cacheWriteTokens!==0){
      await this.repo.rejectReceived(c,attempt.id,"USAGE_EXCEEDS_RESERVATION",actual);return;
    }
    try{await this.repo.saveUsage(c,attempt.id,{...actual,status:body.status,requestId:raw.metadata?.requestId ?? null,latencyMs:raw.metadata?.latencyMs},
      {requests:1,inputTokens:actual.inputTokens,cachedTokens:actual.cachedTokens,outputTokens:actual.outputTokens,reasoningTokens:actual.reasoningTokens,cost:actual.actualTotalMicroUsd});}
    catch(error){if(error instanceof BatchError && error.code==="USAGE_EXCEEDS_RESERVATION"){await this.repo.rejectReceived(c,attempt.id,error.code,actual);return;}throw error;}
    this.fault?.("AFTER_USAGE");
    let observation;
    try{
      if(raw.metadata?.status!==200 || body.status!=="completed" || !Array.isArray(body.output))throw new Error("INCOMPLETE_RESPONSE");
      const messages=body.output.filter((o:Record<string,unknown>)=>o.type==="message");
      if(messages.length!==1 || messages[0].role!=="assistant" || !Array.isArray(messages[0].content) || messages[0].content.length!==1 || messages[0].content[0].type!=="output_text")throw new Error("INVALID_OUTPUT");
      observation=parseLunaObservation(messages[0].content[0].text,12);
    }catch{await this.repo.rejectReceived(c,attempt.id,"SCHEMA_INVALID");return;}
    await this.repo.persistObservation(c,attempt.id,raw.receipt.sha256,observation.neutralObservation,observation.guidanceCandidate,observation.guidanceCandidate.resultQuality);
    this.fault?.("AFTER_RESULT");
  }
  async runCanary(itemId:string,ownerId:string,request:BuiltLunaRequest,workerId:string){
    const actor=await this.actor(ownerId),context=await this.repo.execution(itemId,ownerId,actor);this.assertRequest(request,context.gate);
    const approval=JSON.parse(context.gate.responseApprovalJson!).approval as ResponseApproval;
    const receipt=JSON.parse(context.gate.countReceiptJson!) as TokenReceipt;this.assertReceipt(receipt,request);
    await this.source(ownerId,JSON.parse(context.gate.manifestJson).target);
    const claim=await this.repo.claim(itemId,workerId);if(!claim)return;
    const recovered=await this.repo.pendingRaw(claim);
    if(recovered){await this.persistRaw(claim,recovered,approval,receipt);return;}
    try{
      this.provider.assertEnabled("createResponse");
      evaluateLunaCostGate({...approval,tokenReceipt:receipt,expectedPayloadHash:request.requestHash,expectedFrameManifestHash:request.frameManifestHash,maxOutputTokens:LUNA_MAX_OUTPUT_TOKENS,now:this.now()});
    }catch(error){await this.repo.pause(claim.batchId,ownerId,codeOf(error));throw error;}
    const attempt=await this.repo.reserve(claim,"openai");this.fault?.("AFTER_RESERVATION");
    const ticket=await this.repo.responseTicket(claim,attempt.id,request.requestHash,actor);this.fault?.("AFTER_SENT");
    const heartbeat=setInterval(()=>{void this.repo.heartbeat(claim).catch(()=>{});},15000);heartbeat.unref();
    try{
      let raw:RawRead;
      try{raw=await this.provider.createResponse(request,ticket,requestId=>this.repo.responseHeaders(claim,attempt.id,requestId),()=>{
        evaluateLunaCostGate({...approval,tokenReceipt:receipt,expectedPayloadHash:request.requestHash,expectedFrameManifestHash:request.frameManifestHash,maxOutputTokens:LUNA_MAX_OUTPUT_TOKENS,now:this.now()});
      });}
      catch(error){
        if(error instanceof LunaTransportError && error.stage==="BEFORE_SEND")await this.repo.confirmedFailure(claim,attempt.id,"CONFIRMED_NOT_SENT",true,{requests:0,inputTokens:0,cachedTokens:0,outputTokens:0,reasoningTokens:0,cost:0},null);
        else await this.repo.markLunaUnknown(claim,attempt.id);
        await this.repo.pause(claim.batchId,ownerId,error instanceof LunaTransportError?error.code:"REQUEST_OUTCOME_UNKNOWN");return;
      }
      this.fault?.("AFTER_RAW_FILE");await this.repo.attachRaw(claim,attempt.id,raw);this.fault?.("AFTER_RAW_LEDGER");
      const saved=await this.repo.pendingRaw(claim);if(saved)await this.persistRaw(claim,saved,approval,receipt);
    }finally{clearInterval(heartbeat);}
  }
  async recoverResponse(attemptId:string,ownerId:string,reason:string){
    const actor=await this.actor(ownerId),attempt=await this.repo.attemptContext(attemptId,ownerId,actor);
    const raw=await this.provider.raw.read(attempt.dispatchKey);if(!raw)throw new BatchError("RETRY_NOT_ALLOWED");
    await this.repo.adoptRaw(attemptId,ownerId,actor,raw,reason);
    // Caller then invokes runCanary; its first path consumes stored raw and never asks transport for another request.
  }
  async recoverResponseHeaders(attemptId:string,ownerId:string){
    const actor=await this.actor(ownerId),attempt=await this.repo.attemptContext(attemptId,ownerId,actor);
    const checkpoint=await this.provider.raw.readHeaders(attempt.dispatchKey);
    if(!checkpoint)throw new BatchError("RETRY_NOT_ALLOWED");
    await this.repo.responseHeaders({ownerId,itemId:attempt.itemId,batchId:attempt.batchId,workId:attempt.workId,fence:attempt.fencingToken,workerId:"header-reconciliation"},attempt.id,checkpoint.requestId);
    return checkpoint; // Metadata only: UNKNOWN stays UNKNOWN; neither retrieval nor resend is permitted.
  }
  async recoverTokenCountHeaders(id:string,ownerId:string){
    const actor=await this.actor(ownerId),gate=await this.repo.context(id,ownerId,actor);
    const checkpoint=await this.provider.raw.readHeaders(gate.countDispatchKey);
    if(!checkpoint)throw new BatchError("RETRY_NOT_ALLOWED");
    await this.repo.countHeaders(id,ownerId,gate.countDispatchKey,checkpoint.requestId);
    return checkpoint;
  }
}
