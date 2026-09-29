import { describe, expect, it } from "vitest";
import { planRunningPrescription } from "@/domain/running-policy/engine";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { applyRunningCoachEdit } from "@/application/running-menu/coach-edit";
import {
  finalRunningMenuPrescription, parseRunningMenuEnvelope, presentRunningMenuSnapshot,
  runningMenuEnvelopeSchema, serializeRunningMenuEnvelope, serializeRunningMenuEnvelopeV2,
} from "@/application/running-menu/persistence";
import { snapshotSavedRunningMenuItem, parseRunningSessionSnapshot, serializeRunningSessionSnapshot } from "@/application/running-session/snapshot";

const at = "2026-09-29T10:00:00.000Z";

function fixture(options: { event?: "100m" | "200m"; age?: "JUNIOR_HIGH" | "HIGH_SCHOOL"; light?: boolean; distance?: number; time?: number } = {}) {
  const event = options.event ?? "100m";
  const ageGroup = options.age ?? "HIGH_SCHOOL";
  const result = planRunningPrescription({
    event, ageGroup, humanExplicitDistances: options.distance ? [options.distance] : [],
    loadReductionRequested: options.light ?? false,
    ...(options.time ? { availableTimeSeconds: options.time } : {}),
  });
  if (result.status !== "READY") throw new Error(result.status);
  const p = result.prescription;
  const envelope = runningMenuEnvelopeSchema.parse({
    kind: "RUNNING_POLICY", schemaVersion: 1, policyVersion: p.policyVersion,
    policyHash: p.policyHash, prescription: p,
  });
  const provenanceJson = JSON.stringify({
    schemaVersion: 1, source: "SIGNED_RUNNING_PREVIEW", requestDigest: "0".repeat(64),
    intent: {
      event: { value: event }, ageGroup: { value: ageGroup },
      loadReductionRequested: options.light ? { value: true } : null,
      fatigueState: null, availableTimeSeconds: options.time ? { value: options.time } : null,
    }, context: {},
  });
  return { p, envelope, provenanceJson };
}

function edit(input: ReturnType<typeof fixture>, request: unknown) {
  return applyRunningCoachEdit(input.envelope, input.provenanceJson, request, at);
}

function sessionSource(input: ReturnType<typeof fixture>, prescriptionJson: string) {
  const envelope = parseRunningMenuEnvelope("RUNNING_POLICY", prescriptionJson)!;
  const p = finalRunningMenuPrescription(envelope);
  return {
    id: "item-1", prescriptionKind: "RUNNING_POLICY", prescriptionJson,
    provenanceJson: input.provenanceJson, exerciseId: null, runningMethod: null,
    sessionTemplateId: null, ruleSetVersion: null, ruleSetContentHash: null,
    distanceMeters: p.distanceMeters, reps: p.totalReps, sets: p.sets,
    restSeconds: p.repRestSeconds, setRestSeconds: p.setRestSeconds,
    durationSeconds: null, intensityPercent: null, loadKg: null,
    recoveryStructure: null, buildUpDistanceMeters: null, flyZoneDistanceMeters: null,
    intraRepRestSeconds: null, intensityReferenceKind: null,
    prescriptionConfidence: null, rationale: null,
  };
}

