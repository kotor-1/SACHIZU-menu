/** Domain contract for explicit, rule-bound plausibility reviews (OPEN20 F2). */
import { z } from "zod";
import { coachActorSchema } from "./actor";
import { confidenceSchema, dataSourceSchema, isoDateSchema, isoDateTimeSchema, unitSchema } from "./primitives";
import { runningSelectionSchema } from "./template";

export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export type Sha256Digest = z.infer<typeof sha256DigestSchema>;

export type CanonicalReviewContextValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalReviewContextValue[]
  | { readonly [key: string]: CanonicalReviewContextValue };

const canonicalReviewContextValueSchema: z.ZodType<CanonicalReviewContextValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(canonicalReviewContextValueSchema),
    z.record(z.string(), canonicalReviewContextValueSchema),
  ]),
);

/** Server-resolved context; itemIdentity is logical and does not require a persisted database id. */
export const plausibilityReviewContextSchema = z
  .object({
    subject: z
      .object({
        kind: z.enum(["ATHLETE", "GROUP"]),
        identity: z.string().trim().min(1).max(256),
      })
      .strict(),
    planningDate: isoDateSchema,
    selection: runningSelectionSchema,
    itemIdentity: z.string().trim().min(1).max(256),
    /** Projection built by the domain helper from a validated PlanRequest and, when available, its prescription. */
    planningState: z.object({
      subjectState: canonicalReviewContextValueSchema,
      requestState: canonicalReviewContextValueSchema,
      prescriptionState: canonicalReviewContextValueSchema.nullable(),
    }).strict(),
  })
  .strict();
export type PlausibilityReviewContext = z.infer<typeof plausibilityReviewContextSchema>;
export type CanonicalReviewContext = CanonicalReviewContextValue;

export const plausibilityReviewScopeSchema = z.enum(["ITEM", "INPUT", "SESSION"]);

export const plausibilityIssueTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PRESCRIPTION_FIELD"), field: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("REP_DISTANCE") }).strict(),
  z.object({ kind: z.literal("ITEM_TOTAL_DISTANCE") }).strict(),
  z.object({ kind: z.literal("TIMED_MARK"), recordDigest: sha256DigestSchema }).strict(),
  z.object({ kind: z.literal("HEIGHT_POINT"), recordDigest: sha256DigestSchema }).strict(),
]);
export type PlausibilityIssueTarget = z.infer<typeof plausibilityIssueTargetSchema>;

export const plausibilityIssueObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SCALAR"), value: z.number().finite(), unit: unitSchema }).strict(),
  z
    .object({
      kind: z.literal("INTERVAL"),
      lower: z.number().finite().nullable(),
      upper: z.number().finite().nullable(),
      unit: unitSchema,
      source: dataSourceSchema,
      confidence: confidenceSchema,
    })
    .strict(),
]).superRefine((value, ctx) => {
  if (value.kind === "INTERVAL" && value.lower !== null && value.upper !== null && value.lower > value.upper) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "observation.lower は upper 以下である必要があります" });
  }
});
export type PlausibilityIssueObservation = z.infer<typeof plausibilityIssueObservationSchema>;

export const plausibilityIssueCertaintySchema = z.enum(["CONFIRMED_EXCEED", "POSSIBLE_EXCEED"]);

export const plausibilityIssueSchema = z
  .object({
    ruleId: z.string().trim().min(1).max(160),
    findingCode: z.string().trim().min(1).max(160),
    scope: plausibilityReviewScopeSchema,
    target: plausibilityIssueTargetSchema,
    observation: plausibilityIssueObservationSchema,
    boundary: z.object({ side: z.enum(["MIN", "MAX"]), threshold: z.number().finite() }).strict(),
    certainty: plausibilityIssueCertaintySchema,
    ruleSet: z.object({ version: z.string().trim().min(1).max(128), contentHash: sha256DigestSchema }).strict(),
    contextDigest: sha256DigestSchema,
    issueDigest: sha256DigestSchema,
  })
  .strict();
export type PlausibilityIssue = z.infer<typeof plausibilityIssueSchema>;
export type PlausibilityIssueDraft = Omit<PlausibilityIssue, "issueDigest">;

/** The client can request review only by digest and explicit human confirmations. */
export const plausibilityReviewRequestSchema = z
  .object({
    issueDigest: sha256DigestSchema,
    reason: z.string().trim().min(10, "PlausibilityReviewRequest.reason は10文字以上必要です").max(1000),
    firstConfirmed: z.literal(true),
    secondConfirmed: z.literal(true),
  })
  .strict();
export type PlausibilityReviewRequest = z.infer<typeof plausibilityReviewRequestSchema>;

export const appliedPlausibilityReviewSchema = plausibilityIssueSchema
  .omit({ issueDigest: true })
  .extend({
    issueDigest: sha256DigestSchema,
    reason: z.string().trim().min(10).max(1000),
    confirmedTwice: z.literal(true),
    actor: coachActorSchema,
    at: isoDateTimeSchema,
  })
  .strict();
export type AppliedPlausibilityReview = z.infer<typeof appliedPlausibilityReviewSchema>;
