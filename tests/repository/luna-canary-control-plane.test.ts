import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPersistenceDatabaseTemplate } from "../fixtures/video-guidance-persistence";
import { buildLunaCanaryFixture, buildLunaResponseBody, lunaCanaryActor, lunaCanaryBinding, lunaCanaryOwner, lunaCanaryTarget } from "../fixtures/luna-canary";
import { LunaCanaryControlPlane, lunaCanaryManifestHash, type ResponseApproval } from "@/application/video-batch/luna-canary";
import { expectedLunaScheduleHash, createLunaPriceSnapshot, type PriceVerification } from "@/domain/video-batch/luna-cost";
import { LUNA_MODEL } from "@/domain/video-batch/luna-schema";
import { LunaBatchRepository } from "@/infra/video-batch/luna-repository";
import { OpenAiLunaProvider } from "@/infra/video-batch/luna-provider";
import { markedTestTransport, type FetchLike } from "@/infra/video-batch/luna-transport";
import { PrivateRawStore } from "@/infra/video-batch/private-raw-store";

const at = (ms: number) => new Date(ms);
const SOURCE_URL = "https://developers.openai.com/api/docs/pricing";
const COST_CAP_USD = "0.01";

function priceAt(clock: number) {
  const verification: PriceVerification = { source: SOURCE_URL, pricingAsOf: "2026-10-05", scheduleHash: expectedLunaScheduleHash("2026-10-05"),
    sourceContentHash: "d".repeat(64), checkedAt: at(clock).toISOString() };
  return { currentPriceVerification: verification, priceSnapshot: createLunaPriceSnapshot(verification) };
}

type FetchSetup = {
  countStatus?: number;
  countBody?: string;
  countTimeout?: boolean;
  responseMode?: "success" | "reject" | "body-loss" | "hang" | "deferred";
  responseMutation?: "invalid-json" | "schema-invalid" | "empty-output" | "unknown-field" | "incomplete";
  quality?: "COMPLETE" | "PARTIAL";
};
function makeOfflineFetch(options: FetchSetup = {}) {
  let responseMode = options.responseMode ?? "success";
  const calls: Array<{ url: string; method: string | undefined; body: string; clientId: string | null }> = [];
  let signalDeferred!: () => void;
  let releaseDeferred!: () => void;
  const deferredStarted = new Promise<void>(resolve => { signalDeferred = resolve; });
  const responseGate = new Promise<void>(resolve => { releaseDeferred = resolve; });
  const fake: FetchLike = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, method: init?.method, body, clientId: new Headers(init?.headers).get("x-client-request-id") });
    if (url.endsWith("/v1/responses/input_tokens")) {
      if (options.countTimeout) return new Promise<Response>(() => {});
      return new Response(options.countBody ?? JSON.stringify({ object: "response.input_tokens", input_tokens: 1000 }), {
        status: options.countStatus ?? 200, headers: { "x-request-id": "req-count-fixture" },
      });
    }
    if (responseMode === "reject") throw new Error("offline socket loss");
    if (responseMode === "hang") return new Promise<Response>(() => {});
    if (responseMode === "body-loss") {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("offline response body lost")); } });
      return new Response(stream, { status: 200, headers: { "x-request-id": "req-header-before-body-loss" } });
    }
    if (responseMode === "deferred") {
      signalDeferred(); await responseGate;
    }
    if (options.responseMutation === "invalid-json") return new Response("not-json", { status: 200, headers: { "x-request-id": "req-response-fixture" } });
    const responseBody = buildLunaResponseBody(options.quality);
    if (options.responseMutation === "schema-invalid") responseBody.output[0].content[0].text = "not-json";
    if (options.responseMutation === "empty-output") responseBody.output = [];
    if (options.responseMutation === "unknown-field") {
      const parsed = JSON.parse(responseBody.output[0].content[0].text) as Record<string, unknown>;
      parsed.unexpected = "must be rejected by strict schema";
      responseBody.output[0].content[0].text = JSON.stringify(parsed);
    }
    if (options.responseMutation === "incomplete") responseBody.status = "incomplete";
    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: { "content-type": "application/json", "x-request-id": "req-response-fixture" },
    });
  };
  return { transport: markedTestTransport(fake), calls, deferredStarted, release: releaseDeferred, setResponseMode(mode: NonNullable<FetchSetup["responseMode"]>) { responseMode = mode; } };
}

