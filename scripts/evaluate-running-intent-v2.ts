/** Recorded-response replay only. This command never loads API credentials or uses native fetch. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { extractRunningSemanticIntentV2 } from "../src/infra/running-menu/openai-semantic-intent-v2";
import { runningSemanticClientConfig, type RunningSemanticClientOptions, type RunningResponseDiagnostic } from "../src/infra/running-menu/structured-response";
import { verifyPrimarySemanticIntentV2, type SemanticClaimV2 } from "../src/application/running-menu/semantic-intent-v2";
import { createRunningMenuPreview } from "../src/application/running-menu/preview";
import type { VerifiedRunningIntent } from "../src/application/running-menu/intent";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "../src/domain/running-policy";

type Fields = {
  event: string | null; ageGroup: string | null; explicitDistances: number[];
  humanExplicitReps: number | null; humanExplicitRestSeconds: number | null;
  availableTimeSeconds: number | null; distancePreference: string | null;
  loadReductionRequested: boolean; fatigueState: string | null;
};
type Case = {
  id: string; category: string; input: string; expectedSemanticFields: Fields;
  expectedEngineAdapterFields: Fields; expectedUnsupportedIntents: string[];
  expectedSemanticClaims?: { loadReductionRequested?: boolean };
  expectedAmbiguity: boolean; expectedVerifierResult: string;
};
const args = process.argv.slice(2);
function flag(name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
if (args.includes("--live") || args.includes("--env-root")) throw new Error("Replay only: live API and credential loading are forbidden. Plan smoke requests separately.");
const recorded = JSON.parse(readFileSync(resolve("tests/fixtures/running-intent-v2-recorded-responses.json"), "utf8")) as {
  corpus: { id: string; repetition: number; primary: unknown; semanticReview: unknown }[];
  highRisk: { id: string; repetition: number; primary: unknown; semanticReview: unknown }[];
  provenance: unknown;
};
const requestedEffort = flag("--effort");
if (requestedEffort && !["low", "medium", "high", "xhigh", "max"].includes(requestedEffort)) throw new Error("Invalid effort");
const options: RunningSemanticClientOptions = {
  ...(flag("--model") ? { model: flag("--model") } : {}),
  ...(requestedEffort ? { reasoningEffort: requestedEffort as RunningSemanticClientOptions["reasoningEffort"] } : {}),
  ...(flag("--timeout-ms") ? { timeoutMs: Number(flag("--timeout-ms")) } : {}),
  ...(flag("--max-output-tokens") ? { maxOutputTokens: Number(flag("--max-output-tokens")) } : {}),
};
const config = runningSemanticClientConfig(options);
const corpus: Case[] = JSON.parse(readFileSync(resolve("tests/fixtures/running-intent-v2-corpus.json"), "utf8"));
const focusIds = ["X03", "X45", "X08", "X49"];
const highRiskIds = ["EV02", "EV04", "EV09", "J01", "L01", "L02", "L03", "D02", "D03", "D04", "D07", "CH06", "CH13", "N01", "N02", "N03", "N04", "NEG02", "NEG03", "AMB01", "X35", "X39", "X40", "X41", "X42", "X43", "X44", "X45", "X46", "X48", "X50", "M01", "R02", "R07", "EV05", "CH09", "CH10", "CP01", "CP03", "X09", "X15", "X18", "X22", "X26", "X36", "X03", "X08", "X10", "X11", "X14", "X19", "X21", "X23", "X24", "X31", "X49"];
const mode = flag("--mode") ?? (args.includes("ALL") ? "full" : "focus");
if (!["focus", "full", "high-risk"].includes(mode)) throw new Error("Invalid mode");
const ids = flag("--ids")?.split(",");
const selected = ids ? ids.map(id => {
  const item = corpus.find(x => x.id === id);
  if (!item) throw new Error(`Unknown case ${id}`);
  return item;
}) : mode === "full" ? corpus : corpus.filter(x => (mode === "high-risk" ? highRiskIds : focusIds).includes(x.id));
const repeats = Number(flag("--repeat") ?? "1"), concurrency = Number(flag("--concurrency") ?? "4");
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Invalid bounds");
const jobs = Array.from({ length: repeats }, (_, repeat) => selected.map(item => ({ item, repetition: repeat + 1 }))).flat();
const outputDir = flag("--output-dir") ? resolve(flag("--output-dir")!) : null;
const label = flag("--label") ?? mode;
if (!/^[a-z0-9-]+$/u.test(label)) throw new Error("Invalid label");
if (outputDir) {
  mkdirSync(outputDir, { recursive: true });
  for (const suffix of ["results.jsonl", "transport.jsonl"]) writeFileSync(resolve(outputDir, `${label}-${suffix}`), "", { flag: "wx" });
  writeFileSync(resolve(outputDir, `${label}-metadata.json`), JSON.stringify({ config, mode, repeats, concurrency,
    corpusSize: corpus.length, corpusSHA256: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
    jobs: jobs.map(({ item, repetition }) => ({ id: item.id, repetition })), highRiskIds,
    policyVersion: RUNNING_POLICY_VERSION, policyHash: RUNNING_POLICY_HASH,
    semanticRetryPolicy: "NONE", liveOpenAICalls: 0, measurementKind: "STORED_RESPONSE_REPLAY", responseProvenance: recorded.provenance,
    startedAt: new Date().toISOString() }, null, 2), { flag: "wx" });
}
function semanticFields(claims: readonly SemanticClaimV2[]): Fields {
  const active = claims.filter(x => x.status === "ACTIVE" && x.polarity === "AFFIRMED" && x.temporalScope !== "PAST");
  const one = (field: SemanticClaimV2["field"]) => active.find(x => x.field === field)?.value ?? null;
  return { event: one("EVENT") as string | null, ageGroup: one("AGE_GROUP") as string | null,
    explicitDistances: active.filter(x => x.field === "TRAINING_DISTANCE").map(x => Number(x.value)),
    humanExplicitReps: one("REPS") as number | null, humanExplicitRestSeconds: one("REST") as number | null,
    availableTimeSeconds: one("AVAILABLE_TIME") as number | null, distancePreference: one("DISTANCE_PREFERENCE") as string | null,
    loadReductionRequested: one("LOAD_REDUCTION") === true, fatigueState: one("FATIGUE") as string | null };
}
function adapterFields(intent: VerifiedRunningIntent): Fields {
  return { event: intent.event?.value ?? null, ageGroup: intent.ageGroup?.value ?? null,
    explicitDistances: intent.explicitDistances.map(x => x.value), humanExplicitReps: intent.humanExplicitReps?.value ?? null,
    humanExplicitRestSeconds: intent.humanExplicitRestSeconds?.value ?? null, availableTimeSeconds: intent.availableTimeSeconds?.value ?? null,
    distancePreference: intent.distancePreference?.value ?? null, loadReductionRequested: intent.loadReductionRequested?.value ?? false,
    fatigueState: intent.fatigueState?.value ?? null };
}
const mismatch = (expected: Fields, actual: Fields | null) => actual
  ? (Object.keys(expected) as (keyof Fields)[]).filter(key => JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) : [];
async function evaluate(item: Case, repetition: number) {
  const diagnostics: RunningResponseDiagnostic[] = [];
  const requests: { stage: string; instructionsSHA256: string; model: string; effort: string; maxOutputTokens: number }[] = [];
  const started = Date.now();
  const source = (mode === "high-risk" ? recorded.highRisk : recorded.corpus).find(x => x.id === item.id && x.repetition === repetition)
    ?? recorded.corpus.find(x => x.id === (item.id === "ORIGINAL_MULTILINE" ? "M01" : item.id));
  if (!source) throw new Error("Recorded primary response missing; replay will never fall back to the network.");
  const extraction = await extractRunningSemanticIntentV2({ requestText: item.input, exercises: [] }, { ...options, apiKey: "offline-replay-only",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ stage: body.text.format.name, instructionsSHA256: createHash("sha256").update(body.instructions).digest("hex"),
        model: body.model, effort: body.reasoning.effort, maxOutputTokens: body.max_output_tokens });
      const value = body.text.format.name === "running_semantic_intent_v2" ? source.primary
        : body.text.format.name === "running_semantic_review_v2" ? source.semanticReview : null;
      if (value === null) throw new Error("Unexpected replay stage; no network fallback.");
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(value) }] }] }), { headers: { "content-type": "application/json" } });
    }, onAttempt: diagnostic => {
      diagnostics.push(diagnostic);
      if (outputDir) appendFileSync(resolve(outputDir, `${label}-transport.jsonl`), JSON.stringify({ id: item.id, repetition, ...diagnostic }) + "\n");
    } });
  const verification = extraction.ok ? verifyPrimarySemanticIntentV2(item.input, extraction.interpretation, [], extraction.review) : null;
  const actualSemantic = verification?.ok ? semanticFields(verification.interpretation.claims)
    : extraction.ok ? semanticFields(extraction.interpretation.claims) : null;
  const actualAdapter = verification?.ok ? adapterFields(verification.engineIntent) : null;
  const semanticMismatches: string[] = item.expectedAmbiguity ? [] : mismatch(item.expectedSemanticFields, actualSemantic);
  const adapterMismatches = item.expectedAmbiguity ? [] : mismatch(item.expectedEngineAdapterFields, actualAdapter);
  if (extraction.ok && item.expectedSemanticClaims?.loadReductionRequested !== undefined &&
    !extraction.interpretation.claims.some(x => x.field === "LOAD_REDUCTION" && x.status === "ACTIVE" && x.polarity === "AFFIRMED" &&
      x.value === item.expectedSemanticClaims?.loadReductionRequested)) semanticMismatches.push("explicitLoadReduction");
  const mismatches = [...new Set([...semanticMismatches, ...adapterMismatches])];
  const unsupported = verification?.ok ? verification.interpretation.unsupportedIntents : extraction.ok ? extraction.interpretation.unsupportedIntents : [];
  const unsupportedLost = verification?.ok === true && item.expectedUnsupportedIntents.some(fragment => !unsupported.some(x => x.sourceText.includes(fragment)));
  // Grounded extra background never reaches the engine. Record it without demanding exact paraphrase/array agreement.
  const unexpectedUnsupported = verification?.ok === true && item.expectedUnsupportedIntents.length === 0 && unsupported.length > 0;
  const actualAmbiguity = verification?.ok === false && verification.reason === "AMBIGUOUS";
  const categories: string[] = [];
  if (!extraction.ok) categories.push("API_FAILURE");
  else {
    if (mismatches.length) categories.push("SEMANTIC_MISS");
    if (!verification?.ok && !(item.expectedAmbiguity && actualAmbiguity)) categories.push("FALSE_REJECTION");
    if (!item.expectedAmbiguity && actualAmbiguity) categories.push("UNNECESSARY_CLARIFICATION");
    if (item.expectedAmbiguity && verification?.ok) categories.push("MISSED_CLARIFICATION");
    if (verification?.ok && (item.expectedAmbiguity || mismatches.length || unsupportedLost)) categories.push("FALSE_ACCEPTANCE");
    if (mismatches.some(x => ["explicitDistances", "humanExplicitReps", "humanExplicitRestSeconds", "availableTimeSeconds"].includes(x))) categories.push("NUMERIC_ROLE_ERROR");
    if (mismatches.some(x => ["event", "explicitDistances"].includes(x))) categories.push("EVENT_DISTANCE_ROLE_ERROR");
    if (/negation|kansai|kyushu|chugoku|tohoku|current-desired/.test(item.category) &&
      mismatches.some(x => ["distancePreference", "loadReductionRequested", "fatigueState", "explicitLoadReduction"].includes(x))) categories.push("NEGATION_ERROR");
    if (/correction/.test(item.category) && (mismatches.length || !verification?.ok)) categories.push("CORRECTION_ERROR");
    if (unsupportedLost) categories.push("UNSUPPORTED_INTENT_LOST");
  }
  // X45 omits age. Declare context for its engine check; do not inject it into semantic fields.
  const engineContext = item.id === "X45" ? { ageGroup: "JUNIOR_HIGH" as const } : {};
  const engine = verification?.ok ? createRunningMenuPreview(verification.engineIntent, engineContext, item.input) : null;
  const expectedFocusEngine = item.id === "X03" ? [60, 3, 240] : item.id === "X45" ? [50, 4, 240] : item.id === "X08" ? [60, 4, 240] : null;
  if (expectedFocusEngine && (!engine || engine.status !== "READY" ||
    JSON.stringify([engine.prescription.distanceMeters, engine.prescription.totalReps, engine.prescription.repRestSeconds]) !== JSON.stringify(expectedFocusEngine))) categories.push("ENGINE_MISMATCH");
  if (!categories.length) categories.push("PASS");
  const result = { id: item.id, category: item.category, input: item.input, repetition, categories,
    expectedSemantic: item.expectedSemanticFields, actualSemantic, expectedAdapter: item.expectedEngineAdapterFields, actualAdapter,
    expectedUnsupported: item.expectedUnsupportedIntents, unsupported, unsupportedLost, unexpectedUnsupported,
    expectedAmbiguity: item.expectedAmbiguity, actualAmbiguity, semanticMismatches, adapterMismatches,
    extraction, verification, engineContext, engine, diagnostics, requests, elapsedMs: Date.now() - started };
  if (outputDir) appendFileSync(resolve(outputDir, `${label}-results.jsonl`), JSON.stringify(result) + "\n");
  process.stdout.write(JSON.stringify({ label, id: item.id, repetition, categories, mismatches, elapsedMs: result.elapsedMs }) + "\n");
  return result;
}
async function main() {
  let cursor = 0;
  const results: Awaited<ReturnType<typeof evaluate>>[] = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) { const job = jobs[cursor++]; results.push(await evaluate(job.item, job.repetition)); }
  }));
  const count = (category: string) => results.filter(x => x.categories.includes(category)).length;
  const instability = selected.filter(item => results.filter(x => x.id === item.id).length > 1 &&
    results.some(x => x.id === item.id && !x.categories.includes("PASS") && !x.categories.includes("API_FAILURE"))).map(x => x.id);
  const primaryCalls = results.flatMap(x => x.requests).filter(x => x.stage === "running_semantic_intent_v2").length;
  const secondaryCalls = results.flatMap(x => x.requests).filter(x => x.stage === "running_semantic_review_v2").length;
  const summary = { config, liveOpenAICalls: 0, measurementKind: "STORED_RESPONSE_REPLAY", uniqueCases: selected.length, totalRuns: results.length, semanticCorrect: count("PASS"),
    simulatedPrimaryCalls: primaryCalls, simulatedSecondaryReviewCalls: secondaryCalls,
    simulatedAverageLlmCalls: (primaryCalls + secondaryCalls) / results.length,
    simulatedOneCallFastPathRate: results.filter(x => x.requests.length === 1).length / results.length,
    falseRejection: count("FALSE_REJECTION"), falseAcceptance: count("FALSE_ACCEPTANCE"), numericRoleError: count("NUMERIC_ROLE_ERROR"),
    negationError: count("NEGATION_ERROR"), correctionError: count("CORRECTION_ERROR"), eventDistanceRoleError: count("EVENT_DISTANCE_ROLE_ERROR"),
    unnecessaryClarification: count("UNNECESSARY_CLARIFICATION"), missedClarification: count("MISSED_CLARIFICATION"),
    unsupportedIntentLost: count("UNSUPPORTED_INTENT_LOST"), userVisibleApiFailureAfterRetry: count("API_FAILURE"),
    semanticFlakyCases: instability, transportFlakyCases: [...new Set(results.filter(x => x.diagnostics.some(d => d.retryable)).map(x => x.id))],
    failures: results.filter(x => !x.categories.includes("PASS")).map(x => ({ id: x.id, repetition: x.repetition, categories: x.categories })),
    focus: Object.fromEntries(focusIds.map(id => [id, { pass: results.filter(x => x.id === id && x.categories.includes("PASS")).length,
      runs: results.filter(x => x.id === id).length }])) };
  if (outputDir) writeFileSync(resolve(outputDir, `${label}-summary.json`), JSON.stringify(summary, null, 2), { flag: "wx" });
  process.stdout.write(`METRICS ${JSON.stringify(summary)}\n`);
  if (summary.semanticCorrect !== jobs.length) process.exitCode = 1;
}
void main().catch(() => { process.stderr.write("EVALUATION_FAILED; no raw provider error exported\n"); process.exitCode = 1; });
