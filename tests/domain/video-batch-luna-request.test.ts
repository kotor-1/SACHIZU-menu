import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assertBuiltLunaRequest, buildLunaRequest, CANARY_0_TIMESTAMPS, LUNA_MAX_OUTPUT_TOKENS, type LunaFrameInput } from "@/domain/video-batch/luna-request";
import { LUNA_FIELD_NAMES, LUNA_MODEL, LUNA_PROMPT_VERSION, LUNA_SCHEMA_VERSION, parseLunaObservation, type LunaObservation } from "@/domain/video-batch/luna-schema";

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const sha = createHash("sha256").update(bytes).digest("hex");
function fixtureFrames(): LunaFrameInput[] {
  return CANARY_0_TIMESTAMPS.map((actualPTS, i) => ({ index: i + 1, actualPTS, filename: `frame-${String(i + 1).padStart(2, "0")}.jpg`, width: 1280, height: 720, sha256: sha, byteSize: bytes.length, jpegBase64: bytes.toString("base64") }));
}
function observation(partial = false): LunaObservation {
  const fields: LunaObservation["guidanceCandidate"]["fields"] = LUNA_FIELD_NAMES.map(field => ({ field, state: "OBSERVED", value: "Synthetic evidence only", numericValue: null, unit: null, confidence: 0.6, frameRefs: [1], reason: "Synthetic fixture" }));
  fields[0].value = "TOTAL_REPS";
  if (partial) Object.assign(fields[3], { state: "UNRESOLVED", value: null, confidence: null, frameRefs: [], reason: "Sparse frames cannot establish a complete count" });
  const equipment = { ...fields[6], field: "equipment" as const };
  const visibleInstructions = { ...fields[7], field: "observedInstructions" as const };
  return { schemaVersion: LUNA_SCHEMA_VERSION, neutralObservation: { summary: "Synthetic motion", events: [{ frameRef: 1, kind: "MOVEMENT", description: "Synthetic transition" }], equipment, visibleInstructions, limitations: ["NO_AUDIO", "SPARSE_FRAMES"] }, guidanceCandidate: { authority: "AI_ANALYZED", resultQuality: partial ? "PARTIAL" : "COMPLETE", fields, unresolvedFields: partial ? ["quantity"] : [] } };
}
function maximumUnresolvedObservation(): LunaObservation {
  const fields: LunaObservation["guidanceCandidate"]["fields"] = LUNA_FIELD_NAMES.map(field => ({ field, state: "UNRESOLVED", value: null, numericValue: null, unit: null, confidence: null, frameRefs: [], reason: "Sparse visual frames do not establish this item" }));
  return { schemaVersion: LUNA_SCHEMA_VERSION, neutralObservation: { summary: "Synthetic maximum-unresolved fixture", events: [], equipment: { ...fields[6], field: "equipment" }, visibleInstructions: { ...fields[7], field: "observedInstructions" }, limitations: ["NO_AUDIO", "SPARSE_FRAMES", "OCCLUSION", "NO_SCALE", "SIDE_NOT_SHOWN", "NO_VISIBLE_INSTRUCTION"] }, guidanceCandidate: { authority: "AI_ANALYZED", resultQuality: "PARTIAL", fields, unresolvedFields: [...LUNA_FIELD_NAMES] } };
}
function maximumEvidenceObservation(): LunaObservation {
  const refs = Array.from({ length: 16 }, (_, i) => i + 1);
  const fields: LunaObservation["guidanceCandidate"]["fields"] = LUNA_FIELD_NAMES.map(field => ({ field, state: "OBSERVED", value: "e".repeat(1200), numericValue: null, unit: null, confidence: 1, frameRefs: refs, reason: "r".repeat(1200) }));
  fields[0].value = "TOTAL_REPS";
  const event = { frameRef: 16, kind: "MOVEMENT" as const, description: "d".repeat(1200) };
  return { schemaVersion: LUNA_SCHEMA_VERSION, neutralObservation: { summary: "s".repeat(1200), events: Array.from({ length: 32 }, () => event), equipment: { ...fields[6], field: "equipment" }, visibleInstructions: { ...fields[7], field: "observedInstructions" }, limitations: ["NO_AUDIO", "SPARSE_FRAMES", "OCCLUSION", "NO_SCALE", "SIDE_NOT_SHOWN", "NO_VISIBLE_INSTRUCTION"] }, guidanceCandidate: { authority: "AI_ANALYZED", resultQuality: "COMPLETE", fields, unresolvedFields: [] } };
}

