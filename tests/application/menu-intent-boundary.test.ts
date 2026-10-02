import { describe, expect, it, vi } from "vitest";
import { verifyPrimarySemanticIntentV2, runningSemanticIntentV2Schema, type SemanticClaimV2 } from "@/application/running-menu/semantic-intent-v2";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import * as engine from "@/domain/running-policy";
import { resolveWhitespaceQuote } from "@/domain/shared/source-quote";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { extractRunningSemanticIntentV2 } from "@/infra/running-menu/openai-semantic-intent-v2";
import { composeMenuWithOpenAI } from "@/infra/menu-composition/openai-composer";
import { validateComposition, EMPTY_EXERCISE_DOSE, type ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import saved from "../fixtures/menu-composition-luna-boundary.json";
import { COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";

const claim = (field: SemanticClaimV2["field"], value: SemanticClaimV2["value"], sourceText: string,
  numericParts: SemanticClaimV2["numericParts"] = []): SemanticClaimV2 => ({ field, value, sourceText, numericParts,
  status: "ACTIVE", polarity: "AFFIRMED", temporalScope: "DESIRED" });
const intent = (requestKind: "RUNNING" | "EXERCISE_ONLY", claims: SemanticClaimV2[] = []) => ({
  interpreterVersion: "running-intent-v2", requestKind, claims, corrections: [], unsupportedIntents: [], ambiguity: null, exerciseIds: [],
});

describe("Request kind and negative Running request", () => {
  it.each([
    ["EXERCISE_ONLY", false, true], ["EXERCISE_ONLY", true, false],
    ["RUNNING", true, true], ["RUNNING", false, false],
  ] as const)("%s + %s has value-based consistency", (kind, value, accepted) => {
    const text = value ? "今日は普通に走る" : "今日は走らずに体幹だけ";
    const result = verifyPrimarySemanticIntentV2(text, intent(kind, [claim("RUNNING_REQUEST", value, text)]), []);
    expect(result.ok).toBe(accepted);
    if (result.ok) {
      expect(result.engineIntent.runningRequested).toBe(value);
      expect(result.interpretation.claims[0].polarity).toBe("AFFIRMED");
    }
  });
  it("keeps a second negation invalid instead of rewriting it", () => {
    const text = "今日は走らずに体幹だけ";
    expect(verifyPrimarySemanticIntentV2(text, intent("EXERCISE_ONLY", [{ ...claim("RUNNING_REQUEST", false, text), polarity: "NEGATED" }]), []).ok).toBe(false);
  });
});

describe("Session budget versus item duration", () => {
  it.each([
    ["今日は30分しかない", "30分", "MINUTE", 1800],
    ["メニュー全体を45分で", "45分", "MINUTE", 2700],
    ["あと20分で終わりたい", "20分", "MINUTE", 1200],
    ["30分で練習したい", "30分", "MINUTE", 1800],
    ["練習時間は1時間", "1時間", "HOUR", 3600],
  ] as const)("accepts grounded session scope: %s", (text, rawText, unit, seconds) => {
    const result = verifyPrimarySemanticIntentV2(text, intent("EXERCISE_ONLY", [claim("AVAILABLE_TIME", seconds, text, [{ rawText, unit }])]), []);
    expect(result).toMatchObject({ ok: true, engineIntent: { runningRequested: false, availableTimeSeconds: { value: seconds } } });
  });
  it.each(["プランク30秒", "これを20秒やりたい", "20秒くらいやりたい", "30秒休んで", "メニュー全体は45分、プランク30秒"])("rejects item time mislabeled as session availability: %s", text => {
    const rawText = text.includes("20秒") ? "20秒" : "30秒";
    const result = verifyPrimarySemanticIntentV2(text, intent("EXERCISE_ONLY", [claim("AVAILABLE_TIME", parseInt(rawText), text, [{ rawText, unit: "SECOND" }])]), []);
    expect(result).toMatchObject({ ok: false, issue: "SESSION_TIME_BASIS_REQUIRED" });
  });
  it("rejects a cropped amount that has lost the session-level evidence", () => {
    expect(verifyPrimarySemanticIntentV2("今日は30分しかない", intent("RUNNING", [claim("AVAILABLE_TIME", 1800, "30分", [{ rawText: "30分", unit: "MINUTE" }])]), [])).toMatchObject({ ok: false, issue: "SESSION_TIME_BASIS_REQUIRED" });
  });
  it.each([
    ["20mだけ走りたい", "TRAINING_DISTANCE", "20m", "METER"],
    ["20本やりたい", "REPS", "20本", "REP"],
  ] as const)("keeps %s in its original numeric role", (text, field, rawText, unit) => {
    const result = verifyPrimarySemanticIntentV2(text, intent("RUNNING", [claim("RUNNING_REQUEST", true, text), claim(field, 20, text, [{ rawText, unit }])]), []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.engineIntent.availableTimeSeconds).toBeNull();
      expect(result.interpretation.claims.find(c => c.field === field)?.numericParts[0]).toMatchObject({ semanticRole: field, normalizedValue: 20, unit });
    }
    expect(verifyPrimarySemanticIntentV2(text, intent("RUNNING", [claim("AVAILABLE_TIME", 20, text, [{ rawText, unit }])]), []).ok).toBe(false);
  });
});

describe("Whitespace-only provenance with unique original spans", () => {
  it.each(["左右の膝を素早く入れ替える", "左右の膝を 素早く入れ替える", "左右の膝を\t  素早く入れ替える"])("rebinds %j to exact source", quote => {
    const source = "希望：左右の膝を\r\n素早く入れ替える。";
    const span = resolveWhitespaceQuote(source, quote)!;
    expect(span).toEqual({ sourceText: "左右の膝を\r\n素早く入れ替える", start: 3, end: source.length - 1 });
    expect(source.slice(span.start, span.end)).toBe(span.sourceText);
    const raw = { ...intent("EXERCISE_ONLY"), unsupportedIntents: [{ meaning: "膝を入れ替える", sourceText: quote }] };
    const result = verifyPrimarySemanticIntentV2(source, raw, []);
    expect(result).toMatchObject({ ok: true, interpretation: { unsupportedIntents: [{ ...span, sourceType: "USER_TEXT" }] } });
    expect(raw.unsupportedIntents[0].sourceText).toBe(quote);
  });
  it.each(["20秒やりたい", "20秒くらい休みたい", "やりたい20秒くらい", "２０秒くらいやりたい"])("does not repair word, order or non-whitespace differences: %s", quote => {
    expect(resolveWhitespaceQuote("20秒くらいやりたい", quote)).toBeNull();
    expect(verifyPrimarySemanticIntentV2("20秒くらいやりたい", { ...intent("EXERCISE_ONLY"), unsupportedIntents: [{ meaning: "希望", sourceText: quote }] }, []).ok).toBe(false);
  });
  it("rejects duplicate normalized locations, including an exact first occurrence", () => {
    const source = "膝を入れ替える。膝を\n入れ替える。";
    expect(resolveWhitespaceQuote(source, "膝を入れ替える")).toBeNull();
    expect(verifyPrimarySemanticIntentV2(source, { ...intent("EXERCISE_ONLY"), unsupportedIntents: [{ meaning: "希望", sourceText: "膝を 入れ替える" }] }, []).ok).toBe(false);
  });
  it("canonicalizes categorical and numeric claim quotes but never joins numerals into new evidence", () => {
    const text = "今日は\n30分しかない";
    const result = verifyPrimarySemanticIntentV2(text, intent("EXERCISE_ONLY", [claim("AVAILABLE_TIME", 1800, "今日は30分しかない", [{ rawText: "30分", unit: "MINUTE" }])]), []);
    expect(result).toMatchObject({ ok: true, interpretation: { claims: [{ sourceText: text, start: 0, end: text.length }] } });
    expect(verifyPrimarySemanticIntentV2("全体を2 0秒で", intent("EXERCISE_ONLY", [claim("AVAILABLE_TIME", 20, "全体を20秒で", [{ rawText: "20秒", unit: "SECOND" }])]), []).ok).toBe(false);
  });
  it("does not hide negation from selective review after restoring a line break", () => {
    const text = "今日は疲れていな\nい";
    expect(verifyPrimarySemanticIntentV2(text, intent("RUNNING", [claim("FATIGUE", "FATIGUED", "今日は疲れていない")]), []))
      .toMatchObject({ ok: false, reason: "SEMANTIC_REVIEW_REQUIRED", triggers: ["SOURCE_POLARITY_UNCERTAIN"] });
  });
  it.each(["中\n2です", "2\n年生です"])("does not turn a whitespace-separated grade into reps: %s", text => {
    expect(verifyPrimarySemanticIntentV2(text, intent("RUNNING", [claim("REPS", 2, text.replace(/\s/gu, ""), [{ rawText: "2", unit: "NONE" }])]), []).ok).toBe(false);
  });
  it("keeps a separated time unit and its exact numeric offset", () => {
    const text = "今日は30\n分しかない";
    const result = verifyPrimarySemanticIntentV2(text, intent("EXERCISE_ONLY", [claim("AVAILABLE_TIME", 1800, "今日は30分しかない", [{ rawText: "30", unit: "MINUTE" }])]), []);
    expect(result).toMatchObject({ ok: true, interpretation: { claims: [{ numericParts: [{ start: 3, end: 5, normalizedValue: 30, unit: "MINUTE" }] }] }, engineIntent: { availableTimeSeconds: { value: 1800 } } });
  });
});

describe("Recorded live failures through the offline composition pipeline", () => {
  it("rejects the original CASE4 wrong time role after safely grounding its multiline quote", () => {
    const row = saved.cases[1];
    expect(verifyPrimarySemanticIntentV2(row.input, row.primary, [])).toMatchObject({ ok: false, issue: "SESSION_TIME_BASIS_REQUIRED" });
  });
  it.each([3, 4])("CASE%s reaches editable preview with no Engine or second review call", async id => {
    const row = saved.cases.find(x => x.id === id)!;
    const primary = runningSemanticIntentV2Schema.parse(row.primary);
    if (id === 4) {
      // Explicit corrected-contract mock, not a replacement recorded response.
      primary.claims = [];
      primary.unsupportedIntents.push({ meaning: "このExerciseを20秒程度行いたい", sourceText: "20秒くらいやりたい" });
    }
    const catalog = row.catalog as ComposerCatalogExercise[];
    const items = id === 3 ? [catalog[0], catalog.at(-1)!].map(x => ({ type: "CATALOG_EXERCISE", exerciseId: x.id,
      displayName: x.name, executionInstruction: x.description!, plannedNote: "", reason: "希望した動作", ...EMPTY_EXERCISE_DOSE })) : [{
      type: "FREEFORM", category: "DRILL", displayName: "壁で膝を左右に入れ替える", originalUserInstruction: row.input.replace(/\n/gu, ""),
      executionInstruction: "壁に両手をついて前傾し、姿勢を保って膝を左右に素早く入れ替える。", plannedNote: "20秒程度", reason: "希望した動作を保持",
      ...EMPTY_EXERCISE_DOSE, plannedDurationSeconds: 20,
    }];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const stage = body.text.format.name;
      expect(["running_semantic_intent_v2", "menu_composition_v1"]).toContain(stage);
      const value = stage === "running_semantic_intent_v2" ? primary : { blocks: [{ name: "今回の希望", items }] };
      if (stage === "menu_composition_v1") {
        const input = JSON.parse(body.input);
        expect(input.requestText).toBe(row.input);
        expect(input.runningPrescription).toBeNull();
      }
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }));
    });
    const options = { apiKey: "offline-mock-key", fetchImpl: fetchMock };
    const engineSpy = vi.spyOn(engine, "planRunningPrescription");
    try {
      const result = await generateComposedMenu({ requestText: row.input, context: {} }, {
        ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => catalog,
        interpret: async input => {
          const extracted = await extractRunningSemanticIntentV2({ requestText: input.requestText, exercises: catalog }, options);
          expect(extracted.ok).toBe(true);
          if (!extracted.ok) throw new Error("mock extraction failed");
          const verified = verifyPrimarySemanticIntentV2(input.requestText, extracted.interpretation, catalog.map(x => x.id), extracted.review);
          expect(verified.ok).toBe(true);
          if (!verified.ok) throw new Error("verification failed");
          expect(verified.engineIntent.availableTimeSeconds).toBeNull();
          return { ok: true, intent: verified.engineIntent, running: createRunningMenuPreview(verified.engineIntent, {}, row.input),
            exercises: catalog.map(({ id, name }) => ({ id, name })), unsupportedIntents: verified.interpretation.unsupportedIntents.map(x => x.meaning), persistable: false, previewToken: null };
        },
        compose: input => composeMenuWithOpenAI(input, options),
      });
      expect(result.ok).toBe(true);
      expect(engineSpy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      if (result.ok && id === 4) {
        expect(result.preview.runningPrescription).toBeNull();
        expect(result.preview.composition.blocks[0].items[0]).toMatchObject({ type: "FREEFORM", originalUserInstruction: row.input,
          plannedDurationSeconds: 20, plannedReps: null, plannedDistanceMeters: null });
      }
    } finally { engineSpy.mockRestore(); }
    if (id === 4) for (const extra of [{ plannedReps: 20 }, { plannedDistanceMeters: 20 }]) {
      expect(validateComposition({ blocks: [{ name: "希望", items: [{ ...items[0], ...extra }] }] }, { catalog, ownerId: DEFAULT_OWNER_ID, requestText: row.input, runningAvailable: false })).toMatchObject({ ok: false, code: "CONFLICTING_UNITS" });
    }
  });
});
