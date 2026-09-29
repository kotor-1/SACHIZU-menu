/** Read-only, real API acceptance check. Run with an isolated database environment. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractRunningSemanticIntentV2 } from "../src/infra/running-menu/openai-semantic-intent-v2";
import { verifySemanticIntentV2 } from "../src/application/running-menu/semantic-intent-v2";

type Expected = {
  event: string | null; ageGroup: string | null; explicitDistances: number[];
  humanExplicitReps: number | null; humanExplicitRestSeconds: number | null;
  availableTimeSeconds: number | null; distancePreference: string | null;
  loadReductionRequested: boolean; fatigueState: string | null;
};
type Case = { id: string; category: string; input: string; expectedSemanticFields: Expected;
  expectedEngineAdapterFields: Expected; expectedUnsupportedIntents: string[];
  expectedSemanticClaims?: { loadReductionRequested?: boolean };
  expectedAmbiguity: boolean; expectedVerifierResult: string };

const corpus = JSON.parse(readFileSync(resolve("tests/fixtures/running-intent-v2-corpus.json"), "utf8")) as Case[];
const defaultIds = ["A01", "EV02", "EV04", "J01", "L01", "L02", "D02", "D04", "CH05", "CH06", "CH09", "CH13", "N01", "N03", "NEG02", "NEG03", "AMB01", "M01", "PAIR02", "AGE01", "X08", "X35", "X41", "X43", "X45", "X48"];
const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultIds;
const cases = ids.includes("ALL") ? corpus : ids.map((id) => corpus.find((item) => item.id === id)).filter((item): item is Case => item !== undefined);
const stats = { realApiCases: 0, semanticCorrect: 0, falseRejection: 0, falseAcceptance: 0,
  numericRoleError: 0, negationError: 0, unnecessaryClarification: 0, unsupportedIntentLost: 0, apiFailure: 0 };

async function evaluate(item: Case) {
  let extracted = await extractRunningSemanticIntentV2({ requestText: item.input, exercises: [] }, { model: "gpt-6-luna" });
  if (!extracted.ok) { stats.apiFailure++; return { id: item.id, result: extracted.reason }; }
  stats.realApiCases++;
  let verification = verifySemanticIntentV2(item.input, extracted.interpretation, extracted.review, extracted.numericRoleReview, []);
  if (!verification.ok && verification.reason === "INVALID_AI_CLAIM") {
    const retry = await extractRunningSemanticIntentV2({ requestText: item.input, exercises: [] }, { model: "gpt-6-luna" });
    if (retry.ok) {
      extracted = retry;
      verification = verifySemanticIntentV2(item.input, retry.interpretation, retry.review, retry.numericRoleReview, []);
    }
  }
  const actual: Expected | null = verification.ok ? {
    event: verification.engineIntent.event?.value ?? null,
    ageGroup: verification.engineIntent.ageGroup?.value ?? null,
    explicitDistances: verification.engineIntent.explicitDistances.map((claim) => claim.value),
    humanExplicitReps: verification.engineIntent.humanExplicitReps?.value ?? null,
    humanExplicitRestSeconds: verification.engineIntent.humanExplicitRestSeconds?.value ?? null,
    availableTimeSeconds: verification.engineIntent.availableTimeSeconds?.value ?? null,
    distancePreference: verification.engineIntent.distancePreference?.value ?? null,
    loadReductionRequested: verification.engineIntent.loadReductionRequested?.value ?? false,
    fatigueState: verification.engineIntent.fatigueState?.value ?? null,
  } : null;
  const activeFatigue = verification.ok ? verification.interpretation.claims.find((claim) => claim.field === "FATIGUE" && claim.status === "ACTIVE" && claim.polarity === "AFFIRMED") : undefined;
  const actualSemantic = actual ? { ...actual, fatigueState: typeof activeFatigue?.value === "string" ? activeFatigue.value : null } : null;
  const activeLoad = verification.ok ? verification.interpretation.claims.find((claim) => claim.field === "LOAD_REDUCTION" && claim.status === "ACTIVE" && claim.polarity === "AFFIRMED") : undefined;
  const expected = item.expectedSemanticFields;
  const semanticMismatches = actualSemantic ? (Object.keys(expected) as (keyof Expected)[]).filter((key) => JSON.stringify(actualSemantic[key]) !== JSON.stringify(expected[key])) : [];
  const adapterMismatches = actual ? (Object.keys(item.expectedEngineAdapterFields) as (keyof Expected)[]).filter((key) => JSON.stringify(actual[key]) !== JSON.stringify(item.expectedEngineAdapterFields[key])) : [];
  const mismatches: string[] = [...new Set([...semanticMismatches, ...adapterMismatches])];
  if (verification.ok && item.expectedSemanticClaims?.loadReductionRequested !== undefined &&
    activeLoad?.value !== item.expectedSemanticClaims.loadReductionRequested) mismatches.push("explicitLoadReduction");
  const actualUnsupported = verification.ok ? verification.interpretation.unsupportedIntents : extracted.interpretation.unsupportedIntents;
  // A clarification has not produced a final interpretation; the request text
  // remains available for the next turn. Measure loss only in accepted output.
  const unsupportedLost = verification.ok && item.expectedUnsupportedIntents.some((fragment) => !actualUnsupported.some((intent) => intent.sourceText.includes(fragment)));
  const unexpectedUnsupported = verification.ok && item.expectedUnsupportedIntents.length === 0 && actualUnsupported.length > 0;
  if (unsupportedLost) stats.unsupportedIntentLost++;
  const unexpectedAmbiguity = !item.expectedAmbiguity && !verification.ok && verification.reason === "AMBIGUOUS";
  if (unexpectedAmbiguity) stats.unnecessaryClarification++;
  if (!verification.ok && (!item.expectedAmbiguity || verification.reason !== "AMBIGUOUS")) stats.falseRejection++;
  if (verification.ok && (item.expectedAmbiguity || mismatches.length > 0 || unsupportedLost || unexpectedUnsupported)) stats.falseAcceptance++;
  if (mismatches.some((field) => ["explicitDistances", "humanExplicitReps", "humanExplicitRestSeconds", "availableTimeSeconds"].includes(field))) stats.numericRoleError++;
  if (["negation", "correction", "current-desired", "kansai", "kyushu", "chugoku", "tohoku"].includes(item.category) && mismatches.some((field) => ["distancePreference", "loadReductionRequested", "fatigueState", "explicitLoadReduction"].includes(field))) stats.negationError++;
  if ((item.expectedAmbiguity && !verification.ok && verification.reason === "AMBIGUOUS") || (!item.expectedAmbiguity && verification.ok && mismatches.length === 0 && !unsupportedLost && !unexpectedUnsupported)) stats.semanticCorrect++;
  return { id: item.id, result: verification.ok ? "ACCEPT" : verification.reason, mismatches,
    actual: actualSemantic, adapter: actual, expected, unsupportedLost, unexpectedUnsupported, actualUnsupported,
    numericRoleReview: extracted.numericRoleReview,
    claims: extracted.interpretation.claims.map(({ field, value, sourceText, numericParts }) => ({ field, value, sourceText, numericParts })),
    review: verification.ok ? undefined : extracted.review };
}

async function main() {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, cases.length) }, async () => {
    while (cursor < cases.length) {
      const index = cursor++;
      const result = await evaluate(cases[index]);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }));
  process.stdout.write(`METRICS ${JSON.stringify(stats)}\n`);
}
void main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
