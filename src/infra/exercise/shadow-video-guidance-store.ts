import { isDeepStrictEqual } from "node:util";
import { exerciseVideoGuidanceSchema, type ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";
import {
  fieldAssessmentsSchema, sourceBindingSchema, VideoGuidancePersistenceError,
  type FieldAssessment, type SourceBinding,
} from "@/domain/exercise/video-guidance-persistence";
import type { StoredGuidance, VideoGuidanceRepository } from "@/infra/repositories/video-guidance-repository";
import type { VideoGuidanceStore } from "./video-guidance-store";
import { parseVideoGuidanceReadConfig, resolveVideoGuidanceReadMode, type VideoGuidanceReadConfigLoader } from "./video-guidance-read-config";

export type LegacyVideoGuidanceEvidence = {
  sourceBinding?: SourceBinding;
  fieldAssessment?: FieldAssessment[];
  /** Supplied legacy evidence, not inferred from natural-language guidance. */
  reviewedEffective?: boolean;
};
export type VideoGuidanceShadowCode = "MATCH" | "MISSING_SQL" | "MISSING_FILE" | "AUTHORITY_MISMATCH"
  | "PAYLOAD_MISMATCH" | "SOURCE_MISMATCH" | "INVALID_SQL" | "DB_READ_FAILURE";
export type VideoGuidanceShadowDiagnosis = {
  ownerId: string;
  exerciseId: string;
  code: VideoGuidanceShadowCode;
  codes: VideoGuidanceShadowCode[];
  reasons: string[];
  mismatchedFields: string[];
  comparison: "GUIDANCE" | "BOTH_ABSENT" | "INCOMPLETE";
};
export type ShadowVideoGuidanceStoreOptions = {
  fileStore: Pick<VideoGuidanceStore, "read">;
  sqlRepository: Pick<VideoGuidanceRepository, "readEffectiveGuidance">;
  configLoader?: VideoGuidanceReadConfigLoader;
  legacyEvidence: (ownerId: string, exerciseId: string) => Promise<LegacyVideoGuidanceEvidence | null>;
  onDiagnosis?: (diagnosis: VideoGuidanceShadowDiagnosis) => void | Promise<void>;
};

/** Snapshot configuration once for one caller's catalog read; subsequent sessions can switch modes. */
export async function createVideoGuidanceReadSession(options: ShadowVideoGuidanceStoreOptions): Promise<ShadowVideoGuidanceStore> {
  const config = parseVideoGuidanceReadConfig(options.configLoader
    ? await options.configLoader() : { version: 1, owners: {} });
  // Parsing validates and clones the owner map, so later loader/file mutations
  // cannot change authority halfway through a request's parallel item reads.
  return new ShadowVideoGuidanceStore({ ...options, configLoader: async () => config });
}

function validateSql(value: StoredGuidance, ownerId: string, exerciseId: string): StoredGuidance {
  const payload = exerciseVideoGuidanceSchema.safeParse(value?.guidance);
  const binding = sourceBindingSchema.safeParse(value?.sourceBinding);
  const fields = fieldAssessmentsSchema.safeParse(value?.fieldAssessment);
  if (!payload.success || !binding.success || !fields.success || !value.head
    || !isDeepStrictEqual(payload.data, value.guidance) || !isDeepStrictEqual(binding.data, value.sourceBinding)
    || !isDeepStrictEqual(fields.data, value.fieldAssessment)) throw new VideoGuidancePersistenceError("INVALID_PAYLOAD");
  if (typeof value.revisionId !== "string" || !value.revisionId.trim()
    || !Number.isSafeInteger(value.head.rowVersion) || value.head.rowVersion < 0
    || [value.head.approvedRevisionId, value.head.activeAiRevisionId, value.head.latestCandidateRevisionId]
      .some((pointer) => pointer !== null && (typeof pointer !== "string" || !pointer.trim()))) {
    throw new VideoGuidancePersistenceError("INVALID_PAYLOAD");
  }
  if (value.head.ownerId !== ownerId || value.head.exerciseId !== exerciseId) throw new VideoGuidancePersistenceError("CROSS_BOUNDARY");
  if (value.guidance.sourceVideoId !== value.sourceBinding.sourceVideoId) throw new VideoGuidancePersistenceError("SOURCE_MISMATCH");
  const reviewed = value.guidance.videoAnalysisStatus === "COACH_REVIEWED";
  if (reviewed ? value.head.approvedRevisionId !== value.revisionId
    : value.head.approvedRevisionId !== null || value.head.activeAiRevisionId !== value.revisionId) {
    throw new VideoGuidancePersistenceError("INVALID_PAYLOAD");
  }
  return value;
}

/** Mode selection is explicit and reloadable. This class never writes guidance or changes configuration. */
export class ShadowVideoGuidanceStore implements VideoGuidanceStore {
  constructor(private readonly options: ShadowVideoGuidanceStoreOptions) {}

  private async sql(ownerId: string, exerciseId: string) {
    try { return validateSql(await this.options.sqlRepository.readEffectiveGuidance(ownerId, exerciseId), ownerId, exerciseId); }
    catch (error) {
      if (error instanceof VideoGuidancePersistenceError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  private async report(diagnosis: VideoGuidanceShadowDiagnosis) {
    // Observability failures must not change FILE authority in shadow mode.
    try { await this.options.onDiagnosis?.(diagnosis); } catch { /* No payloads or raw errors are logged here. */ }
  }

  async read(ownerId: string, exerciseId: string): Promise<ExerciseVideoGuidance | null> {
    const config = this.options.configLoader ? await this.options.configLoader() : { version: 1 as const, owners: {} };
    const mode = resolveVideoGuidanceReadMode(config, ownerId);
    if (mode === "FILE") return this.options.fileStore.read(ownerId, exerciseId);
    if (mode === "SQL") return (await this.sql(ownerId, exerciseId))?.guidance ?? null;

    const file = await this.options.fileStore.read(ownerId, exerciseId);
    const diagnosis: VideoGuidanceShadowDiagnosis = {
      ownerId, exerciseId, code: "MATCH", codes: [], reasons: [], mismatchedFields: [], comparison: "INCOMPLETE",
    };
    let sql: StoredGuidance | null;
    try { sql = await this.sql(ownerId, exerciseId); }
    catch (error) {
      const code: VideoGuidanceShadowCode = error instanceof VideoGuidancePersistenceError
        ? error.code === "SOURCE_MISMATCH" ? "SOURCE_MISMATCH"
          : ["INVALID_PAYLOAD", "CROSS_BOUNDARY"].includes(error.code) ? "INVALID_SQL" : "DB_READ_FAILURE"
        : "DB_READ_FAILURE";
      await this.report({ ...diagnosis, code, codes: [code], reasons: [code] });
      return file;
    }
    if (!file || !sql) {
      const code = file ? "MISSING_SQL" : sql ? "MISSING_FILE" : "MATCH";
      await this.report({ ...diagnosis, code, codes: [code], reasons: [code === "MATCH" ? "BOTH_ABSENT" : code],
        comparison: code === "MATCH" ? "BOTH_ABSENT" : "INCOMPLETE" });
      return file;
    }

    const add = (code: VideoGuidanceShadowCode, reason: string, fields: string[]) => {
      if (!diagnosis.codes.includes(code)) diagnosis.codes.push(code);
      diagnosis.reasons.push(reason);
      diagnosis.mismatchedFields.push(...fields);
    };
    let evidence: LegacyVideoGuidanceEvidence | null = null;
    try { evidence = await this.options.legacyEvidence(ownerId, exerciseId); }
    catch { diagnosis.reasons.push("LEGACY_EVIDENCE_UNAVAILABLE"); }
    if (file.videoAnalysisStatus !== sql.guidance.videoAnalysisStatus || file.coachReviewedAt !== sql.guidance.coachReviewedAt) {
      add("AUTHORITY_MISMATCH", "AUTHORITY_OR_REVIEW_TIMESTAMP_DIFFERS", ["videoAnalysisStatus", "coachReviewedAt"]);
    }
    if (evidence?.reviewedEffective === undefined) add("AUTHORITY_MISMATCH", "LEGACY_REVIEWED_BASIS_UNKNOWN", ["reviewedEffective"]);
    else if (evidence.reviewedEffective !== (sql.head.approvedRevisionId === sql.revisionId)
      || evidence.reviewedEffective !== (file.videoAnalysisStatus === "COACH_REVIEWED")) {
      add("AUTHORITY_MISMATCH", "REVIEWED_EFFECTIVE_BASIS_DIFFERS", ["reviewedEffective"]);
    }
    const legacyBinding = sourceBindingSchema.safeParse(evidence?.sourceBinding);
    if (file.sourceVideoId !== sql.guidance.sourceVideoId) add("SOURCE_MISMATCH", "SOURCE_VIDEO_DIFFERS", ["sourceVideoId"]);
    if (!legacyBinding.success) add("SOURCE_MISMATCH", "LEGACY_SOURCE_BINDING_UNKNOWN", ["sourceBinding"]);
    else if (!isDeepStrictEqual(legacyBinding.data, evidence?.sourceBinding)
      || !isDeepStrictEqual(legacyBinding.data, sql.sourceBinding)
      || legacyBinding.data.sourceVideoId !== file.sourceVideoId) {
      add("SOURCE_MISMATCH", "SOURCE_BINDING_DIFFERS", ["sourceBinding"]);
    }
    const changedPayloadFields = Object.keys(sql.guidance).filter((key) =>
      !isDeepStrictEqual(file[key as keyof ExerciseVideoGuidance], sql.guidance[key as keyof ExerciseVideoGuidance]));
    if (changedPayloadFields.length) add("PAYLOAD_MISMATCH", "PAYLOAD_FIELDS_DIFFER", changedPayloadFields);
    const legacyFields = fieldAssessmentsSchema.safeParse(evidence?.fieldAssessment);
    if (!legacyFields.success) add("PAYLOAD_MISMATCH", "LEGACY_FIELD_ASSESSMENT_UNKNOWN", ["fieldAssessment"]);
    else if (!isDeepStrictEqual(legacyFields.data, evidence?.fieldAssessment)
      || !isDeepStrictEqual([...legacyFields.data].sort((a, b) => a.field.localeCompare(b.field)),
        [...sql.fieldAssessment].sort((a, b) => a.field.localeCompare(b.field)))) {
      add("PAYLOAD_MISMATCH", "FIELD_ASSESSMENT_DIFFERS", ["fieldAssessment"]);
    }
    diagnosis.comparison = "GUIDANCE";
    if (diagnosis.codes.length === 0) { diagnosis.codes.push("MATCH"); diagnosis.reasons.push("ALL_SUPPLIED_EVIDENCE_MATCHES"); }
    diagnosis.code = diagnosis.codes[0];
    diagnosis.mismatchedFields = [...new Set(diagnosis.mismatchedFields)];
    await this.report(diagnosis);
    return file;
  }

  async write(): Promise<never> { throw new VideoGuidancePersistenceError("WRITE_AUTHORITY_REQUIRED"); }
}
