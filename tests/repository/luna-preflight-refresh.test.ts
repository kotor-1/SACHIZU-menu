import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPersistenceDatabaseTemplate } from "../fixtures/video-guidance-persistence";
import {
  buildLunaCanaryFixture,
  buildLunaResponseBody,
  lunaCanaryActor,
  lunaCanaryBinding,
  lunaCanaryOwner,
  lunaCanaryTarget,
} from "../fixtures/luna-canary";
import {
  LunaCanaryControlPlane,
  lunaCanaryManifestHash,
  type CanaryApproval,
  type ResponseApproval,
} from "@/application/video-batch/luna-canary";
import {
  createLunaPriceSnapshot,
  expectedLunaScheduleHash,
  type PriceVerification,
} from "@/domain/video-batch/luna-cost";
import { contentKey, digest, workKey } from "@/domain/video-batch/contracts";
import { LUNA_MODEL } from "@/domain/video-batch/luna-schema";
import { LunaBatchRepository } from "@/infra/video-batch/luna-repository";
import { OpenAiLunaProvider } from "@/infra/video-batch/luna-provider";
import { markedTestTransport, type FetchLike } from "@/infra/video-batch/luna-transport";
import { PrivateRawStore } from "@/infra/video-batch/private-raw-store";

const CANARY_COST_CAP_USD = "0.01";
const COUNT_TOKENS = 14_492;
const nowDate = (ms: number) => new Date(ms);
const uuid = () => randomUUID();

function pricesAt(ms: number) {
  const currentPriceVerification: PriceVerification = {
    source: "https://developers.openai.com/api/docs/pricing",
    pricingAsOf: "2026-10-05",
    scheduleHash: expectedLunaScheduleHash("2026-10-05"),
    sourceContentHash: "d".repeat(64),
    checkedAt: nowDate(ms).toISOString(),
  };
  return { currentPriceVerification, priceSnapshot: createLunaPriceSnapshot(currentPriceVerification) };
}

function offlineTransport(inputTokens = COUNT_TOKENS) {
  const calls: Array<{ url: string; body: string; clientId: string | null }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, body, clientId: new Headers(init?.headers).get("x-client-request-id") });
    if (url.endsWith("/v1/responses/input_tokens")) {
      return new Response(JSON.stringify({ object: "response.input_tokens", input_tokens: inputTokens }), {
        status: 200,
        headers: { "x-request-id": `req-count-${calls.length}` },
      });
    }
    const response = buildLunaResponseBody();
    response.usage.input_tokens = inputTokens;
    response.usage.total_tokens = inputTokens + response.usage.output_tokens;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": `req-response-${calls.length}` },
    });
  };
  return {
    transport: markedTestTransport(fetch),
    calls,
    countCalls: () => calls.filter(call => call.url.endsWith("/v1/responses/input_tokens")),
    responseCalls: () => calls.filter(call => call.url.endsWith("/v1/responses")),
  };
}

let template: Awaited<ReturnType<typeof createPersistenceDatabaseTemplate>>;
let db: PrismaClient;
let clock: number;
let rawRoot: string;
let raw: PrivateRawStore;
let repo: LunaBatchRepository;
let identity: {
  currentIdentity: () => Promise<{
    actorId: string;
    ownerIds: string[];
    permissions: string[];
    ownerPermissions: { ownerId: string; permissions: ["ANALYZE_VIDEO_GUIDANCE"] }[];
  } | null>;
};
const rawRoots: string[] = [];

beforeAll(async () => { template = await createPersistenceDatabaseTemplate(); }, 90_000);
beforeEach(async () => {
  db = await template.open();
  clock = Date.parse("2026-10-05T12:00:00.000Z");
  await db.user.create({ data: { ...lunaCanaryActor, emailVerified: true } });
  await db.guidanceOwnerAccess.create({
    data: { userId: lunaCanaryActor.id, ownerId: lunaCanaryOwner, permission: "ANALYZE_VIDEO_GUIDANCE" },
  });
  await db.exercise.create({ data: {
    id: lunaCanaryTarget.exerciseId,
    ownerId: lunaCanaryOwner,
    name: "Canary 0 refresh fixture",
    category: "DRILL",
  } });
  await db.videoAsset.create({ data: {
    id: lunaCanaryBinding.sourceVideoId,
    ownerId: lunaCanaryOwner,
    exerciseId: lunaCanaryTarget.exerciseId,
    storageKey: lunaCanaryBinding.storageKey,
    sourceUrl: lunaCanaryBinding.sourceUrl,
    filename: "canary-0.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1200,
    durationSeconds: 16,
  } });
  identity = { currentIdentity: async () => ({
    actorId: lunaCanaryActor.id,
    ownerIds: [lunaCanaryOwner],
    permissions: [],
    ownerPermissions: [{ ownerId: lunaCanaryOwner, permissions: ["ANALYZE_VIDEO_GUIDANCE"] }],
  }) };
  rawRoot = await realpath(await mkdtemp(path.join(tmpdir(), "luna-preflight-refresh-raw-")));
  rawRoots.push(rawRoot);
  raw = new PrivateRawStore(rawRoot);
  repo = new LunaBatchRepository(db, () => nowDate(clock));
});
afterEach(async () => { await db?.$disconnect(); });
afterAll(async () => {
  for (const root of rawRoots) await rm(root, { recursive: true, force: true });
  await template.dispose();
});

