import { describe, expect, it } from "vitest";
import {
  planRunningPrescription,
  RUNNING_POLICY,
  RUNNING_POLICY_HASH,
  RUNNING_POLICY_VERSION,
  type RunningPrescription,
} from "@/domain/running-policy";

function ready(input: unknown): RunningPrescription {
  const result = planRunningPrescription(input);
  expect(result.status).toBe("READY");
  if (result.status !== "READY") throw new Error(`Unexpected status: ${result.status}`);
  return result.prescription;
}

describe("confirmed 100m and 200m distance selection", () => {
  it.each([
    [{ event: "100m", ageGroup: "JUNIOR_HIGH" }, 60, 4, 240],
    [{ event: "100m", ageGroup: "HIGH_SCHOOL", distancePreference: "SHORT" }, 50, 4, 240],
    [{ event: "100m", ageGroup: "ADULT", distancePreference: "LONG" }, 100, 3, 720],
    [{ event: "100m", ageGroup: "ADULT", humanExplicitDistances: [150] }, 150, 3, 1080],
    [{ event: "200m", ageGroup: "HIGH_SCHOOL" }, 120, 3, 900],
    [{ event: "200m", ageGroup: "HIGH_SCHOOL", distancePreference: "SHORT" }, 100, 3, 720],
    [{ event: "200m", ageGroup: "HIGH_SCHOOL", distancePreference: "LONG" }, 150, 3, 1080],
  ] as const)("selects the coach-approved result for %j", (input, distance, reps, rest) => {
    const prescription = ready(input);
    expect([prescription.distanceMeters, prescription.totalReps, prescription.repRestSeconds]).toEqual([distance, reps, rest]);
    expect(prescription.sets).toBe(1);
    expect(prescription.setReps).toBeNull();
    expect(prescription.policyVersion).toBe(RUNNING_POLICY_VERSION);
    expect(prescription.policyHash).toBe(RUNNING_POLICY_HASH);
  });

  it("gives a human explicit supported distance priority even outside the normal pool", () => {
    const p = ready({ event: "100m", ageGroup: "ADULT", humanExplicitDistances: [250], distancePreference: "SHORT" });
    expect(p.distanceMeters).toBe(250);
    expect(p.totalReps).toBe(1);
    expect(p.repRestSeconds).toBeNull();
    expect(p.decisionReasons).toContain("HUMAN_EXPLICIT_DISTANCE_SELECTED");
  });

  it.each([40, 80])("preserves unsupported explicit %im for coach review", (distance) => {
    const result = planRunningPrescription({ event: "100m", ageGroup: "ADULT", humanExplicitDistances: [distance] });
    expect(result).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "HUMAN_EXPLICIT_UNSUPPORTED_DISTANCE", selectedDistanceMeters: distance });
    expect(result.humanExplicitDistances).toEqual([distance]);
  });

  it("preserves multiple explicit distances without selecting one", () => {
    const result = planRunningPrescription({ event: "200m", ageGroup: "ADULT", humanExplicitDistances: [30, 60] });
    expect(result).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "MULTIPLE_EXPLICIT_DISTANCES", selectedDistanceMeters: null });
    expect(result.humanExplicitDistances).toEqual([30, 60]);
  });

  it("does not create an event default for other events", () => {
    expect(planRunningPrescription({ event: "400m", ageGroup: "ADULT" })).toMatchObject({ status: "NEEDS_POLICY", reason: "EVENT_POLICY_NOT_SUPPORTED" });
  });
});

