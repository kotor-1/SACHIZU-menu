import { createHash } from "node:crypto";
import { canonical } from "@/domain/video-batch/contracts";
import { LUNA_JSON_SCHEMA, LUNA_MODEL, LUNA_PROMPT, LUNA_PROMPT_VERSION, LUNA_SCHEMA_VERSION } from "@/domain/video-batch/luna-schema";

export const CANARY_0_EXERCISE_ID = "cmtrg8ip20056itxbl2ouptrx" as const;
export const LUNA_MAX_OUTPUT_TOKENS = 8192 as const;
export const CANARY_0_TIMESTAMPS = [0.333, 1.733, 3.15, 4.55, 5.967, 7.367, 8.784, 10.183, 11.6, 13, 14.416, 15.816] as const;
export interface LunaFrameInput {
  index: number; actualPTS: number; filename: string; width: number; height: number;
  sha256: string; byteSize: number; jpegBase64: string;
}
export interface LunaRequestHashes { requestHash: string; frameManifestHash: string }
export interface BuiltLunaRequest extends LunaRequestHashes {
  model: typeof LUNA_MODEL;
  endpoint: "/v1/responses";
  /** Hash of the canonical Responses body, including response-only controls. */
  responsePayload: Record<string, unknown>;
  inputTokensPayload: Record<string, unknown>;
  inspectionPayload: Record<string, unknown>;
  frameManifest: Array<Omit<LunaFrameInput, "jpegBase64">>;
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const userText = "Describe only the supplied visual evidence. No existing approved interpretation or prescribed dose is supplied.";

function validateFrames(frames: LunaFrameInput[]) {
  if (!Array.isArray(frames) || frames.length !== CANARY_0_TIMESTAMPS.length) throw new Error("CANARY_0_REQUIRES_12_FRAMES");
  frames.forEach((f, i) => {
    if (f.index !== i + 1 || !Number.isFinite(f.actualPTS) || Math.abs(f.actualPTS - CANARY_0_TIMESTAMPS[i]) > 0.000001) throw new Error("CANARY_0_FRAME_ORDER_OR_PTS_INVALID");
    if (f.width !== 1280 || f.height !== 720) throw new Error("CANARY_0_FRAME_DIMENSIONS_INVALID");
    if (!/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.byteSize) || f.byteSize <= 0 || !f.filename) throw new Error("CANARY_0_FRAME_MANIFEST_INVALID");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.jpegBase64)) throw new Error("CANARY_0_JPEG_BASE64_INVALID");
    const bytes = Buffer.from(f.jpegBase64, "base64");
    if (bytes.length !== f.byteSize || hash(bytes) !== f.sha256 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error("CANARY_0_JPEG_INTEGRITY_INVALID");
  });
}

