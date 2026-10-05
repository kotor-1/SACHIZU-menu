import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LunaTransport, makeLunaPermit, markedTestTransport, type TransportRequest } from "@/infra/video-batch/luna-transport";
import { PrivateRawStore, type RawMetadata } from "@/infra/video-batch/private-raw-store";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request = (operation: "countInputTokens" | "createResponse" = "countInputTokens", body: Record<string, unknown> = { model: "gpt-6-luna", input: "fixture" }): TransportRequest => {
  const serialized = JSON.stringify(body);
  const payloadHash = hash(serialized);
  const dispatchKey = "7b9c4e2d-6a10-4c33-a742-d851a2cfe520";
  return { operation, body, payloadHash, dispatchKey, clientRequestId: `cg-${operation}-123`,
    permit: makeLunaPermit({ capability: operation === "createResponse" ? "CANARY_RESPONSE_ALLOWED" : "TOKEN_COUNT_ONLY", operation,
      payloadHash, dispatchKey, expiresAt: Date.now() + 30_000 }) };
};
const response = (body: Uint8Array | string, init: { status?: number; headers?: Record<string, string> } = {}) => new Response(typeof body === "string" ? body : Buffer.from(body), { status: init.status ?? 200, headers: init.headers });

describe("Luna direct transport", () => {
  it("pins endpoint, model, client ID, bearer header, sends once, captures provider ID before returning body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = new LunaTransport({ capability: "NETWORK_DISABLED", testTransport: markedTestTransport(async (url, init) => {
      calls.push({ url: String(url), init }); return response('{"input_tokens":17}', { headers: { "x-request-id": "req-header-1" } });
    }) });
    let progress: { requestId: string | null } | undefined;
    const req = request();
    const result = await transport.send(req, value => { progress = value; });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses/input_tokens");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.redirect).toBe("error");
    expect(new Headers(calls[0].init?.headers).get("x-client-request-id")).toBe(req.clientRequestId);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(progress?.requestId).toBe("req-header-1");
    expect(result.requestId).toBe("req-header-1");
    expect(Buffer.from(result.body).toString()).toBe('{"input_tokens":17}');
  });

  it("denies before fetch for every non-Luna model, expired permit, and hash mismatch", async () => {
    let calls = 0;
    const transport = new LunaTransport({ capability: "NETWORK_DISABLED", testTransport: markedTestTransport(async () => { calls++; return response("{}"); }) });
    const good = request();
    for (const model of ["gpt-6-sol", "gpt-6-astra", "gpt-5.6-luna", "unknown-model", ""]) {
      const body = { ...good.body, model };
      const payloadHash = hash(JSON.stringify(body));
      const permit = makeLunaPermit({ capability: "TOKEN_COUNT_ONLY", operation: "countInputTokens", payloadHash,
        dispatchKey: good.dispatchKey, expiresAt: Date.now() + 30_000 });
      await expect(transport.send({ ...good, body, payloadHash, permit })).rejects.toMatchObject({ stage: "BEFORE_SEND", code: "MODEL_MISMATCH" });
    }
    const wrongHash = "0".repeat(64);
    await expect(transport.send({ ...good, payloadHash: wrongHash, permit: { ...good.permit, payloadHash: wrongHash } })).rejects.toMatchObject({ stage: "BEFORE_SEND", code: "PAYLOAD_HASH_MISMATCH" });
    await expect(transport.send({ ...good, permit: { ...good.permit, expiresAt: Date.now() - 1 } })).rejects.toMatchObject({ stage: "BEFORE_SEND", code: "INVALID_DISPATCH_PERMIT" });
    expect(calls).toBe(0);
    expect(() => makeLunaPermit({ capability: "NETWORK_DISABLED", operation: "countInputTokens", payloadHash: good.payloadHash, dispatchKey: good.dispatchKey, expiresAt: Date.now() + 1000 }))
      .toThrowError("NETWORK_CAPABILITY_DENIED");
  });

  it("does not call even a marked fake for an already-aborted request or a response under TOKEN_COUNT_ONLY", async () => {
    let calls = 0;
    const transport = new LunaTransport({ capability: "TOKEN_COUNT_ONLY", testTransport: markedTestTransport(async () => { calls++; return response("{}"); }) });
    const abort = new AbortController(); abort.abort();
    await expect(transport.send({ ...request(), signal: abort.signal })).rejects.toMatchObject({ stage: "BEFORE_SEND", code: "ABORTED_BEFORE_SEND" });
    const responseRequest = request("createResponse");
    await expect(transport.send(responseRequest)).rejects.toMatchObject({ stage: "BEFORE_SEND", code: "NETWORK_CAPABILITY_DENIED" });
    expect(calls).toBe(0);
  });

  it("classifies fetch rejection and response-body loss as UNKNOWN and never retries", async () => {
    let calls = 0;
    const transport = new LunaTransport({ capability: "CANARY_RESPONSE_ALLOWED", apiKey: "server-secret", testTransport: markedTestTransport(async () => {
      calls++; throw new Error("socket closed");
    }) });
    await expect(transport.send(request("createResponse"))).rejects.toMatchObject({ stage: "SENT_OR_UNKNOWN", code: "REQUEST_OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);

    let savedId: string | null = null;
    const bodyTransport = new LunaTransport({ capability: "CANARY_RESPONSE_ALLOWED", apiKey: "server-secret", testTransport: markedTestTransport(async () => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("body lost")); } });
      return new Response(stream, { headers: { "x-request-id": "req-before-body" } });
    }) });
    await expect(bodyTransport.send(request("createResponse"), p => { savedId = p.requestId; }))
      .rejects.toMatchObject({ stage: "SENT_OR_UNKNOWN" });
    expect(savedId).toBe("req-before-body");
  });

  it("retains malformed response bytes for raw-first parsing and caps response bytes", async () => {
    const malformed = new TextEncoder().encode("not-json");
    const transport = new LunaTransport({ capability: "TOKEN_COUNT_ONLY", testTransport: markedTestTransport(async () => response(malformed)) });
    const received = await transport.send(request());
    expect(Buffer.from(received.body)).toEqual(Buffer.from(malformed));
    const tooSmall = new LunaTransport({ capability: "TOKEN_COUNT_ONLY", maxResponseBytes: 4, testTransport: markedTestTransport(async () => response("12345")) });
    await expect(tooSmall.send(request())).rejects.toMatchObject({ stage: "SENT_OR_UNKNOWN", code: "RESPONSE_TOO_LARGE" });
  });

  it("enforces timeout during response body reads and cancels the reader", async () => {
    let cancelled = false;
    const pendingBody = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; },
    });
    const transport = new LunaTransport({ capability: "TOKEN_COUNT_ONLY", timeoutMs: 25,
      testTransport: markedTestTransport(async () => new Response(pendingBody)) });
    await expect(transport.send(request())).rejects.toMatchObject({ stage: "SENT_OR_UNKNOWN", code: "OPENAI_TIMEOUT" });
    expect(cancelled).toBe(true);
  });
});

