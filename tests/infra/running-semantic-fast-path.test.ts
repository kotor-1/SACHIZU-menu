import { describe, expect, it, vi } from "vitest";
import { extractRunningSemanticIntentV2 } from "@/infra/running-menu/openai-semantic-intent-v2";
import { verifyPrimarySemanticIntentV2, type RunningSemanticIntentV2, type SemanticReviewV2 } from "@/application/running-menu/semantic-intent-v2";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import corpus from "@/../tests/fixtures/running-intent-v2-corpus.json";
import recorded from "@/../tests/fixtures/running-intent-v2-recorded-responses.json";
import { ORIGINAL_RUNNING_INTENT_SENTENCE, RUNNING_INTENT_SMOKE_PLAN } from "@/../scripts/running-intent-smoke-plan";
import { prepareRecordedSafetyReplay } from "@/../scripts/running-intent-replay-safety";

type Claim = RunningSemanticIntentV2["claims"][number];
const claim = (field: Claim["field"], value: Claim["value"], sourceText: string, numericParts: Claim["numericParts"] = []): Claim =>
  ({ field, value, sourceText, numericParts, status: "ACTIVE", polarity: "AFFIRMED", temporalScope: "CURRENT" });
const intent = (claims: Claim[], extra: Partial<RunningSemanticIntentV2> = {}): RunningSemanticIntentV2 =>
  ({ interpreterVersion: "running-intent-v2", requestKind: "RUNNING", claims, corrections: [], unsupportedIntents: [], ambiguity: null, exerciseIds: [], ...extra });
const review = (primary: RunningSemanticIntentV2, supported = true): SemanticReviewV2 =>
  ({ assessments: primary.claims.map((_, index) => ({ index, supported })),
    activeClaimIndexes: primary.claims.flatMap((c, index) => c.status === "ACTIVE" ? [index] : []),
    requestKindSupported: true, missingCriticalClaim: false, ambiguityCorrect: true,
    unsupportedIntentsSupported: true, correctionsSupported: true });
const response = (value: unknown) => new Response(JSON.stringify({ status: "completed", output: [
  { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] },
] }), { headers: { "content-type": "application/json" } });

async function run(text: string, primary: RunningSemanticIntentV2, secondary = review(primary)) {
  const stages: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const name = JSON.parse(String(init?.body)).text.format.name;
    stages.push(name);
    if (name === "running_semantic_intent_v2") return response(primary);
    if (name === "running_semantic_review_v2") return response(secondary);
    throw new Error("Unexpected stage; mock has no network fallback");
  });
  const extraction = await extractRunningSemanticIntentV2({ requestText: text, exercises: [] }, { apiKey: "mock-only", fetchImpl });
  expect(extraction.ok).toBe(true);
  if (!extraction.ok) throw new Error("Unexpected mocked transport failure");
  const verification = verifyPrimarySemanticIntentV2(text, extraction.interpretation, [], extraction.review);
  return { extraction, verification, stages, fetchImpl };
}