describe("Luna canonical request builder (offline fixtures only)", () => {
  it("fixes model, output cap, service tier, cache behavior and controls", () => {
    const req = buildLunaRequest(fixtureFrames());
    expect(req.model).toBe("gpt-6-luna");
    expect(req.responsePayload).toMatchObject({ store: false, stream: false, background: false, service_tier: "default", truncation: "disabled", max_output_tokens: 8192, reasoning: { effort: "medium" }, tools: [], prompt_cache_options: { mode: "explicit" } });
    expect(Object.keys(req.responsePayload.prompt_cache_options as object)).toEqual(["mode"]);
    expect(() => assertBuiltLunaRequest(req)).not.toThrow();
    expect(LUNA_MAX_OUTPUT_TOKENS).toBe(8192);
  });
  it.each(["gpt-6-sol", "gpt-6-astra", "gpt-5.6-luna", "unknown", ""]) ("rejects non-Luna model %s", model => expect(() => buildLunaRequest(fixtureFrames(), model)).toThrow("LUNA_MODEL_NOT_ALLOWED"));
  it("keeps one ordered sequence of 12 timestamped high-detail private JPEG data URLs", () => {
    const req = buildLunaRequest(fixtureFrames());
    const content = (req.responsePayload.input as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(content).toHaveLength(25);
    expect(content.filter(x => x.type === "input_image")).toHaveLength(12);
    expect(content[1]).toEqual({ type: "input_text", text: "Frame 01 — source PTS=0.333000s" });
    expect(content[2]).toMatchObject({ type: "input_image", image_url: `data:image/jpeg;base64,${bytes.toString("base64")}`, detail: "high" });
    expect(content.at(-1)).toMatchObject({ type: "input_image", detail: "high" });
  });
  it("uses the same canonical input and strict schema in token-count projection", () => {
    const req = buildLunaRequest(fixtureFrames());
    expect(req.inputTokensPayload).toMatchObject({ model: req.responsePayload.model, instructions: req.responsePayload.instructions, input: req.responsePayload.input, reasoning: req.responsePayload.reasoning, text: req.responsePayload.text, tools: [], truncation: "disabled" });
    expect(req.inputTokensPayload).not.toHaveProperty("max_output_tokens");
    expect(req.inputTokensPayload).not.toHaveProperty("service_tier");
    expect(req.inputTokensPayload).not.toHaveProperty("prompt_cache_options");
    expect((req.responsePayload.text as { format: { strict: boolean } }).format.strict).toBe(true);
  });
  it("hashes full payload and ordered frame manifest; inspection has no image bytes", () => {
    const first = buildLunaRequest(fixtureFrames()), second = buildLunaRequest(fixtureFrames());
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.frameManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.frameManifestHash).toBe(second.frameManifestHash);
    const inspected = JSON.stringify(first.inspectionPayload);
    expect(inspected).toContain(sha);
    expect(inspected).toContain("frame-12.jpg");
    expect(inspected).not.toContain(bytes.toString("base64"));
  });
  it("fails closed if a payload is mutated after its hashes are computed", () => {
    const request = buildLunaRequest(fixtureFrames());
    request.responsePayload.service_tier = "priority";
    expect(() => assertBuiltLunaRequest(request)).toThrow("LUNA_REQUEST_HASH_MISMATCH");
  });
  it.each(["wrong count", "wrong order", "wrong timestamp", "wrong dimensions", "wrong hash", "wrong byte size", "bad base64"])("rejects invalid frame input: %s", reason => {
    const frames = fixtureFrames();
    if (reason === "wrong count") frames.pop();
    if (reason === "wrong order") [frames[0].index, frames[1].index] = [frames[1].index, frames[0].index];
    if (reason === "wrong timestamp") frames[0].actualPTS = 0.334;
    if (reason === "wrong dimensions") frames[0].width = 640;
    if (reason === "wrong hash") frames[0].sha256 = "0".repeat(64);
    if (reason === "wrong byte size") frames[0].byteSize++;
    if (reason === "bad base64") frames[0].jpegBase64 = "not-base64!";
    expect(() => buildLunaRequest(frames)).toThrow();
  });
});