describe("Phase A, B and C", () => {
  it("stores all nine approved Phase A rows, including the latest coach rest defaults", () => {
    expect(RUNNING_POLICY.phaseA.map((row) => [row.distanceMeters, row.minReps, row.defaultReps, row.maxReps, row.repRestMinSeconds, row.defaultRepRestSeconds, row.repRestMaxSeconds])).toEqual([
      [30, 3, 5, 7, 120, 180, 300],
      [50, 3, 4, 5, 180, 240, 420],
      [60, 3, 4, 5, 180, 240, 300],
      [100, 2, 3, 4, 480, 720, 1080],
      [120, 2, 3, 4, 600, 900, 1200],
      [150, 2, 3, 4, 720, 1080, 1500],
      [200, 1, 2, 3, 720, 900, 1800],
      [250, 1, 1, 2, 900, 1200, 2100],
      [300, 1, 1, 2, 1200, 1200, 2400],
    ]);
  });

  it("omits executable inter-rep rest for a single run", () => {
    const p = ready({ event: "200m", ageGroup: "HIGH_SCHOOL", humanExplicitDistances: [250] });
    expect([p.totalReps, p.repRestSeconds, p.minimumKnownRestSeconds]).toEqual([1, null, 0]);
  });

  it("accepts an explicit coach split without multiplying total reps", () => {
    const p = ready({ event: "100m", ageGroup: "ADULT", humanExplicitDistances: [30], coachSetSplit: { setReps: [3, 2], setRestSeconds: 600 } });
    expect([p.totalReps, p.totalDistanceMeters, p.sets, p.setReps, p.setRestSeconds]).toEqual([5, 150, 2, [3, 2], 600]);
    expect(p.minimumKnownRestSeconds).toBe(1140);
    expect(p.decisionReasons).toContain("COACH_SET_SPLIT_APPLIED");
  });

  it("rejects an incomplete or inconsistent split", () => {
    expect(planRunningPrescription({ event: "100m", ageGroup: "ADULT", humanExplicitDistances: [30], coachSetSplit: { setReps: [3, 2] } })).toMatchObject({ status: "BLOCKED", reason: "COACH_SET_SPLIT_INCOMPLETE" });
    expect(planRunningPrescription({ event: "100m", ageGroup: "ADULT", humanExplicitDistances: [30], coachSetSplit: { setReps: [3, 3], setRestSeconds: 600 } })).toMatchObject({ status: "BLOCKED", reason: "COACH_SET_REPS_MISMATCH" });
  });

  it("uses plain language only and retains explicit coach target time", () => {
    const p = ready({ event: "100m", ageGroup: "ADULT", executionInstructionText: "フォームを保って走る", coachTargetTimeRange: { minSeconds: 7.6, maxSeconds: 7.8 } });
    expect(p).toMatchObject({ intensityPresentation: "PLAIN_LANGUAGE", executionInstructionText: "フォームを保って走る", coachTargetTimeSeconds: null, coachTargetTimeRange: { minSeconds: 7.6, maxSeconds: 7.8 } });
    expect(ready({ event: "100m", ageGroup: "ADULT" }).coachTargetTimeRange).toBeNull();
  });

  it("rejects conflicting coach time fields and preserves human numeric constraints for review", () => {
    expect(planRunningPrescription({ event: "100m", ageGroup: "ADULT", coachTargetTimeSeconds: 7.7, coachTargetTimeRange: { minSeconds: 7.6, maxSeconds: 7.8 } })).toMatchObject({ status: "BLOCKED", reason: "COACH_TARGET_TIME_CONFLICT" });
    expect(planRunningPrescription({ event: "100m", ageGroup: "ADULT", humanExplicitNumbers: { totalReps: 10 } })).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "HUMAN_EXPLICIT_NUMBERS_REQUIRE_REVIEW", humanExplicitNumbers: { totalReps: 10 } });
    expect(planRunningPrescription({ event: "100m", ageGroup: "ADULT", standardPolicyConflict: true })).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "PHASE_A_CONFLICT" });
  });
});

