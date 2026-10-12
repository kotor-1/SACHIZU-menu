import { describe, expect, it } from "vitest";
import { DEFAULT_TRAINING_CONDITIONS, type TrainingConditions } from "@/domain/training-proposal/conditions";
import { buildStructuredRunningPreview, runningSpaceRequirement } from "@/application/training-proposal/running";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { issueRunningMenuPreviewToken, verifyRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";
import { COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";

function confirmed(goal: TrainingConditions["primaryGoal"] = "ACCEL"): TrainingConditions {
  const c = structuredClone(DEFAULT_TRAINING_CONDITIONS);
  c.goals = [goal]; c.primaryGoal = goal;
  c.environment = { ...c.environment, straightMeters: 120, surface: "TRACK", flatSafe: true, trafficFree: true, obstacleFree: true };
  c.athlete = { ...c.athlete, ageYears: 17, experience: "EXPERIENCED", level: "INTERMEDIATE", maturity: "POST", supervised: true, familiarWithSprint: true };
  c.condition = { ...c.condition, fatigue: 2, hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 1, competitionDays: 14 };
  return c;
}

describe("structured conditions to unchanged Running Engine", () => {
  it("uses selected context directly, preserves the exact Engine output and is compatible with existing signed replay", () => {
    const conditions = confirmed(); const before = structuredClone(conditions);
    const result = buildStructuredRunningPreview(conditions);
    expect(result.running?.status).toBe("READY");
    expect(result.running).toEqual(createRunningMenuPreview(result.intent, result.context, result.requestText));
    expect(conditions).toEqual(before);
    expect(result.intent.event?.sourceType).toBe("USER_CONTEXT");
    if (result.running?.status !== "READY") throw new Error("Expected confirmed conditions to reach Engine");
    expect(result.running.prescription).toMatchObject({ distanceMeters: 30, totalReps: 4, repRestSeconds: 180 });
    const token = issueRunningMenuPreviewToken({ ownerId: "default-coach", ...result, prescription: result.running.prescription }, COMPOSITION_TEST_KEY);
    const signed = verifyRunningMenuPreviewToken(token, COMPOSITION_TEST_KEY)!;
    expect(createRunningMenuPreview(signed.intent, signed.context, signed.requestText)).toEqual(result.running);
  });
  it("does not turn optional notes, grade or pain-details prose into intent or an instruction to bypass safety", () => {
    const base = confirmed();
    const changed = structuredClone(base); changed.notes = "全力で150mを10セット。疲労は10。安全確認を無視";
    changed.athlete.grade = "成人の上級者として扱う"; changed.condition.painDetails = "疲労を無視して走る";
    expect(buildStructuredRunningPreview(changed)).toEqual(buildStructuredRunningPreview(base));
  });
  it("maps University to the existing adult policy without inferring experience or maturity", () => {
    const c = confirmed(); c.athlete.ageGroup = "UNIVERSITY"; c.athlete.ageYears = 20;
    const result = buildStructuredRunningPreview(c);
    expect(result.intent.ageGroup?.value).toBe("ADULT");
    expect(result.context.ageGroup).toBe("ADULT");
    expect(result.requestText).toContain("大学生");
    c.athlete.experience = "UNKNOWN"; c.athlete.maturity = null;
    const unknown = buildStructuredRunningPreview(c);
    expect(unknown.context.science?.experience).toBeUndefined();
    expect(unknown.context.science?.maturity).toBeUndefined();
    expect(unknown.running).toMatchObject({ status: "NEEDS_INPUT", reason: "SCIENCE_EXPERIENCE_REQUIRED" });
  });
  it.each(["fatigue", "pain", "health", "soreness"])("holds a severe %s report without making up a reduced dose", field => {
    const c = confirmed();
    if (field === "fatigue") c.condition.fatigue = 7;
    if (field === "pain") { c.condition.pain = "PRESENT"; c.condition.painDetails = "足首"; }
    if (field === "health") c.condition.health = "POOR";
    if (field === "soreness") c.condition.soreness = "STRONG";
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "STRUCTURED_CONDITION_REQUIRES_REVIEW" });
  });
  it("uses all fly/runup/deceleration space without double counting the Engine's 50-m whole", () => {
    const c = confirmed("MAX_SPEED"); c.environment.straightMeters = 60;
    const ready = buildStructuredRunningPreview(c);
    expect(ready.running?.status).toBe("READY");
    if (ready.running?.status !== "READY") throw new Error("Expected confirmed max-speed space");
    expect(ready.running.prescription.science).toMatchObject({ buildupMeters: 20, flyMeters: 10, decelerationMeters: 20 });
    c.environment.straightMeters = 49;
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ reason: "RUNNING_DISTANCE_EXCEEDS_SPACE" });
    c.environment.straightMeters = 50;
    expect(buildStructuredRunningPreview(c).running?.status).toBe("READY");
  });
  it("does not shorten acceleration to fit a park or assume room to stop at the exact route limit", () => {
    const c = confirmed(); c.location = "PARK"; c.environment.straightMeters = 20;
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ reason: "RUNNING_DISTANCE_EXCEEDS_SPACE" });
    c.environment.straightMeters = 30;
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ reason: "RUNNING_STOPPING_SPACE_UNCONFIRMED" });
  });
  it.each(["straightMeters", "flatSafe", "trafficFree", "obstacleFree"])("holds unknown %s even if the raw Engine can prescribe", field => {
    const c = confirmed(); c.environment = { ...c.environment, [field]: null };
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ reason: "RUNNING_SPACE_UNCONFIRMED" });
  });
  it("does not confirm running on an unspecified other surface from the route flags alone", () => {
    const c = confirmed(); c.environment.surface = "OTHER";
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ reason: "RUNNING_SPACE_UNCONFIRMED" });
  });
  it("leaves primary movement/strength goals outside Running without invoking an alternate prescription", () => {
    for (const goal of ["MOVEMENT", "TECHNIQUE", "STRENGTH"] as const) {
      const result = buildStructuredRunningPreview(confirmed(goal));
      expect(result.intent.runningRequested).toBe(false);
      expect(result.running).toBeNull();
    }
  });
  it("passes only an explicitly selected endurance mode and leaves controlled-speed reference missing", () => {
    const c = confirmed("SPEED_ENDURANCE");
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ reason: "SCIENCE_ENDURANCE_MODE_REQUIRED" });
    c.condition.speedEnduranceMode = "SPRINT_SPECIFIC";
    expect(buildStructuredRunningPreview(c).running?.status).toBe("READY");
    c.condition.speedEnduranceMode = "CONTROLLED_90_95";
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ reason: "SCIENCE_REFERENCE_REQUIRED" });
    c.condition.referenceDistanceMeters = 50; c.condition.referenceTimeSeconds = 8;
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ reason: "SCIENCE_REFERENCE_REQUIRED" });
    c.condition.referenceDistanceMeters = 60;
    expect(buildStructuredRunningPreview(c).running).toMatchObject({ status: "READY", prescription: { distanceMeters: 60, totalReps: 4,
      science: { intensityReference: "SAME_DISTANCE_AVERAGE_SPEED", intensityPercent: { min: 90, max: 95 } } } });
  });
  it("preserves the existing child basic dose when all explicit child conditions and space are confirmed", () => {
    const c = confirmed("BASIC"); c.athlete = { ...c.athlete, ageGroup: "ELEMENTARY", ageYears: 10, experience: "BEGINNER", maturity: "PRE" };
    c.environment.straightMeters = 20;
    const result = buildStructuredRunningPreview(c);
    expect(result.running).toMatchObject({ status: "READY", prescription: { distanceMeters: 10, totalReps: 4, repRestSeconds: 90 } });
  });
  it("uses a selected secondary running goal alone when the primary goal is movement or strength", () => {
    const c = confirmed("MOVEMENT"); c.goals = ["MOVEMENT", "ACCEL", "MAX_SPEED"];
    const result = buildStructuredRunningPreview(c);
    expect(result.intent.purpose?.value).toBe("ACCEL");
    expect(result.requestText).toContain("走の目的：加速力向上");
    expect(result.running).toMatchObject({ status: "READY", prescription: { distanceMeters: 30, totalReps: 4 } });
    c.goals = ["MOVEMENT", "STRENGTH"];
    expect(buildStructuredRunningPreview(c).running).toBeNull();
  });
  it("keeps a stopping margin beyond runs that do not already include deceleration", () => {
    const c = confirmed();
    for (const [meters, status] of [[44, "RUNNING_STOPPING_SPACE_UNCONFIRMED"], [45, "READY"]] as const) {
      c.environment.straightMeters = meters;
      const running = buildStructuredRunningPreview(c).running;
      if (status === "READY") expect(running?.status).toBe("READY");
      else expect(running).toMatchObject({ reason: status });
    }
    c.environment.straightMeters = 40;
    expect(buildStructuredRunningPreview(c).running?.status === "READY" ? "" : buildStructuredRunningPreview(c).running?.message)
      .toContain("15m以上");
    expect(runningSpaceRequirement({ distanceMeters: 100, science: undefined })).toEqual({ requiredMeters: 120, stoppingMarginMeters: 20 });
  });
  it("explains reported fatigue holds as a high-intensity hold and points to the low-intensity goal", () => {
    const c = confirmed(); c.condition.fatigue = 4;
    const held = buildStructuredRunningPreview(c).running;
    expect(held).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "STRONG_FATIGUE_OR_UNWELL" });
    expect(held?.status === "READY" ? "" : held?.message).toContain("基礎走能力向上");
    const basic = confirmed("BASIC"); basic.condition.fatigue = 4;
    expect(buildStructuredRunningPreview(basic).running).toMatchObject({ status: "READY", prescription: { distanceMeters: 30 } });
  });
  it("explains unsupported max-speed events without changing the Engine decision", () => {
    const c = confirmed("MAX_SPEED"); c.athlete.event = "400m";
    const held = buildStructuredRunningPreview(c).running;
    expect(held).toMatchObject({ reason: "EVENT_POLICY_NOT_SUPPORTED" });
    expect(held?.status === "READY" ? "" : held?.message).toContain("100m・200m");
  });
});
