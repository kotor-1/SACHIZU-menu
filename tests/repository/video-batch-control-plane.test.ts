import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistenceDatabaseTemplate, persistenceOwner as owner, persistenceExercise as exercise,
  persistenceBinding as binding, persistencePayload, persistenceAssessments, persistenceObservation } from "../fixtures/video-guidance-persistence";
import { createGuidanceAuthFixture, fixtureAuthUser } from "../fixtures/guidance-auth";
import { VideoBatchRepository } from "@/infra/video-batch/repository";
import { FakeVideoObservationProvider } from "@/infra/video-batch/fake-provider";
import { IsolatedVideoBatchWorker, VideoBatchControlPlane } from "@/application/video-batch/control-plane";
import { canonical, contentKey, digest, workKey, type BatchInput, type Config, type FakeBehavior } from "@/domain/video-batch/contracts";
import { VideoGuidanceRepository } from "@/infra/repositories/video-guidance-repository";

let template: Awaited<ReturnType<typeof createPersistenceDatabaseTemplate>>, db: PrismaClient, repo: VideoBatchRepository;
let now: number, seq=0;
const config: Config={provider:"isolated-fake",model:"synthetic-v1",schemaVersion:"neutral-v1",promptVersion:"p1",configVersion:"c1",recipe:"fixture-v1",inputManifest:"synthetic-manifest-v1",
  segment:{startMs:0,endMs:100},worstCase:{requests:1,tokens:100,cost:20},maxRetries:2,leaseMs:1000};
const usage={requests:1,inputTokens:20,cachedTokens:5,outputTokens:10,reasoningTokens:2,cost:7};
const raw=JSON.stringify({schemaVersion:"neutral-v1",quality:"COMPLETE",events:[{atMs:10,kind:"CONTACT",evidenceRef:"fixture:1"}],unresolved:[]});
const input=(overrides:Partial<BatchInput>={}):BatchInput=>({ownerId:owner,creationKey:`create-${++seq}`,config:structuredClone(config),budget:{requests:10,tokens:1000,cost:200},targets:[{exerciseId:exercise,sourceBinding:{...binding}}],...overrides});
const fail=(p:Promise<unknown>,code:string)=>expect(p).rejects.toMatchObject({code});
async function create(overrides:Partial<BatchInput>={}) {
  const batch=await repo.create(input(overrides),fixtureAuthUser.id);
  return {batch,items:await db.videoGuidanceBatchItem.findMany({where:{batchId:batch.id},orderBy:{exerciseId:"asc"}})};
}
const fake=(behaviors:FakeBehavior[]=["SUCCESS"])=>new FakeVideoObservationProvider(behaviors,true);
const worker=(p=fake(),r=repo)=>new IsolatedVideoBatchWorker(r,p,"isolated-test");
async function claim(itemId:string,workerId="worker-a") { const c=await repo.claim(itemId,workerId); expect(c).not.toBeNull(); return c!; }
async function state(batchId:string) {return db.videoGuidanceBatch.findUniqueOrThrow({where:{id:batchId}});}
const item=(id:string)=>db.videoGuidanceBatchItem.findUniqueOrThrow({where:{id}});
async function peer() { const p=template.peer(db); await p.$connect(); return p; }
async function runChild(itemId:string,point:string,ledger:string) {
  const rows=await db.$queryRawUnsafe<{file:string}[]>('PRAGMA database_list');
  return new Promise<{code:number|null;signal:string|null;stderr:string}>(resolveChild=>{
    const child=spawn(process.execPath,["--import","tsx","tests/fixtures/video-batch-child.ts",`file:${rows[0].file}`,itemId,point,ledger,String(now)],{
      cwd:process.cwd(),env:{...process.env,NODE_ENV:"test"},stdio:["ignore","ignore","pipe"]});
    let stderr=""; child.stderr.on("data",v=>{stderr+=v;});child.on("exit",(code,signal)=>resolveChild({code,signal,stderr}));
  });
}
beforeAll(async()=>{template=await createPersistenceDatabaseTemplate();},90_000);
beforeEach(async()=>{
  db=await template.open();now=Date.parse("2026-10-05T00:00:00Z");repo=new VideoBatchRepository(db,()=>new Date(now));
  await db.user.create({data:{...fixtureAuthUser,emailVerified:true}});
  await db.guidanceOwnerAccess.create({data:{userId:fixtureAuthUser.id,ownerId:owner,permission:"ANALYZE_VIDEO_GUIDANCE"}});
});
afterEach(async()=>{vi.restoreAllMocks();await db?.$disconnect();});
afterAll(async()=>{await template.dispose();});