describe("Phase D and E", () => {
  it("gates junior high 200m without confirmed personal history or coach approval", () => {
    const base = { event: "100m", ageGroup: "JUNIOR_HIGH", humanExplicitDistances: [200] };
    expect(planRunningPrescription({ ...base, similarDistanceHistoryStatus: "UNKNOWN" })).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "JUNIOR_HIGH_LONG_DISTANCE_HISTORY_REQUIRED" });
    expect(ready({ ...base, similarDistanceHistoryStatus: "CONFIRMED" }).distanceMeters).toBe(200);
    expect(ready({ ...base, coachAgeGateApproval: true }).distanceMeters).toBe(200);
  });

  it("does not automatically apply Phase A to elementary or unknown age", () => {
    expect(planRunningPrescription({ event: "100m", ageGroup: "ELEMENTARY", humanExplicitDistances: [60] })).toMatchObject({ status: "NEEDS_POLICY", reason: "ELEMENTARY_POLICY_NOT_APPROVED" });
    expect(planRunningPrescription({ event: "100m", ageGroup: "UNKNOWN" })).toMatchObject({ status: "NEEDS_INPUT", reason: "AGE_REQUIRED" });
  });

  it("reduces only reps to the approved minimum on explicit request", () => {
    const p = ready({ event: "100m", ageGroup: "JUNIOR_HIGH", loadReductionRequested: true });
    expect(p).toMatchObject({ distanceMeters: 60, totalReps: 3, repsPosition: "MIN", repRestSeconds: 240, repsReductionApplied: true });
  });

  it("preserves a fatigue report without reducing reps and reviews strong fatigue", () => {
    const p = ready({ event: "100m", ageGroup: "ADULT", fatigueState: "REPORTED" });
    expect(p).toMatchObject({ totalReps: 4, repsPosition: "DEFAULT", repsReductionApplied: false });
    expect(p.decisionReasons).toContain("FATIGUE_REPORT_PRESERVED");
    expect(planRunningPrescription({ event: "100m", ageGroup: "ADULT", fatigueState: "STRONG_OR_UNWELL" })).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "STRONG_FATIGUE_OR_UNWELL" });
  });

  it.each([250, 300])("does not claim a reduction for %im when min equals default", (distance) => {
    const p = ready({ event: "200m", ageGroup: "ADULT", humanExplicitDistances: [distance], loadReductionRequested: true });
    expect(p).toMatchObject({ totalReps: 1, repsPosition: "MIN", repsReductionApplied: false, repRestSeconds: null });
    expect(p.decisionReasons).toContain("LOAD_REDUCTION_NO_REP_CHANGE");
  });
});

describe("time gate and determinism", () => {
  it("rejects time at or below the known rest while preserving rest and distance", () => {
    const input = { event: "100m", ageGroup: "ADULT", availableTimeSeconds: 720 };
    const result = planRunningPrescription(input);
    expect(result).toMatchObject({ status: "NEEDS_TIME_ADJUSTMENT", reason: "AVAILABLE_TIME_TOO_SHORT", selectedDistanceMeters: 60 });
    if (result.status !== "NEEDS_TIME_ADJUSTMENT") throw new Error("Unexpected status");
    expect(result.candidate).toMatchObject({ distanceMeters: 60, totalReps: 4, repRestSeconds: 240, minimumKnownRestSeconds: 720 });
    expect(ready({ ...input, availableTimeSeconds: 721 }).fullSessionTimeGuaranteed).toBe(false);
  });

  it("never depends on clock, randomness, AI or storage for the same input", () => {
    const input = { event: "200m", ageGroup: "ADULT", distancePreference: "SHORT", loadReductionRequested: true };
    expect(planRunningPrescription(input)).toEqual(planRunningPrescription(input));
  });

  it("rejects malformed input without calculating a prescription", () => {
    expect(planRunningPrescription({ event: "100m", ageGroup: "ADULT", availableTimeSeconds: -1 })).toMatchObject({ status: "BLOCKED", reason: "INVALID_INPUT" });
    expect(planRunningPrescription({ event: "100m", ageGroup: "ADULT", percentageIntensity: 90 })).toMatchObject({ status: "BLOCKED", reason: "INVALID_INPUT" });
  });
});
