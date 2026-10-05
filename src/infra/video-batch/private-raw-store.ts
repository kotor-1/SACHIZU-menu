import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type RawMetadata = Readonly<{
  operation: "countInputTokens" | "createResponse";
  status: number;
  requestId: string | null;
  clientRequestId: string;
  payloadHash: string;
  latencyMs: number;
  returnedModel?: string | null;
  responseId?: string | null;
}>;
export type HeaderCheckpoint = Readonly<{ requestId: string | null; headersReceivedAt: number; status: number }>;
export type RawReceipt = Readonly<{ dispatchKey: string; sha256: string; byteLength: number; rawPath: string; metadataPath: string; headersPath: string; durable: true }>;
export type RawRead = Readonly<{ receipt: RawReceipt; bytes: Uint8Array; metadata: RawMetadata | null; orphan: boolean }>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const validKey = (key: string) => /^(?:[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(key);
const validHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const metadataKeys = new Set(["operation", "status", "requestId", "clientRequestId", "payloadHash", "latencyMs", "returnedModel", "responseId"]);

function parseMetadata(value: unknown): RawMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RAW_METADATA");
  const m = value as Record<string, unknown>;
  if (Object.keys(m).some(k => !metadataKeys.has(k)) ||
      (m.operation !== "countInputTokens" && m.operation !== "createResponse") ||
      !Number.isInteger(m.status) || (m.status as number) < 100 || (m.status as number) > 599 ||
      !(m.requestId === null || typeof m.requestId === "string") || typeof m.clientRequestId !== "string" ||
      !validHash(m.payloadHash) || typeof m.latencyMs !== "number" || !Number.isFinite(m.latencyMs) || m.latencyMs < 0 ||
      (m.returnedModel !== undefined && m.returnedModel !== null && typeof m.returnedModel !== "string") ||
      (m.responseId !== undefined && m.responseId !== null && typeof m.responseId !== "string")) throw new Error("INVALID_RAW_METADATA");
  return Object.freeze({ operation: m.operation, status: m.status, requestId: m.requestId, clientRequestId: m.clientRequestId,
    payloadHash: m.payloadHash, latencyMs: m.latencyMs, ...(m.returnedModel !== undefined ? { returnedModel: m.returnedModel as string | null } : {}),
    ...(m.responseId !== undefined ? { responseId: m.responseId as string | null } : {}) }) as RawMetadata;
}

async function noSymlinkPath(target: string, allowMissingTail = false) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const pieces = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("SYMLINK_PATH_FORBIDDEN");
      if (i < pieces.length - 1 && !stat.isDirectory()) throw new Error("RAW_PATH_NOT_DIRECTORY");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissingTail) throw e;
      break;
    }
  }
  return absolute;
}

/** Durable LOCAL_PRIVATE response bytes. Raw files are immutable and never public/uploads. */
export class PrivateRawStore {
  private readonly dir: string;
  constructor(privateRoot: string, storageClass: "LOCAL_PRIVATE" = "LOCAL_PRIVATE") {
    if (storageClass !== "LOCAL_PRIVATE") throw new Error("RAW_STORAGE_CLASS_FORBIDDEN");
    const absolute = path.resolve(privateRoot);
    const lower = absolute.toLowerCase().split(path.sep);
    if (lower.includes("public") || lower.includes("uploads") || lower.includes("public_uploads")) throw new Error("PUBLIC_RAW_PATH_FORBIDDEN");
    this.dir = path.join(absolute, "video-guidance-raw");
  }

