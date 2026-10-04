import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { exerciseVideoGuidanceSchema } from "@/domain/exercise/video-guidance";
import {
  aiMetadataSchema, fieldAssessmentsSchema, sourceBindingSchema,
  type AIMetadata, type FieldAssessment, type SourceBinding,
} from "@/domain/exercise/video-guidance-persistence";
import type {
  LegacyGuidanceInput, VideoGuidanceRepository,
} from "@/infra/repositories/video-guidance-repository";

/** Bytes and binding metadata are supplied by an explicit offline import runner. */
export type LegacyVideoGuidanceEntry = {
  sourcePath: string;
  rawText: string;
  sourceSha256: string;
  sourceBinding: SourceBinding;
  fieldAssessment?: FieldAssessment[];
  aiMetadata?: AIMetadata;
  provenance?: Record<string, unknown>;
};

export type LegacyVideoGuidanceManifestInput = {
  ownerId: string;
  /** Exact caller-approved scope. Missing, duplicate or extra entries fail closed. */
  exerciseIds: readonly string[];
  entries: readonly LegacyVideoGuidanceEntry[];
};

const identity = z.string().min(1).max(128).refine((value) => value.trim() === value);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const legacyEntrySchema = z.object({
  ownerId: identity,
  exerciseId: identity,
  guidance: exerciseVideoGuidanceSchema,
}).strict();

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_LEGACY_GUIDANCE_METADATA");
  }
  // Refuse non-JSON metadata rather than dropping undefined, NaN or functions.
  const copy: unknown = JSON.parse(JSON.stringify(value));
  if (!isDeepStrictEqual(copy, value)) throw new Error("INVALID_LEGACY_GUIDANCE_METADATA");
  return copy as Record<string, unknown>;
}

/** Pure validation: no filesystem, database, video analysis or clock access. */
export function buildLegacyVideoGuidanceManifest(input: LegacyVideoGuidanceManifestInput) {
  identity.parse(input.ownerId);
  if (input.exerciseIds.length === 0 || input.entries.length !== input.exerciseIds.length) {
    throw new Error("INVALID_LEGACY_GUIDANCE_SCOPE");
  }
  const scope = new Set(input.exerciseIds.map((id) => identity.parse(id)));
  if (scope.size !== input.exerciseIds.length) throw new Error("DUPLICATE_LEGACY_GUIDANCE_SCOPE");
  const seen = new Set<string>();
  const entries: LegacyGuidanceInput[] = input.entries.map((entry) => {
    z.string().min(1).max(4096).parse(entry.sourcePath);
    z.string().min(1).max(32000).parse(entry.rawText);
    sha256.parse(entry.sourceSha256);
    if (hash(entry.rawText) !== entry.sourceSha256) throw new Error("LEGACY_GUIDANCE_SOURCE_HASH_MISMATCH");

    const raw: unknown = JSON.parse(entry.rawText);
    const parsed = legacyEntrySchema.parse(raw);
    // Existing schemas trim text. Import must not silently rewrite historical knowledge.
    if (!isDeepStrictEqual(parsed, raw)) throw new Error("LEGACY_GUIDANCE_PAYLOAD_TRANSFORMED");
    if (parsed.ownerId !== input.ownerId || !scope.has(parsed.exerciseId)) {
      throw new Error("INVALID_LEGACY_GUIDANCE_SCOPE");
    }
    if (seen.has(parsed.exerciseId)) throw new Error("DUPLICATE_LEGACY_GUIDANCE_ENTRY");
    seen.add(parsed.exerciseId);

    const sourceBinding = sourceBindingSchema.parse(entry.sourceBinding);
    if (!isDeepStrictEqual(sourceBinding, entry.sourceBinding)) throw new Error("LEGACY_GUIDANCE_BINDING_TRANSFORMED");
    if (sourceBinding.sourceVideoId !== parsed.guidance.sourceVideoId) throw new Error("INVALID_VIDEO_SOURCE");
    const rawAssessment = entry.fieldAssessment ?? [];
    const fieldAssessment = fieldAssessmentsSchema.parse(rawAssessment);
    if (!isDeepStrictEqual(fieldAssessment, rawAssessment)) throw new Error("LEGACY_GUIDANCE_METADATA_TRANSFORMED");
    const aiMetadata = aiMetadataSchema.parse(entry.aiMetadata ?? null);
    if (!isDeepStrictEqual(aiMetadata, entry.aiMetadata ?? null)) throw new Error("LEGACY_GUIDANCE_METADATA_TRANSFORMED");
    const provenance = {
      legacyImport: {
        sourcePath: entry.sourcePath,
        rawSourceHash: entry.sourceSha256,
        reviewerId: null,
        reviewerIdentity: "LEGACY_UNKNOWN",
        analyzedAt: parsed.guidance.analyzedAt,
        coachReviewedAt: parsed.guidance.coachReviewedAt,
      },
      suppliedEvidence: jsonObject(entry.provenance ?? {}),
    };
    return {
      ownerId: parsed.ownerId,
      exerciseId: parsed.exerciseId,
      operationKey: `legacy-import:${hash(JSON.stringify([parsed.ownerId, parsed.exerciseId, entry.sourceSha256]))}`,
      actor: { id: null, kind: "IMPORT" },
      reason: "Import validated legacy guidance; reviewer identity was not recorded.",
      sourceBinding,
      payload: parsed.guidance,
      fieldAssessment,
      aiMetadata,
      provenance,
      importSourceHash: entry.sourceSha256,
    };
  });
  // The scope/count/duplicate checks together require exactly the approved IDs.
  return { ownerId: input.ownerId, entries };
}

/**
 * Validate the entire manifest before the first write. Each repository operation
 * rechecks current source ownership/binding and is atomic and idempotent. A later
 * persistence failure can be resumed with the same manifest without reanalysis.
 */
export async function importLegacyVideoGuidance(input: LegacyVideoGuidanceManifestInput, deps: {
  repository: Pick<VideoGuidanceRepository, "importLegacy">;
}) {
  const manifest = buildLegacyVideoGuidanceManifest(input);
  const results: Awaited<ReturnType<VideoGuidanceRepository["importLegacy"]>>[] = [];
  for (const entry of manifest.entries) results.push(await deps.repository.importLegacy(entry));
  return { manifest, results };
}