const responseCalls = (calls: ReturnType<typeof makeOfflineFetch>["calls"]) => calls.filter(c => c.url.endsWith("/v1/responses"));
const countCalls = (calls: ReturnType<typeof makeOfflineFetch>["calls"]) => calls.filter(c => c.url.endsWith("/v1/responses/input_tokens"));

let template: Awaited<ReturnType<typeof createPersistenceDatabaseTemplate>>;
let db: PrismaClient;
let clock: number;
let rawRoot: string;
let raw: PrivateRawStore;
let repo: LunaBatchRepository;
let identity: { currentIdentity: () => Promise<{ actorId: string; ownerIds: string[]; permissions: string[]; ownerPermissions: { ownerId: string; permissions: ["ANALYZE_VIDEO_GUIDANCE"] }[] } | null> };
const activeRawRoots: string[] = [];

beforeAll(async () => { template = await createPersistenceDatabaseTemplate(); }, 90_000);
beforeEach(async () => {
  db = await template.open();
  clock = Date.parse("2026-10-05T12:00:00.000Z");
  await db.user.create({ data: { ...lunaCanaryActor, emailVerified: true } });
  await db.guidanceOwnerAccess.create({ data: { userId: lunaCanaryActor.id, ownerId: lunaCanaryOwner, permission: "ANALYZE_VIDEO_GUIDANCE" } });
  await db.exercise.create({ data: { id: lunaCanaryTarget.exerciseId, ownerId: lunaCanaryOwner, name: "Canary 0 squat fixture", category: "DRILL" } });
  await db.videoAsset.create({ data: { id: lunaCanaryBinding.sourceVideoId, ownerId: lunaCanaryOwner, exerciseId: lunaCanaryTarget.exerciseId,
    storageKey: lunaCanaryBinding.storageKey, sourceUrl: lunaCanaryBinding.sourceUrl, filename: "canary-0.mp4", mimeType: "video/mp4", sizeBytes: 1200, durationSeconds: 16 } });
  identity = { currentIdentity: async () => ({ actorId: lunaCanaryActor.id, ownerIds: [lunaCanaryOwner], permissions: [],
    ownerPermissions: [{ ownerId: lunaCanaryOwner, permissions: ["ANALYZE_VIDEO_GUIDANCE"] }] }) };
  rawRoot = await realpath(await mkdtemp(path.join(tmpdir(), "luna-canary-raw-")));
  activeRawRoots.push(rawRoot);
  raw = new PrivateRawStore(rawRoot);
  repo = new LunaBatchRepository(db, () => at(clock));
});
afterEach(async () => { vi.restoreAllMocks(); await db?.$disconnect(); });
afterAll(async () => { for (const dir of activeRawRoots) await rm(dir, { recursive: true, force: true }); await template.dispose(); });

function control(fetch: ReturnType<typeof makeOfflineFetch>, options: { capability?: "NETWORK_DISABLED" | "TOKEN_COUNT_ONLY" | "CANARY_RESPONSE_ALLOWED"; apiKey?: string; timeoutMs?: number; fault?: (point: string) => void; authorized?: boolean; useTestTransport?: boolean } = {}) {
  const actorPort = options.authorized === false ? { currentIdentity: async () => null } : identity;
  const provider = new OpenAiLunaProvider(raw, { capability: options.capability ?? "NETWORK_DISABLED", apiKey: options.apiKey,
    ...(options.useTestTransport === false ? {} : { testTransport: fetch.transport }), now: () => clock, timeoutMs: options.timeoutMs });
  return new LunaCanaryControlPlane(actorPort, repo, provider, async () => true, () => at(clock), options.fault as never);
}