  private async ensureDir() {
    await noSymlinkPath(this.dir, true);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await noSymlinkPath(this.dir);
    await fs.chmod(this.dir, 0o700);
  }
  private names(key: string) {
    if (!validKey(key)) throw new Error("INVALID_DISPATCH_KEY");
    return { raw: path.join(this.dir, `${key}.raw`), meta: path.join(this.dir, `${key}.meta.json`), headers: path.join(this.dir, `${key}.headers.json`) };
  }
  private async durableCreate(file: string, bytes: Uint8Array) {
    const temp = path.join(this.dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temp, file); } catch (e) {
      await fs.unlink(temp).catch(() => {});
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("RAW_IMMUTABLE_EXISTS");
      throw e;
    }
    await fs.unlink(temp);
    const dirHandle = await fs.open(this.dir, "r");
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    await fs.chmod(file, 0o600);
  }

  async save(dispatchKey: string, bytes: Uint8Array, metadata: RawMetadata): Promise<RawReceipt> {
    await this.ensureDir();
    const names = this.names(dispatchKey);
    const clean = parseMetadata(metadata);
    const rawHash = hash(bytes);
    await this.durableCreate(names.raw, bytes);
    // Raw is durable before metadata. If metadata persistence fails, recover() sees a body-only orphan.
    await this.durableCreate(names.meta, Buffer.from(JSON.stringify(clean), "utf8"));
    return Object.freeze({ dispatchKey, sha256: rawHash, byteLength: bytes.byteLength, rawPath: names.raw, metadataPath: names.meta, headersPath: names.headers, durable: true as const });
  }

  /** Persist x-request-id as soon as response headers arrive, before reading any body bytes. */
  async saveHeaders(dispatchKey: string, checkpoint: HeaderCheckpoint): Promise<void> {
    await this.ensureDir();
    const names = this.names(dispatchKey);
    if (!(checkpoint.requestId === null || (typeof checkpoint.requestId === "string" && checkpoint.requestId.length <= 200)) ||
        !Number.isFinite(checkpoint.headersReceivedAt) || checkpoint.headersReceivedAt < 0 ||
        !Number.isInteger(checkpoint.status) || checkpoint.status < 100 || checkpoint.status > 599)
      throw new Error("INVALID_HEADER_CHECKPOINT");
    await this.durableCreate(names.headers, Buffer.from(JSON.stringify(checkpoint), "utf8"));
  }

  async readHeaders(dispatchKey: string): Promise<HeaderCheckpoint | null> {
    await this.ensureDir();
    const names = this.names(dispatchKey);
    try {
      const stat = await fs.lstat(names.headers);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("RAW_FILE_TYPE_FORBIDDEN");
      const raw = JSON.parse(await fs.readFile(names.headers, "utf8")) as Record<string, unknown>;
      if (Object.keys(raw).some(k => !["requestId", "headersReceivedAt", "status"].includes(k)) ||
          !(raw.requestId === null || (typeof raw.requestId === "string" && raw.requestId.length <= 200)) ||
          typeof raw.headersReceivedAt !== "number" || !Number.isFinite(raw.headersReceivedAt) ||
          !Number.isInteger(raw.status) || (raw.status as number) < 100 || (raw.status as number) > 599) throw new Error("INVALID_HEADER_CHECKPOINT");
      return Object.freeze(raw as unknown as HeaderCheckpoint);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  async read(dispatchKey: string): Promise<RawRead | null> {
    await this.ensureDir();
    const names = this.names(dispatchKey);
    let bytes: Buffer;
    try {
      const stat = await fs.lstat(names.raw);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("RAW_FILE_TYPE_FORBIDDEN");
      bytes = await fs.readFile(names.raw);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    let metadata: RawMetadata | null = null;
    try {
      const metaStat = await fs.lstat(names.meta);
      if (metaStat.isSymbolicLink() || !metaStat.isFile()) throw new Error("RAW_FILE_TYPE_FORBIDDEN");
      metadata = parseMetadata(JSON.parse(await fs.readFile(names.meta, "utf8")));
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return { receipt: Object.freeze({ dispatchKey, sha256: hash(bytes), byteLength: bytes.byteLength, rawPath: names.raw, metadataPath: names.meta, headersPath: names.headers, durable: true as const }),
      bytes, metadata, orphan: metadata === null };
  }

  /** Adopt a raw-only orphan after the control plane confirms its dispatch key; no provider request occurs. */
  async adopt(dispatchKey: string, metadata: RawMetadata): Promise<RawReceipt> {
    await this.ensureDir();
    const names = this.names(dispatchKey);
    const existing = await this.read(dispatchKey);
    if (!existing) throw new Error("RAW_ORPHAN_MISSING");
    if (!existing.orphan) throw new Error("RAW_ORPHAN_ALREADY_ADOPTED");
    const clean = parseMetadata(metadata);
    await this.durableCreate(names.meta, Buffer.from(JSON.stringify(clean), "utf8"));
    return existing.receipt;
  }

  async recover(): Promise<RawRead[]> {
    await this.ensureDir();
    const names = await fs.readdir(this.dir);
    const keys = names.filter(n => n.endsWith(".raw")).map(n => n.slice(0, -4)).filter(validKey).sort();
    const out: RawRead[] = [];
    for (const key of keys) { const item = await this.read(key); if (item) out.push(item); }
    return out;
  }
}
