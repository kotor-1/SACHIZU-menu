import { describe, expect, it } from "vitest";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import {
  parseSpokenNumber, verifySemanticIntentV2, RUNNING_INTERPRETER_VERSION,
  type RunningSemanticIntentV2, type SemanticReviewV2,
} from "@/application/running-menu/semantic-intent-v2";
import corpus from "@/../tests/fixtures/running-intent-v2-corpus.json";

const claim = (field: RunningSemanticIntentV2["claims"][number]["field"], value: string | number | boolean, sourceText: string, numericParts: { rawText: string; unit: "METER" | "REP" | "SECOND" | "MINUTE" | "HOUR" | "DAY" | "SET" | "NONE" }[] = []): RunningSemanticIntentV2["claims"][number] => ({
  field, value, sourceText, numericParts, polarity: "AFFIRMED", temporalScope: "CURRENT", status: "ACTIVE",
});
const raw = (claims: RunningSemanticIntentV2["claims"], extras: Partial<RunningSemanticIntentV2> = {}): RunningSemanticIntentV2 => ({
  interpreterVersion: RUNNING_INTERPRETER_VERSION, requestKind: "RUNNING", claims,
  unsupportedIntents: [], ambiguity: null, exerciseIds: [], ...extras,
});
const review = (claims: RunningSemanticIntentV2["claims"], extras: Partial<SemanticReviewV2> = {}): SemanticReviewV2 => ({
  assessments: claims.map((_, index) => ({ index, supported: true })),
  activeClaimIndexes: claims.map((_, index) => index),
  requestKindSupported: true, missingCriticalClaim: false, ambiguityCorrect: true,
  unsupportedIntentsSupported: true, ...extras,
});
const verify = (text: string, claims: RunningSemanticIntentV2["claims"], extras: Partial<RunningSemanticIntentV2> = {}, reviewExtras: Partial<SemanticReviewV2> = {}) =>
  verifySemanticIntentV2(text, raw(claims, extras), review(claims, reviewExtras), { roles: claims.flatMap((item) =>
    item.field === "EVENT" || item.field === "TRAINING_DISTANCE"
      ? item.numericParts.filter((part) => part.unit === "NONE").map((part) => ({ sourceText: item.sourceText, rawText: part.rawText, role: item.field }))
      : []) }, []);