describe("isolated batch control plane — fault matrix",()=>{
  it("01 idempotent double start creates one batch and detects a changed immutable manifest",async()=>{
    const command=input();const p=await peer();
    try {
      const [a,b]=await Promise.all([repo.create(command,fixtureAuthUser.id),new VideoBatchRepository(p,()=>new Date(now)).create(command,fixtureAuthUser.id)]);
      expect(a.id).toBe(b.id);expect(await db.videoGuidanceBatch.count()).toBe(1);
      await fail(repo.create({...command,budget:{...command.budget,requests:9}},fixtureAuthUser.id),"OPERATION_KEY_CONFLICT");
      const i=await db.videoGuidanceBatchItem.findFirstOrThrow();const f=fake();await worker(f).run(i.id,"a");await worker(f).run(i.id,"b");expect(f.calls).toBe(1);
    } finally {await p.$disconnect();}
  });
  it("02 global single-flight suppresses simultaneous workers in separate batches",async()=>{
    const a=await create(),b=await create(),p=await peer(),f=fake(["DELAYED_SUCCESS"]);
    try {
      const active=worker(f).run(a.items[0].id,"a");await vi.waitFor(()=>expect(f.calls).toBe(1));
      await worker(f,new VideoBatchRepository(p,()=>new Date(now))).run(b.items[0].id,"b");expect(f.calls).toBe(1);
      f.release();await active;await worker(f).run(b.items[0].id,"b");
      expect(f.calls).toBe(1);expect(await db.videoAnalysisWork.count()).toBe(1);expect(await db.videoObservationResult.count()).toBe(1);
      expect(await item(b.items[0].id)).toMatchObject({status:"SKIPPED",skipReason:"OBSERVATION_REUSED"});
    } finally {await p.$disconnect();}
  });
  it("03 reservation transaction failure rolls back budget and attempt before any provider call",async()=>{
    const a=await create(),f=fake();
    await db.$executeRawUnsafe(`CREATE TRIGGER inject_reservation BEFORE INSERT ON VideoAnalysisAttempt BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    await fail(worker(f).run(a.items[0].id,"a"),"PERSISTENCE_ERROR");
    expect(f.calls).toBe(0);expect(await db.videoAnalysisAttempt.count()).toBe(0);expect(await state(a.batch.id)).toMatchObject({reservedRequests:0,usedRequests:0});
  });
  it.each(["BEFORE_CLAIM","AFTER_CLAIM","AFTER_RESERVATION"])("04 real SIGKILL %s can recover only proven-unsent work",async point=>{
    const a=await create(),dir=mkdtempSync(join(tmpdir(),"batch-kill-")),ledger=join(dir,"dispatch.txt");
    try {
      expect((await runChild(a.items[0].id,point,ledger)).signal).toBe("SIGKILL");
      expect(existsSync(ledger)).toBe(false);
      now+=1001;const f=fake();await worker(f).run(a.items[0].id,"replacement");
      expect(f.calls).toBe(1);expect((await item(a.items[0].id)).status).toBe("SUCCEEDED");
      if(point==="AFTER_RESERVATION") expect(await db.videoAnalysisAttempt.findFirst({where:{attemptNo:1}})).toMatchObject({outcome:"FAILED_CONFIRMED",reconciliationState:"CONFIRMED_NOT_SENT"});
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it.each(["AFTER_SENT","IN_PROVIDER"])("05 SIGKILL %s is UNKNOWN, never automatically resent",async point=>{
    const a=await create(),dir=mkdtempSync(join(tmpdir(),"batch-unknown-")),ledger=join(dir,"dispatch.txt");
    try {
      expect((await runChild(a.items[0].id,point,ledger)).signal).toBe("SIGKILL");
      now+=1001;const f=fake();await worker(f).run(a.items[0].id,"replacement");
      const b=await create();await worker(f).run(b.items[0].id,"new-batch");
      expect(f.calls).toBe(0);expect((await item(b.items[0].id)).errorCode).toBe("REQUEST_OUTCOME_UNKNOWN");
      expect(await db.videoAnalysisAttempt.findFirstOrThrow()).toMatchObject({outcome:"REQUEST_OUTCOME_UNKNOWN",accounted:false});
      expect((await state(a.batch.id)).reservedRequests).toBe(1);
      expect(existsSync(ledger)?readFileSync(ledger,"utf8").trim().split("\n").length:0).toBe(point==="IN_PROVIDER"?1:0);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it("06 raw survives result transaction failure and a new worker persists without provider dispatch",async()=>{
    const a=await create(),f=fake();
    await db.$executeRawUnsafe(`CREATE TRIGGER inject_result BEFORE INSERT ON VideoObservationResult BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    await fail(worker(f).run(a.items[0].id,"a"),"PERSISTENCE_ERROR");
    expect(await db.videoAnalysisAttempt.findFirstOrThrow()).toMatchObject({outcome:"RECEIVED",rawHash:expect.any(String),accounted:true});
    expect(await db.videoObservationResult.count()).toBe(0);
    await db.$executeRawUnsafe("DROP TRIGGER inject_result");now+=1001;
    const recover=fake();await worker(recover).run(a.items[0].id,"b");expect(recover.calls).toBe(0);expect(f.calls).toBe(1);
    expect((await item(a.items[0].id)).status).toBe("SUCCEEDED");
  });
  it("07 lease expiry fences a late response into quarantine instead of active observation",async()=>{
    const a=await create(),f=fake(["DELAYED_SUCCESS"]),active=worker(f).run(a.items[0].id,"a");
    await vi.waitFor(()=>expect(f.calls).toBe(1));now+=1001;
    expect(await repo.claim(a.items[0].id,"b")).toBeNull();f.release();await fail(active,"LEASE_LOST");
    expect(await db.videoObservationResult.count()).toBe(0);
    expect(await db.videoAnalysisAttempt.findFirstOrThrow()).toMatchObject({outcome:"RECEIVED",reconciliationState:"QUARANTINED",accounted:true});
    expect((await state(a.batch.id)).usedRequests).toBe(1);expect((await state(a.batch.id)).reservedRequests).toBe(0);
  });
  it("08 coach approval during in-flight work cannot be overwritten by worker completion",async()=>{
    const guidance=new VideoGuidanceRepository(db,async()=>binding,()=>new Date(now));
    const candidate=await guidance.appendAiCandidate({ownerId:owner,exerciseId:exercise,operationKey:"candidate",actor:{kind:"AI",id:null},reason:"fixture",sourceBinding:binding,
      payload:persistencePayload,fieldAssessment:persistenceAssessments,aiMetadata:null,provenance:{source:"fixture"}});
    const a=await create(),f=fake(["DELAYED_SUCCESS"]),running=worker(f).run(a.items[0].id,"a");await vi.waitFor(()=>expect(f.calls).toBe(1));
    const approved=await guidance.reviewAndActivate({ownerId:owner,exerciseId:exercise,operationKey:"review",actor:{kind:"COACH",id:fixtureAuthUser.id},reason:"explicit coach",
      candidateRevisionId:candidate.revisionId,expectedRowVersion:candidate.head.rowVersion,expectedApprovedRevisionId:null,observation:persistenceObservation,
      fieldAssessment:persistenceAssessments,provenance:{source:"coach"}});
    const before=await guidance.readEffectiveGuidance(owner,exercise);const audit=await db.videoGuidanceAuditEvent.count();
    f.release();await running;
    expect(await guidance.readEffectiveGuidance(owner,exercise)).toEqual(before);expect(before.head.approvedRevisionId).toBe(approved.revisionId);
    expect(await db.videoGuidanceAuditEvent.count()).toBe(audit);expect((await item(a.items[0].id)).resultRevisionId).toBeNull();
  });
  it("09 shared source reuses neutral observation but keeps Exercise work and result mappings separate",async()=>{
    const target={exerciseId:"guidance-exercise-b",sourceBinding:{...binding,sourceVideoId:"guidance-video-b",storageKey:"uploads/guidance-video-b.mp4",sourceUrl:null}};
    const targets=[{exerciseId:exercise,sourceBinding:binding},target];const a=await create({targets}),f=fake();
    await Promise.all(a.items.map(i=>worker(f).run(i.id,i.id)));for(const i of a.items) await worker(f).run(i.id,i.id);
    const rows=await db.videoGuidanceBatchItem.findMany();expect(f.calls).toBe(1);expect(new Set(rows.map(i=>i.observationId)).size).toBe(1);
    expect(new Set(rows.map(i=>i.workKey)).size).toBe(2);expect(rows.every(i=>i.resultRevisionId===null)).toBe(true);
    expect(await db.exerciseVideoGuidanceRevision.count()).toBe(0);
  });
  it("10 invalid schema retains raw and settles FAILED without granting coach semantics",async()=>{
    const a=await create(),f=fake(["SCHEMA_INVALID"]);await worker(f).run(a.items[0].id,"a");
    expect((await item(a.items[0].id)).errorCode).toBe("SCHEMA_INVALID");expect((await state(a.batch.id)).status).toBe("FAILED");
    expect((await db.videoAnalysisAttempt.findFirstOrThrow()).rawJson).toContain("COACH_REVIEWED");expect(await db.videoObservationResult.count()).toBe(0);
  });
  it("11 PARTIAL is successful observation with explicit quality, never technical failure",async()=>{
    const a=await create(),f=fake(["PARTIAL"]);await worker(f).run(a.items[0].id,"a");
    expect(await item(a.items[0].id)).toMatchObject({status:"SUCCEEDED",resultQuality:"PARTIAL"});expect((await state(a.batch.id)).status).toBe("SUCCEEDED");
  });
  it.each(["requests","tokens","cost"] as const)("12 independent clients race for the last %s reservation",async dimension=>{
    const second={exerciseId:"guidance-exercise-b",sourceBinding:{...binding,sourceVideoId:"guidance-video-b",storageKey:"uploads/guidance-video-b.mp4",sourceUrl:null,contentSha256:"b".repeat(64)}};
    const budget={requests:10,tokens:1000,cost:200,...{[dimension]:config.worstCase[dimension]}};
    const a=await create({targets:[{exerciseId:exercise,sourceBinding:binding},second],budget});const c1=await claim(a.items[0].id),c2=await claim(a.items[1].id,"b");const p=await peer();
    try {
      const results=await Promise.allSettled([repo.reserve(c1),new VideoBatchRepository(p,()=>new Date(now)).reserve(c2)]);
      expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"BUDGET_EXCEEDED"}});
      expect(await db.videoAnalysisAttempt.count()).toBe(1);
    }finally{await p.$disconnect();}
  });
  it("12b real separate OS workers cannot dispatch beyond one request budget",async()=>{
    const second={exerciseId:"guidance-exercise-b",sourceBinding:{...binding,sourceVideoId:"guidance-video-b",storageKey:"uploads/guidance-video-b.mp4",sourceUrl:null,contentSha256:"b".repeat(64)}};
    const a=await create({targets:[{exerciseId:exercise,sourceBinding:binding},second],budget:{requests:1,tokens:1000,cost:200}});
    const dir=mkdtempSync(join(tmpdir(),"batch-race-")),ledger=join(dir,"calls.txt");
    try { const results=await Promise.all(a.items.map(i=>runChild(i.id,"NONE",ledger)));expect(results.filter(r=>r.code===0).length).toBeGreaterThanOrEqual(1);
      expect(readFileSync(ledger,"utf8").trim().split("\n")).toHaveLength(1);expect((await state(a.batch.id)).usedRequests).toBe(1);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it("13 pause accepts in-flight raw/usage/result but blocks all new dispatch",async()=>{
    const a=await create(),f=fake(["DELAYED_SUCCESS"]),active=worker(f).run(a.items[0].id,"a");await vi.waitFor(()=>expect(f.calls).toBe(1));
    await repo.pause(a.batch.id,owner,"MANUAL_STOP");f.release();await active;
    expect(await state(a.batch.id)).toMatchObject({status:"PAUSED",usedRequests:1,reservedRequests:0});expect((await item(a.items[0].id)).status).toBe("SUCCEEDED");
    await repo.resume(a.batch.id,owner);expect((await state(a.batch.id)).status).toBe("SUCCEEDED");await worker(f).run(a.items[0].id,"b");expect(f.calls).toBe(1);
  });
  it("14 pause between reservation and dispatch prevents sending; resume retains durable attempt",async()=>{
    const a=await create(),c=await claim(a.items[0].id),attempt=await repo.reserve(c);
    await repo.pause(a.batch.id,owner,"STOP");await fail(repo.markSent(c,attempt.id),"PAUSED");
    await repo.resume(a.batch.id,owner);expect(await repo.markSent(c,attempt.id)).toBe(true);expect(await repo.markSent(c,attempt.id)).toBe(false);
  });
  it("15 selected retry alone resets FAILED with bounded backoff and keeps attempts",async()=>{
    const a=await create(),f=fake(["HTTP_429","HTTP_500","SUCCESS"]);await worker(f).run(a.items[0].id,"a");
    await repo.resume(a.batch.id,owner);await worker(f).run(a.items[0].id,"b");expect(f.calls).toBe(1);
    await repo.retrySelected(a.items[0].id,owner);await worker(f).run(a.items[0].id,"b");expect(f.calls).toBe(1);
    now+=1000;await worker(f).run(a.items[0].id,"b");expect(f.calls).toBe(2);
    await repo.retrySelected(a.items[0].id,owner);now+=1999;await worker(f).run(a.items[0].id,"c");expect(f.calls).toBe(2);
    now++;await worker(f).run(a.items[0].id,"c");expect(f.calls).toBe(3);expect(await db.videoAnalysisAttempt.count()).toBe(3);
  });
  it("15b retry limit applies globally across batches",async()=>{
    const a=await create(),f=fake(["HTTP_500"]);
    for(let n=0;n<3;n++){await worker(f).run(a.items[0].id,"a");if(n<2){await repo.retrySelected(a.items[0].id,owner);now+=3000;}}
    await fail(repo.retrySelected(a.items[0].id,owner),"RETRY_NOT_ALLOWED");const b=await create();await worker(f).run(b.items[0].id,"b");
    await fail(repo.retrySelected(b.items[0].id,owner),"RETRY_NOT_ALLOWED");expect(f.calls).toBe(3);
  });
  it("16 UNKNOWN blocks selected retry, resume and other batches while retaining reservation",async()=>{
    const a=await create(),f=fake(["UNKNOWN_AFTER_SEND"]);await worker(f).run(a.items[0].id,"a");
    await fail(repo.retrySelected(a.items[0].id,owner),"RETRY_NOT_ALLOWED");await repo.resume(a.batch.id,owner);
    const b=await create();await worker(f).run(b.items[0].id,"b");expect(f.calls).toBe(1);expect((await state(a.batch.id)).reservedRequests).toBe(1);
  });
  it.each(["AFTER_RAW","AFTER_RESULT"])("17 SIGKILL %s reuses durable raw/result with zero further dispatch",async point=>{
    const a=await create(),dir=mkdtempSync(join(tmpdir(),"batch-reuse-")),ledger=join(dir,"calls.txt");
    try {
      expect((await runChild(a.items[0].id,point,ledger)).signal).toBe("SIGKILL");now+=1001;const f=fake();await worker(f).run(a.items[0].id,"b");
      await worker(f).run(a.items[0].id,"b");expect(f.calls).toBe(0);expect(await db.videoObservationResult.count()).toBe(1);
      expect(await db.videoAnalysisAttempt.count()).toBe(1);expect((await state(a.batch.id)).usedRequests).toBe(1);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it("18 owner boundary partitions content cache and rejects foreign sources",async()=>{
    const other="guidance-owner-b",ex="guidance-exercise-other-owner";
    await db.guidanceOwnerAccess.create({data:{userId:fixtureAuthUser.id,ownerId:other,permission:"ANALYZE_VIDEO_GUIDANCE"}});
    await db.videoAsset.create({data:{id:"other-video",exerciseId:ex,ownerId:other,storageKey:"private/other",filename:"synthetic"}});
    await fail(repo.create(input({ownerId:other}),fixtureAuthUser.id),"INVALID_VIDEO_SOURCE");
    const a=await create(),b=await create({ownerId:other,targets:[{exerciseId:ex,sourceBinding:{...binding,sourceVideoId:"other-video",storageKey:"private/other",sourceUrl:null}}]}),f=fake();
    await worker(f).run(a.items[0].id,"a");await worker(f).run(b.items[0].id,"b");expect(f.calls).toBe(2);expect(await db.videoObservationResult.count()).toBe(2);
  });
  it("19 cross-Exercise binding and forged claim cannot mutate results",async()=>{
    await fail(repo.create(input({targets:[{exerciseId:"guidance-exercise-b",sourceBinding:binding}]}),fixtureAuthUser.id),"INVALID_VIDEO_SOURCE");
    const a=await create(),c=await claim(a.items[0].id);await fail(repo.reserve({...c,ownerId:"foreign"}),"LEASE_LOST");
    await db.videoAsset.update({where:{id:binding.sourceVideoId},data:{storageKey:"changed"}});await fail(repo.reserve(c),"INVALID_VIDEO_SOURCE");
  });
  it("20 production capability gate rejects fake, disabled provider and isAvailable-only stubs",()=>{
    expect(()=>new IsolatedVideoBatchWorker(repo,fake(),"production")).toThrow("動画解析AI");
    expect(()=>new IsolatedVideoBatchWorker(repo,null,"isolated-test")).toThrow("動画解析AI");
    expect(()=>new FakeVideoObservationProvider(["SUCCESS"],false)).toThrow("動画解析AI");
    expect(()=>new IsolatedVideoBatchWorker(repo,{isAvailable:()=>true} as never,"isolated-test")).toThrow("動画解析AI");
  });
  it.each(["TIMEOUT_BEFORE_SEND","FAILURE_CONFIRMED_AFTER_SEND","HTTP_429","HTTP_500"] as FakeBehavior[])("confirmed fake behavior %s reconciles usage without auto retry",async behavior=>{
    const a=await create(),f=fake([behavior]);await worker(f).run(a.items[0].id,"a");await worker(f).run(a.items[0].id,"a");
    expect(f.calls).toBe(1);expect(await db.videoAnalysisAttempt.findFirstOrThrow()).toMatchObject({outcome:"FAILED_CONFIRMED",retryable:true,accounted:true});
    expect((await state(a.batch.id)).usedRequests).toBe(behavior==="TIMEOUT_BEFORE_SEND"?0:1);
  });
  it("one failure does not cancel remaining pending items; FAILED batch means all items settled",async()=>{
    const second={exerciseId:"guidance-exercise-b",sourceBinding:{...binding,sourceVideoId:"guidance-video-b",storageKey:"uploads/guidance-video-b.mp4",sourceUrl:null,contentSha256:"b".repeat(64)}};
    const a=await create({targets:[{exerciseId:exercise,sourceBinding:binding},second]}),f=fake(["HTTP_500","SUCCESS"]);
    await worker(f).run(a.items[0].id,"a");expect((await state(a.batch.id)).status).toBe("RUNNING");
    await worker(f).run(a.items[1].id,"a");expect((await state(a.batch.id)).status).toBe("FAILED");expect(f.calls).toBe(2);
  });
  it("heartbeat extends only the current fence and cannot revive expired workers",async()=>{
    const a=await create(),c=await claim(a.items[0].id);now+=900;await repo.heartbeat(c);now+=900;
    expect(await repo.claim(a.items[0].id,"b")).toBeNull();now+=101;const replacement=await claim(a.items[0].id,"b");expect(replacement.fence).toBeGreaterThan(c.fence);
    await fail(repo.heartbeat(c),"LEASE_LOST");await fail(repo.reserve(c),"LEASE_LOST");
  });
  it("raw accounting is idempotent and raw cannot be overwritten",async()=>{
    const a=await create(),c=await claim(a.items[0].id),attempt=await repo.reserve(c);await repo.markSent(c,attempt.id);
    await repo.saveRaw(c,attempt.id,raw,usage,"fake:1");await repo.saveRaw(c,attempt.id,raw,usage,"fake:1");
    await fail(repo.saveRaw(c,attempt.id,raw+" ",usage,"fake:1"),"OPERATION_KEY_CONFLICT");expect((await state(a.batch.id)).usedTokens).toBe(30);
    await expect(db.videoAnalysisAttempt.update({where:{id:attempt.id},data:{rawJson:"changed"}})).rejects.toThrow();
    await repo.recoverRaw(c);await expect(db.videoObservationResult.updateMany({data:{quality:"PARTIAL"}})).rejects.toThrow();
  });
  it("content identity is canonical, includes owner/recipe/segment/model/schema/prompt/config, excludes Exercise",()=>{
    const target={exerciseId:exercise,sourceBinding:binding};const key=contentKey(owner,target,config);
    expect(digest({b:1,a:2})).toBe(digest({a:2,b:1}));expect(canonical(config)).toBe(canonical({...config}));
    expect(contentKey(owner,{...target,exerciseId:"other"},config)).toBe(key);
    expect(workKey(owner,{...target,exerciseId:"other"},config)).not.toBe(workKey(owner,target,config));
    for(const change of [{recipe:"r2"},{inputManifest:"i2"},{promptVersion:"p2"},{configVersion:"c2"},{segment:{startMs:1,endMs:100}},{model:"other"},{schemaVersion:"other"},{provider:"other"}])
      expect(contentKey(owner,target,{...config,...change} as Config)).not.toBe(key);
    expect(contentKey("other",target,config)).not.toBe(key);
  });
  it("real Better Auth session needs separate owner-scoped ANALYZE permission, revoked grants and sessions fail closed",async()=>{
    await db.guidanceOwnerAccess.deleteMany();await db.user.deleteMany();const auth=createGuidanceAuthFixture(db);await auth.bootstrapUser();
    const service=new VideoBatchControlPlane(auth.identity,repo);
    await expect(service.create(input())).rejects.toMatchObject({code:"UNAUTHENTICATED"});await auth.signIn();
    await auth.grant(fixtureAuthUser.id,owner,["REVIEW_VIDEO_GUIDANCE"]);await expect(service.create(input())).rejects.toMatchObject({code:"FORBIDDEN"});
    await auth.grant(fixtureAuthUser.id,"other",["ANALYZE_VIDEO_GUIDANCE"]);await expect(service.create(input())).rejects.toMatchObject({code:"FORBIDDEN"});
    await auth.grant(fixtureAuthUser.id,owner,["ANALYZE_VIDEO_GUIDANCE"]);const a=await service.create(input());expect(a.actorId).toBe(fixtureAuthUser.id);
    await db.guidanceOwnerAccess.deleteMany({where:{ownerId:owner,permission:"ANALYZE_VIDEO_GUIDANCE"}});
    await expect(service.pause(a.id,owner)).rejects.toMatchObject({code:"FORBIDDEN"});await auth.signOut();await expect(service.resume(a.id,owner)).rejects.toMatchObject({code:"UNAUTHENTICATED"});
  });
  it("late raw reconciliation requires explicit hash + owner authority and never sends again",async()=>{
    const a=await create(),c=await claim(a.items[0].id),attempt=await repo.reserve(c);await repo.markSent(c,attempt.id);
    now+=1001;await repo.claim(a.items[0].id,"replacement");await repo.saveRaw(c,attempt.id,raw,usage,"fake-late");
    await fail(repo.reconcileStoredRaw(attempt.id,owner,fixtureAuthUser.id,"wrong","verified fake response"),"RETRY_NOT_ALLOWED");
    await repo.reconcileStoredRaw(attempt.id,owner,fixtureAuthUser.id,digest(raw),"verified fake request and response hash");
    const f=fake();await worker(f).run(a.items[0].id,"recovery");expect(f.calls).toBe(0);expect((await item(a.items[0].id)).status).toBe("SUCCEEDED");
    expect(await db.videoAnalysisAttempt.findUniqueOrThrow({where:{id:attempt.id}})).toMatchObject({reconciliationState:"RESOLVED_RAW",reconciledBy:fixtureAuthUser.id});
  });
  it("late confirmed failure preserves usage but cannot silently unlock UNKNOWN",async()=>{
    const a=await create(),c=await claim(a.items[0].id),attempt=await repo.reserve(c);await repo.markSent(c,attempt.id);
    now+=1001;await repo.claim(a.items[0].id,"replacement");await repo.confirmedFailure(c,attempt.id,"HTTP_500",true,usage,"fake-late");
    expect((await state(a.batch.id)).usedRequests).toBe(1);await fail(repo.retrySelected(a.items[0].id,owner),"RETRY_NOT_ALLOWED");
  });

  it("B/D/E effective guidance and all approval pointers stay identical even when fake returns COMPLETE",async()=>{
    const decisions=JSON.parse(readFileSync("docs/coach-decisions/2026-10-02-bd-video-guidance.json","utf8"));
    const sources=new Map<string, typeof binding>();
    const guidance=new VideoGuidanceRepository(db,async(_owner,_exercise,id)=>sources.get(id) ?? null,()=>new Date(now));
    const targets: BatchInput["targets"]=[];
    for(const [index,key] of ["B","D","E"].entries()) {
      const exerciseId=`sentinel-${key}`,sourceVideoId=`sentinel-video-${key}`;
      const sourceBinding={...binding,sourceVideoId,contentSha256:String(index+1).repeat(64),storageKey:`private-synthetic/${key}`,sourceUrl:null};sources.set(sourceVideoId,sourceBinding);
      await db.exercise.create({data:{id:exerciseId,ownerId:owner,name:key,category:"DRILL",defaultDistanceMeters:null}});
      await db.videoAsset.create({data:{id:sourceVideoId,exerciseId,ownerId:owner,filename:"synthetic",storageKey:sourceBinding.storageKey}});
      const payload=key==="E"?{...persistencePayload,sourceVideoId}:{...decisions[key].approvedGuidance,sourceVideoId};
      await guidance.importLegacy({ownerId:owner,exerciseId,operationKey:`import-${key}`,reason:"isolated sentinel",actor:{kind:"IMPORT",id:null},sourceBinding,payload,
        fieldAssessment:key==="E"?[{field:"countingUnit",state:"UNRESOLVED",reason:"unknown",evidenceRefs:[]}]:[],aiMetadata:null,provenance:{source:"sentinel"},importSourceHash:digest(payload)});
      targets.push({exerciseId,sourceBinding});
    }
    const snapshot=async()=>({heads:await db.exerciseVideoGuidanceHead.findMany({orderBy:{exerciseId:"asc"}}),revisions:await db.exerciseVideoGuidanceRevision.findMany({orderBy:{id:"asc"}}),audits:await db.videoGuidanceAuditEvent.findMany({orderBy:{id:"asc"}}),effective:await Promise.all(targets.map(t=>guidance.readEffectiveGuidance(owner,t.exerciseId)))});
    const before=await snapshot(),a=await create({targets}),f=fake();for(const i of a.items) await worker(f).run(i.id,"sentinel-worker");
    expect(await snapshot()).toEqual(before);expect(f.calls).toBe(3);
    const b=before.effective[0],d=before.effective[1],e=before.effective[2];
    expect(b.guidance.countingUnit).toBe("PER_SIDE");expect(b.guidance.bilateralCounting).toContain("10回");expect(d.guidance.countingUnit).toBe("ROUND_TRIP");
    expect(e.guidance.videoAnalysisStatus).toBe("AI_ANALYZED");expect(e.head.approvedRevisionId).toBeNull();expect(e.fieldAssessment.some(v=>v.state==="UNRESOLVED")).toBe(true);
    expect((await db.exercise.findUniqueOrThrow({where:{id:"sentinel-B"}})).defaultDistanceMeters).toBeNull();
  });
  it("busy transaction is retried within a bound; persistence contention is not recorded as analysis failure",async()=>{
    const a=await create(),c=await claim(a.items[0].id);
    const spy=vi.spyOn(db,"$transaction");spy.mockRejectedValueOnce(Object.assign(new Error("database is locked"),{code:"P1008"}));
    const reserved=await repo.reserve(c);expect(reserved.outcome).toBe("RESERVED");expect(spy).toHaveBeenCalledTimes(2);spy.mockRestore();
    const failure=vi.spyOn(db,"$transaction").mockRejectedValue(Object.assign(new Error("database is locked"),{code:"P1008"}));
    await fail(repo.markSent(c,reserved.id),"PERSISTENCE_ERROR");expect(failure).toHaveBeenCalledTimes(4);failure.mockRestore();
    expect((await item(c.itemId)).status).toBe("RUNNING");expect((await db.videoAnalysisAttempt.findUniqueOrThrow({where:{id:reserved.id}})).outcome).toBe("RESERVED");
  });

  it("cancel only settles unstarted work; unresolved in-flight accounting cannot be discarded",async()=>{
    const a=await create();await repo.cancel(a.batch.id,owner);const f=fake();await worker(f).run(a.items[0].id,"a");expect(f.calls).toBe(0);
    expect((await state(a.batch.id)).status).toBe("CANCELLED");await repo.resume(a.batch.id,owner);expect((await state(a.batch.id)).status).toBe("CANCELLED");
    const b=await create(),c=await claim(b.items[0].id),attempt=await repo.reserve(c);await repo.markSent(c,attempt.id);await repo.pause(b.batch.id,owner,"STOP");
    await fail(repo.cancel(b.batch.id,owner),"RETRY_NOT_ALLOWED");
  });
  it("separate OS processes still share one global content flight across batches",async()=>{
    const a=await create(),b=await create(),dir=mkdtempSync(join(tmpdir(),"batch-flight-")),ledger=join(dir,"calls.txt");
    try {const results=await Promise.all([runChild(a.items[0].id,"NONE",ledger),runChild(b.items[0].id,"NONE",ledger)]);
      expect(results.map(r=>r.code)).toEqual([0,0]);expect(readFileSync(ledger,"utf8").trim().split("\n")).toHaveLength(1);
      const f=fake();await worker(f).run(a.items[0].id,"finish");await worker(f).run(b.items[0].id,"finish");expect(f.calls).toBe(0);
      expect(await db.videoAnalysisAttempt.count()).toBe(1);expect(await db.videoObservationResult.count()).toBe(1);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });

  it("forged owner on raw persistence cannot mutate another owner's attempt or accounting",async()=>{
    const a=await create(),c=await claim(a.items[0].id),attempt=await repo.reserve(c);await repo.markSent(c,attempt.id);
    await fail(repo.saveRaw({...c,ownerId:"foreign"},attempt.id,raw,usage,"fake"),"LEASE_LOST");
    expect((await db.videoAnalysisAttempt.findUniqueOrThrow({where:{id:attempt.id}})).rawJson).toBeNull();expect((await state(a.batch.id)).usedRequests).toBe(0);
  });

});