function controlPlane(fetch: ReturnType<typeof offlineTransport>, options: {
  afterSent?: () => void;
  inputTokens?: number;
} = {}) {
  const provider = new OpenAiLunaProvider(raw, {
    capability: "NETWORK_DISABLED",
    testTransport: fetch.transport,
    now: () => clock,
    timeoutMs: 2000,
  });
  return new LunaCanaryControlPlane(identity, repo, provider, async () => true, () => nowDate(clock), point => {
    if (point === "AFTER_SENT") options.afterSent?.();
  });
}

function planApproval(request: ReturnType<typeof buildLunaCanaryFixture>, options: {
  runId?: string;
  previousPreflightId?: string | null;
  expiresAt?: Date;
} = {}): CanaryApproval {
  return {
    manifestHash: lunaCanaryManifestHash(lunaCanaryOwner, lunaCanaryTarget, request),
    expiresAt: options.expiresAt ?? nowDate(clock + 60 * 60_000),
    requestCap: 1,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.previousPreflightId === undefined ? {} : { previousPreflightId: options.previousPreflightId }),
  } as CanaryApproval;
}

async function planRun(cp: LunaCanaryControlPlane, options: {
  request?: ReturnType<typeof buildLunaCanaryFixture>;
  runId?: string;
  previousPreflightId?: string | null;
  expiresAt?: Date;
} = {}) {
  const request = options.request ?? buildLunaCanaryFixture();
  const approval = planApproval(request, options);
  const row = await cp.plan(lunaCanaryOwner, lunaCanaryTarget, request, approval);
  return { row, request, approval };
}

async function countRun(cp: LunaCanaryControlPlane, options: Parameters<typeof planRun>[1] = {}) {
  const plan = await planRun(cp, options);
  const receipt = await cp.countInputTokens(plan.row.id, lunaCanaryOwner, plan.request);
  return { ...plan, receipt };
}

async function refreshRun(cp: LunaCanaryControlPlane, parentId: string, runId = uuid(), expiresAt = nowDate(clock + 60 * 60_000)) {
  return planRun(cp, { runId, previousPreflightId: parentId, expiresAt });
}

async function authorizeRun(cp: LunaCanaryControlPlane, run: Awaited<ReturnType<typeof countRun>>, costCapUsd = CANARY_COST_CAP_USD) {
  const approval: ResponseApproval = {
    ...pricesAt(clock),
    costCapUsd,
    manifestHash: run.row.manifestHash,
    requestCap: 1,
  };
  const execution = await cp.authorizeCanary(run.row.id, lunaCanaryOwner, run.request, approval);
  return { ...run, approval, execution };
}

async function expirePreflight(cp: LunaCanaryControlPlane, runId = uuid()) {
  const run = await countRun(cp, { runId, expiresAt: nowDate(clock + 1_000) });
  const before = await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: run.row.id } });
  clock += 1_001;
  return { ...run, before };
}

