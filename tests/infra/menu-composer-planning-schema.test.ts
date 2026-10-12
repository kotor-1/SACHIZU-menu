import { describe, expect, it, vi } from "vitest";
import { composeMenuWithOpenAI } from "@/infra/menu-composition/openai-composer";
import { catalogFixture, catalogPlan } from "../fixtures/menu-composition";

type JsonSchemaNode = {
  type?: string | string[]; enum?: readonly string[]; required?: string[];
  minItems?: number; maxItems?: number;
  properties?: Record<string, JsonSchemaNode>; items?: JsonSchemaNode; anyOf?: JsonSchemaNode[];
};

const overview = { title: "100mの練習", objective: "走技術を練習する", approach: "登録種目を組み合わせる" };
const output = {
  overview,
  transitionSeconds: null,
  transitionDescription: "移動時間は未見積もりです。",
  blocks: [{ name: "導入", phase: "WARM_UP", allocatedSeconds: 300, allocationBasis: null, items: [catalogPlan()] }],
};
const response = new Response(JSON.stringify({ status: "completed", output: [
  { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] },
] }), { status: 200, headers: { "content-type": "application/json" } });

describe("menu composer planning metadata schema (mock transport only)", () => {
  it("requires the overview, transition estimate and per-block phase/allocation in the strict provider schema", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await composeMenuWithOpenAI({ requestText: "100mの練習", context: {}, catalog: [catalogFixture()],
      runningPrescription: null, unsupportedIntents: [] }, { apiKey: "offline-fake-key", fetchImpl });
    expect(result).toEqual({ ok: true, value: output });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      text: { format: { strict: boolean; schema: JsonSchemaNode } };
    };
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.required).toEqual(["sessionPlan", "overview", "transitionSeconds", "transitionDescription", "blocks"]);
    expect(body.text.format.schema.properties?.sessionPlan?.required).toEqual(["blocks", "timeBudgetReasoning"]);
    expect(body.text.format.schema.properties?.sessionPlan?.properties?.blocks?.items?.required)
      .toEqual(["name", "phase", "purpose", "allocatedSeconds"]);
    expect(body.text.format.schema.properties?.overview?.required).toEqual(["title", "objective", "approach"]);
    expect(body.text.format.schema.properties?.transitionSeconds?.type).toEqual(["integer", "null"]);
    expect(body.text.format.schema.properties?.transitionDescription?.type).toBe("string");
    const block = body.text.format.schema.properties?.blocks?.items?.properties;
    expect(block?.phase?.enum).toEqual(["WARM_UP", "DRILLS_STRENGTH", "RUNNING", "COOL_DOWN", "OTHER"]);
    expect(block?.allocatedSeconds?.type).toEqual(["integer", "null"]);
    const allocationBasis = body.text.format.schema.properties?.blocks?.items?.properties?.allocationBasis;
    expect(allocationBasis?.anyOf?.map(branch => branch.type ?? "object")).toEqual(["object", "null"]);
    expect(allocationBasis?.anyOf?.[0]?.required).toEqual(["itemEstimatesSeconds", "preparationSeconds", "explanation", "preparationDescription"]);
    expect(body.text.format.schema.properties?.blocks?.items?.required).toEqual(["name", "phase", "allocatedSeconds", "allocationBasis", "items"]);
  });

  it("preserves a structurally valid estimate mismatch for downstream review without retrying", async () => {
    const estimateMismatch = {
      ...output,
      blocks: [{ name: "導入", phase: "WARM_UP", allocatedSeconds: 300,
        allocationBasis: { itemEstimatesSeconds: [30], preparationSeconds: 0,
          explanation: "項目時間だけを見積もりました。ブロック配分との照合が必要です。", preparationDescription: "準備なし" },
        items: [catalogPlan()] }],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(estimateMismatch) }] },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await composeMenuWithOpenAI({ requestText: "100mの練習", context: {}, catalog: [catalogFixture()],
      runningPrescription: null, unsupportedIntents: [] }, { apiKey: "offline-fake-key", fetchImpl });

    expect(result).toEqual({ ok: true, value: estimateMismatch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