describe("Luna structured observation parser", () => {
  it("preserves neutral observation and AI candidate separately", () => {
    const parsed = parseLunaObservation(JSON.stringify(observation()), 12);
    expect(parsed.guidanceCandidate.authority).toBe("AI_ANALYZED");
    expect(parsed.neutralObservation.summary).toBe("Synthetic motion");
    expect(parsed).not.toHaveProperty("approvedRevisionId");
  });
  it("keeps unresolved maximum fixture partial without synthesizing numeric values", () => {
    const parsed = parseLunaObservation(JSON.stringify(observation(true)), 12);
    expect(parsed.guidanceCandidate.resultQuality).toBe("PARTIAL");
    expect(parsed.guidanceCandidate.fields[3]).toMatchObject({ state: "UNRESOLVED", value: null, numericValue: null, unit: null, frameRefs: [] });
  });
  it("validates maximum unresolved fields, and records serialized bytes without pretending they are tokens", () => {
    const fixture = maximumUnresolvedObservation();
    const raw = JSON.stringify(fixture);
    const parsed = parseLunaObservation(raw, 12);
    expect(parsed.guidanceCandidate.unresolvedFields).toHaveLength(8);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(1000);
  });
  it("validates schema-maximum evidence shape and measures fixture bytes only", () => {
    const raw = JSON.stringify(maximumEvidenceObservation());
    const parsed = parseLunaObservation(raw, 16);
    const serializedBytes = Buffer.byteLength(raw, "utf8");
    expect(parsed.neutralObservation.events).toHaveLength(32);
    expect(parsed.guidanceCandidate.fields.every(field => field.frameRefs.length === 16)).toBe(true);
    expect(serializedBytes).toBeGreaterThan(30_000);
    // This is JSON byte size, not a token count or token estimate.
    expect(LUNA_MAX_OUTPUT_TOKENS).toBe(8192);
  });
  it("rejects invalid JSON and incomplete or extended schemas", () => {
    expect(() => parseLunaObservation("", 12)).toThrow();
    expect(() => parseLunaObservation("{bad", 12)).toThrow();
    expect(() => parseLunaObservation(JSON.stringify({ schemaVersion: LUNA_SCHEMA_VERSION }), 12)).toThrow();
    expect(() => parseLunaObservation(JSON.stringify({ ...observation(), approval: true }), 12)).toThrow();
  });
  it("rejects schema and semantic integrity failures", () => {
    const bad = observation(true);
    bad.guidanceCandidate.fields[3].numericValue = 0;
    expect(() => parseLunaObservation(JSON.stringify(bad), 12)).toThrow();
    const missingEvidence = observation();
    missingEvidence.guidanceCandidate.fields[0].frameRefs = [];
    expect(() => parseLunaObservation(JSON.stringify(missingEvidence), 12)).toThrow("LUNA_EVIDENCE_MISSING");
    const wrongQuality = observation(true);
    wrongQuality.guidanceCandidate.resultQuality = "COMPLETE";
    expect(() => parseLunaObservation(JSON.stringify(wrongQuality), 12)).toThrow("LUNA_QUALITY_MISMATCH");
  });
  it("rejects invented frame references and duplicate/missing field order", () => {
    const badRef = observation();
    badRef.guidanceCandidate.fields[0].frameRefs = [13];
    expect(() => parseLunaObservation(JSON.stringify(badRef), 12)).toThrow("LUNA_FRAME_REFERENCE_INVALID");
    const badOrder = observation();
    badOrder.guidanceCandidate.fields[1].field = "countingUnit";
    expect(() => parseLunaObservation(JSON.stringify(badOrder), 12)).toThrow("LUNA_FIELD_ORDER_INVALID");
  });
  it("uses the fixed prompt/schema versions", () => {
    expect(LUNA_MODEL).toBe("gpt-6-luna");
    expect(LUNA_SCHEMA_VERSION).toBe("luna-visual-guidance-v1");
    expect(LUNA_PROMPT_VERSION).toBe("luna-frame-observation-v1");
  });
});
