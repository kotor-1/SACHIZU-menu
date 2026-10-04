import { z } from "zod";
import { exerciseVideoGuidanceSchema, type ExerciseVideoGuidance } from "./video-guidance";

export const VIDEO_GUIDANCE_PERSISTENCE_ERROR_CODES = [
  "NOT_FOUND", "DB_READ_FAILURE", "DB_WRITE_FAILURE", "WRITE_AUTHORITY_REQUIRED", "INVALID_PAYLOAD", "SOURCE_MISMATCH",
  "STALE_VIDEO_GUIDANCE", "CROSS_BOUNDARY", "OPERATION_KEY_CONFLICT",
] as const;
export type VideoGuidancePersistenceErrorCode = typeof VIDEO_GUIDANCE_PERSISTENCE_ERROR_CODES[number];

/** Stable, non-sensitive error codes; callers must not include raw payloads or secrets. */
export class VideoGuidancePersistenceError extends Error {
  constructor(readonly code: VideoGuidancePersistenceErrorCode) {
    super(code);
    this.name = "VideoGuidancePersistenceError";
  }
}

export const sourceBindingSchema = z.object({
  sourceVideoId: z.string().trim().min(1).max(64),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageKey: z.string().trim().min(1).max(1024),
  sourceUrl: z.string().trim().min(1).max(2000).nullable(),
}).strict();
export type SourceBinding = z.infer<typeof sourceBindingSchema>;

export const VIDEO_GUIDANCE_FIELDS = [
  "executionSummary", "movementPattern", "countingUnit", "bilateralCounting", "typicalStructure",
  "equipment", "setup", "keyCues", "commonErrors", "doseObservations",
] as const;
export const FIELD_ASSESSMENT_STATES = ["KNOWN", "UNRESOLVED", "NOT_OBSERVED", "NOT_APPLICABLE"] as const;
export const fieldAssessmentSchema = z.object({
  field: z.enum(VIDEO_GUIDANCE_FIELDS),
  state: z.enum(FIELD_ASSESSMENT_STATES),
  reason: z.string().trim().min(1).max(2000),
  evidenceRefs: z.array(z.string().trim().min(1).max(2048)).max(32),
}).strict();
export type FieldAssessment = z.infer<typeof fieldAssessmentSchema>;
export const fieldAssessmentsSchema = z.array(fieldAssessmentSchema).max(VIDEO_GUIDANCE_FIELDS.length)
  .refine((items) => new Set(items.map((item) => item.field)).size === items.length, "Duplicate field assessment");

const optionalMetadataText = z.string().trim().min(1).max(200).nullable().optional();
/** Unknown legacy metadata remain null/absent; importing does not invent a provider. */
export const aiMetadataSchema = z.object({
  provider: optionalMetadataText,
  model: optionalMetadataText,
  promptVersion: optionalMetadataText,
  schemaVersion: optionalMetadataText,
  promptHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
}).strict().nullable();
export type AIMetadata = z.infer<typeof aiMetadataSchema>;

export const VIDEO_GUIDANCE_REVISION_ORIGINS = ["AI_ANALYSIS", "COACH_REVIEW", "LEGACY_IMPORT"] as const;
export type VideoGuidanceRevisionOrigin = typeof VIDEO_GUIDANCE_REVISION_ORIGINS[number];

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new VideoGuidancePersistenceError("INVALID_PAYLOAD");
  return parsed.data;
}

export function parseSourceBinding(value: unknown): SourceBinding {
  return parseOrInvalid(sourceBindingSchema, value);
}
export function parseFieldAssessments(value: unknown): FieldAssessment[] {
  return parseOrInvalid(fieldAssessmentsSchema, value);
}
export function parseAIMetadata(value: unknown): AIMetadata {
  return parseOrInvalid(aiMetadataSchema, value);
}
export function parsePersistencePayload(value: unknown): ExerciseVideoGuidance {
  return parseOrInvalid(exerciseVideoGuidanceSchema, value);
}

/** Database ownership and current media fingerprints must be checked separately. */
export function assertGuidanceSourceBinding(guidance: ExerciseVideoGuidance, binding: SourceBinding): void {
  if (guidance.sourceVideoId !== binding.sourceVideoId) throw new VideoGuidancePersistenceError("SOURCE_MISMATCH");
}
