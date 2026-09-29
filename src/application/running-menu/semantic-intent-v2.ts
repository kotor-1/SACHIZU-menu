import { z } from "zod";
import type { VerifiedRunningIntent, VerifiedClaim } from "./intent";

export const RUNNING_INTERPRETER_VERSION = "running-intent-v2" as const;

const fieldSchema = z.enum([
  "RUNNING_REQUEST", "EVENT", "AGE_GROUP", "TRAINING_DISTANCE", "REPS", "REST",
  "AVAILABLE_TIME", "DISTANCE_PREFERENCE", "LOAD_REDUCTION", "FATIGUE", "COMPETITION_DAYS",
]);
const unitSchema = z.enum(["METER", "REP", "SECOND", "MINUTE", "HOUR", "DAY", "SET", "GRADE", "NONE"]);
const numericPartSchema = z.object({ rawText: z.string().min(1).max(24), unit: unitSchema }).strict();
const claimSchema = z.object({
  field: fieldSchema,
  value: z.union([z.string().min(1).max(32), z.number().int().positive(), z.boolean()]),
  sourceText: z.string().min(1).max(160),
  polarity: z.enum(["AFFIRMED", "NEGATED"]),
  temporalScope: z.enum(["CURRENT", "DESIRED", "FUTURE", "PAST"]),
  status: z.enum(["ACTIVE", "SUPERSEDED"]),
  numericParts: z.array(numericPartSchema).max(4),
}).strict();

export const runningSemanticIntentV2Schema = z.object({
  interpreterVersion: z.literal(RUNNING_INTERPRETER_VERSION),
  requestKind: z.enum(["RUNNING", "EXERCISE_ONLY", "AMBIGUOUS"]),
  claims: z.array(claimSchema).max(30),
  unsupportedIntents: z.array(z.object({ meaning: z.string().min(1).max(140), sourceText: z.string().min(1).max(200) }).strict()).max(10),
  ambiguity: z.object({ question: z.string().min(1).max(160), sourceText: z.string().min(1).max(200) }).strict().nullable(),
  exerciseIds: z.array(z.string().min(1).max(64)).max(20),
}).strict();
export type RunningSemanticIntentV2 = z.infer<typeof runningSemanticIntentV2Schema>;
export type SemanticClaimV2 = RunningSemanticIntentV2["claims"][number];

export const semanticReviewV2Schema = z.object({
  assessments: z.array(z.object({ index: z.number().int().nonnegative(), supported: z.boolean() }).strict()).max(30),
  activeClaimIndexes: z.array(z.number().int().nonnegative()).max(30),
  requestKindSupported: z.boolean(),
  missingCriticalClaim: z.boolean(),
  ambiguityCorrect: z.boolean(),
  unsupportedIntentsSupported: z.boolean(),
}).strict();
export type SemanticReviewV2 = z.infer<typeof semanticReviewV2Schema>;

export const bareNumericRoleReviewV2Schema = z.object({
  roles: z.array(z.object({
    sourceText: z.string().min(1).max(160), rawText: z.string().min(1).max(24),
    role: z.enum(["EVENT", "TRAINING_DISTANCE", "AMBIGUOUS", "OTHER"]),
  }).strict()).max(20),
}).strict();
export type BareNumericRoleReviewV2 = z.infer<typeof bareNumericRoleReviewV2Schema>;

export type VerifiedNumericPartV2 = SemanticClaimV2["numericParts"][number] & {
  normalizedValue: number; semanticRole: SemanticClaimV2["field"]; start: number; end: number;
};
export type VerifiedSemanticClaimV2 = Omit<SemanticClaimV2, "numericParts"> & {
  numericParts: VerifiedNumericPartV2[]; start: number; end: number; sourceType: "USER_TEXT";
};
export type VerifiedUnsupportedIntentV2 = RunningSemanticIntentV2["unsupportedIntents"][number] & {
  supportStatus: "UNSUPPORTED_BY_CURRENT_POLICY"; start: number; end: number; sourceType: "USER_TEXT";
};
export type VerifiedSemanticIntentV2 = Omit<RunningSemanticIntentV2, "claims" | "unsupportedIntents"> & {
  claims: VerifiedSemanticClaimV2[];
  unsupportedIntents: VerifiedUnsupportedIntentV2[];
  understandingStatus: "UNDERSTOOD_AND_SUPPORTED" | "UNDERSTOOD_BUT_UNSUPPORTED";
};
export type SemanticVerificationV2 =
  | { ok: true; interpretation: VerifiedSemanticIntentV2; engineIntent: VerifiedRunningIntent }
  | { ok: false; reason: "INVALID_AI_CLAIM" | "AMBIGUOUS" | "UNSUPPORTED_EXTRACTION"; question?: string };

