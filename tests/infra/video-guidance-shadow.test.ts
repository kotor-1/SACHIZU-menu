import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";
import { VideoGuidancePersistenceError, type FieldAssessment } from "@/domain/exercise/video-guidance-persistence";
import type { StoredGuidance } from "@/infra/repositories/video-guidance-repository";
import {
  ShadowVideoGuidanceStore, type LegacyVideoGuidanceEvidence,
} from "@/infra/exercise/shadow-video-guidance-store";
import {
  createFileVideoGuidanceReadConfigLoader, parseVideoGuidanceReadConfig, resolveVideoGuidanceReadMode,
  type VideoGuidanceReadConfig, type VideoGuidanceReadMode,
} from "@/infra/exercise/video-guidance-read-config";

const owner = "owner-a";
const exercise = "exercise-a";
const payload: ExerciseVideoGuidance = {
  executionSummary: "足を上げて下ろす", movementPattern: "脚の上げ下げ", countingUnit: "CUSTOM",
  bilateralCounting: null, typicalStructure: null, equipment: [], setup: null,
  keyCues: ["姿勢を保つ"], commonErrors: [], doseObservations: [],
  videoAnalysisStatus: "AI_ANALYZED", sourceVideoId: "video-a", analysisVersion: "fixture-v1",
  analyzedAt: "2026-10-01T00:00:00.000Z", coachReviewedAt: null,
};
const binding = { sourceVideoId: "video-a", contentSha256: "a".repeat(64), storageKey: "uploads/a.mp4", sourceUrl: null };
const partialFields: FieldAssessment[] = [{ field: "countingUnit", state: "UNRESOLVED", reason: "元資料では定義未確定", evidenceRefs: ["fixture:record"] }];
function sqlRecord(reviewed = false): StoredGuidance {
  return {
    revisionId: "revision-a",
    head: { ownerId: owner, exerciseId: exercise, approvedRevisionId: reviewed ? "revision-a" : null,
      activeAiRevisionId: reviewed ? null : "revision-a", latestCandidateRevisionId: reviewed ? null : "revision-a",
      rowVersion: 1, updatedAt: new Date("2026-10-02T00:00:00.000Z") },
    guidance: reviewed ? { ...structuredClone(payload), videoAnalysisStatus: "COACH_REVIEWED", coachReviewedAt: "2026-10-02T00:00:00.000Z" } : structuredClone(payload),
    sourceBinding: { ...binding }, fieldAssessment: reviewed ? [] : structuredClone(partialFields),
  };
}
function setup(mode: VideoGuidanceReadMode = "SHADOW", reviewed = false) {
  const sql = sqlRecord(reviewed);
  const file = structuredClone(sql.guidance);
  const fileRead = vi.fn(async (): Promise<ExerciseVideoGuidance | null> => file);
  const sqlRead = vi.fn(async (): Promise<StoredGuidance> => sql);
  const legacyEvidence = vi.fn(async (): Promise<LegacyVideoGuidanceEvidence | null> => ({
    sourceBinding: { ...binding }, fieldAssessment: structuredClone(sql.fieldAssessment), reviewedEffective: reviewed,
  }));
  const onDiagnosis = vi.fn();
  const configLoader = vi.fn(async (): Promise<VideoGuidanceReadConfig> => ({ version: 1, owners: { [owner]: mode } }));
  const store = new ShadowVideoGuidanceStore({ fileStore: { read: fileRead }, sqlRepository: { readEffectiveGuidance: sqlRead },
    legacyEvidence, onDiagnosis, configLoader });
  return { store, sql, file, fileRead, sqlRead, legacyEvidence, onDiagnosis, configLoader };
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("explicit video guidance read authority", () => {
  it("FILE returns only legacy data and never reads SQL/evidence", async () => {
    const t = setup("FILE");
    t.sqlRead.mockRejectedValue(new Error("SQL unavailable"));
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    expect(t.sqlRead).not.toHaveBeenCalled(); expect(t.legacyEvidence).not.toHaveBeenCalled();
    expect(t.onDiagnosis).not.toHaveBeenCalled();
  });

  it("defaults to FILE when no loader or owner override exists", async () => {
    const t = setup();
    const store = new ShadowVideoGuidanceStore({ fileStore: { read: t.fileRead }, sqlRepository: { readEffectiveGuidance: t.sqlRead }, legacyEvidence: t.legacyEvidence });
    expect(await store.read(owner, exercise)).toBe(t.file);
    expect(await t.store.read("another-owner", exercise)).toBe(t.file);
    expect(t.sqlRead).not.toHaveBeenCalled();
  });

  it.each([false, true])("SHADOW compares supplied evidence, returns FILE, and never mutates authority (reviewed=%s)", async (reviewed) => {
    const t = setup("SHADOW", reviewed);
    const original = structuredClone(t.sql);
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    expect(t.onDiagnosis).toHaveBeenCalledWith(expect.objectContaining({ code: "MATCH", codes: ["MATCH"], comparison: "GUIDANCE" }));
    expect(t.sql).toEqual(original);
  });

  it("preserves explicit partial/unresolved metadata without turning AI guidance into reviewed guidance", async () => {
    const t = setup();
    const result = await t.store.read(owner, exercise);
    expect(result?.videoAnalysisStatus).toBe("AI_ANALYZED");
    expect(t.sql.head.approvedRevisionId).toBeNull();
    expect(t.sql.fieldAssessment).toEqual(partialFields);
    expect(t.onDiagnosis.mock.calls[0][0].code).toBe("MATCH");
  });

  it("does not claim MATCH when legacy evidence is missing", async () => {
    const t = setup(); t.legacyEvidence.mockResolvedValue(null);
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    const diagnosis = t.onDiagnosis.mock.calls[0][0];
    expect(diagnosis.codes).toEqual(expect.arrayContaining(["SOURCE_MISMATCH", "PAYLOAD_MISMATCH", "AUTHORITY_MISMATCH"]));
    expect(diagnosis.codes).not.toContain("MATCH");
    expect(diagnosis.reasons).toContain("LEGACY_FIELD_ASSESSMENT_UNKNOWN");
  });

  it("does not infer missing field assessment or reviewed basis from wording/status", async () => {
    const t = setup("SHADOW", true);
    t.legacyEvidence.mockResolvedValue({ sourceBinding: binding });
    await t.store.read(owner, exercise);
    expect(t.onDiagnosis.mock.calls[0][0].codes).toEqual(["AUTHORITY_MISMATCH", "PAYLOAD_MISMATCH"]);
  });

  it("records source fingerprint mismatches without leaking source values", async () => {
    const t = setup();
    t.legacyEvidence.mockResolvedValue({ sourceBinding: { ...binding, contentSha256: "b".repeat(64) }, fieldAssessment: partialFields, reviewedEffective: false });
    await t.store.read(owner, exercise);
    expect(t.onDiagnosis.mock.calls[0][0]).toMatchObject({ code: "SOURCE_MISMATCH", mismatchedFields: ["sourceBinding"] });
    expect(JSON.stringify(t.onDiagnosis.mock.calls)).not.toContain("b".repeat(64));
  });

  it("records payload and unresolved field mismatches while preserving FILE content", async () => {
    const t = setup(); t.sql.guidance.keyCues = ["別の指示"];
    t.sql.fieldAssessment = [];
    t.legacyEvidence.mockResolvedValue({ sourceBinding: binding, fieldAssessment: partialFields, reviewedEffective: false });
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    expect(t.onDiagnosis.mock.calls[0][0]).toMatchObject({ code: "PAYLOAD_MISMATCH", mismatchedFields: ["keyCues", "fieldAssessment"] });
    expect(JSON.stringify(t.onDiagnosis.mock.calls)).not.toContain("別の指示");
  });

  it("reports valid SQL authority differences, without replacing FILE authority", async () => {
    const t = setup(); t.sqlRead.mockResolvedValue(sqlRecord(true));
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    expect(t.onDiagnosis.mock.calls[0][0].code).toBe("AUTHORITY_MISMATCH");
  });

  it("distinguishes missing SQL, missing FILE, and absence in both stores", async () => {
    const t = setup(); t.sqlRead.mockRejectedValue(new VideoGuidancePersistenceError("NOT_FOUND"));
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    expect(t.onDiagnosis.mock.calls.at(-1)![0].code).toBe("MISSING_SQL");
    t.fileRead.mockResolvedValue(null); t.sqlRead.mockResolvedValue(t.sql);
    expect(await t.store.read(owner, exercise)).toBeNull();
    expect(t.onDiagnosis.mock.calls.at(-1)![0].code).toBe("MISSING_FILE");
    t.sqlRead.mockRejectedValue(new VideoGuidancePersistenceError("NOT_FOUND"));
    expect(await t.store.read(owner, exercise)).toBeNull();
    expect(t.onDiagnosis.mock.calls.at(-1)![0]).toMatchObject({ code: "MATCH", comparison: "BOTH_ABSENT", reasons: ["BOTH_ABSENT"] });
  });

  it.each(["DB_READ_FAILURE", "INVALID_PAYLOAD", "SOURCE_MISMATCH", "CROSS_BOUNDARY"] as const)("SHADOW reports SQL %s but returns FILE", async (code) => {
    const t = setup(); t.sqlRead.mockRejectedValue(new VideoGuidancePersistenceError(code));
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    const expected = code === "INVALID_PAYLOAD" || code === "CROSS_BOUNDARY" ? "INVALID_SQL" : code;
    expect(t.onDiagnosis.mock.calls[0][0].code).toBe(expected);
  });

  it("does not expose unexpected database error messages in diagnostics", async () => {
    const t = setup(); t.sqlRead.mockRejectedValue(new Error("secret credential in provider error"));
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    expect(t.onDiagnosis.mock.calls[0][0].code).toBe("DB_READ_FAILURE");
    expect(JSON.stringify(t.onDiagnosis.mock.calls)).not.toContain("secret credential");
  });

  it("reports malformed SQL payloads and inconsistent approved pointers as INVALID_SQL", async () => {
    const t = setup(); t.sql.guidance.executionSummary = " trimmed unexpectedly ";
    await t.store.read(owner, exercise);
    expect(t.onDiagnosis.mock.calls.at(-1)![0].code).toBe("INVALID_SQL");
    t.sql.guidance.executionSummary = payload.executionSummary;
    t.sql.head.approvedRevisionId = "another-revision";
    await t.store.read(owner, exercise);
    expect(t.onDiagnosis.mock.calls.at(-1)![0].code).toBe("INVALID_SQL");
  });

  it("does not substitute SQL when FILE or the diagnostic sink fails", async () => {
    const t = setup(); t.onDiagnosis.mockRejectedValue(new Error("diagnostic unavailable"));
    expect(await t.store.read(owner, exercise)).toBe(t.file);
    t.fileRead.mockRejectedValue(new Error("FILE_READ_FAILED"));
    await expect(t.store.read(owner, exercise)).rejects.toThrow("FILE_READ_FAILED");
    expect(t.sqlRead).toHaveBeenCalledOnce();
  });

  it("SQL mode reads SQL alone without FILE fallback or legacy evidence", async () => {
    const t = setup("SQL"); t.fileRead.mockRejectedValue(new Error("FILE unavailable"));
    expect(await t.store.read(owner, exercise)).toBe(t.sql.guidance);
    expect(t.fileRead).not.toHaveBeenCalled(); expect(t.legacyEvidence).not.toHaveBeenCalled();
    expect(t.onDiagnosis).not.toHaveBeenCalled();
  });

  it.each(["DB_READ_FAILURE", "INVALID_PAYLOAD", "SOURCE_MISMATCH", "CROSS_BOUNDARY"] as const)("SQL propagates %s without fallback", async (code) => {
    const t = setup("SQL"); t.sqlRead.mockRejectedValue(new VideoGuidancePersistenceError(code));
    await expect(t.store.read(owner, exercise)).rejects.toMatchObject({ code });
    expect(t.fileRead).not.toHaveBeenCalled();
  });

  it("SQL treats only NOT_FOUND as absence and rejects malformed effective records", async () => {
    const t = setup("SQL"); t.sqlRead.mockRejectedValueOnce(new VideoGuidancePersistenceError("NOT_FOUND"));
    expect(await t.store.read(owner, exercise)).toBeNull();
    t.sql.head.ownerId = "other-owner";
    await expect(t.store.read(owner, exercise)).rejects.toMatchObject({ code: "CROSS_BOUNDARY" });
    expect(t.fileRead).not.toHaveBeenCalled();
  });

  it("reloads the owner flag and rejects invalid config before reading either store", async () => {
    const t = setup("FILE");
    await t.store.read(owner, exercise);
    t.configLoader.mockResolvedValue({ version: 1, owners: { [owner]: "SQL" } });
    await t.store.read(owner, exercise);
    t.configLoader.mockResolvedValue({ version: 1, owners: { [owner]: "AUTO" } } as unknown as VideoGuidanceReadConfig);
    await expect(t.store.read(owner, exercise)).rejects.toMatchObject({ code: "INVALID_VIDEO_GUIDANCE_READ_CONFIG" });
    expect(t.fileRead).toHaveBeenCalledOnce(); expect(t.sqlRead).toHaveBeenCalledOnce();
  });

  it("never writes legacy or SQL guidance through the compatibility interface", async () => {
    await expect(setup().store.write()).rejects.toMatchObject({ code: "WRITE_AUTHORITY_REQUIRED" });
  });
});

describe("local reloadable per-owner read config", () => {
  it("defaults missing config/owner to FILE and reloads explicit owner modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "guidance-read-config-")); directories.push(directory);
    const path = join(directory, "private-config.json");
    const load = createFileVideoGuidanceReadConfigLoader(path);
    expect(resolveVideoGuidanceReadMode(await load(), owner)).toBe("FILE");
    for (const mode of ["SHADOW", "SQL", "FILE"] as const) {
      await writeFile(path, JSON.stringify({ version: 1, owners: { [owner]: mode } }));
      expect(resolveVideoGuidanceReadMode(await load(), owner)).toBe(mode);
      expect(resolveVideoGuidanceReadMode(await load(), "other-owner")).toBe("FILE");
    }
  });

  it.each([
    { version: 1, owners: { [owner]: "AUTO" } },
    { version: 2, owners: {} }, { version: 1, owners: {}, defaultMode: "SQL" },
    { version: 1, owners: { " owner-a ": "SQL" } },
  ])("fails closed for unsupported or ambiguous config %j", (value) => {
    expect(() => parseVideoGuidanceReadConfig(value)).toThrow("INVALID_VIDEO_GUIDANCE_READ_CONFIG");
  });

  it("rejects malformed local JSON and read errors without silently returning FILE", async () => {
    const directory = await mkdtemp(join(tmpdir(), "guidance-read-config-")); directories.push(directory);
    const path = join(directory, "private-config.json");
    await writeFile(path, "{not valid json}");
    await expect(createFileVideoGuidanceReadConfigLoader(path)()).rejects.toMatchObject({ code: "INVALID_VIDEO_GUIDANCE_READ_CONFIG" });
    await expect(createFileVideoGuidanceReadConfigLoader(directory)()).rejects.toMatchObject({ code: "VIDEO_GUIDANCE_READ_CONFIG_READ_FAILURE" });
  });
});
