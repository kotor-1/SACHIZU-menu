import { describe, expect, it, vi } from "vitest";
import { composeMenuWithOpenAI, MENU_COMPOSER_JSON_SCHEMA } from "@/infra/menu-composition/openai-composer";
import { catalogFixture, catalogPlan } from "../fixtures/menu-composition";

describe("Menu composer structured-response adapter (mock transport only)", () => {
  it("issues one composition call with rich context, no video tools and unchanged production defaults", async () => {
    const output = { blocks: [{ name: "体幹", items: [catalogPlan()] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }), { headers: { "content-type": "application/json" } }));
    const result = await composeMenuWithOpenAI({ requestText: "プランクを入れたい", context: {}, catalog: [catalogFixture()], runningPrescription: null, unsupportedIntents: [] }, { apiKey: "offline-fake-key", fetchImpl });
    expect(result).toEqual({ ok: true, value: output }); expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "low" }, max_output_tokens: 3000, store: false });
    expect(body.tools).toBeUndefined(); expect(body.text.format.strict).toBe(true);
    expect(JSON.parse(body.input).catalog[0].coachingPoint).toBe(catalogFixture().coachingPoint);
  });
  it("uses a strict union whose Running variant has no numeric fields", () => {
    const variants = MENU_COMPOSER_JSON_SCHEMA.properties.blocks.items.properties.items.items.anyOf;
    expect(variants[0].required).toEqual(["type"]); expect(variants.every((item) => !item.additionalProperties)).toBe(true);
  });
});
