import { z } from "zod";

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
  availableTimeSeconds: VerifiedClaim<number> | null;
  humanExplicitReps: VerifiedClaim<number> | null;
  humanExplicitRestSeconds: VerifiedClaim<number> | null;
  exerciseIds: string[];
};

const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");
const distanceIn = (text: string, value: number) => new RegExp(`(^|[^0-9])${value}\\s*(?:m|メートル)(?![0-9])`, "iu").test(text);
const eventIn = (text: string, value: string) => {
  if (/^(100m|200m)$/u.test(value)) return distanceIn(text, Number(value.slice(0, -1))) && /選手|種目|専門|競技|小学生|中学生|高校生|成人/u.test(text);
  return text.includes(value);
};
const explicitDistanceIn = (text: string, value: number) => distanceIn(text, value)
  && new RegExp(`${value}\\s*(?:m|メートル)(?:を|で|中心|走|やりたい|にする|×|x|$)`, "iu").test(text);
const ageIn = (text: string, value: string) => ({
  ELEMENTARY: /小学生|小学/u,
  JUNIOR_HIGH: /中学生|中学/u,
  HIGH_SCHOOL: /高校生|高校/u,
  ADULT: /成人|大人|社会人/u,
} as Record<string, RegExp>)[value]?.test(text) ?? false;

function exactTime(text: string, seconds: number): boolean {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(時間|分|秒)/gu)];
  return matches.some((match) => Number(match[1]) * ({ 時間: 3600, 分: 60, 秒: 1 }[match[2] as "時間" | "分" | "秒"]) === seconds);
}

/** Fail closed if an AI claim cannot be rederived from its quoted user span. */
export function verifyRunningIntentClaims(
  inputText: string,
  raw: unknown,
  allowedExerciseIds: readonly string[],
): { ok: true; intent: VerifiedRunningIntent } | { ok: false; reason: string } {
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
  const event = source(claims.event, (text, value) => eventIn(text, value)
    || (/^(100m|200m)$/u.test(value)
      && (new RegExp(`(?:小学生|中学生|高校生|成人)${value}`, "u").test(input)
        || new RegExp(`^${value}。今日は`, "u").test(input))
      && text === value));
  const ageGroup = source(claims.ageGroup, ageIn);
  const explicitDistances = claims.explicitDistances.map((claim) => source(claim, explicitDistanceIn));
  const distancePreference = source(claims.distancePreference, (text, value) => value === "SHORT" ? /短め|短い|短く/u.test(text) : /長め|長い|長く/u.test(text));
  const loadReductionRequested = source(claims.loadReductionRequested, (text) => /軽め|本数を(?:少な|減ら|抑え)|量を(?:少な|減ら|抑え)|疲労を残したくない/u.test(text));
  const fatigueState = source(claims.fatigueState, (text, value) => value === "REPORTED"
    ? /疲れ|疲労/u.test(text)
    : /走れない|かなり.*疲れ|体が動かない|強い不調|体調が悪い/u.test(text));
  const availableTimeSeconds = source(claims.availableTimeSeconds, (text, value) => exactTime(text, value) && /(?:分|時間)(?:で|しか|以内|だけ)|(?:あと|練習時間)/u.test(text));
  const humanExplicitReps = source(claims.humanExplicitReps, (text, value) => new RegExp(`(^|[^0-9])${value}\\s*本(?![0-9])`, "u").test(text));
  const humanExplicitRestSeconds = source(claims.humanExplicitRestSeconds, (text, value) => exactTime(text, value) && /休憩|レスト|本間/u.test(text));
  if ([event, ageGroup, distancePreference, loadReductionRequested, fatigueState, availableTimeSeconds, humanExplicitReps, humanExplicitRestSeconds, ...explicitDistances].some((claim) => claim === false)) {
    return { ok: false, reason: "UNSUPPORTED_SOURCE_CLAIM" };
  }
  const allowed = new Set(allowedExerciseIds);
  if (claims.exerciseIds.some((id) => !allowed.has(id)) || new Set(claims.exerciseIds).size !== claims.exerciseIds.length) {
    return { ok: false, reason: "UNSUPPORTED_EXERCISE_SELECTION" };
  }
  // Missing claims are as dangerous as invented claims: do not turn an explicit
  // unsupported distance or a light-session request into an ordinary default.
  const explicitInText = [...input.matchAll(/(\d{2,3})(?:m|メートル)(?=を|で|中心|走|やりたい|にする|×|x)/giu)].map((match) => Number(match[1]));
  if (explicitInText.some((value) => !claims.explicitDistances.some((claim) => claim.value === value))) return { ok: false, reason: "MISSING_EXPLICIT_DISTANCE" };
  if (claims.explicitDistances.some((claim) => !explicitInText.includes(claim.value))) return { ok: false, reason: "INVENTED_EXPLICIT_DISTANCE" };
  if (/軽め|本数を(?:少な|減ら|抑え)|量を(?:少な|減ら|抑え)|疲労を残したくない/u.test(input) && claims.loadReductionRequested === null) return { ok: false, reason: "MISSING_LOAD_REDUCTION" };
  if (/短め|短い距離/u.test(input) && claims.distancePreference?.value !== "SHORT") return { ok: false, reason: "MISSING_SHORT_PREFERENCE" };
  if (/長め|長い距離/u.test(input) && claims.distancePreference?.value !== "LONG") return { ok: false, reason: "MISSING_LONG_PREFERENCE" };
  if (/(?:あと)?\d+(?:分|時間)(?:で|しか|以内)/u.test(input) && !/(?:休憩|レスト)\D*\d+(?:分|時間)(?:で|しか|以内)/u.test(input) && claims.availableTimeSeconds === null) return { ok: false, reason: "MISSING_AVAILABLE_TIME" };
  if (/疲れて|疲労が|体が動かない|体調が悪い/u.test(input) && claims.fatigueState === null) return { ok: false, reason: "MISSING_FATIGUE_CONTEXT" };
  if (/走れない|かなり.*疲れ|体が動かない|強い不調|体調が悪い/u.test(input) && claims.fatigueState?.value !== "STRONG_OR_UNWELL") return { ok: false, reason: "STRONG_FATIGUE_DOWNGRADED" };
  if (/(?:100|200)(?:m|メートル)選手/u.test(input) && /メニュー|練習/u.test(input) && !/走らない|補強だけ|ストレッチだけ/u.test(input) && !claims.runningRequested) return { ok: false, reason: "RUNNING_REQUEST_OMITTED" };
  if (/(?:本数|休憩|レスト|目標タイム)/u.test(input) && /\d/u.test(input)) {
    if (/\d+本/u.test(input) && claims.humanExplicitReps === null) return { ok: false, reason: "MISSING_EXPLICIT_REPS" };
    if (/(?:休憩|レスト)\D*\d+(?:分|秒)/u.test(input) && claims.humanExplicitRestSeconds === null) return { ok: false, reason: "MISSING_EXPLICIT_REST" };
  }
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
      availableTimeSeconds: availableTimeSeconds as VerifiedRunningIntent["availableTimeSeconds"],
      humanExplicitReps: humanExplicitReps as VerifiedRunningIntent["humanExplicitReps"],
      humanExplicitRestSeconds: humanExplicitRestSeconds as VerifiedRunningIntent["humanExplicitRestSeconds"],
      exerciseIds: claims.exerciseIds,
    },
  };
}
