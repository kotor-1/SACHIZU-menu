import { describe, expect, it, vi } from "vitest";
import {
  verifyPrimarySemanticIntentV2, type RunningSemanticIntentV2, type SemanticReviewV2,
} from "@/application/running-menu/semantic-intent-v2";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import {
  extractRunningSemanticIntentV2, SEMANTIC_INTENT_V2_OUTPUT_SCHEMA, SEMANTIC_REVIEW_V2_OUTPUT_SCHEMA,
} from "@/infra/running-menu/openai-semantic-intent-v2";
import regression from "@/../tests/fixtures/running-intent-v2-safety-regression.json";
import lunaFailure from "@/../tests/fixtures/running-intent-v2-luna-fatigue-escalation.json";
import recorded from "@/../tests/fixtures/running-intent-v2-recorded-responses.json";
import { prepareRecordedSafetyReplay } from "@/../scripts/running-intent-replay-safety";

type Claim = RunningSemanticIntentV2["claims"][number];
const claim = (field: Claim["field"], value: Claim["value"], sourceText: string, numericParts: Claim["numericParts"] = []): Claim =>
  ({ field, value, sourceText, numericParts, status: "ACTIVE", polarity: "AFFIRMED", temporalScope: "CURRENT", safetyConcernEvidence: null });
const intent = (claims: Claim[], extra: Partial<RunningSemanticIntentV2> = {}): RunningSemanticIntentV2 =>
  ({ interpreterVersion: "running-intent-v2", requestKind: "RUNNING", claims, corrections: [], unsupportedIntents: [], ambiguity: null, exerciseIds: [], ...extra });
const review = (primary: RunningSemanticIntentV2): SemanticReviewV2 => ({
  assessments: primary.claims.map((_, index) => ({ index, supported: true })),
  activeClaimIndexes: primary.claims.flatMap((c, index) => c.status === "ACTIVE" ? [index] : []),
  requestKindSupported: true, missingCriticalClaim: false, ambiguityCorrect: true,
  unsupportedIntentsSupported: true, correctionsSupported: true,
  safetyAssessments: primary.claims.flatMap((c, index) => c.field === "FATIGUE" && c.value === "STRONG_OR_UNWELL" &&
    c.status === "ACTIVE" && c.temporalScope !== "PAST" ? [{ index,
      basis: c.safetyConcernEvidence?.basis ?? "UNSUPPORTED", sourceText: c.safetyConcernEvidence?.sourceText ?? null }] : []),
});
const response = (value: unknown) => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant",
  content: [{ type: "output_text", text: JSON.stringify(value) }] }] }), { headers: { "content-type": "application/json" } });

async function run(text: string, primary: RunningSemanticIntentV2, secondary: SemanticReviewV2 = review(primary)) {
  const stages: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const stage = JSON.parse(String(init?.body)).text.format.name;
    stages.push(stage);
    if (stage === "running_semantic_intent_v2") return response(primary);
    if (stage === "running_semantic_review_v2") return response(secondary);
    throw new Error("Unknown mock stage; live network fallback forbidden");
  });
  const extraction = await extractRunningSemanticIntentV2({ requestText: text, exercises: [] }, { apiKey: "mock-only", fetchImpl });
  if (!extraction.ok) throw new Error("Unexpected mocked transport failure");
  return { extraction, stages, verification: verifyPrimarySemanticIntentV2(text, extraction.interpretation, [], extraction.review) };
}

function fixturePrimary(item: typeof regression.cases[number]): RunningSemanticIntentV2 {
  const claims = [claim("AGE_GROUP", "JUNIOR_HIGH", "中学生200m選手"),
    claim("EVENT", "200m", "中学生200m選手", [{ rawText: "200", unit: "METER" }]),
    claim("RUNNING_REQUEST", true, "今日のメニューを作って"),
    { ...claim("FATIGUE", item.fatigueValue, item.fatigueSource),
      safetyConcernEvidence: item.safetyConcernEvidence as Claim["safetyConcernEvidence"] }];
  if (item.loadReduction) claims.push(claim("LOAD_REDUCTION", item.loadReduction.value, item.loadReduction.sourceText));
  return intent(claims);
}