describe("Luna preflight refresh lineage and run isolation", () => {
  it("reuses a same-run preflight while it remains valid", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const request = buildLunaCanaryFixture();
    const runId = uuid();
    const first = await planRun(cp, { request, runId });
    const originalExpiry = first.row.expiresAt.getTime();
    const originalReceipt = await cp.countInputTokens(first.row.id, lunaCanaryOwner, request);
    const again = await cp.plan(lunaCanaryOwner, lunaCanaryTarget, request, {
      ...first.approval, expiresAt: nowDate(clock + 2 * 60 * 60_000),
    });
    expect(again.id).toBe(first.row.id);
    expect(again.expiresAt.getTime()).toBe(originalExpiry);
    await expect(cp.countInputTokens(again.id, lunaCanaryOwner, request)).resolves.toEqual(originalReceipt);
    expect(fetch.countCalls()).toHaveLength(1);
  });

  it("denies reuse of the same run ID once its preflight expires", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const expired = await expirePreflight(cp);
    await expect(cp.plan(lunaCanaryOwner, lunaCanaryTarget, expired.request, expired.approval))
      .rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
    await expect(cp.countInputTokens(expired.row.id, lunaCanaryOwner, expired.request))
      .rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
    expect(fetch.countCalls()).toHaveLength(1);
  });

  it("creates an expired-parent refresh under a new run ID and new dispatch key", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const expired = await expirePreflight(cp);
    const refreshed = await refreshRun(cp, expired.row.id);
    expect(refreshed.row.id).not.toBe(expired.row.id);
    expect(refreshed.row.runId).not.toBe(expired.row.runId);
    expect(refreshed.row.previousPreflightId).toBe(expired.row.id);
    expect(refreshed.row.countDispatchKey).not.toBe(expired.row.countDispatchKey);
    expect(refreshed.row.countReceiptJson).toBeNull();
    expect(fetch.countCalls()).toHaveLength(1);
  });

  it("performs a new exact token count for the refreshed run and stores the fixture count 14,492", async () => {
    const fetch = offlineTransport(COUNT_TOKENS);
    const cp = controlPlane(fetch);
    const expired = await expirePreflight(cp);
    const refreshed = await refreshRun(cp, expired.row.id);
    const receipt = await cp.countInputTokens(refreshed.row.id, lunaCanaryOwner, refreshed.request);
    expect(receipt).toMatchObject({ model: LUNA_MODEL, inputTokens: 14_492,
      payloadHash: refreshed.row.payloadHash, frameManifestHash: refreshed.row.frameManifestHash, frameCount: 12 });
    expect(fetch.countCalls()).toHaveLength(2);
    const prior = await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: expired.row.id } });
    expect(prior.countReceiptJson).toBe(expired.before.countReceiptJson);
    expect(refreshed.row.countDispatchKey).not.toBe(expired.row.countDispatchKey);
  });

  it("does not authorize new inference from only the expired parent receipt", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const expired = await expirePreflight(cp);
    const refreshed = await refreshRun(cp, expired.row.id);
    expect(refreshed.row.countReceiptJson).toBeNull();
    const approval: ResponseApproval = {
      ...pricesAt(clock), costCapUsd: CANARY_COST_CAP_USD,
      manifestHash: refreshed.row.manifestHash, requestCap: 1,
    };
    await expect(cp.authorizeCanary(refreshed.row.id, lunaCanaryOwner, refreshed.request, approval))
      .rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
    expect(fetch.responseCalls()).toHaveLength(0);
  });

  it("hands only the refreshed run receipt into mock inference", async () => {
    const fetch = offlineTransport(COUNT_TOKENS);
    const cp = controlPlane(fetch);
    const expired = await expirePreflight(cp);
    const refreshed = await refreshRun(cp, expired.row.id);
    const receipt = await cp.countInputTokens(refreshed.row.id, lunaCanaryOwner, refreshed.request);
    const ready = await authorizeRun(cp, { ...refreshed, receipt });
    const priorUsage = JSON.parse(expired.before.countReceiptJson!) as { inputTokens: number };
    expect(priorUsage.inputTokens).toBe(COUNT_TOKENS);
    expect(receipt.inputTokens).toBe(COUNT_TOKENS);
    await cp.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "refresh-handoff-worker");
    expect(fetch.countCalls()).toHaveLength(2);
    expect(fetch.responseCalls()).toHaveLength(1);
    const attempt = await db.videoAnalysisAttempt.findFirstOrThrow();
    expect(JSON.parse(attempt.providerUsageJson!).inputTokens).toBe(receipt.inputTokens);
    expect(attempt.outcome).toBe("RECEIVED");
  });

  it("rejects a high count cost before making any response request", async () => {
    const highInputTokens = 1_050_000;
    const fetch = offlineTransport(highInputTokens);
    const cp = controlPlane(fetch);
    const run = await countRun(cp, { runId: uuid() });
    const approval: ResponseApproval = {
      ...pricesAt(clock), costCapUsd: CANARY_COST_CAP_USD,
      manifestHash: run.row.manifestHash, requestCap: 1,
    };
    await expect(cp.authorizeCanary(run.row.id, lunaCanaryOwner, run.request, approval))
      .rejects.toMatchObject({ code: "COST_CAP_EXCEEDED" });
    expect(fetch.countCalls()).toHaveLength(1);
    expect(fetch.responseCalls()).toHaveLength(0);
    expect(await db.videoAnalysisAttempt.count()).toBe(0);
  });

  it("serializes concurrent same-run reuse and competing child refreshes without duplicate counts", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const expired = await expirePreflight(cp);
    const competingRunIds = [uuid(), uuid()];
    const contenders = await Promise.allSettled(competingRunIds.map(runId => refreshRun(cp, expired.row.id, runId)));
    const winner = contenders.find(result => result.status === "fulfilled");
    expect(contenders.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter(result => result.status === "rejected")).toHaveLength(1);
    if (winner?.status !== "fulfilled") throw new Error("no refresh winner");
    const sameRunArgs = { request: expired.request, runId: winner.value.row.runId,
      previousPreflightId: expired.row.id, expiresAt: nowDate(clock + 60 * 60_000) };
    const sameRunRetries = await Promise.all([planRun(cp, sameRunArgs), planRun(cp, sameRunArgs)]);
    expect(sameRunRetries[0].row.id).toBe(winner.value.row.id);
    expect(sameRunRetries[1].row.id).toBe(winner.value.row.id);
    expect(await db.videoLunaPreflight.count()).toBe(2);
    expect(fetch.countCalls()).toHaveLength(1);
    const peer = template.peer(db);
    try {
      const peerPlane = new LunaCanaryControlPlane(identity, new LunaBatchRepository(peer, () => nowDate(clock)),
        new OpenAiLunaProvider(raw, { capability: "NETWORK_DISABLED", testTransport: fetch.transport, now: () => clock }),
        async () => true, () => nowDate(clock));
      const counts = await Promise.allSettled([cp, peerPlane].map(plane =>
        plane.countInputTokens(winner.value.row.id, lunaCanaryOwner, expired.request)));
      expect(counts.some(result => result.status === "fulfilled")).toBe(true);
      expect(fetch.countCalls()).toHaveLength(2); // One historical fixture count + exactly one refreshed count.
      expect(fetch.responseCalls()).toHaveLength(0);
    } finally { await peer.$disconnect(); }
  });

  it("rejects the refreshed receipt again when its own stored expiry passes", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const parent = await expirePreflight(cp);
    const refreshed = await refreshRun(cp, parent.row.id, uuid(), nowDate(clock + 1_000));
    const receipt = await cp.countInputTokens(refreshed.row.id, lunaCanaryOwner, refreshed.request);
    const ready = await authorizeRun(cp, { ...refreshed, receipt });
    clock += 1_001;
    await expect(cp.countInputTokens(refreshed.row.id, lunaCanaryOwner, refreshed.request))
      .rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
    await expect(cp.runCanary(ready.execution.item.id, lunaCanaryOwner, refreshed.request, "expired-refresh"))
      .rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
    expect(fetch.countCalls()).toHaveLength(2);
    expect(fetch.responseCalls()).toHaveLength(0);
    expect((await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: refreshed.row.id } })).countReceiptJson)
      .toContain(receipt.countedAt);
  });

  it("cannot use a fresh run ID to evade an unknown token-count flight", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const run = await planRun(cp, { runId: uuid(), expiresAt: nowDate(clock + 1_000) });
    const ticket = await repo.beginCount(run.row.id, lunaCanaryOwner, lunaCanaryActor.id, run.request.requestHash);
    await repo.countFailure(run.row.id, lunaCanaryOwner, ticket.dispatchKey, false, "TOKEN_COUNT_OUTCOME_UNKNOWN");
    const prior = await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: run.row.id } });
    clock += 1_001;
    await expect(refreshRun(cp, run.row.id)).rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
    expect(await db.videoLunaPreflight.count()).toBe(1);
    expect(await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: run.row.id } })).toEqual(prior);
    expect(fetch.calls).toHaveLength(0);
  });

  it("leaves the expired parent history and receipt immutable while the new run uses the same payload keys", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const parent = await countRun(cp, { runId: uuid(), expiresAt: nowDate(clock + 1_000) });
    const parentReady = await authorizeRun(cp, parent);
    const oldSnapshot = await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: parent.row.id } });
    clock += 1_001;
    const expired = parent;
    const refreshed = await refreshRun(cp, expired.row.id);
    const newReceipt = await cp.countInputTokens(refreshed.row.id, lunaCanaryOwner, refreshed.request);
    const ready = await authorizeRun(cp, { ...refreshed, receipt: newReceipt });
    const afterSnapshot = await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: expired.row.id } });
    expect(afterSnapshot).toEqual(oldSnapshot);
    expect(afterSnapshot.countReceiptJson).toBe(oldSnapshot.countReceiptJson);
    const oldConfig = JSON.parse(parentReady.execution.batch.configJson);
    const newConfig = JSON.parse(ready.execution.batch.configJson);
    expect(contentKey(lunaCanaryOwner, lunaCanaryTarget, oldConfig)).toBe(contentKey(lunaCanaryOwner, lunaCanaryTarget, newConfig));
    expect(workKey(lunaCanaryOwner, lunaCanaryTarget, oldConfig)).toBe(workKey(lunaCanaryOwner, lunaCanaryTarget, newConfig));
    const oldItem = await db.videoGuidanceBatchItem.findFirstOrThrow({ where: { batchId: parentReady.execution.batch.id } });
    expect(ready.execution.item.contentKey).toBe(oldItem.contentKey);
    expect(ready.execution.item.workKey).toBe(oldItem.workKey);
    const refreshedGate = await db.videoLunaPreflight.findUniqueOrThrow({ where: { id: refreshed.row.id } });
    expect(refreshedGate.countReceiptJson).toContain('"inputTokens":14492');
  });

  it("preserves the pre-refresh work-key formula for existing isolated-fake configurations", async () => {
    const fakeConfig = {
      provider: "isolated-fake" as const,
      model: "synthetic-v1" as const,
      schemaVersion: "neutral-v1" as const,
      promptVersion: "legacy-fake-prompt-v1",
      configVersion: "legacy-fake-config-v1",
      recipe: "legacy-fake-recipe-v1",
      inputManifest: "legacy-fake-manifest-v1",
      segment: { startMs: 0, endMs: 1000 },
      worstCase: { requests: 1, tokens: 30, cost: 7 },
      maxRetries: 0,
      leaseMs: 180_000,
    };
    const expectedContentKey = digest({ ownerId: lunaCanaryOwner,
      mediaFingerprint: lunaCanaryTarget.sourceBinding.contentSha256, segment: fakeConfig.segment,
      recipe: fakeConfig.recipe, inputManifest: fakeConfig.inputManifest, provider: fakeConfig.provider,
      model: fakeConfig.model, schemaVersion: fakeConfig.schemaVersion,
      promptVersion: fakeConfig.promptVersion, configVersion: fakeConfig.configVersion });
    const legacyWorkKey = digest({ ownerId: lunaCanaryOwner, exerciseId: lunaCanaryTarget.exerciseId,
      sourceBinding: lunaCanaryTarget.sourceBinding, contentKey: expectedContentKey, configHash: digest(fakeConfig) });
    expect(contentKey(lunaCanaryOwner, lunaCanaryTarget, fakeConfig)).toBe(expectedContentKey);
    expect(workKey(lunaCanaryOwner, lunaCanaryTarget, fakeConfig)).toBe(legacyWorkKey);
  });

  it("denies an already-expired new run and proves AFTER_SENT cannot issue a fake response call", async () => {
    const fetch = offlineTransport();
    const cp = controlPlane(fetch);
    const expired = await expirePreflight(cp);
    await expect(refreshRun(cp, expired.row.id, uuid(), nowDate(clock - 1)))
      .rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
    expect(fetch.countCalls()).toHaveLength(1);

    const freshRun = await refreshRun(cp, expired.row.id);
    const receipt = await cp.countInputTokens(freshRun.row.id, lunaCanaryOwner, freshRun.request);
    const counted = { ...freshRun, receipt };
    const ready = await authorizeRun(cp, counted);
    const afterSentControl = controlPlane(fetch, { afterSent: () => { throw new Error("stop-after-sent-marker"); } });
    await expect(afterSentControl.runCanary(ready.execution.item.id, lunaCanaryOwner, ready.request, "after-sent-worker"))
      .rejects.toThrow("stop-after-sent-marker");
    expect(fetch.responseCalls()).toHaveLength(0);
    expect(await db.videoAnalysisAttempt.findFirstOrThrow()).toMatchObject({ outcome: "SENT" });
  });
});