async function plan(controlPlane: LunaCanaryControlPlane, request = buildLunaCanaryFixture()) {
  const expiresAt = at(clock + 60 * 60_000);
  const approval = { manifestHash: lunaCanaryManifestHash(lunaCanaryOwner, lunaCanaryTarget, request), expiresAt, requestCap: 1 as const };
  const record = await controlPlane.plan(lunaCanaryOwner, lunaCanaryTarget, request, approval);
  return { record, request };
}
async function count(controlPlane: LunaCanaryControlPlane, request = buildLunaCanaryFixture()) {
  const p = await plan(controlPlane, request);
  const tokenReceipt = await controlPlane.countInputTokens(p.record.id, lunaCanaryOwner, request);
  return { ...p, tokenReceipt };
}
async function authorize(controlPlane: LunaCanaryControlPlane, request = buildLunaCanaryFixture(), costCapUsd = COST_CAP_USD) {
  const ready = await count(controlPlane, request);
  const approval: ResponseApproval = { ...priceAt(clock), costCapUsd, manifestHash: ready.record.manifestHash, requestCap: 1 };
  const execution = await controlPlane.authorizeCanary(ready.record.id, lunaCanaryOwner, request, approval);
  return { ...ready, approval, execution };
}
const fakeControl = (fetch: ReturnType<typeof makeOfflineFetch>, options: Parameters<typeof control>[1] = {}) => control(fetch, { capability: "NETWORK_DISABLED", ...options });

