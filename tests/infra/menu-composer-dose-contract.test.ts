import { describe, expect, it, vi } from "vitest";
import { composeMenuWithOpenAI, menuComposerJsonSchema } from "@/infra/menu-composition/openai-composer";
import type { MenuComposerInput } from "@/infra/menu-composition/openai-composer";
import { catalogFixture } from "../fixtures/menu-composition";
import recordedLunaOutput from "../fixtures/menu-time-luna-20261012.json";

type JsonSchema = {
  type?: string | string[]; enum?: string[]; required?: string[];
  properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[];
};

const envelope = (value: unknown) => new Response(JSON.stringify({ status: "completed", output: [
  { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] },
] }), { status: 200, headers: { "content-type": "application/json" } });

const catalogItem = (dose: Record<string, unknown> = {}) => ({
  type: "CATALOG_EXERCISE", exerciseId: "exercise-a", displayName: "プランク",
  executionInstruction: "姿勢を保つ", plannedNote: "", reason: "希望に合うため",
  plannedSets: null, plannedReps: null, plannedDurationSeconds: null,
  plannedDistanceMeters: null, plannedRestSeconds: null,
  ...dose,
});

const freeformItem = (dose: Record<string, unknown> = {}) => ({
  type: "FREEFORM", category: "DRILL", originalUserInstruction: "プランクを入れたい",
  displayName: "プランク", executionInstruction: "姿勢を保つ", plannedNote: "", reason: "希望に合うため",
  plannedSets: null, plannedReps: null, plannedDurationSeconds: null,
  plannedDistanceMeters: null, plannedRestSeconds: null,
  ...dose,
});

function input(unprescribedRunning = false): MenuComposerInput {
  return {
    requestText: "プランクを入れたい", context: {}, catalog: [catalogFixture()],
    runningPrescription: null, unsupportedIntents: [],
    unprescribedRunning: unprescribedRunning ? { reasonCode: "SCIENCE_CONTEXT_REQUIRED", reasonMessage: "走の条件を確認してください。" } : null,
  };
}

function itemVariantsFrom(value: unknown): JsonSchema[] {
  const schema = value as JsonSchema;
  return schema.properties!.blocks!.items!.properties!.items!.items!.anyOf!;
}

function itemVariants(pending = false): JsonSchema[] {
  return itemVariantsFrom(menuComposerJsonSchema(pending ? { unprescribedRunning: input(true).unprescribedRunning } : undefined));
}

function schemaSentBy(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): unknown {
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text?: { format?: { schema?: unknown } } };
  return body.text?.format?.schema;
}

const unitKeys = ["plannedReps", "plannedDurationSeconds", "plannedDistanceMeters"] as const;
function allowsNumericValue(property: unknown): boolean {
  if (typeof property !== "object" || property === null || !("type" in property)) return false;
  const type = (property as { type: unknown }).type;
  return type === "integer" || type === "number" || (Array.isArray(type) && type.some(value => value === "integer" || value === "number"));
}