/** Builds both endpoint bodies from one semantic input. No HTTP capability is exposed here. */
export function buildLunaRequest(frames: LunaFrameInput[], model: string = LUNA_MODEL): BuiltLunaRequest {
  if (model !== LUNA_MODEL) throw new Error("LUNA_MODEL_NOT_ALLOWED");
  validateFrames(frames);
  const content: Record<string, unknown>[] = [{ type: "input_text", text: userText }];
  for (const f of frames) {
    content.push({ type: "input_text", text: `Frame ${String(f.index).padStart(2, "0")} — source PTS=${f.actualPTS.toFixed(6)}s` });
    content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${f.jpegBase64}`, detail: "high" });
  }
  const input = [{ role: "user", content }];
  const text = { format: { type: "json_schema", name: "luna_visual_guidance_v1", strict: true, schema: LUNA_JSON_SCHEMA } };
  const responsePayload = {
    model: LUNA_MODEL, store: false, stream: false, background: false, service_tier: "default", truncation: "disabled",
    reasoning: { effort: "medium" }, max_output_tokens: LUNA_MAX_OUTPUT_TOKENS, tools: [], instructions: LUNA_PROMPT, input,
    text, prompt_cache_options: { mode: "explicit" },
  };
  // The input token endpoint accepts the same model, instructions, input and input interpretation settings.
  // This projection intentionally retains both reasoning and strict output format.
  const inputTokensPayload = { model: responsePayload.model, instructions: responsePayload.instructions, input: responsePayload.input, reasoning: responsePayload.reasoning, text: responsePayload.text, tools: responsePayload.tools, truncation: responsePayload.truncation };
  const frameManifest = frames.map(f => ({ index: f.index, actualPTS: f.actualPTS, filename: f.filename, width: f.width, height: f.height, sha256: f.sha256, byteSize: f.byteSize }));
  const frameManifestHash = hash(canonical(frameManifest));
  if (Buffer.byteLength(JSON.stringify(responsePayload)) > 16 * 1024 * 1024) throw new Error("LUNA_REQUEST_TOO_LARGE");
  const requestHash = hash(canonical({ endpoint: "/v1/responses", payload: responsePayload, schemaVersion: LUNA_SCHEMA_VERSION, promptVersion: LUNA_PROMPT_VERSION, frameManifestHash }));
  const inspectionContent = [{ type: "input_text", text: userText }, ...frames.flatMap(f => [
    { type: "input_text", text: `Frame ${String(f.index).padStart(2, "0")} — source PTS=${f.actualPTS.toFixed(6)}s` },
    { type: "input_image", image: { filename: f.filename, sha256: f.sha256, byteSize: f.byteSize, width: f.width, height: f.height, detail: "high" } },
  ])];
  const inspectionPayload = { ...responsePayload, input: [{ role: "user", content: inspectionContent }], requestHash, frameManifestHash, schemaVersion: LUNA_SCHEMA_VERSION, promptVersion: LUNA_PROMPT_VERSION };
  return { model: LUNA_MODEL, endpoint: "/v1/responses", responsePayload, inputTokensPayload, inspectionPayload, requestHash, frameManifestHash, frameManifest };
}

/** Recheck mutable payload objects at dispatch; rejects changed content or controls. */
export function assertBuiltLunaRequest(request: BuiltLunaRequest): void {
  if (request.endpoint !== "/v1/responses" || request.model !== LUNA_MODEL || request.responsePayload.model !== LUNA_MODEL) throw new Error("LUNA_REQUEST_MODEL_OR_ENDPOINT_INVALID");
  const expectedManifestHash = hash(canonical(request.frameManifest));
  if (expectedManifestHash !== request.frameManifestHash) throw new Error("LUNA_FRAME_MANIFEST_HASH_MISMATCH");
  const expected = hash(canonical({ endpoint: "/v1/responses", payload: request.responsePayload, schemaVersion: LUNA_SCHEMA_VERSION, promptVersion: LUNA_PROMPT_VERSION, frameManifestHash: expectedManifestHash }));
  if (expected !== request.requestHash) throw new Error("LUNA_REQUEST_HASH_MISMATCH");
  const p = request.responsePayload;
  if (p.store !== false || p.stream !== false || p.background !== false || p.service_tier !== "default" || p.max_output_tokens !== LUNA_MAX_OUTPUT_TOKENS || p.truncation !== "disabled" || p.reasoning === null || (p.reasoning as { effort?: unknown }).effort !== "medium" || !Array.isArray(p.tools) || p.tools.length !== 0 || p.prompt_cache_options === null || (p.prompt_cache_options as { mode?: unknown }).mode !== "explicit" || Object.keys(p.prompt_cache_options as object).length !== 1) throw new Error("LUNA_REQUEST_CONTROLS_INVALID");
  const input = p.input as Array<{role: string; content: Array<Record<string, unknown>>}>;
  if (!Array.isArray(input) || input.length !== 1 || input[0].role !== "user" || !Array.isArray(input[0].content) || input[0].content.length !== 25) throw new Error("LUNA_REQUEST_INPUT_INVALID");
  const frames = request.frameManifest.map((frame, index) => {
    const image = input[0].content[2 + index * 2];
    if (image.type !== "input_image" || image.detail !== "high" || typeof image.image_url !== "string" || !image.image_url.startsWith("data:image/jpeg;base64,")) throw new Error("LUNA_REQUEST_INPUT_INVALID");
    return { ...frame, jpegBase64: image.image_url.slice("data:image/jpeg;base64,".length) };
  });
  const rebuilt = buildLunaRequest(frames);
  if (canonical(rebuilt.responsePayload) !== canonical(p) || canonical(rebuilt.inspectionPayload) !== canonical(request.inspectionPayload)) throw new Error("LUNA_REQUEST_BUILDER_MISMATCH");
  const shared = { model: p.model, instructions: p.instructions, input: p.input, reasoning: p.reasoning, text: p.text, tools: p.tools, truncation: p.truncation };
  if (canonical(shared) !== canonical(request.inputTokensPayload)) throw new Error("LUNA_TOKEN_COUNT_PROJECTION_MISMATCH");
}
