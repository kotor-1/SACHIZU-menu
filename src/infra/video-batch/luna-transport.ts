import { createHash, randomUUID } from "node:crypto";

export const LUNA_MODEL = "gpt-6-luna" as const;
export const OPENAI_API_BASE = "https://api.openai.com" as const;
export type LunaOperation = "countInputTokens" | "createResponse";
export type NetworkCapability = "NETWORK_DISABLED" | "TOKEN_COUNT_ONLY" | "CANARY_RESPONSE_ALLOWED";
export type Permit = Readonly<{ operation: LunaOperation; payloadHash: string; dispatchKey: string; expiresAt: number; nonce: string }>;
export type RequestProgress = { requestId: string | null; headersReceivedAt: number; status: number };
export type TransportRequest = Readonly<{
  operation: LunaOperation; body: Record<string, unknown>; payloadHash: string; dispatchKey: string;
  clientRequestId: string; permit: Permit; signal?: AbortSignal;
}>;
export type TransportResponse = Readonly<{ status: number; body: Uint8Array; requestId: string | null; latencyMs: number }>;
export type TransportFailureStage = "BEFORE_SEND" | "SENT_OR_UNKNOWN";
export class LunaTransportError extends Error {
  constructor(readonly code: string, readonly stage: TransportFailureStage) { super(code); this.name = "LunaTransportError"; }
}
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type MarkedTestTransport = Readonly<{ kind: "video-guidance-test-transport"; fetch: FetchLike }>;
export const markedTestTransport = (fetch: FetchLike): MarkedTestTransport => ({ kind: "video-guidance-test-transport", fetch });

const operationPath: Record<LunaOperation, string> = {
  countInputTokens: "/v1/responses/input_tokens",
  createResponse: "/v1/responses",
};
const isHash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Hash the exact JSON bytes the direct HTTP transport will send. */
export const lunaTransportPayloadHash = (body: Record<string, unknown>) => sha256(Buffer.from(JSON.stringify(body), "utf8"));

/** Mint a short-lived, exact-payload permit only after an upstream durable dispatch claim. */
export function makeLunaPermit(input: { capability: NetworkCapability; operation: LunaOperation; payloadHash: string; dispatchKey: string; expiresAt: number; now?: number }): Permit {
  const now = input.now ?? Date.now();
  if (input.capability === "NETWORK_DISABLED" || (input.operation === "countInputTokens" && input.capability !== "TOKEN_COUNT_ONLY" && input.capability !== "CANARY_RESPONSE_ALLOWED") ||
      (input.operation === "createResponse" && input.capability !== "CANARY_RESPONSE_ALLOWED")) throw new LunaTransportError("NETWORK_CAPABILITY_DENIED", "BEFORE_SEND");
  if (!isHash(input.payloadHash) || !input.dispatchKey.trim() || input.expiresAt <= now || input.expiresAt - now > 5 * 60_000)
    throw new LunaTransportError("INVALID_DISPATCH_PERMIT", "BEFORE_SEND");
  return Object.freeze({ operation: input.operation, payloadHash: input.payloadHash, dispatchKey: input.dispatchKey, expiresAt: input.expiresAt, nonce: randomUUID() });
}

