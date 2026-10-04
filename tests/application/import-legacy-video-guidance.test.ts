import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildLegacyVideoGuidanceManifest, importLegacyVideoGuidance,
  type LegacyVideoGuidanceEntry, type LegacyVideoGuidanceManifestInput,
} from "@/application/menu-composition/import-legacy-video-guidance";
import type { ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";
import type { VideoGuidanceRepository } from "@/infra/repositories/video-guidance-repository";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const guidance = (exerciseId: string): ExerciseVideoGuidance => ({
  executionSummary: "支えを使って動きを確認する", movementPattern: "左右を順に動かす",
  countingUnit: "CUSTOM", bilateralCounting: null, typicalStructure: null,
  equipment: ["支え"], setup: null, keyCues: ["姿勢を確認する"], commonErrors: [], doseObservations: [],
  videoAnalysisStatus: "COACH_REVIEWED", sourceVideoId: `video-${exerciseId}`, analysisVersion: "legacy-v1",
  analyzedAt: "2026-09-29T03:00:00.000Z", coachReviewedAt: "2026-10-01T05:00:00.000Z",
});
function record(exerciseId: string, change: Partial<ExerciseVideoGuidance> = {}): LegacyVideoGuidanceEntry {
  const payload = { ...guidance(exerciseId), ...change };
  const rawText = JSON.stringify({ ownerId: "owner-a", exerciseId, guidance: payload }, null, 2);
  return {
    sourcePath: `/offline/legacy/${exerciseId}.json`, rawText, sourceSha256: sha(rawText),
    sourceBinding: {
      sourceVideoId: payload.sourceVideoId, contentSha256: sha(`media-${exerciseId}`),
      storageKey: `uploads/${exerciseId}.mp4`, sourceUrl: null,
    },
  };
}
function input(...entries: LegacyVideoGuidanceEntry[]): LegacyVideoGuidanceManifestInput {
  return { ownerId: "owner-a", exerciseIds: entries.map((entry) => JSON.parse(entry.rawText).exerciseId), entries };
}
function replaceRaw(entry: LegacyVideoGuidanceEntry, mutate: (value: ReturnType<typeof JSON.parse>) => void) {
  const raw = JSON.parse(entry.rawText);
  mutate(raw);
  const rawText = JSON.stringify(raw);
  return { ...entry, rawText, sourceSha256: sha(rawText) };
}
function repository() {
  return { importLegacy: vi.fn<VideoGuidanceRepository["importLegacy"]>() };
}

describe("explicit offline legacy video-guidance import", () => {
  it("preserves exact payload, timestamps and explicitly unknown reviewer identity", async () => {
    const original = record("exercise-one");
    const before = structuredClone(original);
    const repo = repository();
    const result = await importLegacyVideoGuidance(input(original), { repository: repo });
    expect(original).toEqual(before);
    expect(repo.importLegacy).toHaveBeenCalledOnce();
    expect(result.manifest.entries[0]).toMatchObject({
      ownerId: "owner-a", exerciseId: "exercise-one", payload: JSON.parse(original.rawText).guidance,
      actor: { id: null, kind: "IMPORT" }, aiMetadata: null, importSourceHash: original.sourceSha256,
      provenance: { legacyImport: {
        reviewerId: null, reviewerIdentity: "LEGACY_UNKNOWN",
        sourcePath: original.sourcePath, rawSourceHash: original.sourceSha256,
        analyzedAt: "2026-09-29T03:00:00.000Z", coachReviewedAt: "2026-10-01T05:00:00.000Z",
      } },
    });
  });

  it("derives stable operation keys from owner, exercise and raw bytes", () => {
    const original = record("exercise-one");
    const first = buildLegacyVideoGuidanceManifest(input(original)).entries[0];
    const second = buildLegacyVideoGuidanceManifest(input(structuredClone(original))).entries[0];
    expect(first.operationKey).toBe(second.operationKey);
    const changedRaw = { ...original, rawText: `${original.rawText}\n`, sourceSha256: sha(`${original.rawText}\n`) };
    expect(buildLegacyVideoGuidanceManifest(input(changedRaw)).entries[0].operationKey).not.toBe(first.operationKey);
  });

  it("validates every record before writing any, including a corrupt last source hash", async () => {
    const repo = repository();
    const last = { ...record("exercise-two"), sourceSha256: "0".repeat(64) };
    await expect(importLegacyVideoGuidance(input(record("exercise-one"), last), { repository: repo }))
      .rejects.toThrow("LEGACY_GUIDANCE_SOURCE_HASH_MISMATCH");
    expect(repo.importLegacy).not.toHaveBeenCalled();
  });

  it("rejects later schema corruption before the first write", async () => {
    const repo = repository();
    const last = replaceRaw(record("exercise-two"), (raw) => { raw.guidance.countingUnit = "NOT_AN_ENUM"; });
    await expect(importLegacyVideoGuidance(input(record("exercise-one"), last), { repository: repo })).rejects.toThrow();
    expect(repo.importLegacy).not.toHaveBeenCalled();
  });

  it("requires exactly the caller-approved exercise scope and owner", () => {
    const original = record("exercise-one");
    expect(() => buildLegacyVideoGuidanceManifest({ ...input(original), ownerId: "other-owner" })).toThrow("INVALID_LEGACY_GUIDANCE_SCOPE");
    expect(() => buildLegacyVideoGuidanceManifest({ ...input(original), exerciseIds: ["other-exercise"] })).toThrow("INVALID_LEGACY_GUIDANCE_SCOPE");
    expect(() => buildLegacyVideoGuidanceManifest({ ...input(original), exerciseIds: ["exercise-one", "exercise-two"] })).toThrow("INVALID_LEGACY_GUIDANCE_SCOPE");
    expect(() => buildLegacyVideoGuidanceManifest({ ownerId: "owner-a", exerciseIds: [], entries: [] })).toThrow("INVALID_LEGACY_GUIDANCE_SCOPE");
  });

  it("rejects duplicate scope and duplicate records", () => {
    const one = record("exercise-one");
    expect(() => buildLegacyVideoGuidanceManifest(input(one, one))).toThrow("DUPLICATE_LEGACY_GUIDANCE_SCOPE");
    expect(() => buildLegacyVideoGuidanceManifest({ ...input(one, record("exercise-two")), entries: [one, one] }))
      .toThrow("DUPLICATE_LEGACY_GUIDANCE_ENTRY");
  });

  it("requires the payload's exact video binding and a content SHA", () => {
    const one = record("exercise-one");
    expect(() => buildLegacyVideoGuidanceManifest(input({ ...one, sourceBinding: { ...one.sourceBinding, sourceVideoId: "another-video" } })))
      .toThrow("INVALID_VIDEO_SOURCE");
    expect(() => buildLegacyVideoGuidanceManifest(input({ ...one, sourceBinding: { ...one.sourceBinding, contentSha256: "" } }))).toThrow();
  });

  it("rejects payload/binding trim transformations instead of changing legacy knowledge", () => {
    expect(() => buildLegacyVideoGuidanceManifest(input(record("exercise-one", { executionSummary: "  元の文章  " }))))
      .toThrow("LEGACY_GUIDANCE_PAYLOAD_TRANSFORMED");
    const one = record("exercise-one");
    expect(() => buildLegacyVideoGuidanceManifest(input({ ...one, sourceBinding: { ...one.sourceBinding, storageKey: " uploads/one.mp4 " } })))
      .toThrow("LEGACY_GUIDANCE_BINDING_TRANSFORMED");
  });

  it("keeps caller-declared partial field evidence without promoting AI authority", () => {
    const partial = record("exercise-partial", {
      videoAnalysisStatus: "AI_ANALYZED", coachReviewedAt: null,
      bilateralCounting: "左右の順序は未確定", doseObservations: [],
    });
    partial.fieldAssessment = [{ field: "bilateralCounting", state: "UNRESOLVED", reason: "原記録に左右順の定義なし", evidenceRefs: ["legacy-note"] }];
    partial.provenance = { source: "legacy note", reviewerId: "untrusted-supplied-field" };
    const imported = buildLegacyVideoGuidanceManifest(input(partial)).entries[0];
    expect(imported.fieldAssessment).toEqual(partial.fieldAssessment);
    expect(imported.payload).toEqual(JSON.parse(partial.rawText).guidance);
    expect(imported.payload.videoAnalysisStatus).toBe("AI_ANALYZED");
    expect(imported.provenance).toMatchObject({ legacyImport: { reviewerId: null }, suppliedEvidence: partial.provenance });
    expect(imported.actor.id).toBeNull();
  });

  it("does not derive field states from guidance wording", () => {
    const one = record("exercise-one", { bilateralCounting: "UNRESOLVED: 手元の情報だけでは確定しない" });
    expect(buildLegacyVideoGuidanceManifest(input(one)).entries[0].fieldAssessment).toEqual([]);
  });

  it("prevalidates duplicate field assessments and invalid metadata before any writes", async () => {
    const repo = repository();
    const last = record("exercise-two");
    const field = { field: "countingUnit", state: "KNOWN", reason: "原記録", evidenceRefs: [] } as const;
    last.fieldAssessment = [{ ...field, evidenceRefs: [] }, { ...field, evidenceRefs: [] }];
    await expect(importLegacyVideoGuidance(input(record("exercise-one"), last), { repository: repo })).rejects.toThrow();
    expect(repo.importLegacy).not.toHaveBeenCalled();
    const withInvalidJson = { ...record("exercise-three"), provenance: { confidence: Number.NaN } };
    await expect(importLegacyVideoGuidance(input(record("exercise-one"), withInvalidJson), { repository: repo }))
      .rejects.toThrow("INVALID_LEGACY_GUIDANCE_METADATA");
    expect(repo.importLegacy).not.toHaveBeenCalled();
  });

  it("retains only supplied provider metadata and rejects schema normalization", () => {
    const one = record("exercise-one");
    one.aiMetadata = { provider: null, model: null, promptVersion: "legacy-v1" };
    expect(buildLegacyVideoGuidanceManifest(input(one)).entries[0].aiMetadata).toEqual(one.aiMetadata);
    one.aiMetadata = { model: " model-with-padding " };
    expect(() => buildLegacyVideoGuidanceManifest(input(one))).toThrow("LEGACY_GUIDANCE_METADATA_TRANSFORMED");
  });

  it("propagates persistence failure without retries or a second write", async () => {
    const repo = repository();
    repo.importLegacy.mockRejectedValueOnce(new Error("DB_UNAVAILABLE"));
    await expect(importLegacyVideoGuidance(input(record("exercise-one"), record("exercise-two")), { repository: repo }))
      .rejects.toThrow("DB_UNAVAILABLE");
    expect(repo.importLegacy).toHaveBeenCalledOnce();
  });
});
