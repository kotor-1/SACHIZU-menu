import { z } from "zod";
import { hasNumericEvidence, hasReportedFatigue, normalizeIntentText, numericEvidence } from "./numeric-evidence";
import { historicalIntensityFromGroundedText, historicalPurposeFromGroundedText, type RunningIntensityPreference, type RunningPurpose } from "@/domain/running-policy/purpose";

const sourced = <T extends z.ZodTypeAny>(value: T) => z.object({
  value,
  sourceText: z.string().trim().min(1).max(160),
}).strict();

/** Provider output contains claims about the input, never a prescription. */
export const runningIntentClaimsSchema = z.object({
  runningRequested: z.boolean(),
  event: sourced(z.string().trim().min(1).max(32)).nullable(),
  ageGroup: sourced(z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"])).nullable(),
  explicitDistances: z.array(sourced(z.number().int().positive())).max(20),
  distancePreference: sourced(z.enum(["SHORT", "LONG"])).nullable(),
  loadReductionRequested: sourced(z.literal(true)).nullable(),
  fatigueState: sourced(z.enum(["REPORTED", "STRONG_OR_UNWELL"])).nullable(),
  purpose: sourced(z.enum(["ACCEL", "MAX_SPEED", "SPEED_ENDURANCE", "BASIC", "PRECOMP", "RECOVERY"])).nullable().default(null),
  intensityPreference: sourced(z.literal("LOW")).nullable().default(null),
  competitionDays: sourced(z.number().int().nonnegative()).nullable().default(null),
  availableTimeSeconds: sourced(z.number().int().positive()).nullable(),
  humanExplicitReps: sourced(z.number().int().positive()).nullable(),
  humanExplicitRestSeconds: sourced(z.number().int().positive()).nullable(),
  /** Selected only from the server supplied REVIEWED Exercise catalog. */
  exerciseIds: z.array(z.string().trim().min(1).max(64)).max(20),
}).strict();

export type RunningIntentClaims = z.infer<typeof runningIntentClaimsSchema>;
export type IntentSource = "USER_TEXT" | "USER_CONTEXT" | "PROFILE";
export type VerifiedClaim<T> = { value: T; sourceText: string; sourceType: IntentSource };

export type VerifiedRunningIntent = {
  runningRequested: boolean;
  event: VerifiedClaim<string> | null;
  ageGroup: VerifiedClaim<"ELEMENTARY" | "JUNIOR_HIGH" | "HIGH_SCHOOL" | "ADULT"> | null;
  explicitDistances: VerifiedClaim<number>[];
  distancePreference: VerifiedClaim<"SHORT" | "LONG"> | null;
  loadReductionRequested: VerifiedClaim<true> | null;
  fatigueState: VerifiedClaim<"REPORTED" | "STRONG_OR_UNWELL"> | null;
  purpose: VerifiedClaim<RunningPurpose> | null;
  intensityPreference: VerifiedClaim<RunningIntensityPreference> | null;
  competitionDays: VerifiedClaim<number> | null;
  availableTimeSeconds: VerifiedClaim<number> | null;
  humanExplicitReps: VerifiedClaim<number> | null;
  humanExplicitRestSeconds: VerifiedClaim<number> | null;
  exerciseIds: string[];
};

const normalize = normalizeIntentText;
const ageIn = (text: string, value: string) => ({
  ELEMENTARY: /小学生|小学/u,
  JUNIOR_HIGH: /中学生|中学/u,
  HIGH_SCHOOL: /高校生|高校/u,
  ADULT: /成人|大人|社会人/u,
} as Record<string, RegExp>)[value]?.test(text) ?? false;

/** Fail closed if an AI claim cannot be rederived from its quoted user span. */
export function verifyRunningIntentClaims(
  inputText: string,
  raw: unknown,
  allowedExerciseIds: readonly string[],
): { ok: true; intent: VerifiedRunningIntent } | { ok: false; reason: string; field?: keyof RunningIntentClaims } {
  const parsed = runningIntentClaimsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "AI_OUTPUT_INVALID" };
  const claims = parsed.data;
  const input = normalize(inputText);
  if (!claims.runningRequested && claims.explicitDistances.length > 0) return { ok: false, reason: "RUNNING_REQUEST_OMITTED" };
  const source = <T>(claim: { value: T; sourceText: string } | null, check: (text: string, value: T) => boolean): VerifiedClaim<T> | null | false => {
    if (claim === null) return null;
    const text = normalize(claim.sourceText);
    if (!input.includes(text) || !check(text, claim.value)) return false;
    return { ...claim, sourceType: "USER_TEXT" };
  };
  const event = source(claims.event, (text, value) => /^\d+m$/iu.test(value)
    ? hasNumericEvidence(input, text, "EVENT_DISTANCE", Number(value.slice(0, -1)))
    : text.includes(value));
  const ageGroup = source(claims.ageGroup, ageIn);
  const explicitDistances = claims.explicitDistances.map((claim) => source(claim, (text, value) => hasNumericEvidence(input, text, "TRAINING_DISTANCE", value)));
  const distancePreference = source(claims.distancePreference, (text, value) => value === "SHORT" ? /短め|短い|短く/u.test(text) : /長め|長い|長く/u.test(text));
  const loadReductionRequested = source(claims.loadReductionRequested, (text) => /軽め|本数を(?:少な|減ら|抑え)|量を(?:少な|減ら|抑え)|疲労を残したくない/u.test(text));
  const fatigueState = source(claims.fatigueState, (text, value) => value === "REPORTED"
    ? hasReportedFatigue(text)
    : /走れない|かなり.*疲れ|体が動かない|強い不調|体調が悪い/u.test(text));
  const purpose = source(claims.purpose, (text, value) => historicalPurposeFromGroundedText(text) === value);
  const intensityPreference = source(claims.intensityPreference, (text, value) => historicalIntensityFromGroundedText(text) === value);
  const competitionDays = source(claims.competitionDays, (text, value) =>
    hasNumericEvidence(input, text, "COMPETITION_DAYS", value));
  const availableTimeSeconds = source(claims.availableTimeSeconds, (text, value) => hasNumericEvidence(input, text, "TIME_AVAILABLE", value));
  const humanExplicitReps = source(claims.humanExplicitReps, (text, value) => hasNumericEvidence(input, text, "REPS", value));
  const humanExplicitRestSeconds = source(claims.humanExplicitRestSeconds, (text, value) => hasNumericEvidence(input, text, "REST", value));
  const verifiedFields = { event, ageGroup, distancePreference, loadReductionRequested, fatigueState, purpose,
    intensityPreference, competitionDays, availableTimeSeconds, humanExplicitReps, humanExplicitRestSeconds };
  for (const [field, claim] of Object.entries(verifiedFields)) {
    if (claim === false) return { ok: false, reason: "UNSUPPORTED_SOURCE_CLAIM", field: field as keyof RunningIntentClaims };
  }
  if (explicitDistances.some((claim) => claim === false)) return { ok: false, reason: "UNSUPPORTED_SOURCE_CLAIM", field: "explicitDistances" };
  const allowed = new Set(allowedExerciseIds);
  if (claims.exerciseIds.some((id) => !allowed.has(id)) || new Set(claims.exerciseIds).size !== claims.exerciseIds.length) {
    return { ok: false, reason: "UNSUPPORTED_EXERCISE_SELECTION" };
  }
  // Missing claims are as dangerous as invented claims: do not turn an explicit
  // unsupported distance or a light-session request into an ordinary default.
  const evidence = numericEvidence(input);
  const explicitInText = evidence.filter((entry) => entry.role === "TRAINING_DISTANCE").map((entry) => entry.value);
  if (explicitInText.some((value) => !claims.explicitDistances.some((claim) => claim.value === value))) return { ok: false, reason: "MISSING_EXPLICIT_DISTANCE" };
  if (claims.explicitDistances.some((claim) => !explicitInText.includes(claim.value))) return { ok: false, reason: "INVENTED_EXPLICIT_DISTANCE" };
  if (/軽め|本数を(?:少な|減ら|抑え)|量を(?:少な|減ら|抑え)|疲労を残したくない/u.test(input) && claims.loadReductionRequested === null) return { ok: false, reason: "MISSING_LOAD_REDUCTION" };
  if (/短め|短い距離/u.test(input) && claims.distancePreference?.value !== "SHORT") return { ok: false, reason: "MISSING_SHORT_PREFERENCE" };
  if (/長め|長い距離/u.test(input) && claims.distancePreference?.value !== "LONG") return { ok: false, reason: "MISSING_LONG_PREFERENCE" };
  if (evidence.some((entry) => entry.role === "TIME_AVAILABLE") && claims.availableTimeSeconds === null) return { ok: false, reason: "MISSING_AVAILABLE_TIME", field: "availableTimeSeconds" };
  if (hasReportedFatigue(input) && claims.fatigueState === null) return { ok: false, reason: "MISSING_FATIGUE_CONTEXT", field: "fatigueState" };
  if (/走れない|かなり.*疲れ|体が動かない|強い不調|体調が悪い/u.test(input) && claims.fatigueState?.value !== "STRONG_OR_UNWELL") return { ok: false, reason: "STRONG_FATIGUE_DOWNGRADED" };
  if (historicalPurposeFromGroundedText(input) !== null && claims.purpose === null) return { ok: false, reason: "MISSING_RUNNING_PURPOSE", field: "purpose" };
  if (historicalIntensityFromGroundedText(input) !== null && claims.intensityPreference === null) return { ok: false, reason: "MISSING_INTENSITY_PREFERENCE", field: "intensityPreference" };
  if (/(?:100|200)(?:m|メートル)選手/u.test(input) && /メニュー|練習/u.test(input) && !/走らない|補強だけ|ストレッチだけ/u.test(input) && !claims.runningRequested) return { ok: false, reason: "RUNNING_REQUEST_OMITTED" };
  if (evidence.some((entry) => entry.role === "REPS") && claims.humanExplicitReps === null) return { ok: false, reason: "MISSING_EXPLICIT_REPS", field: "humanExplicitReps" };
  if (evidence.some((entry) => entry.role === "REST") && claims.humanExplicitRestSeconds === null) return { ok: false, reason: "MISSING_EXPLICIT_REST", field: "humanExplicitRestSeconds" };
  return {
    ok: true,
    intent: {
      runningRequested: claims.runningRequested,
      event: event as VerifiedRunningIntent["event"],
      ageGroup: ageGroup as VerifiedRunningIntent["ageGroup"],
      explicitDistances: explicitDistances as VerifiedClaim<number>[],
      distancePreference: distancePreference as VerifiedRunningIntent["distancePreference"],
      loadReductionRequested: loadReductionRequested as VerifiedRunningIntent["loadReductionRequested"],
      fatigueState: fatigueState as VerifiedRunningIntent["fatigueState"],
      purpose: purpose as VerifiedRunningIntent["purpose"],
      intensityPreference: intensityPreference as VerifiedRunningIntent["intensityPreference"],
      competitionDays: competitionDays as VerifiedRunningIntent["competitionDays"],
      availableTimeSeconds: availableTimeSeconds as VerifiedRunningIntent["availableTimeSeconds"],
      humanExplicitReps: humanExplicitReps as VerifiedRunningIntent["humanExplicitReps"],
      humanExplicitRestSeconds: humanExplicitRestSeconds as VerifiedRunningIntent["humanExplicitRestSeconds"],
      exerciseIds: claims.exerciseIds,
    },
  };
}