describe("fatigue intensity and safety evidence are separate semantic axes, offline only", () => {
  it.each(regression.cases)("$id: validates the semantic contract and existing policy behavior", async item => {
    const primary = fixturePrimary(item);
    const result = await run(item.input, primary);
    expect(result.verification.ok).toBe(true);
    if (!result.verification.ok) throw new Error("Offline safety fixture rejected");
    const x = result.verification.engineIntent;
    expect(x.loadReductionRequested?.value ?? false).toBe(item.loadReduction?.value ?? false);
    expect(x.fatigueState?.value ?? null).toBe(item.fatigueValue === "FATIGUED" ? "REPORTED"
      : item.fatigueValue === "NOT_FATIGUED" ? null : "STRONG_OR_UNWELL");
    const engine = createRunningMenuPreview(x, {}, item.input);
    if (item.safetyConcernEvidence) {
      expect(result.stages).toHaveLength(2);
      expect(engine).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "STRONG_FATIGUE_OR_UNWELL" });
      const evidence = result.verification.interpretation.claims[3].safetyConcernEvidence!;
      expect(evidence).toMatchObject({ sourceType: "USER_TEXT", basis: item.safetyConcernEvidence.basis });
      expect(item.input.slice(evidence.start, evidence.end)).toBe(item.safetyConcernEvidence.sourceText);
    } else {
      expect(result.stages).toEqual(["running_semantic_intent_v2"]);
      expect(engine).toMatchObject({ status: "READY", prescription: {
        distanceMeters: 120, totalReps: item.loadReduction?.value ? 2 : 3, repRestSeconds: 900,
      } });
    }
  });

  it("rejects the exact recorded Luna CASE7 despite the two original models agreeing, retaining the load request", async () => {
    const primary = lunaFailure.primary as RunningSemanticIntentV2;
    const secondary = lunaFailure.semanticReview as SemanticReviewV2;
    const verdict = verifyPrimarySemanticIntentV2(lunaFailure.input, primary, [], secondary);
    expect(verdict).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM", issue: "SAFETY_EVIDENCE_REQUIRED",
      retainedClaims: expect.arrayContaining([expect.objectContaining({ field: "LOAD_REDUCTION", value: true })]) });
    expect(verdict).not.toHaveProperty("engineIntent");
    const result = await run(lunaFailure.input, primary, secondary);
    expect(result.stages).toHaveLength(1); // An invalid proof is not retried or sent to another model.
    expect(result.extraction.interpretation.claims).toContainEqual(expect.objectContaining({ field: "LOAD_REDUCTION", value: true }));
    expect(result.verification.ok).toBe(false);
  });

  it.each(["B_INTENSE", "C_DIALECT_REDUCTION", "CASE7_FULL"])("rejects fabricated escalation with no safety evidence: %s", async id => {
    const item = regression.cases.find(c => c.id === id)!;
    const primary = fixturePrimary(item);
    primary.claims[3].value = "STRONG_OR_UNWELL";
    const result = await run(item.input, primary);
    expect(result.verification).toMatchObject({ ok: false, issue: "SAFETY_EVIDENCE_REQUIRED" });
    expect(result.stages).toHaveLength(1);
    if (item.loadReduction) expect(result.verification).toMatchObject({ retainedClaims:
      expect.arrayContaining([expect.objectContaining({ field: "LOAD_REDUCTION", value: true })]) });
  });

  it("rejects fatigue intensity as safety evidence even when primary and review mark everything supported", () => {
    const item = regression.cases.find(c => c.id === "B_INTENSE")!;
    const primary = fixturePrimary(item);
    primary.claims[3] = { ...primary.claims[3], value: "STRONG_OR_UNWELL",
      safetyConcernEvidence: { basis: "FATIGUE_INTENSITY_ONLY", sourceText: item.fatigueSource } };
    expect(verifyPrimarySemanticIntentV2(item.input, primary, [], review(primary)))
      .toMatchObject({ ok: false, issue: "INVALID_SAFETY_EVIDENCE" });
  });

  it.each(["FATIGUE_INTENSITY_ONLY", "UNSUPPORTED"] as const)("rejects selective review that identifies %s despite generic support=true", async basis => {
    const item = regression.cases.find(c => c.id === "FEVER")!;
    const primary = fixturePrimary(item);
    const secondary = { ...review(primary), safetyAssessments: [{ index: 3, basis, sourceText: item.fatigueSource }] };
    const result = await run(item.input, primary, secondary);
    expect(result.stages).toHaveLength(2);
    expect(result.verification).toMatchObject({ ok: false, issue: "SAFETY_REVIEW_REJECTED" });
  });

  it("requires a separate safety review assessment and grounded quote, not just supported=true", () => {
    const item = regression.cases.find(c => c.id === "FEVER")!;
    const primary = fixturePrimary(item);
    for (const assessments of [undefined, [], [{ index: 3, basis: "ILLNESS_OR_INJURY", sourceText: "原文にない症状" }],
      [{ index: 2, basis: "ILLNESS_OR_INJURY", sourceText: item.fatigueSource }],
      [{ index: 3, basis: "ILLNESS_OR_INJURY", sourceText: item.fatigueSource }, { index: 3, basis: "ILLNESS_OR_INJURY", sourceText: item.fatigueSource }]]) {
      expect(verifyPrimarySemanticIntentV2(item.input, primary, [],
        { ...review(primary), safetyAssessments: assessments as SemanticReviewV2["safetyAssessments"] }))
        .toMatchObject({ ok: false, issue: "SAFETY_REVIEW_REJECTED" });
    }
  });

  it("retains a grounded load request when review rejects only the safety claim", () => {
    const item = regression.cases.find(c => c.id === "CASE7_FULL")!;
    const primary = fixturePrimary(item);
    primary.claims[3] = { ...primary.claims[3], value: "STRONG_OR_UNWELL",
      safetyConcernEvidence: { basis: "ILLNESS_OR_INJURY", sourceText: item.fatigueSource } };
    const secondary = review(primary);
    secondary.assessments[3].supported = false;
    secondary.safetyAssessments = [{ index: 3, basis: "FATIGUE_INTENSITY_ONLY", sourceText: item.fatigueSource }];
    expect(verifyPrimarySemanticIntentV2(item.input, primary, [], secondary)).toMatchObject({ ok: false,
      issue: "SAFETY_REVIEW_REJECTED", retainedClaims: expect.arrayContaining([
        expect.objectContaining({ field: "LOAD_REDUCTION", value: true }),
      ]) });
  });

  it("rejects invented or unrelated evidence and evidence attached to an ordinary field", () => {
    const item = regression.cases.find(c => c.id === "FEVER")!;
    for (const sourceText of ["痛みがある", "中学生200m選手", " "]) {
      const primary = fixturePrimary(item);
      primary.claims[3].safetyConcernEvidence = { basis: "ILLNESS_OR_INJURY", sourceText };
      expect(verifyPrimarySemanticIntentV2(item.input, primary, [], review(primary))).toMatchObject({ ok: false, reason: "INVALID_AI_CLAIM" });
    }
    const primary = fixturePrimary(item);
    primary.claims[3].value = "FATIGUED";
    expect(verifyPrimarySemanticIntentV2(item.input, primary, [])).toMatchObject({ ok: false, issue: "INVALID_SAFETY_EVIDENCE" });
  });

  it("does not turn a desired safety state into a current safety escalation", () => {
    const item = regression.cases.find(c => c.id === "FEVER")!;
    const primary = fixturePrimary(item);
    primary.claims[3].temporalScope = "DESIRED";
    expect(verifyPrimarySemanticIntentV2(item.input, primary, [], review(primary))).toMatchObject({ ok: false, issue: "INVALID_SAFETY_EVIDENCE" });
  });

  it("makes the legacy X53 migration explicit and rejects the unchanged evidence-free legacy response", () => {
    const source = recorded.corpus.find(c => c.id === "X53")!;
    const text = "中学生100m選手。走れないほど体調が悪い";
    expect(verifyPrimarySemanticIntentV2(text, source.primary, [], source.semanticReview as SemanticReviewV2))
      .toMatchObject({ ok: false, issue: "SAFETY_EVIDENCE_REQUIRED" });
    const migrated = prepareRecordedSafetyReplay(source);
    expect(migrated.contractMigration).toEqual({ id: "X53", measurementKind: "OFFLINE_CONTRACT_MIGRATION" });
    expect(verifyPrimarySemanticIntentV2(text, migrated.primary, [], migrated.semanticReview as SemanticReviewV2).ok).toBe(true);
    expect(source.primary.claims[2]).not.toHaveProperty("safetyConcernEvidence");
    expect(() => prepareRecordedSafetyReplay({ ...source, primary: { ...source.primary, requestKind: "AMBIGUOUS" } })).toThrow("source changed");
  });

  it("requires evidence in the provider schema and explicit safety classification in the review schema", () => {
    expect(SEMANTIC_INTENT_V2_OUTPUT_SCHEMA.properties.claims.items.required).toContain("safetyConcernEvidence");
    expect(SEMANTIC_REVIEW_V2_OUTPUT_SCHEMA.required).toContain("safetyAssessments");
  });
});