describe("Luna Canary Phase 3 control plane (offline transport fake only)", () => {
  it("runs token preflight then one durable response and stores only an AI candidate", async () => {
    const fetch = makeOfflineFetch();
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key" });
    const ready = await authorize(cp);
    await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "worker-one");
    expect(countCalls(fetch.calls)).toHaveLength(1);
    expect(responseCalls(fetch.calls)).toHaveLength(1);
    expect(new URL(fetch.calls[0].url).pathname).toBe("/v1/responses/input_tokens");
    expect(JSON.parse(fetch.calls[0].body).model).toBe(LUNA_MODEL);
    expect(new URL(fetch.calls[1].url).pathname).toBe("/v1/responses");
    expect(JSON.parse(fetch.calls[1].body).model).toBe(LUNA_MODEL);
    expect(fetch.calls[0].clientId).not.toBe(fetch.calls[1].clientId);
    expect(await db.videoAnalysisAttempt.findFirstOrThrow()).toMatchObject({ outcome: "RECEIVED", rawHash: expect.any(String), accounted: true });
    const attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
    expect(JSON.parse(attempt.candidateJson!)).toMatchObject({ authority: "AI_ANALYZED", resultQuality: "COMPLETE" });
    expect(await db.videoObservationResult.count()).toBe(1);
    expect(await db.exerciseVideoGuidanceRevision.count()).toBe(0);
    expect(await db.exerciseVideoGuidanceHead.count()).toBe(0);
    expect(await db.videoGuidanceBatchItem.findFirstOrThrow()).toMatchObject({ status: "SUCCEEDED", resultQuality: "COMPLETE", resultRevisionId: null });
  });

  it("records a valid PARTIAL output as a candidate with unresolved fields", async () => {
    const fetch = makeOfflineFetch({ quality: "PARTIAL" });
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key" });
    const ready = await authorize(cp);
    await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "partial-worker");
    const attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
    expect(JSON.parse(attempt.candidateJson!)).toMatchObject({ authority: "AI_ANALYZED", resultQuality: "PARTIAL", unresolvedFields: ["equipment"] });
    expect(await db.videoGuidanceBatchItem.findFirstOrThrow()).toMatchObject({ status: "SUCCEEDED", resultQuality: "PARTIAL" });
  });

  it.each([400, 401, 429, 500, "malformed"])("a token-count %s response fails closed and never sends a response", async failure => {
    const fetch = makeOfflineFetch({ ...(failure === "malformed" ? { countBody: "not-json" } : { countStatus: failure as number }) });
    const cp = fakeControl(fetch);
    const p = await plan(cp);
    await expect(cp.countInputTokens(p.record.id, lunaCanaryOwner, p.request)).rejects.toBeDefined();
    expect(countCalls(fetch.calls)).toHaveLength(1);
    expect(responseCalls(fetch.calls)).toHaveLength(0);
    expect(await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: p.record.id } })).toMatchObject({ countOutcome: "FAILED_CONFIRMED" });
  });

  it("treats a token-count timeout after fetch invocation as unknown and makes no response call", async () => {
    const fetch = makeOfflineFetch({ countTimeout: true });
    const cp = control(fetch, { capability: "TOKEN_COUNT_ONLY", apiKey: "fixture-server-key", timeoutMs: 20 });
    const p = await plan(cp);
    await expect(cp.countInputTokens(p.record.id, lunaCanaryOwner, p.request)).rejects.toBeDefined();
    expect(countCalls(fetch.calls)).toHaveLength(1);
    expect(responseCalls(fetch.calls)).toHaveLength(0);
    expect(await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: p.record.id } })).toMatchObject({ countOutcome: "REQUEST_OUTCOME_UNKNOWN" });
  });

  it("denies an over-cap authorization before creating a response batch or attempt", async () => {
    const fetch = makeOfflineFetch();
    const cp = fakeControl(fetch);
    const ready = await count(cp);
    const approval: ResponseApproval = { ...priceAt(clock), costCapUsd: "0.000001", manifestHash: ready.record.manifestHash, requestCap: 1 };
    await expect(cp.authorizeCanary(ready.record.id, lunaCanaryOwner, ready.request, approval)).rejects.toMatchObject({ code: "COST_CAP_EXCEEDED" });
    expect(await db.videoGuidanceBatch.count()).toBe(0);
    expect(await db.videoAnalysisAttempt.count()).toBe(0);
    expect(responseCalls(fetch.calls)).toHaveLength(0);
  });

  it("rechecks exact price freshness immediately before send and records CONFIRMED_NOT_SENT if it expired", async () => {
    const fetch = makeOfflineFetch();
    let advanceOnSent = true;
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key",
      fault: point => { if (point === "AFTER_SENT" && advanceOnSent) { advanceOnSent = false; clock += 2_000; } } });
    const ready = await count(cp);
    // The verification is 23:59:59 old at approval, so the two-second advance makes it stale
    // while the one-hour dispatch ticket and three-minute lease remain valid.
    const nearlyStalePrice = priceAt(clock - 24 * 60 * 60_000 + 1_000);
    const approval: ResponseApproval = { ...nearlyStalePrice, costCapUsd: COST_CAP_USD, manifestHash: ready.record.manifestHash, requestCap: 1 };
    const execution = await cp.authorizeCanary(ready.record.id, lunaCanaryOwner, ready.request, approval);
    await cp.runCanary(execution.item.id, lunaCanaryOwner, ready.request, "stale-price-worker");
    expect(countCalls(fetch.calls)).toHaveLength(1);
    expect(responseCalls(fetch.calls)).toHaveLength(0);
    expect(await db.videoAnalysisAttempt.findFirstOrThrow()).toMatchObject({ outcome: "FAILED_CONFIRMED", reconciliationState: "CONFIRMED" });
  });

  it("requires the authenticated owner grant and NETWORK_DISABLED sends nothing", async () => {
    const noAuthFetch = makeOfflineFetch();
    const denied = control(noAuthFetch, { authorized: false });
    await expect(plan(denied)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(noAuthFetch.calls).toHaveLength(0);
    const disabledFetch = makeOfflineFetch();
    const disabled = control(disabledFetch, { capability: "NETWORK_DISABLED", useTestTransport: false });
    const p = await plan(disabled);
    await expect(disabled.countInputTokens(p.record.id, lunaCanaryOwner, p.request)).rejects.toMatchObject({ code: "NETWORK_DISABLED" });
    expect(disabledFetch.calls).toHaveLength(0);
    expect(await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: p.record.id } })).toMatchObject({ countOutcome: "PENDING" });
  });

  it("reuses idempotent plan, count receipt, approved batch, and result without extra API calls", async () => {
    const fetch = makeOfflineFetch();
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key" });
    const request = buildLunaCanaryFixture();
    const p1 = await plan(cp, request), p2 = await plan(cp, request);
    expect(p1.record.id).toBe(p2.record.id);
    await cp.countInputTokens(p1.record.id, lunaCanaryOwner, request);
    await cp.countInputTokens(p1.record.id, lunaCanaryOwner, request);
    const approval: ResponseApproval = { ...priceAt(clock), costCapUsd: COST_CAP_USD, manifestHash: p1.record.manifestHash, requestCap: 1 };
    const b1 = await cp.authorizeCanary(p1.record.id, lunaCanaryOwner, request, approval);
    const b2 = await cp.authorizeCanary(p1.record.id, lunaCanaryOwner, request, approval);
    expect(b1.batch.id).toBe(b2.batch.id);
    await cp.runCanary(b1.item.id, lunaCanaryOwner, request, "idempotent-worker");
    await cp.runCanary(b1.item.id, lunaCanaryOwner, request, "idempotent-worker-again");
    expect(countCalls(fetch.calls)).toHaveLength(1);
    expect(responseCalls(fetch.calls)).toHaveLength(1);
    expect(await db.videoAnalysisAttempt.count()).toBe(1);
    expect(await db.videoObservationResult.count()).toBe(1);
  });

  it("recovers body persisted before a ledger failure with zero additional provider requests", async () => {
    const fetch = makeOfflineFetch();
    let inject = true;
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key",
      fault: point => { if (point === "AFTER_RAW_FILE" && inject) { inject = false; throw new Error("injected DB unavailable after raw fsync"); } } });
    const ready = await authorize(cp);
    await expect(cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "raw-worker")).rejects.toThrow("injected DB unavailable");
    const attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
    expect((await raw.read(attempt.dispatchKey))?.orphan).toBe(false);
    clock += 180_001;
    await cp.recoverResponse(attempt.id, lunaCanaryOwner, "offline fixture raw recovered after DB fault");
    await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "raw-recovery-worker");
    expect(countCalls(fetch.calls)).toHaveLength(1);
    expect(responseCalls(fetch.calls)).toHaveLength(1);
    expect(await db.videoObservationResult.count()).toBe(1);
  });

  it("keeps x-request-id durable when response headers arrive but body is lost, then leaves outcome UNKNOWN", async () => {
    const fetch = makeOfflineFetch({ responseMode: "body-loss" });
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key" });
    const ready = await authorize(cp);
    await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "body-loss-worker");
    const attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
    expect(attempt).toMatchObject({ outcome: "REQUEST_OUTCOME_UNKNOWN", providerRequestId: "req-header-before-body-loss" });
    expect(await raw.readHeaders(attempt.dispatchKey)).toMatchObject({ requestId: "req-header-before-body-loss", status: 200 });
    expect(responseCalls(fetch.calls)).toHaveLength(1);
    expect(await db.videoObservationResult.count()).toBe(0);
  });

  it("recovers a durable x-request-id after the DB header checkpoint failed, without another API call", async () => {
    const fetch = makeOfflineFetch({ responseMode: "body-loss" });
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key" });
    const ready = await authorize(cp);
    vi.spyOn(repo, "responseHeaders").mockRejectedValueOnce(new Error("injected header DB checkpoint failure"));
    await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "header-recovery-worker");
    let attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
    expect(attempt).toMatchObject({ outcome: "REQUEST_OUTCOME_UNKNOWN", providerRequestId: null });
    expect(await raw.readHeaders(attempt.dispatchKey)).toMatchObject({ requestId: "req-header-before-body-loss", status: 200 });
    await cp.recoverResponseHeaders(attempt.id, lunaCanaryOwner);
    attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
    expect(attempt).toMatchObject({ outcome: "REQUEST_OUTCOME_UNKNOWN", providerRequestId: "req-header-before-body-loss" });
    expect(responseCalls(fetch.calls)).toHaveLength(1);
    expect(await db.videoObservationResult.count()).toBe(0);
  });

  it.each(["invalid-json", "schema-invalid", "empty-output", "unknown-field", "incomplete"] as const)(
    "retains raw %s response, saves any parseable usage, fails closed, and never retries", async mutation => {
      const fetch = makeOfflineFetch({ responseMutation: mutation });
      const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key" });
      const ready = await authorize(cp);
      await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, `invalid-${mutation}`);
      const attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
      expect(attempt.rawHash).toEqual(expect.any(String));
      expect((await raw.read(attempt.dispatchKey))?.orphan).toBe(false);
      expect(await db.videoObservationResult.count()).toBe(0);
      if (mutation === "invalid-json") {
        expect(attempt).toMatchObject({ errorCode: "USAGE_UNKNOWN", accounted: false });
      } else {
        expect(attempt).toMatchObject({ errorCode: "SCHEMA_INVALID", accounted: true, providerUsageJson: expect.any(String) });
      }
      await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, `invalid-${mutation}-retry`);
      expect(responseCalls(fetch.calls)).toHaveLength(1);
      expect(await db.videoAnalysisAttempt.count()).toBe(1);
    });


  it("marks a sent response timeout UNKNOWN and never retries its dispatch after lease expiry", async () => {
    const fetch = makeOfflineFetch({ responseMode: "hang" });
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key", timeoutMs: 20 });
    const ready = await authorize(cp);
    await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "timeout-worker");
    const attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
    expect(attempt).toMatchObject({ outcome: "REQUEST_OUTCOME_UNKNOWN" });
    clock += 180_001;
    fetch.setResponseMode("success");
    await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "timeout-retry-worker");
    expect(responseCalls(fetch.calls)).toHaveLength(1);
    expect(await db.videoAnalysisAttempt.count()).toBe(1);
    expect(await db.videoObservationResult.count()).toBe(0);
  });

  it("pauses during response dispatch, then completes the already in-flight raw without another dispatch", async () => {
    const fetch = makeOfflineFetch({ responseMode: "deferred" });
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key" });
    const ready = await authorize(cp);
    const running = cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "pause-worker");
    await fetch.deferredStarted;
    await repo.pause(ready.execution.batch.id, lunaCanaryOwner, "TEST_PAUSE_IN_FLIGHT");
    fetch.release();
    await running;
    expect(await db.videoGuidanceBatch.findUniqueOrThrow({ where: { id: ready.execution.batch.id } })).toMatchObject({ status: "PAUSED" });
    expect(await db.videoGuidanceBatchItem.findUniqueOrThrow({ where: { id: ready.execution.item.id } })).toMatchObject({ status: "SUCCEEDED" });
    expect(responseCalls(fetch.calls)).toHaveLength(1);
  });

  it("quarantines a late response after lease expiry and does not publish an observation", async () => {
    const fetch = makeOfflineFetch({ responseMode: "deferred" });
    const cp = control(fetch, { capability: "CANARY_RESPONSE_ALLOWED", apiKey: "fixture-server-key" });
    const ready = await authorize(cp);
    const running = cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "late-worker");
    await fetch.deferredStarted;
    clock += 180_001;
    fetch.release();
    await running;
    expect(await db.videoAnalysisAttempt.findFirstOrThrow()).toMatchObject({ outcome: "RECEIVED", reconciliationState: "QUARANTINED" });
    expect(await db.videoObservationResult.count()).toBe(0);
    expect(responseCalls(fetch.calls)).toHaveLength(1);
  });
});