export type LunaTransportOptions = Readonly<{
  capability: NetworkCapability;
  /** Injected by server-only caller; deliberately never read from process.env here. */
  apiKey?: string;
  /** Tests must use markedTestTransport; arbitrary fetch injection is not accepted. */
  testTransport?: MarkedTestTransport;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

/** Direct, one-shot HTTP transport. It has no SDK, redirect following, or retry path. */
export class LunaTransport {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetcher: FetchLike;
  private readonly testMode: boolean;
  constructor(private readonly options: LunaTransportOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new Error("INVALID_TIMEOUT");
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 1_048_576) throw new Error("INVALID_RESPONSE_LIMIT");
    this.testMode = options.testTransport !== undefined;
    if (options.testTransport) {
      if (process.env.NODE_ENV !== "test" || options.testTransport.kind !== "video-guidance-test-transport") throw new Error("TEST_TRANSPORT_FORBIDDEN");
      this.fetcher = options.testTransport.fetch;
    } else this.fetcher = fetch;
  }

  async send(request: TransportRequest, onHeaders?: (progress: RequestProgress) => Promise<void> | void): Promise<TransportResponse> {
    const capability = this.options.capability;
    const permit = request.permit;
    const permitValid = permit && permit.operation === request.operation && permit.payloadHash === request.payloadHash &&
      permit.dispatchKey === request.dispatchKey && permit.expiresAt > this.now();
    if (!permitValid || !isHash(request.payloadHash)) throw new LunaTransportError("INVALID_DISPATCH_PERMIT", "BEFORE_SEND");
    if (this.options.capability === "NETWORK_DISABLED" && !this.testMode) throw new LunaTransportError("NETWORK_DISABLED", "BEFORE_SEND");
    // Test injection relaxes only the disabled-network gate. It never grants an operation
    // that the selected capability would reject in production.
    if ((request.operation === "countInputTokens" && capability !== "TOKEN_COUNT_ONLY" && capability !== "CANARY_RESPONSE_ALLOWED" && !(this.testMode && capability === "NETWORK_DISABLED")) ||
      (request.operation === "createResponse" && capability !== "CANARY_RESPONSE_ALLOWED" && !(this.testMode && capability === "NETWORK_DISABLED"))) throw new LunaTransportError("NETWORK_CAPABILITY_DENIED", "BEFORE_SEND");
    if (!this.testMode && (!this.options.apiKey || this.options.apiKey.trim() !== this.options.apiKey)) throw new LunaTransportError("OPENAI_API_KEY_MISSING", "BEFORE_SEND");
    if (request.body.model !== LUNA_MODEL) throw new LunaTransportError("MODEL_MISMATCH", "BEFORE_SEND");
    const input = JSON.stringify(request.body);
    if (sha256(Buffer.from(input, "utf8")) !== request.payloadHash) throw new LunaTransportError("PAYLOAD_HASH_MISMATCH", "BEFORE_SEND");
    if (!request.clientRequestId.trim() || request.clientRequestId.length > 200) throw new LunaTransportError("INVALID_CLIENT_REQUEST_ID", "BEFORE_SEND");
    const controller = new AbortController();
    const externalSignal = request.signal;
    if (externalSignal?.aborted) throw new LunaTransportError("ABORTED_BEFORE_SEND", "BEFORE_SEND");
    let rejectTimeout!: (reason: Error) => void;
    const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    let rejectExternalAbort!: (reason: Error) => void;
    const externalAbortPromise = new Promise<never>((_resolve, reject) => { rejectExternalAbort = reject; });
    const abortExternal = () => controller.abort(externalSignal?.reason);
    const abortAfterSend = () => {
      abortExternal();
      rejectExternalAbort(new LunaTransportError("ABORTED_AFTER_SEND", "SENT_OR_UNKNOWN"));
    };
    externalSignal?.addEventListener("abort", abortAfterSend, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const timeout = new LunaTransportError("OPENAI_TIMEOUT", "SENT_OR_UNKNOWN");
      controller.abort(timeout);
      void reader?.cancel(timeout).catch(() => {});
      rejectTimeout(timeout);
    }, this.timeoutMs);
    const started = this.now();
    try {
      // Any failure after invoking fetch is conservatively SENT_OR_UNKNOWN. Automatic retries are absent.
      const fetchPromise = this.fetcher(`${OPENAI_API_BASE}${operationPath[request.operation]}`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey ?? "test-key"}`,
          "Content-Type": "application/json",
          "X-Client-Request-Id": request.clientRequestId,
        },
        body: input,
      });
      const response = await Promise.race([fetchPromise, timeoutPromise, externalAbortPromise]);
      if (timedOut) throw new LunaTransportError("OPENAI_TIMEOUT", "SENT_OR_UNKNOWN");
      const requestIdHeader = response.headers.get("x-request-id");
      const requestId = requestIdHeader && requestIdHeader.length <= 200 ? requestIdHeader : null;
      await onHeaders?.({ requestId, headersReceivedAt: this.now(), status: response.status });
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (response.body) {
        reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await Promise.race([reader.read(), timeoutPromise, externalAbortPromise]);
            if (timedOut) throw new LunaTransportError("OPENAI_TIMEOUT", "SENT_OR_UNKNOWN");
            if (done) break;
            length += value.byteLength;
            if (length > this.maxResponseBytes) {
              const tooLarge = new LunaTransportError("RESPONSE_TOO_LARGE", "SENT_OR_UNKNOWN");
              await reader.cancel(tooLarge).catch(() => {});
              throw tooLarge;
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); reader = undefined; }
      }
      if (timedOut) throw new LunaTransportError("OPENAI_TIMEOUT", "SENT_OR_UNKNOWN");
      const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length);
      return { status: response.status, body: bytes, requestId, latencyMs: Math.max(0, this.now() - started) };
    } catch (error) {
      if (error instanceof LunaTransportError) throw error;
      throw new LunaTransportError(controller.signal.aborted ? "TIMEOUT_OR_ABORT_AFTER_SEND" : "REQUEST_OUTCOME_UNKNOWN", "SENT_OR_UNKNOWN");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortExternal);
      externalSignal?.removeEventListener("abort", abortAfterSend);
    }
  }
}