describe("menu composer quantity contract (mock transport only)", () => {
  it.each([
    { metricType: "REPS", description: "片側の膝を引き寄せて戻す動作を繰り返す。", dose: { plannedSets: 1, plannedReps: 10, executionInstruction: "片側10回を終えてから反対側10回。" } },
    { metricType: "TIME", description: "仰向けで腰を床へ押さえる姿勢を保持する。", dose: { plannedSets: 2, plannedDurationSeconds: 30, plannedRestSeconds: 20 } },
    { metricType: "DISTANCE", description: "一歩ずつ膝を上げてゆっくり前進する。", dose: { plannedSets: 2, plannedDistanceMeters: 20, plannedRestSeconds: 30 } },
  ])("keeps editable $metricType proposals for registered descriptions with no defaults", async ({ metricType, description, dose }) => {
    const request = input();
    request.catalog = [catalogFixture({ metricType, description, defaultSets: null, defaultReps: null,
      defaultDurationSeconds: null, defaultDistanceMeters: null, defaultRestSeconds: null })];
    const output = { blocks: [{ name: "補助", items: [catalogItem(dose)] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(envelope(output));
    expect(await composeMenuWithOpenAI(request, { apiKey: "offline-fake-key", fetchImpl }))
      .toEqual({ ok: true, value: output });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input).catalog[0]).toMatchObject({ description, defaultReps: null, defaultDurationSeconds: null });
    expect(body.instructions).toContain("defaultが未設定でも今回の編集可能な量を提案してよい");
    expect(body.instructions).toContain("登録説明に具体的な回数・秒数が書かれていないこと自体はnullにする理由ではない");
    expect(body.instructions).toContain("今回の暫定案として量・セット数・休息を提案できる");
    expect(body.instructions).toContain("登録済みの数量・実測値・科学的に保証された処方ではない");
    expect(body.instructions).toContain("PER_SIDEは片側ごとの回数");
  });

  it("replays the real 2026-10-12 Luna response without filling missing doses or turning per-side ten into twenty", async () => {
    // Output-only fixture from menu-time-20261012-083251/002.response.raw; no new AI generation.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(envelope(recordedLunaOutput));
    const result = await composeMenuWithOpenAI(input(), { apiKey: "offline-fake-key", fetchImpl });
    expect(result).toEqual({ ok: true, value: recordedLunaOutput });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (!result.ok) return;
    expect(result.value.blocks[0].items).toHaveLength(3);
    for (const item of result.value.blocks[0].items) {
      expect(item).toMatchObject({ plannedReps: null, plannedDurationSeconds: null, plannedDistanceMeters: null });
    }
    expect(result.value.blocks[2].items[0]).toMatchObject({ plannedReps: 10 });
    expect(result.value.blocks[1].items).toEqual([{ type: "RUNNING_POLICY" }]);
  });

  it("recovers a contradictory per-side quantity without rewriting either numeric value", async () => {
    const invalid = { blocks: [{ name: "補助", items: [catalogItem({ plannedReps: 20, executionInstruction: "左右10回ずつ行う。" })] }] };
    const corrected = { blocks: [{ name: "補助", items: [catalogItem({ plannedReps: 10, executionInstruction: "左右10回ずつ行う。" })] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(envelope(invalid)).mockResolvedValueOnce(envelope(corrected));
    expect(await composeMenuWithOpenAI(input(), { apiKey: "offline-fake-key", fetchImpl }))
      .toEqual({ ok: true, value: corrected });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(invalid.blocks[0].items[0].plannedReps).toBe(20);
  });

  it("encodes mutually exclusive primary units in the strict provider schema and rejects conflicting values locally", async () => {
    const variants = itemVariants();
    const catalogVariants = variants.filter(variant => variant.properties?.type?.enum?.includes("CATALOG_EXERCISE"));
    expect(catalogVariants).toHaveLength(4);
    const numericUnitCounts = catalogVariants.map(variant => unitKeys.filter(key => allowsNumericValue(variant.properties?.[key])).length).sort();
    expect(numericUnitCounts).toEqual([0, 1, 1, 1]);

    const invalid = { blocks: [{ name: "メイン", items: [catalogItem({ plannedReps: 8, plannedDurationSeconds: 30 })] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => envelope(invalid));
    const result = await composeMenuWithOpenAI(input(), { apiKey: "offline-fake-key", fetchImpl });
    expect(result).toEqual({ ok: false, reason: "INVALID_OUTPUT" });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // shared response client retries once at most
    expect(itemVariantsFrom(schemaSentBy(fetchImpl)).filter(variant => variant.properties?.type?.enum?.includes("CATALOG_EXERCISE")))
      .toHaveLength(4);
  });

  it("recovers once when the first composition violates the unit contract", async () => {
    const invalid = { blocks: [{ name: "メイン", items: [catalogItem({ plannedReps: 8, plannedDurationSeconds: 30 })] }] };
    const corrected = { blocks: [{ name: "メイン", items: [catalogItem({ plannedReps: 8 })] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(envelope(invalid)).mockResolvedValueOnce(envelope(corrected));
    expect(await composeMenuWithOpenAI(input(), { apiKey: "offline-fake-key", fetchImpl }))
      .toEqual({ ok: true, value: corrected });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "repetitions", dose: { plannedSets: 2, plannedReps: 8, plannedRestSeconds: 30 } },
    { label: "duration", dose: { plannedSets: 2, plannedDurationSeconds: 30, plannedRestSeconds: 15 } },
    { label: "distance", dose: { plannedSets: 2, plannedDistanceMeters: 100, plannedRestSeconds: 60 } },
    { label: "no primary unit", dose: {} },
  ])("accepts $label as the sole or absent primary unit", async ({ dose }) => {
    const output = { blocks: [{ name: "メイン", items: [catalogItem(dose)] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(envelope(output));
    const result = await composeMenuWithOpenAI(input(), { apiKey: "offline-fake-key", fetchImpl });
    expect(result).toEqual({ ok: true, value: output });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("makes pending FREEFORM quantities null-only in the provider schema and local validator, while catalog dose remains available", async () => {
    const variants = itemVariants(true);
    const freeformVariants = variants.filter(variant => variant.properties?.type?.enum?.includes("FREEFORM"));
    expect(freeformVariants).toHaveLength(1);
    const freeformVariant = freeformVariants[0]!;
    for (const key of ["plannedSets", "plannedRestSeconds", ...unitKeys]) {
      expect(freeformVariant.properties?.[key]).toEqual({ type: "null" });
    }

    for (const dose of [
      { plannedSets: 1 }, { plannedReps: 4 }, { plannedDurationSeconds: 30 },
      { plannedDistanceMeters: 20 }, { plannedRestSeconds: 0 },
    ]) {
      const invalid = { blocks: [{ name: "補助", items: [freeformItem(dose)] }] };
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => envelope(invalid));
      const rejected = await composeMenuWithOpenAI(input(true), { apiKey: "offline-fake-key", fetchImpl });
      expect(rejected).toEqual({ ok: false, reason: "INVALID_OUTPUT" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const sentFreeform = itemVariantsFrom(schemaSentBy(fetchImpl)).find(variant => variant.properties?.type?.enum?.includes("FREEFORM"));
      expect(sentFreeform?.properties?.plannedReps).toEqual({ type: "null" });
    }

    const unconfigured = { blocks: [{ name: "希望", items: [freeformItem()] }] };
    const unconfiguredFetch = vi.fn<typeof fetch>().mockResolvedValue(envelope(unconfigured));
    expect(await composeMenuWithOpenAI(input(true), { apiKey: "offline-fake-key", fetchImpl: unconfiguredFetch }))
      .toEqual({ ok: true, value: unconfigured });
    expect(unconfiguredFetch).toHaveBeenCalledTimes(1);

    const valid = { blocks: [{ name: "補助", items: [catalogItem({ plannedSets: 2, plannedReps: 8 })] }] };
    const catalogFetch = vi.fn<typeof fetch>().mockResolvedValue(envelope(valid));
    expect(await composeMenuWithOpenAI(input(true), { apiKey: "offline-fake-key", fetchImpl: catalogFetch }))
      .toEqual({ ok: true, value: valid });
    expect(catalogFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps RUNNING_POLICY as a type-only marker and allows one recovery attempt for violations", async () => {
    const variants = itemVariants();
    const runningVariant = variants.find(variant => variant.properties?.type?.enum?.includes("RUNNING_POLICY"));
    expect(runningVariant?.required).toEqual(["type"]);
    expect(Object.keys(runningVariant?.properties ?? {})).toEqual(["type"]);

    const valid = { blocks: [{ name: "走", items: [{ type: "RUNNING_POLICY" }] }] };
    const validFetch = vi.fn<typeof fetch>().mockResolvedValue(envelope(valid));
    expect(await composeMenuWithOpenAI(input(), { apiKey: "offline-fake-key", fetchImpl: validFetch }))
      .toEqual({ ok: true, value: valid });
    expect(validFetch).toHaveBeenCalledTimes(1);

    const invalid = { blocks: [{ name: "走", items: [{ type: "RUNNING_POLICY", plannedReps: 5 }] }] };
    const invalidFetch = vi.fn<typeof fetch>().mockImplementation(async () => envelope(invalid));
    expect(await composeMenuWithOpenAI(input(), { apiKey: "offline-fake-key", fetchImpl: invalidFetch }))
      .toEqual({ ok: false, reason: "INVALID_OUTPUT" });
    expect(invalidFetch).toHaveBeenCalledTimes(2);
  });
});