describe("semantic intent v2 structural and independent semantic verification", () => {
  it("keeps the 110-case corpus as a versioned evaluation fixture with explicit expectations", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(100);
    for (const item of corpus) {
      expect(item.input.length).toBeGreaterThan(0);
      expect(item.expectedSemanticFields).toHaveProperty("event");
      expect(item.expectedSemanticFields).toHaveProperty("explicitDistances");
      expect(item).toHaveProperty("expectedUnsupportedIntents");
      expect(item).toHaveProperty("expectedAmbiguity");
      expect(item).toHaveProperty("expectedVerifierResult");
      expect(item).toHaveProperty("expectedEngineAdapterFields");
      expect(item.expectedUnsupportedIntents).not.toContain("原文の希望を保持");
      for (const source of item.expectedUnsupportedIntents) expect(item.input).toContain(source);
      if ("expectedSemanticClaims" in item) expect(item.expectedSemanticClaims).toHaveProperty("loadReductionRequested", false);
    }
    expect(new Set(corpus.map((item) => item.category)).size).toBeGreaterThanOrEqual(15);
    const recovered = corpus.find((item) => item.id === "X41")!;
    expect(recovered.expectedSemanticFields.fatigueState).toBe("NOT_FATIGUED");
    expect(recovered.expectedEngineAdapterFields.fatigueState).toBeNull();
  });

  it("normalizes written numerals structurally without a dialect dictionary", () => {
    expect(parseSpokenNumber("２００")).toBe(200);
    expect(parseSpokenNumber("二百")).toBe(200);
    expect(parseSpokenNumber("にひゃく")).toBe(200);
    expect(parseSpokenNumber("さん")).toBe(3);
    expect(parseSpokenNumber("せん")).toBe(1000);
    expect(parseSpokenNumber("さんぜん")).toBe(3000);
    expect(parseSpokenNumber("あと三日")).toBeNull();
  });

  it("preserves 200m event and 3 competition days without training distance or reps", () => {
    const text = "今週に２００mのレースがある。中学2年男子です。あと3日で試合ですが、疲労が抜けすぎています。少し疲労を溜めるメニューを消化したい";
    const claims = [
      claim("EVENT", "200m", "２００mのレース", [{ rawText: "２００", unit: "METER" }]),
      claim("AGE_GROUP", "JUNIOR_HIGH", "中学2年", [{ rawText: "2", unit: "NONE" }]),
      claim("COMPETITION_DAYS", 3, "あと3日で試合", [{ rawText: "3", unit: "DAY" }]),
      claim("FATIGUE", "NOT_FATIGUED", "疲労が抜けすぎています"),
    ];
    const result = verify(text, claims, { unsupportedIntents: [{ meaning: "少し疲労を溜めたい", sourceText: "少し疲労を溜めるメニューを消化したい" }] }, { unsupportedIntentsSupported: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engineIntent).toMatchObject({ event: { value: "200m" }, ageGroup: { value: "JUNIOR_HIGH" }, explicitDistances: [], humanExplicitReps: null, humanExplicitRestSeconds: null, loadReductionRequested: null });
    const eventEvidence = result.interpretation.claims.find((item) => item.field === "EVENT")?.numericParts[0];
    expect(eventEvidence).toMatchObject({ normalizedValue: 200, unit: "METER", semanticRole: "EVENT" });
    expect(text.slice(eventEvidence!.start, eventEvidence!.end)).toBe(eventEvidence!.rawText);
    expect(result.interpretation.unsupportedIntents[0].meaning).toBe("少し疲労を溜めるメニューを消化したい");
    expect(result.interpretation).toMatchObject({ understandingStatus: "UNDERSTOOD_BUT_UNSUPPORTED", unsupportedIntents: [{ supportStatus: "UNSUPPORTED_BY_CURRENT_POLICY", sourceType: "USER_TEXT" }] });
    expect(createRunningMenuPreview(result.engineIntent, {}, text)).toMatchObject({ status: "READY", prescription: { distanceMeters: 120, totalReps: 3, repRestSeconds: 900 } });
  });

  it("accepts spoken event and explicit training distance as different roles", () => {
    const text = "にひゃく出るで。今日は60を3本";
    const claims = [
      claim("EVENT", "200m", "にひゃく出るで", [{ rawText: "にひゃく", unit: "NONE" }]),
      claim("TRAINING_DISTANCE", 60, "今日は60を3本", [{ rawText: "60", unit: "NONE" }]),
      claim("REPS", 3, "60を3本", [{ rawText: "3", unit: "REP" }]),
    ];
    expect(verify(text, claims)).toMatchObject({ ok: true, engineIntent: { event: { value: "200m" }, explicitDistances: [{ value: 60 }], humanExplicitReps: { value: 3 } } });
  });

  it("rejects a fabricated numeric value even when the quote exists", () => {
    const text = "100出る";
    expect(verify(text, [claim("EVENT", "200m", text, [{ rawText: "100", unit: "NONE" }])])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(verify("せんを走りたい", [claim("TRAINING_DISTANCE", 100, "せんを走りたい", [{ rawText: "せん", unit: "NONE" }])]))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it.each([
    ["EVENT", "200m"], ["TRAINING_DISTANCE", 60], ["REPS", 3], ["REST", 180], ["AVAILABLE_TIME", 1800],
  ] as const)("rejects invented %s with nonnumeric evidence even if both AI reviews agree", (field, value) => {
    const text = "今日は短め";
    expect(verify(text, [claim(field, value, text, [{ rawText: "短め", unit: "NONE" }])]))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it.each([
    ["あと3日", "REPS", 3, "3"], ["中2", "REPS", 2, "2"], ["高1", "REPS", 1, "1"], ["小5", "REPS", 5, "5"],
    ["休憩3分", "TRAINING_DISTANCE", 3, "3"], ["3セット", "REPS", 3, "3"], ["200mを2本", "EVENT", "200m", "200"],
  ] as const)("checks original numeric context when an AI crops the unit or grade out of %s", (text, field, value, rawText) => {
    expect(verify(text, [claim(field, value, rawText, [{ rawText, unit: "NONE" }])]))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("retains independently reviewed calendar context without giving it engine numeric authority", () => {
    const text = "200m選手。明後日試合";
    const result = verify(text, [
      claim("EVENT", "200m", "200m選手", [{ rawText: "200", unit: "METER" }]),
      claim("COMPETITION_DAYS", 2, "明後日試合"),
    ]);
    expect(result).toMatchObject({ ok: true, engineIntent: {
      explicitDistances: [], humanExplicitReps: null, humanExplicitRestSeconds: null, availableTimeSeconds: null,
    } });
  });

  it("requires independent distance-role evidence when a spoken unit is not a structural unit token", () => {
    const text = "200めーとるでる";
    const claims = [claim("EVENT", "200m", text, [{ rawText: "200", unit: "METER" }])];
    expect(verifySemanticIntentV2(text, raw(claims), review(claims),
      { roles: [{ sourceText: text, rawText: "200", role: "EVENT" }] }, []))
      .toMatchObject({ ok: true, engineIntent: { event: { value: "200m" }, explicitDistances: [] } });
    expect(verifySemanticIntentV2(text, raw(claims), review(claims), { roles: [] }, []))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("rejects a running request that contradicts its structured request kind", () => {
    expect(verify("補強だけで", [claim("RUNNING_REQUEST", false, "補強だけで")])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("rejects wrong units: days, rest and sets cannot become reps", () => {
    for (const [text, rawText, unit] of [["あと3日で試合", "3", "DAY"], ["休憩3分", "3", "MINUTE"], ["3セット", "3", "SET"], ["３セット", "３", "SET"]] as const) {
      expect(verify(text, [claim("REPS", 3, text, [{ rawText, unit }])])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    }
    expect(verify("試合まで60分", [claim("TRAINING_DISTANCE", 60, "試合まで60分", [{ rawText: "60", unit: "MINUTE" }])])).toMatchObject({ ok: false });
    for (const grade of ["中2", "高1", "小5", "中学2", "高校1"]) {
      const digit = grade.match(/\d/u)![0];
      expect(verify(grade, [claim("REPS", Number(digit), grade, [{ rawText: digit, unit: "NONE" }])])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    }
    expect(verify("高1", [claim("REPS", 1, "高1", [{ rawText: "高1", unit: "NONE" }])])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("rejects assigning one numeric source span to two semantic roles", () => {
    const race = "200mのレース";
    expect(verify(race, [
      claim("EVENT", "200m", race, [{ rawText: "200", unit: "METER" }]),
      claim("TRAINING_DISTANCE", 200, race, [{ rawText: "200", unit: "METER" }]),
    ])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    const grade = "高1";
    expect(verify(grade, [
      claim("AGE_GROUP", "HIGH_SCHOOL", grade, [{ rawText: "1", unit: "NONE" }]),
      claim("REPS", 1, grade, [{ rawText: "1", unit: "NONE" }]),
    ])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("rejects an event claim whose numeric span is directly bound to workout reps", () => {
    const text = "あと3日で試合。60mを3本。休憩4分";
    expect(verify(text, [
      claim("EVENT", "60m", "60mを3本", [{ rawText: "60", unit: "METER" }]),
      claim("REPS", 3, "60mを3本", [{ rawText: "3", unit: "REP" }]),
    ])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(verify(text, [
      claim("TRAINING_DISTANCE", 60, "60mを3本", [{ rawText: "60", unit: "METER" }]),
      claim("REPS", 3, "60mを3本", [{ rawText: "3", unit: "REP" }]),
    ])).toMatchObject({ ok: true, engineIntent: { explicitDistances: [{ value: 60 }], humanExplicitReps: { value: 3 } } });
  });

  it("rejects numeric role swaps and negation contradictions found by independent review", () => {
    const cases = [
      ["200mのレース", claim("TRAINING_DISTANCE", 200, "200mのレース", [{ rawText: "200", unit: "METER" }])],
      ["長いのはやだ", claim("DISTANCE_PREFERENCE", "LONG", "長いのはやだ")],
      ["軽めにはしないで", claim("LOAD_REDUCTION", true, "軽めにはしないで")],
      ["疲れてへん", claim("FATIGUE", "FATIGUED", "疲れてへん")],
      ["短めで、いや長め", claim("DISTANCE_PREFERENCE", "SHORT", "短めで、いや長め")],
    ] as const;
    for (const [text, bad] of cases) {
      expect(verify(text, [bad], {}, { assessments: [{ index: 0, supported: false }] })).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    }
  });

  it("projects only active final claims after negation or correction", () => {
    const text = "短めで、いや長め。疲れてるけど普通にやりたい";
    const claims = [
      claim("DISTANCE_PREFERENCE", "SHORT", "短めで"),
      claim("DISTANCE_PREFERENCE", "LONG", "長め"),
      claim("FATIGUE", "FATIGUED", "疲れてる"),
      claim("LOAD_REDUCTION", false, "普通にやりたい"),
    ];
    expect(verify(text, claims, {}, { activeClaimIndexes: [1, 2, 3] })).toMatchObject({ ok: true, engineIntent: { distancePreference: { value: "LONG" }, fatigueState: { value: "REPORTED" }, loadReductionRequested: null } });
    expect(verify(text, claims)).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    const negated = { ...claim("DISTANCE_PREFERENCE", "LONG", "長いのはやだ"), polarity: "NEGATED" as const };
    expect(verify("長いのはやだ", [negated])).toMatchObject({ ok: true, engineIntent: { distancePreference: null } });
    expect(verify("長いのはやだ", [negated], {}, { activeClaimIndexes: [] })).toMatchObject({ ok: true, engineIntent: { distancePreference: null } });
  });

  it("preserves a verified negative preference as unsupported without inventing its opposite", () => {
    const text = "長いのはやだ";
    const negative = { ...claim("DISTANCE_PREFERENCE", "LONG", text), polarity: "NEGATED" as const, temporalScope: "DESIRED" as const };
    const result = verify(text, [negative], {}, { activeClaimIndexes: [] });
    expect(result).toMatchObject({ ok: true, engineIntent: { distancePreference: null }, interpretation: {
      understandingStatus: "UNDERSTOOD_BUT_UNSUPPORTED", unsupportedIntents: [{ sourceText: text, meaning: text }],
    } });
    expect(verify(text, [negative], { unsupportedIntents: [{ meaning: "長い距離を避けたい", sourceText: text }] }, { activeClaimIndexes: [] }))
      .toMatchObject({ ok: true, interpretation: { unsupportedIntents: [{ sourceText: text, meaning: "長い距離を避けたい" }] } });
  });

  it("does not revive a superseded negative preference after an affirmative correction", () => {
    const text = "長いのはやだ。いや長めで";
    const negative = { ...claim("DISTANCE_PREFERENCE", "LONG", "長いのはやだ"), polarity: "NEGATED" as const, status: "SUPERSEDED" as const };
    const positive = claim("DISTANCE_PREFERENCE", "LONG", "長めで");
    expect(verify(text, [negative, positive], {}, { activeClaimIndexes: [1] }))
      .toMatchObject({ ok: true, engineIntent: { distancePreference: { value: "LONG" } }, interpretation: { unsupportedIntents: [] } });
  });

  it("ignores blind ambiguity only for an independently reviewed superseded numeric span", () => {
    const text = "100m選手。60mで、いや50mを走りたい";
    const old = { ...claim("TRAINING_DISTANCE", 60, "60mで", [{ rawText: "60", unit: "METER" }]), status: "SUPERSEDED" as const };
    const claims = [claim("EVENT", "100m", "100m選手", [{ rawText: "100", unit: "METER" }]), old,
      claim("TRAINING_DISTANCE", 50, "50mを走りたい", [{ rawText: "50", unit: "METER" }])];
    const roles = { roles: [{ sourceText: "60mで", rawText: "60", role: "AMBIGUOUS" }] };
    expect(verifySemanticIntentV2(text, raw(claims), review(claims, { activeClaimIndexes: [0, 2] }), roles, []))
      .toMatchObject({ ok: true, engineIntent: { explicitDistances: [{ value: 50 }] } });
    const stillActive = claims.map((item) => ({ ...item, status: "ACTIVE" as const }));
    expect(verifySemanticIntentV2(text, raw(stillActive), review(stillActive), roles, []))
      .toMatchObject({ ok: false, reason: "AMBIGUOUS" });
  });

  it("separates desired light load from current fatigue", () => {
    const text = "疲れとらんけど軽めがいい";
    expect(verify(text, [claim("FATIGUE", "NOT_FATIGUED", "疲れとらん"), claim("LOAD_REDUCTION", true, "軽めがいい")])).toMatchObject({ ok: true, engineIntent: { fatigueState: null, loadReductionRequested: { value: true } } });
  });

  it("does not silently drop a supported current-state claim without a correction", () => {
    const text = "疲れとらん";
    const claims = [claim("FATIGUE", "NOT_FATIGUED", text)];
    expect(verify(text, claims, {}, { activeClaimIndexes: [] })).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("rejects double negation of fields whose value already encodes it", () => {
    expect(verify("軽めにはしないで", [{ ...claim("LOAD_REDUCTION", false, "軽めにはしないで"), polarity: "NEGATED" }]))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(verify("疲れてへん", [{ ...claim("FATIGUE", "NOT_FATIGUED", "疲れてへん"), polarity: "NEGATED" }]))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("asks one question only for supported ambiguity and rejects fabricated quotes", () => {
    const ambiguous = raw([], { requestKind: "AMBIGUOUS", ambiguity: { sourceText: "200", question: "種目の200mですか、今日走る200mですか？" } });
    const roles = { roles: [{ sourceText: "200", rawText: "200", role: "AMBIGUOUS" }] };
    expect(verifySemanticIntentV2("200", ambiguous, review([]), roles, [])).toMatchObject({ ok: false, reason: "AMBIGUOUS" });
    expect(verifySemanticIntentV2("200", ambiguous, review([], { ambiguityCorrect: false }), roles, [])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(verifySemanticIntentV2("200", ambiguous, review([], { requestKindSupported: false }), roles, [])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(verify("200出る", [claim("EVENT", "200m", "存在しない引用", [{ rawText: "200", unit: "NONE" }])])).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("uses a blind numeric-role review to stop an agreed but ambiguous AI claim", () => {
    const text = "次200走ります";
    const claims = [claim("TRAINING_DISTANCE", 200, text, [{ rawText: "200", unit: "NONE" }])];
    expect(verifySemanticIntentV2(text, raw(claims), review(claims),
      { roles: [{ sourceText: text, rawText: "200", role: "AMBIGUOUS" }] }, []))
      .toMatchObject({ ok: false, reason: "AMBIGUOUS" });
    expect(verifySemanticIntentV2("200出る", raw([claim("TRAINING_DISTANCE", 200, "200出る", [{ rawText: "200", unit: "NONE" }])]),
      review(claims), { roles: [{ sourceText: "200出る", rawText: "200", role: "EVENT" }] }, []))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(verifySemanticIntentV2("中2、100、短め", raw([claim("AGE_GROUP", "JUNIOR_HIGH", "中2")]),
      review([claim("AGE_GROUP", "JUNIOR_HIGH", "中2")]),
      { roles: [{ sourceText: "中2、100、短め", rawText: "100", role: "AMBIGUOUS" }] }, []))
      .toMatchObject({ ok: false, reason: "AMBIGUOUS" });
  });

  it("does not pass unsupported wishes or model-created prescription numbers to the engine", () => {
    const text = "100m選手。今日は短めで、少し疲労を溜めたい";
    const claims = [claim("EVENT", "100m", "100m選手", [{ rawText: "100", unit: "METER" }]), claim("DISTANCE_PREFERENCE", "SHORT", "短めで")];
    const result = verify(text, claims, { unsupportedIntents: [{ meaning: "疲労を少し溜めたい", sourceText: "少し疲労を溜めたい" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engineIntent).not.toHaveProperty("semanticIntents");
    expect(result.engineIntent).not.toHaveProperty("generatedDistanceMeters");
    expect(result.engineIntent).not.toHaveProperty("generatedReps");
    expect(result.engineIntent).not.toHaveProperty("generatedRestSeconds");
    expect(result.interpretation.unsupportedIntents).toHaveLength(1);
  });
});