const numericFields = new Set<SemanticClaimV2["field"]>(["EVENT", "TRAINING_DISTANCE", "REPS", "REST", "AVAILABLE_TIME", "COMPETITION_DAYS"]);
const units: Record<string, string> = { m: "METER", メートル: "METER", 本: "REP", 秒: "SECOND", 分: "MINUTE", 時間: "HOUR", 日: "DAY", セット: "SET", 年: "GRADE" };
const orderedUnits = Object.entries(units).sort((a, b) => b[0].length - a[0].length);
function numericToken(part: { rawText: string; unit: string }): { number: number | null; embeddedUnit: string | null } {
  const normalized = part.rawText.normalize("NFKC").toLowerCase();
  const suffix = orderedUnits.find(([rawUnit]) => normalized.endsWith(rawUnit));
  const numberText = suffix ? normalized.slice(0, -suffix[0].length) : normalized;
  // A numeric witness must itself be a numeral. Accepting arbitrary text around
  // a digit would let a grade such as 高1 masquerade as one repetition.
  return { number: parseSpokenNumber(numberText), embeddedUnit: suffix?.[1] ?? null };
}

function normalizeSourceUnits(claim: SemanticClaimV2): SemanticClaimV2 | null {
  let offset = 0;
  const numericParts: SemanticClaimV2["numericParts"] = [];
  for (const part of claim.numericParts) {
    const at = claim.sourceText.indexOf(part.rawText, offset);
    if (at < 0) return null;
    const embedded = numericToken(part).embeddedUnit;
    const after = claim.sourceText.slice(at + part.rawText.length).normalize("NFKC").toLowerCase();
    const before = claim.sourceText.slice(0, at).normalize("NFKC");
    // 小5 / 中2 / 高1 are grade numerals with an omitted 年 suffix.
    const gradePrefix = /(?:小学|中学|高校|[小中高])$/u.test(before);
    const explicit = embedded ?? orderedUnits.find(([rawUnit]) => after.startsWith(rawUnit))?.[1] ?? (gradePrefix ? "GRADE" : "NONE");
    numericParts.push({ ...part, unit: explicit as typeof part.unit });
    offset = at + part.rawText.length;
  }
  // These fields do not carry a number into the policy engine. A model may
  // redundantly cite a number in their source span; do not turn it into a role.
  if (!numericFields.has(claim.field) && claim.field !== "AGE_GROUP") return { ...claim, numericParts: [] };
  return { ...claim, numericParts };
}
const digitWords: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  ゼロ: 0, れい: 0, いち: 1, に: 2, さん: 3, よん: 4, し: 4, ご: 5, ろく: 6, なな: 7, はち: 8, きゅう: 9,
};
const scaleWords: Record<string, number> = { 十: 10, 百: 100, 千: 1000, じゅう: 10, ひゃく: 100, びゃく: 100, ぴゃく: 100, せん: 100, ぜん: 1000 };

/** Closed arithmetic grammar for numerals, never a dialect or training-intent dictionary. */
export function parseSpokenNumber(raw: string): number | null {
  const text = raw.normalize("NFKC");
  if (/^\d+$/u.test(text)) return Number(text);
  const tokens = Object.keys({ ...digitWords, ...scaleWords }).sort((a, b) => b.length - a.length);
  let rest = text;
  let total = 0;
  let digit: number | null = null;
  while (rest.length > 0) {
    const token = tokens.find((item) => rest.startsWith(item));
    if (!token) return null;
    if (token in scaleWords) {
      total += (digit ?? 1) * scaleWords[token];
      digit = null;
    } else {
      if (digit !== null) return null;
      digit = digitWords[token];
    }
    rest = rest.slice(token.length);
  }
  return total + (digit ?? 0);
}