describe("Coach edit v2 contracts and frozen policy", () => {
  it.each([
    [{ totalReps: 5, repRestSeconds: 300 }, 5, 300],
    [{ totalReps: 3, repRestSeconds: 180 }, 3, 180],
  ] as const)("accepts in-range 60m edit %j", (request, reps, rest) => {
    const source = fixture();
    const result = edit(source, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.finalPrescription).toMatchObject({ distanceMeters: 60, totalReps: reps, repRestSeconds: rest, minimumKnownRestSeconds: (reps - 1) * rest });
    expect(result.envelope.basePrescription).toMatchObject({ totalReps: 4, repRestSeconds: 240, repsPosition: "DEFAULT" });
    expect(result.envelope.coachEditProvenance.edits).toEqual(expect.arrayContaining([expect.objectContaining({ field: "totalReps", actorClass: "COACH", at })]));
  });

  it.each([{ totalReps: 6 }, { totalReps: 10, repRestSeconds: 60 }, { repRestSeconds: 60 }])("rejects range outside without clamping: %j", (request) => {
    expect(edit(fixture(), request)).toEqual({ ok: false, code: "RANGE_OUTSIDE" });
  });

  it.each([
    [50, 4, 240], [100, 3, 720],
  ] as const)("replans 60m to %im through the current policy", (distance, reps, rest) => {
    const result = edit(fixture(), { distanceMeters: distance });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.basePrescription).toMatchObject({ distanceMeters: distance, totalReps: reps, repRestSeconds: rest });
    expect(result.envelope.finalPrescription).toMatchObject({ distanceMeters: distance, totalReps: reps, repRestSeconds: rest });
    expect(result.envelope.policyVersion).toBe(RUNNING_POLICY_VERSION);
    expect(result.envelope.policyHash).toBe(RUNNING_POLICY_HASH);
  });

  it.each([40, 80])("does not silently replace rejected %im", (distance) => {
    expect(edit(fixture(), { distanceMeters: distance })).toEqual({ ok: false, code: "DISTANCE_REVIEW_REQUIRED" });
  });

  it("retains Phase D history gate when a junior high coach requests 200m", () => {
    expect(edit(fixture({ age: "JUNIOR_HIGH" }), { distanceMeters: 200 })).toEqual({ ok: false, code: "DISTANCE_REVIEW_REQUIRED" });
  });

  it("retains explicit load reduction after distance replanning", () => {
    const result = edit(fixture({ light: true }), { distanceMeters: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.basePrescription).toMatchObject({ distanceMeters: 50, totalReps: 3, repsPosition: "MIN", loadReductionRequested: true });
  });

  it("rejects an edit whose known rest exceeds originally available time", () => {
    expect(edit(fixture({ time: 900 }), { totalReps: 5, repRestSeconds: 300 })).toEqual({ ok: false, code: "TIME_ADJUSTMENT_REQUIRED" });
  });

  it("adds, changes and removes a coach target time without modifying Engine metadata", () => {
    const source = fixture();
    const added = edit(source, { coachTargetTimeSeconds: 7.7 });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const changed = applyRunningCoachEdit(added.envelope, source.provenanceJson, { coachTargetTimeRange: { minSeconds: 7.6, maxSeconds: 7.8 } }, at);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.envelope.finalPrescription).toMatchObject({ coachTargetTimeSeconds: null, coachTargetTimeRange: { minSeconds: 7.6, maxSeconds: 7.8 } });
    const removed = applyRunningCoachEdit(changed.envelope, source.provenanceJson, { coachTargetTimeRange: null }, at);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.envelope.finalPrescription.coachTargetTimeRange).toBeNull();
  });

  it("adds, changes and removes plain-language execution instructions", () => {
    const source = fixture();
    const added = edit(source, { executionInstructionText: "フォームを保って" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const changed = applyRunningCoachEdit(added.envelope, source.provenanceJson, { executionInstructionText: "力まず走る" }, at);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    const removed = applyRunningCoachEdit(changed.envelope, source.provenanceJson, { executionInstructionText: null }, at);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.envelope.finalPrescription.executionInstructionText).toBeNull();
  });

  it("uses total set-boundary rest without adding rep rest", () => {
    const source = fixture({ distance: 30 });
    const result = edit(source, { setReps: [3, 2], setRestSeconds: 600 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.finalPrescription).toMatchObject({ totalReps: 5, sets: 2, setReps: [3, 2], setRestSeconds: 600, minimumKnownRestSeconds: 4 * 180 + 600 - 180 });
  });

  it.each([
    { setReps: [3, 1], setRestSeconds: 600 },
    { setReps: [3, 2] },
    { setRestSeconds: 600 },
  ])("rejects incomplete or inconsistent split %j", (request) => {
    expect(edit(fixture({ distance: 30 }), request).ok).toBe(false);
  });

  it("preserves v1 bytes, reads v2 final and snapshots coach provenance independently", () => {
    const source = fixture();
    const v1 = serializeRunningMenuEnvelope(source.p);
    expect(parseRunningMenuEnvelope("RUNNING_POLICY", v1)?.schemaVersion).toBe(1);
    const result = edit(source, { totalReps: 5, repRestSeconds: 300 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v2 = serializeRunningMenuEnvelopeV2(result.envelope);
    expect(parseRunningMenuEnvelope("RUNNING_POLICY", v2)).toMatchObject({ schemaVersion: 2, finalPrescription: { totalReps: 5, repRestSeconds: 300 }, basePrescription: { totalReps: 4 } });
    expect(presentRunningMenuSnapshot("RUNNING_POLICY", v2)).toMatchObject({ title: "60m × 5本", restText: "1本ごとの休憩 5分", coachEdited: true });
    const session = snapshotSavedRunningMenuItem(sessionSource(source, v2));
    expect(session).toMatchObject({ snapshotSchemaVersion: 2, sourcePersistenceSchemaVersion: 2, origin: "COACH_EDITED", prescription: { totalReps: 5, repRestSeconds: 300 } });
    const saved = serializeRunningSessionSnapshot(session);
    expect(parseRunningSessionSnapshot("RUNNING_POLICY", saved)).toEqual(session);
    expect(snapshotSavedRunningMenuItem(sessionSource(source, v1))).toMatchObject({ snapshotSchemaVersion: 1, prescription: { totalReps: 4 } });
  });

  it("keeps one-run rest hidden in a coach-edited 250m snapshot", () => {
    const source = fixture({ distance: 250 });
    const result = edit(source, { executionInstructionText: "フォームを保って" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = serializeRunningMenuEnvelopeV2(result.envelope);
    expect(presentRunningMenuSnapshot("RUNNING_POLICY", json)).toMatchObject({ title: "250m × 1本", restText: null });
    const session = snapshotSavedRunningMenuItem(sessionSource(source, json));
    expect(session.prescription).toMatchObject({ totalReps: 1, repRestSeconds: null });
  });
});