describe("cost-safe primary and selective review orchestration, no live API", () => {
  it.each(["X03", "EV02", "L02", "X43", "X44", "X45", "X39", "X40", "X49", "CH02", "NEG03"])("%s uses no second review", async id => {
    const item = corpus.find(x => x.id === id)!;
    const record = recorded.corpus.find(x => x.id === id)!;
    const result = await run(item.input, record.primary as RunningSemanticIntentV2, record.semanticReview as SemanticReviewV2);
    expect(result.verification.ok).toBe(true);
    expect(result.stages).toEqual(["running_semantic_intent_v2"]);
  });

  it("routes an active safety escalation, but not a superseded escalation", async () => {
    const text = "今日は体調が悪い";
    const primary = intent([{ ...claim("FATIGUE", "STRONG_OR_UNWELL", text),
      safetyConcernEvidence: { basis: "ILLNESS_OR_INJURY", sourceText: text } }]);
    expect(verifyPrimarySemanticIntentV2(text, primary, [])).toMatchObject({ reason: "SEMANTIC_REVIEW_REQUIRED", triggers: ["SAFETY_ESCALATION"] });
    const result = await run(text, primary, { ...review(primary), safetyAssessments: [
      { index: 0, basis: "ILLNESS_OR_INJURY", sourceText: text },
    ] });
    expect(result.stages).toEqual(["running_semantic_intent_v2", "running_semantic_review_v2"]);
    expect(result.verification.ok).toBe(true);
    const negated = intent([{ ...primary.claims[0], polarity: "NEGATED" }]);
    expect((await run(text, negated)).stages).toHaveLength(1);
    const corrected = intent([{ ...primary.claims[0], status: "SUPERSEDED" }, claim("FATIGUE", "NOT_FATIGUED", "今は元気")],
      { corrections: [{ supersededClaimIndex: 0, finalClaimIndex: 1, sourceText: "今日は体調が悪い、いや今は元気" }] });
    expect((await run("今日は体調が悪い、いや今は元気", corrected)).stages).toHaveLength(1);
  });

  it("does not escalate normal fatigue emphasis or ordinary adjectives", async () => {
    for (const id of ["CH10", "PAIR02", "PAIR04"]) {
      const item = corpus.find(x => x.id === id)!;
      expect((await run(item.input, recorded.corpus.find(x => x.id === id)!.primary as RunningSemanticIntentV2)).stages).toHaveLength(1);
    }
  });

  it("reviews unresolved semantic contradictions without allowing review to rewrite the primary", async () => {
    const text = "疲れてる。疲れてない";
    const primary = intent([claim("FATIGUE", "FATIGUED", "疲れてる"), claim("FATIGUE", "NOT_FATIGUED", "疲れてない")]);
    expect(verifyPrimarySemanticIntentV2(text, primary, [])).toMatchObject({ reason: "SEMANTIC_REVIEW_REQUIRED", triggers: ["UNRESOLVED_SEMANTIC_CONTRADICTION"] });
    const result = await run(text, primary);
    expect(result.stages).toHaveLength(2);
    expect(result.verification).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("returns a grounded ambiguity directly to clarification", async () => {
    const primary = intent([], { requestKind: "AMBIGUOUS", ambiguity: { sourceText: "200", question: "種目ですか、練習の距離ですか？" } });
    const result = await run("200", primary);
    expect(result.verification).toMatchObject({ ok: false, reason: "AMBIGUOUS" });
    expect(result.stages).toHaveLength(1);
    expect(verifyPrimarySemanticIntentV2("200", intent([]), [])).toMatchObject({ ok: false, reason: "AMBIGUOUS" });
  });

  it.each([
    ["長いのは嫌", "DISTANCE_PREFERENCE", "LONG"],
    ["疲れてへん", "FATIGUE", "FATIGUED"],
    ["軽めにはしない", "LOAD_REDUCTION", true],
  ] as const)("rejects a contradicted primary claim after selective review: %s", async (text, field, value) => {
    const primary = intent([claim(field, value, text)]);
    const result = await run(text, primary, review(primary, false));
    expect(result.stages).toHaveLength(2);
    expect(result.verification).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it.each([["長いのは嫌", "LONG"], ["短いのは嫌", "SHORT"]] as const)("retains a negative constraint without creating an opposite preference: %s", async (text, value) => {
    const primary = intent([{ ...claim("DISTANCE_PREFERENCE", value, text), polarity: "NEGATED" }]);
    const result = await run(text, primary);
    expect(result.stages).toHaveLength(1);
    expect(result.verification).toMatchObject({ ok: true, engineIntent: { distancePreference: null },
      interpretation: { unsupportedIntents: [{ sourceText: text }] } });
  });

  it.each([
    ["あと3日", "REPS", 3, "3", "DAY"], ["中2", "REPS", 2, "2", "NONE"],
    ["高1", "REPS", 1, "1", "NONE"], ["3セット", "REPS", 3, "3", "SET"],
    ["小5", "REPS", 5, "5", "NONE"], ["休憩3分", "TRAINING_DISTANCE", 3, "3", "MINUTE"],
    ["３セット", "REPS", 3, "３", "SET"],
    ["200mを2本", "EVENT", "200m", "200", "METER"],
    ["200出る", "EVENT", "100m", "200", "NONE"],
    ["今日は短め", "TRAINING_DISTANCE", 60, "短め", "NONE"],
    ["今日は短め", "EVENT", "200m", "短め", "NONE"],
    ["今日は短め", "REPS", 3, "短め", "NONE"],
    ["今日は短め", "REST", 180, "短め", "NONE"],
    ["今日は短め", "AVAILABLE_TIME", 1800, "短め", "NONE"],
  ] as const)("rejects numeric fabrication before any second stage: %s", async (text, field, value, rawText, unit) => {
    const result = await run(text, intent([claim(field, value, text, [{ rawText, unit }])]));
    expect(result.verification).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    expect(result.stages).toHaveLength(1);
  });

  it("rejects an unresolved event/training role after review", async () => {
    const text = "200mのレース";
    const primary = intent([claim("TRAINING_DISTANCE", 200, text, [{ rawText: "200", unit: "METER" }])]);
    const result = await run(text, primary, review(primary, false));
    expect(result.stages).toHaveLength(2);
    expect(result.verification.ok).toBe(false);
  });

  it("rejects forged correction links and cross-role reuse despite favorable review", async () => {
    const text = "100m、60m";
    const primary = intent([claim("EVENT", "100m", "100m", [{ rawText: "100", unit: "METER" }]),
      { ...claim("TRAINING_DISTANCE", 60, "60m", [{ rawText: "60", unit: "METER" }]), status: "SUPERSEDED" }],
      { corrections: [{ supersededClaimIndex: 1, finalClaimIndex: 0, sourceText: text }] });
    expect((await run(text, primary)).verification).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    const reused = intent([claim("EVENT", "100m", "100m", [{ rawText: "100", unit: "METER" }]), claim("TRAINING_DISTANCE", 100, "100m", [{ rawText: "100", unit: "METER" }])]);
    expect(verifyPrimarySemanticIntentV2("100m", reused, [], review(reused))).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("rejects omitted explicit distance/count and cropped numeral evidence", async () => {
    const primary = intent([claim("EVENT", "100m", "100m選手", [{ rawText: "100", unit: "METER" }])]);
    expect(verifyPrimarySemanticIntentV2("100m選手。今日は50mを4本", primary, []))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    const cropped = intent([claim("EVENT", "3m", "3出る", [{ rawText: "3", unit: "NONE" }])]);
    expect(verifyPrimarySemanticIntentV2("1003出る", cropped, []))
      .toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
  });

  it("keeps the future smoke plan bounded and non-executable", () => {
    const plan = RUNNING_INTENT_SMOKE_PLAN;
    expect(plan.liveExecutionAllowedThisPhase).toBe(false);
    expect(plan.model).toBe("gpt-6-luna");
    expect(plan.cases).toHaveLength(5);
    expect(plan.repeatPerInput).toBe(1);
    expect(plan.cases.reduce((sum, c) => sum + c.plannedStages, 0)).toBe(plan.plannedRequests);
    expect(plan.apiRequestHardCap).toBe(8);
    expect(plan.maximumRequestsWithoutBudgetEnforcement).toBe(20);
    expect(plan.solRequests).toBe(0);
    expect(plan.requiresRequestCountReportBeforeExecution).toBe(true);
  });

  it("keeps transport recovery bounded and does not run a secondary stage after exhaustion", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("mock transport failure"));
    expect(await extractRunningSemanticIntentV2({ requestText: "中学生100m", exercises: [] }, { apiKey: "mock-only", fetchImpl }))
      .toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("runs 100 normal requests with 100 primary calls and zero secondary calls", async () => {
    let primaryCalls = 0, secondaryCalls = 0;
    for (let index = 0; index < 100; index++) {
      const event = index % 2 ? "200m" : "100m";
      const reps = index % 3 + 2;
      const text = `中学生${event}選手。今日は60mを${reps}本`;
      const primary = intent([claim("AGE_GROUP", "JUNIOR_HIGH", "中学生"),
        claim("EVENT", event, `${event}選手`, [{ rawText: event.slice(0, -1), unit: "METER" }]),
        claim("RUNNING_REQUEST", true, `今日は60mを${reps}本`),
        claim("TRAINING_DISTANCE", 60, `60mを${reps}本`, [{ rawText: "60", unit: "METER" }]),
        claim("REPS", reps, `${reps}本`, [{ rawText: String(reps), unit: "REP" }])]);
      const result = await run(text, primary);
      expect(result.verification.ok).toBe(true);
      primaryCalls += result.stages.filter(x => x === "running_semantic_intent_v2").length;
      secondaryCalls += result.stages.filter(x => x === "running_semantic_review_v2").length;
    }
    expect({ primaryCalls, secondaryCalls, average: (primaryCalls + secondaryCalls) / 100 }).toEqual({ primaryCalls: 100, secondaryCalls: 0, average: 1 });
  });
});

describe("saved primary responses replayed through the production fast path", () => {
  it("replays the original multiline sentence three times without invented numeric intent", async () => {
    const text = ORIGINAL_RUNNING_INTENT_SENTENCE;
    const record = recorded.corpus.find(c => c.id === "M01")!;
    for (let repeat = 0; repeat < 3; repeat++) {
      const result = await run(text, record.primary as RunningSemanticIntentV2);
      expect(result.verification.ok).toBe(true);
      if (!result.verification.ok) throw new Error("Original sentence rejected");
      const x = result.verification.engineIntent;
      expect(x).toMatchObject({ event: { value: "200m" }, ageGroup: { value: "JUNIOR_HIGH" },
        explicitDistances: [], humanExplicitReps: null, humanExplicitRestSeconds: null, loadReductionRequested: null });
      expect(result.verification.interpretation.unsupportedIntents).not.toHaveLength(0);
      expect(createRunningMenuPreview(x, {}, text)).toMatchObject({ status: "READY",
        prescription: { distanceMeters: 120, totalReps: 3, repRestSeconds: 900 } });
      expect(result.stages).toHaveLength(1);
    }
  });

  async function replay(record: { id: string; primary: unknown; semanticReview: unknown }) {
    const item = corpus.find(x => x.id === record.id)!;
    const migrated = prepareRecordedSafetyReplay(record);
    const result = await run(item.input, migrated.primary as RunningSemanticIntentV2, migrated.semanticReview as SemanticReviewV2);
    expect(result.stages).not.toContain("running_bare_numeric_role_v2");
    if (item.expectedAmbiguity) {
      expect(result.verification).toMatchObject({ ok: false, reason: "AMBIGUOUS" });
      expect(result.stages).toHaveLength(1);
      return;
    }
    expect(result.verification.ok).toBe(true);
    if (!result.verification.ok) return;
    const active = result.verification.interpretation.claims.filter(c => c.status === "ACTIVE" && c.polarity === "AFFIRMED" && c.temporalScope !== "PAST");
    const one = (field: Claim["field"]) => active.find(c => c.field === field)?.value ?? null;
    expect({ event: one("EVENT"), ageGroup: one("AGE_GROUP"),
      explicitDistances: active.filter(c => c.field === "TRAINING_DISTANCE").map(c => c.value),
      humanExplicitReps: one("REPS"), humanExplicitRestSeconds: one("REST"),
      availableTimeSeconds: one("AVAILABLE_TIME"), distancePreference: one("DISTANCE_PREFERENCE"),
      loadReductionRequested: one("LOAD_REDUCTION") === true, fatigueState: one("FATIGUE") })
      .toEqual(item.expectedSemanticFields);
    if ("expectedSemanticClaims" in item && item.expectedSemanticClaims) {
      expect(active.some(c => c.field === "LOAD_REDUCTION" && c.value === item.expectedSemanticClaims.loadReductionRequested)).toBe(true);
    }
    const x = result.verification.engineIntent;
    expect({ event: x.event?.value ?? null, ageGroup: x.ageGroup?.value ?? null,
      explicitDistances: x.explicitDistances.map(d => d.value), humanExplicitReps: x.humanExplicitReps?.value ?? null,
      humanExplicitRestSeconds: x.humanExplicitRestSeconds?.value ?? null, availableTimeSeconds: x.availableTimeSeconds?.value ?? null,
      distancePreference: x.distancePreference?.value ?? null, loadReductionRequested: x.loadReductionRequested?.value ?? false,
      fatigueState: x.fatigueState?.value ?? null }).toEqual(item.expectedEngineAdapterFields);
    for (const fragment of item.expectedUnsupportedIntents) {
      expect(result.verification.interpretation.unsupportedIntents.some(u => u.sourceText.includes(fragment))).toBe(true);
    }
    if (item.id === "M01" || item.id === "X55") expect(createRunningMenuPreview(x, {}, item.input))
      .toMatchObject({ status: "READY", prescription: { distanceMeters: 120, totalReps: 3, repRestSeconds: 900 } });
  }
  it.each(recorded.corpus)("corpus $id", replay);
  it.each(recorded.highRisk)("high-risk $id repeat $repetition", replay);
});