function normalizedClaim(claim: SemanticClaimV2): SemanticClaimV2 | null {
  if (!numericFields.has(claim.field)) return claim;
  if (claim.numericParts.length === 0) return null;
  const parts = claim.numericParts.map((part) => numericToken(part));
  if (parts.some((part) => part.number === null)) return claim;
  const scale = { SECOND: 1, MINUTE: 60, HOUR: 3600 } as Record<string, number>;
  const numericValue = claim.field === "REST" || claim.field === "AVAILABLE_TIME"
    ? claim.numericParts.reduce((sum, part, index) => sum + parts[index].number! * (scale[part.unit] ?? 1), 0)
    : parts.length === 1 ? parts[0].number! : NaN;
  if (!Number.isInteger(numericValue) || numericValue <= 0) return null;
  const written = String(claim.value).normalize("NFKC").toLowerCase();
  const writtenNumber = parseSpokenNumber(written.replace(/(?:メートル|m|時間|秒|分|日|本|セット|年)$/u, ""));
  if (writtenNumber === null) return null;
  if (writtenNumber !== numericValue && !(claim.field === "REST" || claim.field === "AVAILABLE_TIME")) return null;
  if ((claim.field === "REST" || claim.field === "AVAILABLE_TIME") && writtenNumber !== numericValue && !claim.numericParts.some((part, index) => parts[index].number === writtenNumber)) return null;
  return { ...claim, value: claim.field === "EVENT" ? `${numericValue}m` : numericValue };
}

function numericCheck(claim: SemanticClaimV2): boolean {
  if (claim.field === "AGE_GROUP") return claim.numericParts.every((part) => ["NONE", "GRADE"].includes(part.unit) && numericToken(part).number !== null);
  if (!numericFields.has(claim.field)) return claim.numericParts.length === 0;
  if (claim.numericParts.length === 0) return false;
  const expected = claim.field === "EVENT" ? Number(String(claim.value).replace(/m$/u, "")) : claim.value;
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected <= 0) return false;
  const allowed: Record<string, readonly string[]> = {
    EVENT: ["METER", "NONE"], TRAINING_DISTANCE: ["METER", "NONE"],
    REPS: ["REP", "NONE"], REST: ["SECOND", "MINUTE", "HOUR", "NONE"],
    AVAILABLE_TIME: ["SECOND", "MINUTE", "HOUR", "NONE"], COMPETITION_DAYS: ["DAY", "NONE"],
  };
  if (claim.numericParts.some((part) => !allowed[claim.field]?.includes(part.unit))) return false;
  const parts = claim.numericParts.map((part) => ({ ...part, ...numericToken(part) }));
  if (parts.some((part) => part.embeddedUnit !== null && part.embeddedUnit !== part.unit)) return false;
  // An unparseable spoken numeral is sent to an independent semantic review.
  // An Arabic or kanji number that parses must agree with the claimed value.
  if (parts.some((part) => part.number === null)) {
    // Unknown spoken forms need semantic review; Arabic digits have an exact
    // structural representation and may not hide inside arbitrary text.
    return parts.every((part) => part.number !== null || !/[0-9０-９]/u.test(part.rawText));
  }
  if (claim.field === "REST" || claim.field === "AVAILABLE_TIME") {
    return parts.every((part) => ["SECOND", "MINUTE", "HOUR", "NONE"].includes(part.unit))
      && parts.reduce((sum, part) => sum + part.number! * ({ SECOND: 1, MINUTE: 60, HOUR: 3600, NONE: 1 } as Record<string, number>)[part.unit], 0) === expected;
  }
  if (parts.length !== 1 || parts[0].number !== expected) return false;
  return true;
}

function valueCheck(claim: SemanticClaimV2): boolean {
  switch (claim.field) {
    case "RUNNING_REQUEST": case "LOAD_REDUCTION": return typeof claim.value === "boolean";
    case "EVENT": return typeof claim.value === "string" && /^\d+m$/u.test(claim.value);
    case "AGE_GROUP": return ["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"].includes(String(claim.value));
    case "DISTANCE_PREFERENCE": return claim.value === "SHORT" || claim.value === "LONG";
    case "FATIGUE": return ["FATIGUED", "NOT_FATIGUED", "STRONG_OR_UNWELL"].includes(String(claim.value));
    default: return typeof claim.value === "number";
  }
}

