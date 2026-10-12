import { afterEach, describe, expect, it, vi } from "vitest";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { composeMenuWithOpenAI } from "@/infra/menu-composition/openai-composer";
import { compositionSchema, type ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import type { RunningMenuPreviewActionResult } from "@/actions/running-menu-preview-actions";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";
import recorded from "../fixtures/menu-generation-highschool-race-week.json";

afterEach(() => vi.restoreAllMocks());
const deps = () => ({
  ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
  catalog: async () => recorded.catalog as ComposerCatalogExercise[],
  interpret: async () => structuredClone(recorded.interpretation) as RunningMenuPreviewActionResult,
});

describe("High-school 100m / next-weekend competition / fatigue 1 / 90min", () => {
  it("replays the real same-input response through the Composer contract into an editable draft", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(recorded.composition) }] }],
    })));
    const result = await generateComposedMenu(recorded.input, { ...deps(),
      compose: input => composeMenuWithOpenAI(input, { apiKey: "offline-fixture-only", fetchImpl }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.requestedTimeSeconds).toBe(5400);
    expect(result.preview.runningPrescription).toBeNull();
    const items = result.preview.composition.blocks.flatMap(block => block.items);
    expect(items.filter(item => item.type === "UNPRESCRIBED_RUNNING")).toHaveLength(1);
    expect(items.filter(item => item.type === "CATALOG_EXERCISE")).toHaveLength(3);
    expect(items.find(item => item.type === "UNPRESCRIBED_RUNNING")).toMatchObject({
      reasonCode: "SCIENCE_CONTEXT_REQUIRED", plannedReps: null, plannedDistanceMeters: null, plannedRestSeconds: null,
    });
    expect(result.preview.previewToken).toBeTruthy();
  });

  it("retains domain quantity rejection, records only its code, and does not blame the user's input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = compositionSchema.parse(recorded.composition);
    const item = value.blocks[1].items[0];
    if (item.type !== "CATALOG_EXERCISE") throw Error("fixture");
    item.plannedReps = 10; item.plannedDistanceMeters = 20;
    item.plannedNote = "PRIVATE_MODEL_TEXT_MUST_NOT_APPEAR_IN_LOGS";
    const result = await generateComposedMenu(recorded.input, { ...deps(), compose: async () => ({ ok: true, value }) });
    expect(result).toMatchObject({ ok: false, code: "CONFLICTING_UNITS" });
    if (result.ok) return;
    expect(result.message).toContain("入力内容の不足ではありません");
    expect(result.message).not.toContain("具体的に");
    expect(warn).toHaveBeenCalledExactlyOnceWith("[menu-composition] validation rejected", {
      stage: "COMPOSITION_VALIDATION", code: "CONFLICTING_UNITS", runningState: "UNPRESCRIBED",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(recorded.input.requestText);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(item.plannedNote);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(COMPOSITION_TEST_KEY);
  });
});
