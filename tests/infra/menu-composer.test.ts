import { describe, expect, it, vi } from "vitest";
import { composeMenuWithOpenAI, MENU_COMPOSER_JSON_SCHEMA } from "@/infra/menu-composition/openai-composer";
import { catalogFixture, catalogPlan } from "../fixtures/menu-composition";
import type { ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";

describe("Menu composer structured-response adapter (mock transport only)", () => {
  it("issues one composition call with room for a full session and no video tools", async () => {
    const output = { blocks: [{ name: "体幹", items: [catalogPlan()] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }), { headers: { "content-type": "application/json" } }));
    const result = await composeMenuWithOpenAI({ requestText: "プランクを入れたい", context: {}, catalog: [catalogFixture()], runningPrescription: null, unsupportedIntents: [] }, { apiKey: "offline-fake-key", fetchImpl });
    expect(result).toEqual({ ok: true, value: output }); expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "low" }, max_output_tokens: 8000, store: false });
    expect(body.tools).toBeUndefined(); expect(body.text.format.strict).toBe(true);
    expect(JSON.parse(body.input).catalog[0].coachingPoint).toBe(catalogFixture().coachingPoint);
  });
  it("uses a strict union whose Running variant has no numeric fields", () => {
    const variants = MENU_COMPOSER_JSON_SCHEMA.properties.blocks.items.properties.items.items.anyOf;
    expect(variants[0].required).toEqual(["type"]); expect(variants.every((item) => !item.additionalProperties)).toBe(true);
  });
  it.each(["COACH_REVIEWED", "AI_ANALYZED"] as const)("passes cached %s guidance with its authority and keeps proposed dose independent", async (videoAnalysisStatus) => {
    const guidance: ExerciseVideoGuidance = {
      videoAnalysisStatus, sourceVideoId: "video-a", analysisVersion: "guidance-v1", analyzedAt: "2026-10-02T00:00:00.000Z",
      coachReviewedAt: videoAnalysisStatus === "COACH_REVIEWED" ? "2026-10-02T01:00:00.000Z" : null,
      executionSummary: "身体をまっすぐ保つ", movementPattern: "姿勢保持", countingUnit: "SECONDS",
      bilateralCounting: null, typicalStructure: "COACH_DEFINED: 姿勢を保つ間を1回とする",
      equipment: [], setup: "肘をつく", keyCues: ["腰を反らさない"], commonErrors: [],
      doseObservations: ["動画での保持時間は20秒。毎回の推奨量ではない"],
    };
    const output = { blocks: [{ name: "体幹", items: [catalogPlan({ plannedDurationSeconds: 30 })] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }), { headers: { "content-type": "application/json" } }));
    const result = await composeMenuWithOpenAI({ requestText: "プランクを入れたい", context: {}, catalog: [catalogFixture({ videoGuidance: guidance })], runningPrescription: null, unsupportedIntents: [] }, { apiKey: "offline-fake-key", fetchImpl });
    expect(result).toEqual({ ok: true, value: output });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(JSON.parse(body.input).catalog[0].videoGuidance).toEqual(guidance);
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toContain("COACH_REVIEWED guidanceでCOACH_DEFINED");
    expect(body.instructions).toContain("AI_ANALYZEDだけの場合は未承認の観察");
    expect(body.instructions).toContain("doseObservationsは観察であり毎回の正解量ではない");
  });
});