function project(claims: readonly VerifiedSemanticClaimV2[], exerciseIds: string[], runningRequested: boolean): VerifiedRunningIntent | null {
  const active = claims.filter((claim) => claim.status === "ACTIVE" && claim.polarity === "AFFIRMED" && claim.temporalScope !== "PAST");
  const unique = (field: SemanticClaimV2["field"]) => {
    const found = active.filter((claim) => claim.field === field);
    return found.length > 1 ? false : found[0] ?? null;
  };
  const fields = ["EVENT", "AGE_GROUP", "DISTANCE_PREFERENCE", "LOAD_REDUCTION", "FATIGUE", "AVAILABLE_TIME", "REPS", "REST"] as const;
  const values = Object.fromEntries(fields.map((field) => [field, unique(field)])) as Record<(typeof fields)[number], VerifiedSemanticClaimV2 | null | false>;
  if (Object.values(values).some((value) => value === false)) return null;
  const sourced = <T>(claim: VerifiedSemanticClaimV2 | null | false): VerifiedClaim<T> | null =>
    claim ? { value: claim.value as T, sourceText: claim.sourceText, sourceType: "USER_TEXT" } : null;
  const distances = active.filter((claim) => claim.field === "TRAINING_DISTANCE").map((claim) => sourced<number>(claim)!);
  const fatigue = values.FATIGUE;
  const fatigueValue = fatigue ? fatigue.value : null;
  const load = values.LOAD_REDUCTION;
  return {
    runningRequested,
    event: sourced<string>(values.EVENT),
    ageGroup: sourced<"ELEMENTARY" | "JUNIOR_HIGH" | "HIGH_SCHOOL" | "ADULT">(values.AGE_GROUP),
    explicitDistances: distances,
    distancePreference: sourced<"SHORT" | "LONG">(values.DISTANCE_PREFERENCE),
    loadReductionRequested: load && load.value === true ? sourced<true>(load) : null,
    fatigueState: fatigueValue === "FATIGUED" ? sourced<"REPORTED">({ ...fatigue!, value: "REPORTED" } as VerifiedSemanticClaimV2)
      : fatigueValue === "STRONG_OR_UNWELL" ? sourced<"STRONG_OR_UNWELL">(fatigue) : null,
    availableTimeSeconds: sourced<number>(values.AVAILABLE_TIME),
    humanExplicitReps: sourced<number>(values.REPS),
    humanExplicitRestSeconds: sourced<number>(values.REST),
    exerciseIds,
  };
}

