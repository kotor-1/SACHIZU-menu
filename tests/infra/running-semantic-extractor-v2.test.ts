import { describe, expect, it, vi } from "vitest";
import { extractRunningSemanticIntentV2, SEMANTIC_INTENT_V2_OUTPUT_SCHEMA } from "@/infra/running-menu/openai-semantic-intent-v2";

const interpretation = { interpreterVersion: "running-intent-v2", requestKind: "RUNNING", claims: [
  { field: "EVENT", value: "200m", sourceText: "200出る", polarity: "AFFIRMED", temporalScope: "FUTURE", status: "ACTIVE", numericParts: [{ rawText: "200", unit: "NONE" }] },
], unsupportedIntents: [], ambiguity: null, exerciseIds: [] };
const review = { assessments: [{ index: 0, supported: true }], activeClaimIndexes: [0], requestKindSupported: true,
  missingCriticalClaim: false, ambiguityCorrect: true, unsupportedIntentsSupported: true };
const numericRoleReview = { roles: [{ sourceText: "200出る", rawText: "200", role: "EVENT" }] };
const response = (value: unknown) => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }), { status: 200 });

describe("semantic interpreter v2 OpenAI contract", () => {
  it("uses independent structured semantic and bare-number checks without prescription fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(interpretation)).mockResolvedValueOnce(response(numericRoleReview)).mockResolvedValueOnce(response(review));
    const result = await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", model: "gpt-6-luna", fetchImpl });
    expect(result).toMatchObject({ ok: true, interpretation: { requestKind: "RUNNING" }, review: { activeClaimIndexes: [0] }, numericRoleReview });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const first = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const third = JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body));
    expect(first).toMatchObject({ model: "gpt-6-luna", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(second).toMatchObject({ model: "gpt-6-luna", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(third).toMatchObject({ model: "gpt-6-luna", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(JSON.stringify(SEMANTIC_INTENT_V2_OUTPUT_SCHEMA)).not.toMatch(/generatedDistanceMeters|generatedReps|generatedRestSeconds|totalReps|repRestSeconds/u);
  });

  it("fails closed on malformed model output", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ inventedDistance: 60 }));
    expect(await extractRunningSemanticIntentV2({ requestText: "200出る", exercises: [] }, { apiKey: "test-key", fetchImpl })).toEqual({ ok: false, reason: "INVALID_OUTPUT" });
  });
});
