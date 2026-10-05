import { createHash } from "node:crypto";
import { buildLunaRequest, CANARY_0_TIMESTAMPS, CANARY_0_EXERCISE_ID } from "@/domain/video-batch/luna-request";
import { LUNA_FIELD_NAMES, LUNA_MODEL } from "@/domain/video-batch/luna-schema";
import type { LunaFrameInput } from "@/domain/video-batch/luna-request";

export const lunaCanaryOwner = "luna-canary-owner";
export const lunaCanaryActor = { id: "luna-canary-coach", name: "Luna canary fixture coach", email: "luna-canary@example.test" };
export const lunaCanaryBinding = Object.freeze({ sourceVideoId: "luna-canary-video", contentSha256: "a".repeat(64),
  storageKey: "private/luna-canary/source.mp4", sourceUrl: null });
export const lunaCanaryTarget = Object.freeze({ exerciseId: CANARY_0_EXERCISE_ID, sourceBinding: lunaCanaryBinding });

/** Tiny marker-only JPEG fixtures: the offline request builder checks bound bytes/hash, not image decoding. */
export function buildLunaCanaryFixture(salt = 0) {
  const frames: LunaFrameInput[] = CANARY_0_TIMESTAMPS.map((actualPTS, index) => {
    const bytes = Buffer.from([0xff, 0xd8, (salt + index) & 0xff, 0x10, 0xff, 0xd9]);
    return { index: index + 1, actualPTS, filename: `canary-frame-${String(index + 1).padStart(2, "0")}.jpg`, width: 1280,
      height: 720, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, jpegBase64: bytes.toString("base64") };
  });
  return buildLunaRequest(frames);
}

function field(name: typeof LUNA_FIELD_NAMES[number], unresolved = false) {
  return { field: name, state: unresolved ? "UNRESOLVED" : "OBSERVED", value: unresolved ? null : name === "countingUnit" ? "TOTAL_REPS" : `Visible ${name}`,
    numericValue: null, unit: null, confidence: unresolved ? null : 0.8, frameRefs: unresolved ? [] : [1], reason: unresolved ? "Not established by the fixture frames" : "Visible in frame 1" };
}

export function buildLunaOutput(quality: "COMPLETE" | "PARTIAL" = "COMPLETE") {
  const unresolved = quality === "PARTIAL" ? ["equipment"] as const : [] as const;
  return {
    schemaVersion: "luna-visual-guidance-v1",
    neutralObservation: { summary: "Fixture visual sequence.", events: [{ frameRef: 1, kind: "MOVEMENT", description: "A visible movement is present." }],
      equipment: field("equipment", true), visibleInstructions: field("observedInstructions", true), limitations: ["SPARSE_FRAMES", "NO_AUDIO"] },
    guidanceCandidate: { authority: "AI_ANALYZED", resultQuality: quality, fields: LUNA_FIELD_NAMES.map(name => field(name, unresolved.includes(name as never))), unresolvedFields: [...unresolved] },
  };
}

export function buildLunaResponseBody(quality: "COMPLETE" | "PARTIAL" = "COMPLETE") {
  const observation = JSON.stringify(buildLunaOutput(quality));
  return { id: "resp-luna-fixture", object: "response", status: "completed", model: LUNA_MODEL, service_tier: "default",
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 1300 },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: observation }] }] };
}