describe("CASE5 conservative role binding", () => {
  const text = "100m選手。60mで、いや50mを走りたい";
  const correction = "60mで、いや50mを走りたい";
  const primary = () => intent([claim("EVENT", "100m", "100m選手。", [{ rawText: "100m", unit: "METER" }]),
    { ...claim("TRAINING_DISTANCE", 60, correction, [{ rawText: "60m", unit: "METER" }]), status: "SUPERSEDED" },
    claim("TRAINING_DISTANCE", 50, correction, [{ rawText: "50m", unit: "METER" }])],
    { corrections: [{ supersededClaimIndex: 1, finalClaimIndex: 2, sourceText: correction }] });

  it("keeps review when only the distance-role label and correction are present", async () => {
    expect(verifyPrimarySemanticIntentV2(text, primary(), [])).toMatchObject({ reason: "SEMANTIC_REVIEW_REQUIRED", triggers: ["UNBOUND_DISTANCE_ROLE"] });
    const result = await run(text, primary());
    expect(result.stages).toHaveLength(2);
    expect(result.verification).toMatchObject({ ok: true, engineIntent: { explicitDistances: [{ value: 50 }] } });
    if (result.verification.ok) expect(createRunningMenuPreview(result.verification.engineIntent, {}, text)).toMatchObject({ status: "NEEDS_INPUT" });
  });

  it("uses one call when the primary supplies the grounded running-request role witness", async () => {
    const p = primary();
    p.claims.push(claim("RUNNING_REQUEST", true, "50mを走りたい"));
    const result = await run(text, p);
    expect(result.stages).toHaveLength(1);
    expect(result.verification).toMatchObject({ ok: true, engineIntent: { explicitDistances: [{ value: 50 }] } });
  });
});