/** Structural checks are deterministic; meaning is independently reviewed in `review`. */
export function verifySemanticIntentV2(
  requestText: string, raw: unknown, rawReview: unknown, rawRoleReview: unknown, allowedExerciseIds: readonly string[],
): SemanticVerificationV2 {
  const parsed = runningSemanticIntentV2Schema.safeParse(raw);
  const review = semanticReviewV2Schema.safeParse(rawReview);
  const roleReview = bareNumericRoleReviewV2Schema.safeParse(rawRoleReview);
  if (!parsed.success || !review.success || !roleReview.success) return { ok: false, reason: "INVALID_AI_CLAIM" };
  const intent = parsed.data;
  const independentRoles = new Map<string, BareNumericRoleReviewV2["roles"][number]["role"]>();
  for (const item of roleReview.data.roles) {
    const sourceStart = requestText.indexOf(item.sourceText);
    const rawStart = item.sourceText.indexOf(item.rawText);
    if (sourceStart < 0 || rawStart < 0) return { ok: false, reason: "INVALID_AI_CLAIM" };
    const span = `${sourceStart + rawStart}:${sourceStart + rawStart + item.rawText.length}`;
    if (independentRoles.has(span)) return { ok: false, reason: "INVALID_AI_CLAIM" };
    independentRoles.set(span, item.role);
  }
  const blindAmbiguity = roleReview.data.roles.find((item) => item.role === "AMBIGUOUS" &&
    !/(?:小学|中学|高校|[小中高])$/u.test(item.sourceText.slice(0, item.sourceText.indexOf(item.rawText))));
  if (intent.requestKind !== "AMBIGUOUS" && blindAmbiguity) {
    return { ok: false, reason: "AMBIGUOUS",
      question: `${blindAmbiguity.rawText}mの種目に出る意味ですか？それとも今日${blindAmbiguity.rawText}mを走りたい意味ですか？` };
  }
  if (intent.requestKind === "AMBIGUOUS") {
    if (!intent.ambiguity || !requestText.includes(intent.ambiguity.sourceText) || !review.data.ambiguityCorrect || !review.data.requestKindSupported) return { ok: false, reason: "INVALID_AI_CLAIM" };
    return { ok: false, reason: "AMBIGUOUS", question: intent.ambiguity.question };
  }
  if (intent.ambiguity !== null || !review.data.requestKindSupported || !review.data.ambiguityCorrect || review.data.missingCriticalClaim) {
    return { ok: false, reason: "INVALID_AI_CLAIM" };
  }
  const allowed = new Set(allowedExerciseIds);
  if (intent.exerciseIds.some((id) => !allowed.has(id)) || new Set(intent.exerciseIds).size !== intent.exerciseIds.length) return { ok: false, reason: "INVALID_AI_CLAIM" };
  if (review.data.assessments.length !== intent.claims.length ||
    review.data.assessments.some((assessment, index) => assessment.index !== index || !assessment.supported)) return { ok: false, reason: "INVALID_AI_CLAIM" };
  const activeIndexes = new Set(review.data.activeClaimIndexes);
  if (activeIndexes.size !== review.data.activeClaimIndexes.length || [...activeIndexes].some((index) => index >= intent.claims.length)) return { ok: false, reason: "INVALID_AI_CLAIM" };
  for (const [index, claim] of intent.claims.entries()) {
    if (claim.status === "ACTIVE" && claim.polarity === "AFFIRMED" && !activeIndexes.has(index) && review.data.assessments[index]?.supported &&
      !intent.claims.some((other, otherIndex) => otherIndex !== index && activeIndexes.has(otherIndex) && other.field === claim.field)) {
      return { ok: false, reason: "INVALID_AI_CLAIM" };
    }
  }
  if (intent.unsupportedIntents.some((item) => !requestText.includes(item.sourceText))) return { ok: false, reason: "INVALID_AI_CLAIM" };
  const verified: VerifiedSemanticClaimV2[] = [];
  for (const [index, rawClaim] of intent.claims.entries()) {
    const sourceClaim = normalizeSourceUnits(rawClaim);
    if (!sourceClaim) return { ok: false, reason: "INVALID_AI_CLAIM" };
    const claim = normalizedClaim(sourceClaim);
    if (!claim) return { ok: false, reason: "INVALID_AI_CLAIM" };
    // These values already encode the negative state. A second NEGATED polarity
    // would reverse the meaning or silently remove the fact from the adapter.
    if (["RUNNING_REQUEST", "LOAD_REDUCTION", "FATIGUE"].includes(claim.field) && claim.polarity !== "AFFIRMED") {
      return { ok: false, reason: "INVALID_AI_CLAIM" };
    }
    const start = requestText.indexOf(claim.sourceText);
    if (start < 0 || !valueCheck(claim) || !numericCheck(claim)) return { ok: false, reason: "INVALID_AI_CLAIM" };
    const numericParts: VerifiedNumericPartV2[] = [];
    if (claim.numericParts.length > 0) {
      let offset = 0;
      for (const part of claim.numericParts) {
        const at = claim.sourceText.indexOf(part.rawText, offset);
        if (at < 0) return { ok: false, reason: "INVALID_AI_CLAIM" };
        const after = claim.sourceText.slice(at + part.rawText.length).normalize("NFKC");
        const embedded = numericToken(part).embeddedUnit;
        const explicit = embedded ? ["", embedded] : orderedUnits.find(([rawUnit]) => after.toLowerCase().startsWith(rawUnit));
        if (explicit && explicit[1] !== part.unit) return { ok: false, reason: "INVALID_AI_CLAIM" };
        // A distance immediately bound to a repetition count is a workout
        // distance, even if an AI mislabeled that same numeric span as EVENT.
        // This uses only number/unit structure, never a list of event phrases.
        if (claim.field === "EVENT" && /^(?:m|メートル)?\s*(?:を|で|×|x)?\s*[0-9０-９]+\s*本/u.test(after)) {
          return { ok: false, reason: "INVALID_AI_CLAIM" };
        }
        const scale = { SECOND: 1, MINUTE: 60, HOUR: 3600 } as Record<string, number>;
        const claimed = claim.field === "EVENT" ? Number(String(claim.value).slice(0, -1)) : Number(claim.value);
        const normalizedValue = numericToken(part).number ?? (claim.field === "REST" || claim.field === "AVAILABLE_TIME" ? claimed / (scale[part.unit] ?? 1) : claimed);
        if (!Number.isFinite(normalizedValue)) return { ok: false, reason: "INVALID_AI_CLAIM" };
        numericParts.push({ ...part, unit: (explicit?.[1] ?? "NONE") as typeof part.unit,
          normalizedValue, semanticRole: claim.field, start: start + at, end: start + at + part.rawText.length });
        offset = at + part.rawText.length;
      }
    }
    verified.push({ ...claim, status: activeIndexes.has(index) ? "ACTIVE" : "SUPERSEDED", numericParts, start, end: start + claim.sourceText.length, sourceType: "USER_TEXT" });
  }
  const numericRoles = new Map<string, string>();
  for (const claim of verified) {
    for (const part of claim.numericParts) {
      const span = `${part.start}:${part.end}`;
      const priorRole = numericRoles.get(span);
      if (priorRole && priorRole !== claim.field) return { ok: false, reason: "INVALID_AI_CLAIM" };
      numericRoles.set(span, claim.field);
      if (claim.status === "ACTIVE" && (claim.field === "EVENT" || claim.field === "TRAINING_DISTANCE") && part.unit === "NONE") {
        const independent = independentRoles.get(span);
        if (independent === "AMBIGUOUS") {
          return { ok: false, reason: "AMBIGUOUS",
            question: `${part.rawText}mの種目に出る意味ですか？それとも今日${part.rawText}mを走りたい意味ですか？` };
        }
        if (independent !== claim.field) return { ok: false, reason: "INVALID_AI_CLAIM" };
      }
    }
  }
  const activeRunningRequests = verified.filter((claim) => claim.field === "RUNNING_REQUEST" && claim.status === "ACTIVE" && claim.polarity === "AFFIRMED");
  if (activeRunningRequests.length > 1 || activeRunningRequests.some((claim) => claim.value !== (intent.requestKind === "RUNNING"))) {
    return { ok: false, reason: "INVALID_AI_CLAIM" };
  }
  const engineIntent = project(verified, intent.exerciseIds, intent.requestKind === "RUNNING");
  if (!engineIntent) return { ok: false, reason: "INVALID_AI_CLAIM" };
  if (intent.requestKind === "EXERCISE_ONLY" && verified.some((claim) => ["EVENT", "TRAINING_DISTANCE", "RUNNING_REQUEST"].includes(claim.field) && claim.status === "ACTIVE")) return { ok: false, reason: "INVALID_AI_CLAIM" };
  // A doubtful freeform paraphrase cannot become policy input. Preserve the
  // exact source wording for the user instead of rejecting the valid fields.
  const unsupportedRaw = review.data.unsupportedIntentsSupported
    ? intent.unsupportedIntents
    : intent.unsupportedIntents.map((item) => ({ ...item, meaning: item.sourceText }));
  const unsupportedIntents: VerifiedUnsupportedIntentV2[] = unsupportedRaw.map((item) => {
    const start = requestText.indexOf(item.sourceText);
    return { ...item, supportStatus: "UNSUPPORTED_BY_CURRENT_POLICY", start, end: start + item.sourceText.length, sourceType: "USER_TEXT" };
  });
  return { ok: true, interpretation: { ...intent, claims: verified, unsupportedIntents,
    understandingStatus: unsupportedIntents.length > 0 ? "UNDERSTOOD_BUT_UNSUPPORTED" : "UNDERSTOOD_AND_SUPPORTED" }, engineIntent };
}
