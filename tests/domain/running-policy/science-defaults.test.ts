import { describe, expect, it } from "vitest";
import { planRunningPrescription } from "@/domain/running-policy/engine";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { SCIENCE_POLICY, SCIENCE_POLICY_HASH, SCIENCE_POLICY_VERSION } from "@/domain/running-policy/science-policy";
import { runningMenuPrescriptionSchema } from "@/application/running-menu/persistence";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";

const context = { experience: "EXPERIENCED", maturity: "POST", supervised: true, symptomFree: true,
  familiarWithSprint: true, hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72,
  highIntensitySessionsLast7Days: 1, speedEnduranceMode: "SPRINT_SPECIFIC" } as const;
function plan(purpose: string, patch: Record<string, unknown> = {}) {
  return planRunningPrescription({ event: "100m", ageGroup: "HIGH_SCHOOL", purpose, science: context, ...patch });
}
function ready(purpose: string, patch: Record<string, unknown> = {}) {
  const r = plan(purpose, patch); expect(r.status).toBe("READY");
  if (r.status !== "READY") throw new Error(JSON.stringify(r));
  expect(runningMenuPrescriptionSchema.safeParse(r.prescription).success).toBe(true);
  return r.prescription;
}

describe("scientifically informed purpose branch", () => {
  it("does not change the original generic coach prescription", () => {
    expect(planRunningPrescription({ event: "100m", ageGroup: "HIGH_SCHOOL" })).toMatchObject({ status: "READY", prescription: {
      policyVersion: RUNNING_POLICY_VERSION, policyHash: RUNNING_POLICY_HASH, distanceMeters: 60, totalReps: 4, repRestSeconds: 240,
    } });
    expect(SCIENCE_POLICY_HASH).toBe(sha256Utf8Hex(canonicalStringify(SCIENCE_POLICY)));
  });
  it("uses a new explicit authority, not a retroactive coach approval", () => {
    const p = ready("ACCEL");
    expect(p).toMatchObject({ policyVersion: SCIENCE_POLICY_VERSION, policyHash: SCIENCE_POLICY_HASH,
      distanceMeters: 30, totalReps: 4, minimumKnownRestSeconds: 540,
      science: { source: "SCIENCE_INFORMED_DEFAULT", coachApproval: "NOT_COACH_APPROVED", provisional: true, intensityReference: "MAX_INTENT", intensityPercent: null } });
  });
  it("does not use school grade to infer experience or maturity", () => {
    expect(plan("MAX_SPEED", { science: { ...context, maturity: undefined } })).toMatchObject({ reason: "SCIENCE_MATURITY_REQUIRED" });
    expect(plan("ACCEL", { science: { ...context, experience: undefined } })).toMatchObject({ reason: "SCIENCE_EXPERIENCE_REQUIRED" });
  });
  it("selects a lower initial acceleration dose by stated experience", () => {
    expect(ready("ACCEL", { science: { ...context, experience: "BEGINNER" } })).toMatchObject({ distanceMeters: 20, totalReps: 4, repRestSeconds: 120 });
  });
  it("accounts for buildup, fly and deceleration without calling the whole rep a fly", () => {
    const p = ready("MAX_SPEED");
    expect(p).toMatchObject({ distanceMeters: 50, totalReps: 2, totalDistanceMeters: 100, repRestSeconds: 240,
      science: { buildupMeters: 20, flyMeters: 10, decelerationMeters: 20 } });
  });
  it("uses the junior sprint-specific example and preserves full rest", () => {
    expect(ready("SPEED_ENDURANCE")).toMatchObject({ distanceMeters: 100, totalReps: 2, repRestSeconds: 600,
      science: { method: "SPRINT_SPECIFIC_ENDURANCE", intensityReference: "MAX_INTENT", intensityPercent: null } });
  });
  it("separates 90–95% same-distance average-speed targets from Vmax", () => {
    const p = ready("SPEED_ENDURANCE", { science: { ...context, speedEnduranceMode: "CONTROLLED_90_95", referenceDistanceMeters: 60, referenceTimeSeconds: 8 } });
    expect(p).toMatchObject({ distanceMeters: 60, totalReps: 4, repRestSeconds: 240,
      science: { method: "SPEED_ENDURANCE_CONTROLLED", intensityReference: "SAME_DISTANCE_AVERAGE_SPEED", intensityPercent: { min: 90, max: 95 } } });
    expect(p.science?.targetTimeRangeSeconds?.min).toBeCloseTo(8 / .95);
    expect(p.science?.targetTimeRangeSeconds?.max).toBeCloseTo(8 / .90);
    expect(p.coachTargetTimeRange).toBeNull();
  });
  it.each([undefined, 100, 200])("refuses a missing/wrong-distance speed reference %s", referenceDistanceMeters => {
    expect(plan("SPEED_ENDURANCE", { science: { ...context, speedEnduranceMode: "CONTROLLED_90_95", referenceDistanceMeters, referenceTimeSeconds: 8 } })).toMatchObject({ reason: "SCIENCE_REFERENCE_REQUIRED" });
  });
  it("allows general skill practice without inventing a competitive event", () => {
    expect(ready("BASIC", { event: undefined })).toMatchObject({ event: "GENERAL", distanceMeters: 30, totalReps: 4, repRestSeconds: 90,
      science: { intensityReference: "RELAXED_SUBMAX", intensityPercent: null } });
  });
  it("replaces pre-race high-intensity intent with a familiar relaxed primer only", () => {
    const p = ready("ACCEL", { ageGroup: "JUNIOR_HIGH", competitionDays: 1 });
    expect(p).toMatchObject({ distanceMeters: 80, totalReps: 2, repRestSeconds: 180,
      science: { purpose: "PRECOMP", intensityReference: "RELAXED_SUBMAX", minHighIntensitySeparationHours: 0 } });
    expect(p.executionInstructionText).toContain("速い刺激や新しい動きは加えず");
  });
  it.each([undefined, 2, 7])("does not infer day-before taper from an unbound window %s", competitionDays => {
    expect(plan("PRECOMP", { competitionDays })).toMatchObject({ reason: "SCIENCE_COMPETITION_CONTEXT_REQUIRED" });
  });
  it("does not introduce a new day-before stimulus", () => {
    expect(plan("PRECOMP", { competitionDays: 1, science: { ...context, familiarWithSprint: false } })).toMatchObject({ reason: "SCIENCE_FAMILIARITY_REQUIRED" });
  });
  it("never labels tempo as recovery", () => {
    expect(plan("RECOVERY")).toMatchObject({ reason: "RECOVERY_REST_PREFERRED", status: "COACH_REVIEW_REQUIRED" });
    expect(plan("BASIC", { fatigueState: "REPORTED", intensityPreference: "LOW" })).toMatchObject({ reason: "RECOVERY_REST_PREFERRED" });
    expect(ready("BASIC", { intensityPreference: "LOW" }).science?.method).toBe("RELAXED_RUNNING_SKILL");
  });
  it.each(["ACCEL", "MAX_SPEED", "SPEED_ENDURANCE"])("honors explicit LOW ahead of %s", purpose => {
    const p = ready(purpose, { intensityPreference: "LOW" });
    expect(p.science).toMatchObject({ method: "RELAXED_RUNNING_SKILL", intensityReference: "RELAXED_SUBMAX" });
  });
  it("does not choose high-intensity endurance from an unspecified mode", () => {
    expect(plan("SPEED_ENDURANCE", { science: { ...context, speedEnduranceMode: undefined } })).toMatchObject({ status: "NEEDS_INPUT", reason: "SCIENCE_ENDURANCE_MODE_REQUIRED" });
  });
  it("records unknown child maturity explicitly instead of inferring it", () => {
    expect(plan("BASIC", { ageGroup: "ELEMENTARY", science: { ...context, ageYears: 10, maturity: undefined } })).toMatchObject({ reason: "SCIENCE_MATURITY_REQUIRED" });
  });
  it("keeps serious fatigue or illness ahead of every scientific default", () => {
    expect(plan("BASIC", { fatigueState: "STRONG_OR_UNWELL" })).toMatchObject({ reason: "STRONG_FATIGUE_OR_UNWELL" });
    expect(plan("MAX_SPEED", { fatigueState: "STRONG_OR_UNWELL" })).toMatchObject({ reason: "STRONG_FATIGUE_OR_UNWELL" });
  });
  it.each([["ACCEL", {}], ["MAX_SPEED", {}], ["SPEED_ENDURANCE", {}], ["BASIC", {}], ["PRECOMP", { competitionDays: 1 }]] as const)(
    "keeps %s at its usual dose when fatigue is only reported, and checks every rep", (purpose, patch) => {
      const usual = ready(purpose, patch);
      const tired = ready(purpose, { ...patch, fatigueState: "REPORTED" });
      // Same run, reps, rest and intensity: the low starting dose is not cut further or made up.
      expect(tired).toMatchObject({ distanceMeters: usual.distanceMeters, totalReps: usual.totalReps, repRestSeconds: usual.repRestSeconds,
        executionInstructionText: usual.executionInstructionText, repsReductionApplied: false,
        science: { ruleId: usual.science!.ruleId, intensityReference: usual.science!.intensityReference } });
      expect(tired.decisionReasons).toContain("FATIGUE_REPORT_PRESERVED");
      expect(usual.decisionReasons).not.toContain("FATIGUE_REPORT_PRESERVED");
      expect(tired.science!.stopInstruction).toBe(`疲れの申告あり。1本ごとに動きと速さを確かめ、いつもより重い・遅いと感じたら残りは行わない。${usual.science!.stopInstruction}`);
    });
  it.each(["hoursSinceHighIntensity", "hoursUntilNextHighIntensity", "highIntensitySessionsLast7Days"])("requires stated frequency/recovery context %s", field => {
    expect(plan("ACCEL", { science: { ...context, [field]: undefined } })).toMatchObject({ reason: "SCIENCE_RECOVERY_INTERVAL_REQUIRED" });
  });
  it.each([0, 24, 47.99])("blocks insufficient high-intensity separation %s", hours => {
    expect(plan("MAX_SPEED", { science: { ...context, hoursSinceHighIntensity: hours } })).toMatchObject({ reason: "SCIENCE_RECOVERY_INTERVAL_VIOLATION" });
    expect(plan("MAX_SPEED", { science: { ...context, hoursUntilNextHighIntensity: hours } })).toMatchObject({ reason: "SCIENCE_RECOVERY_INTERVAL_VIOLATION" });
  });
  it("accepts the conservative 48-hour floor and blocks a third weekly high-intensity session", () => {
    expect(ready("ACCEL", { science: { ...context, hoursSinceHighIntensity: 48, hoursUntilNextHighIntensity: 48 } }).science?.maxHighIntensitySessionsPer7Days).toBe(2);
    expect(plan("ACCEL", { science: { ...context, highIntensitySessionsLast7Days: 2 } })).toMatchObject({ reason: "SCIENCE_FREQUENCY_LIMIT" });
  });
  it.each(["MAX_SPEED", "SPEED_ENDURANCE"])("does not assign advanced mode %s to a beginner/pre-maturity athlete", purpose => {
    expect(plan(purpose, { science: { ...context, experience: "BEGINNER" } })).toMatchObject({ reason: "SCIENCE_POPULATION_NOT_SUPPORTED" });
    expect(plan(purpose, { science: { ...context, maturity: "PRE" } })).toMatchObject({ reason: "SCIENCE_MATURITY_REQUIRED" });
  });
  it("uses a supervised motor skill initial dose for an elementary beginner", () => {
    expect(ready("BASIC", { event: undefined, ageGroup: "ELEMENTARY", science: { ...context, ageYears: 10, experience: "BEGINNER", maturity: "UNKNOWN" } })).toMatchObject({ event: "GENERAL", distanceMeters: 10, totalReps: 4, repRestSeconds: 90 });
  });
  it("limits elementary acceleration to familiar supervised age 10–12 exposure", () => {
    const p = ready("ACCEL", { ageGroup: "ELEMENTARY", science: { ...context, ageYears: 10, maturity: "UNKNOWN" } });
    expect(p).toMatchObject({ distanceMeters: 10, totalReps: 4, repRestSeconds: 120, science: { intensityReference: "RELAXED_SUBMAX" } });
    expect(plan("ACCEL", { ageGroup: "ELEMENTARY", science: { ...context, ageYears: 9 } })).toMatchObject({ reason: "SCIENCE_POPULATION_NOT_SUPPORTED" });
    expect(plan("ACCEL", { ageGroup: "ELEMENTARY", science: { ...context, ageYears: 11, experience: "BEGINNER" } })).toMatchObject({ reason: "SCIENCE_POPULATION_NOT_SUPPORTED" });
  });
  it.each(["symptomFree", "supervised"])("does not bypass youth %s confirmation", field => {
    expect(plan("BASIC", { ageGroup: "ELEMENTARY", science: { ...context, ageYears: 10, [field]: undefined } }).status).not.toBe("READY");
  });
  it("rejects inconsistent age/grade rather than silently selecting an adult dose", () => {
    expect(plan("ACCEL", { ageGroup: "ELEMENTARY", science: { ...context, ageYears: 17 } })).toMatchObject({ reason: "AGE_CONTEXT_CONFLICT" });
  });
  it("never shortens rest or adds volume to fill the requested duration", () => {
    expect(plan("SPEED_ENDURANCE", { availableTimeSeconds: 600 })).toMatchObject({ status: "NEEDS_TIME_ADJUSTMENT", candidate: { repRestSeconds: 600, totalReps: 2 } });
    const short = ready("SPEED_ENDURANCE", { availableTimeSeconds: 2400 });
    expect(ready("SPEED_ENDURANCE", { availableTimeSeconds: 5400 })).toEqual(short);
  });
  it("preserves an explicit conflicting distance for review instead of replacing it", () => {
    expect(plan("ACCEL", { humanExplicitDistances: [100] })).toMatchObject({ reason: "SCIENCE_EXPLICIT_INPUT_REVIEW", humanExplicitDistances: [100] });
  });
});