describe("private durable raw store", () => {
  const metadata: RawMetadata = { operation: "createResponse", status: 200, requestId: "header-id", clientRequestId: "client-id",
    payloadHash: "a".repeat(64), latencyMs: 10, returnedModel: "gpt-6-luna", responseId: "body-id" };
  async function temp() { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "luna-raw-"))); dirs.push(d); return d; }

  it("writes immutable 0600 raw bytes and allowlisted metadata under a 0700 private directory", async () => {
    const root = await temp();
    const store = new PrivateRawStore(root);
    const bytes = Buffer.from("{bad-json");
    const key = "7b9c4e2d-6a10-4c33-a742-d851a2cfe520";
    await store.saveHeaders(key, { requestId: "header-id", headersReceivedAt: 123, status: 200 });
    const receipt = await store.save(key, bytes, metadata);
    expect(receipt.sha256).toBe(hash(bytes.toString()));
    expect((await fs.stat(path.dirname(receipt.rawPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(receipt.rawPath)).mode & 0o777).toBe(0o600);
    expect((await store.read(key))?.metadata).toEqual(metadata);
    expect(await store.readHeaders(key)).toEqual({ requestId: "header-id", headersReceivedAt: 123, status: 200 });
    expect(await fs.readFile(receipt.rawPath)).toEqual(bytes);
    await expect(store.save(key, Buffer.from("replacement"), metadata)).rejects.toThrow("RAW_IMMUTABLE_EXISTS");
    const metadataOnDisk = await fs.readFile(receipt.metadataPath, "utf8");
    expect(metadataOnDisk).not.toContain("Authorization");
    expect(metadataOnDisk).not.toContain("server-secret");
  });

  it("recovers raw-only crash orphan and adopts it without another request", async () => {
    const root = await temp();
    const store = new PrivateRawStore(root);
    const bytes = Buffer.from("raw persisted before metadata crash");
    const key = "abc123de-0000-4000-8000-000000000002";
    const receipt = await store.save(key, bytes, metadata);
    await fs.unlink(receipt.metadataPath);
    const recovery = await store.recover();
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ orphan: true, metadata: null, receipt: { sha256: hash(bytes.toString()) } });
    await store.adopt(key, metadata);
    expect((await store.read(key))?.orphan).toBe(false);
  });

  it("rejects public/upload roots, symlinks, traversal, and secret-bearing metadata", async () => {
    const root = await temp();
    await expect(fs.mkdir(path.join(root, "public"))).resolves.toBeUndefined();
    expect(() => new PrivateRawStore(path.join(root, "public", "uploads"))).toThrow("PUBLIC_RAW_PATH_FORBIDDEN");
    const store = new PrivateRawStore(root);
    await expect(store.save("../escape", Buffer.from("x"), metadata)).rejects.toThrow("INVALID_DISPATCH_KEY");
    const base = path.join(root, "link"); await fs.symlink(path.join(root, "outside"), base);
    const symlinkStore = new PrivateRawStore(base);
    await expect(symlinkStore.save("safe", Buffer.from("x"), metadata)).rejects.toThrow("SYMLINK_PATH_FORBIDDEN");
    await expect(store.save("7b9c4e2d-6a10-4c33-a742-d851a2cfe520", Buffer.from("x"), { ...metadata, authorization: "Bearer secret" } as RawMetadata)).rejects.toThrow("INVALID_RAW_METADATA");
  });
});
