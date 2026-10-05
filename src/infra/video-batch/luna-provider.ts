import { createHash } from "node:crypto";
import { assertBuiltLunaRequest, type BuiltLunaRequest } from "@/domain/video-batch/luna-request";
import { LUNA_MODEL } from "@/domain/video-batch/luna-schema";
import { consumeLunaTicket, type LunaDispatchTicket, type LunaOperation } from "./luna-repository";
import { LunaTransport, LunaTransportError, lunaTransportPayloadHash, makeLunaPermit, type LunaTransportOptions } from "./luna-transport";
import { PrivateRawStore, type RawRead } from "./private-raw-store";

/** Two operations, one canonical payload; no standalone dispatch without a durable control-plane ticket. */
export class OpenAiLunaProvider {
  readonly capability = "LUNA_CANARY" as const;
  private readonly transport: LunaTransport;
  constructor(readonly raw: PrivateRawStore, private readonly options: LunaTransportOptions = {capability:"NETWORK_DISABLED"}) {
    if(typeof window!=="undefined")throw new Error("SERVER_ONLY_PROVIDER");
    this.transport=new LunaTransport(options);
  }
  assertEnabled(operation:LunaOperation) {
    const testing=this.options.testTransport && process.env.NODE_ENV==="test";
    if(!testing && this.options.capability==="NETWORK_DISABLED")throw new LunaTransportError("NETWORK_DISABLED","BEFORE_SEND");
    if(this.options.capability==="TOKEN_COUNT_ONLY" && operation==="createResponse")throw new LunaTransportError("NETWORK_CAPABILITY_DENIED","BEFORE_SEND");
    if(!testing && !this.options.apiKey)throw new LunaTransportError("OPENAI_API_KEY_MISSING","BEFORE_SEND");
  }
  private async request(operation:LunaOperation,request:BuiltLunaRequest,ticket:LunaDispatchTicket,onHeaders:(id:string|null)=>Promise<void>,beforeSend?:()=>void):Promise<RawRead> {
    this.assertEnabled(operation);assertBuiltLunaRequest(request);
    if(request.model!==LUNA_MODEL)throw new LunaTransportError("MODEL_MISMATCH","BEFORE_SEND");
    const now=this.options.now?.() ?? Date.now();
    consumeLunaTicket(ticket,operation,request.requestHash,now);
    const body=operation==="countInputTokens"?request.inputTokensPayload:request.responsePayload;
    const hash=lunaTransportPayloadHash(body);
    const clientRequestId="vg-"+createHash("sha256").update(`${operation}:${ticket.dispatchKey}`).digest("hex");
    const permit=makeLunaPermit({operation,payloadHash:hash,dispatchKey:ticket.dispatchKey,
      capability:operation==="countInputTokens"?"TOKEN_COUNT_ONLY":"CANARY_RESPONSE_ALLOWED",expiresAt:Math.min(ticket.expiresAt,now+120000),now});
    // Synchronous final cost/freshness proof after durable SENT, with no awaited gap before fetch.
    try { beforeSend?.(); } catch(error) {
      throw new LunaTransportError(error instanceof Error && "code" in error ? String(error.code) : "PREFLIGHT_DENIED", "BEFORE_SEND");
    }
    const result=await this.transport.send({operation,body,payloadHash:hash,dispatchKey:ticket.dispatchKey,clientRequestId,permit},async progress=>{
      await this.raw.saveHeaders(ticket.dispatchKey,progress);
      await onHeaders(progress.requestId);
    });
    await this.raw.save(ticket.dispatchKey,result.body,{operation,status:result.status,requestId:result.requestId,clientRequestId,payloadHash:request.requestHash,latencyMs:result.latencyMs});
    return (await this.raw.read(ticket.dispatchKey))!;
  }
  countInputTokens(request:BuiltLunaRequest,ticket:LunaDispatchTicket,onHeaders:(id:string|null)=>Promise<void>) {return this.request("countInputTokens",request,ticket,onHeaders);}
  createResponse(request:BuiltLunaRequest,ticket:LunaDispatchTicket,onHeaders:(id:string|null)=>Promise<void>,beforeSend:()=>void) {return this.request("createResponse",request,ticket,onHeaders,beforeSend);}
}
