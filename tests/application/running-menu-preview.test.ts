import { describe, expect, it } from "vitest";
import { verifyRunningIntentClaims, type RunningIntentClaims } from "@/application/running-menu/intent";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { RUNNING_INTENT_OUTPUT_SCHEMA, extractRunningMenuIntent } from "@/infra/running-menu/openai-intent-extractor";

const quoted = <T>(value: T, sourceText: string) => ({ value, sourceText });
const empty = (): RunningIntentClaims => ({
  runningRequested: true, event: null, ageGroup: null, explicitDistances: [], distancePreference: null,
  loadReductionRequested: null, fatigueState: null, availableTimeSeconds: null,
  purpose: null, intensityPreference: null, competitionDays: null,
  humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
});

function preview(text: string, patch: Partial<RunningIntentClaims> = {}, context = {}) {
  const checked = verifyRunningIntentClaims(text, { ...empty(), ...patch }, []);
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error(checked.reason);
  return createRunningMenuPreview(checked.intent, context, text);
}

describe("running intent extraction contract and application adapter", () => {
  it("AI schema contains facts, not generated prescription fields", () => {
    const fields = Object.keys(RUNNING_INTENT_OUTPUT_SCHEMA.properties);
    expect(fields).not.toEqual(expect.arrayContaining(["generatedDistanceMeters", "generatedReps", "generatedRestSeconds", "targetTime"]));
    expect(fields).toContain("explicitDistances");
  });

  it.each([
    ["中学生100m選手、今日のメニューを作って", { event: quoted("100m", "100m選手"), ageGroup: quoted("JUNIOR_HIGH", "中学生") }, 60, 4, 240],
    ["高校生200m選手、今日のメニューを作って", { event: quoted("200m", "200m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生") }, 120, 3, 900],
    ["高校生200m。今日は短めで", { event: quoted("200m", "200m"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), distancePreference: quoted("SHORT", "短め") }, 100, 3, 720],
    ["中学生100m。今日は軽めに", { event: quoted("100m", "100m"), ageGroup: quoted("JUNIOR_HIGH", "中学生"), loadReductionRequested: quoted(true, "軽めに") }, 60, 3, 240],
    ["高校生100m選手、短めで", { event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), distancePreference: quoted("SHORT", "短めで") }, 50, 4, 240],
    ["高校生200m選手、長めで", { event: quoted("200m", "200m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), distancePreference: quoted("LONG", "長めで") }, 150, 3, 1080],
    ["高校生100m選手、150mをやりたい", { event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), explicitDistances: [quoted(150, "150mをやりたい")] }, 150, 3, 1080],
    ["高校生100m選手、軽めに", { event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), loadReductionRequested: quoted(true, "軽めに") }, 60, 3, 240],
    ["高校生100m選手、疲れている", { event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), fatigueState: quoted("REPORTED", "疲れている") }, 60, 4, 240],
    ["高校生100m選手、疲れているから軽めに", { event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), fatigueState: quoted("REPORTED", "疲れている"), loadReductionRequested: quoted(true, "軽めに") }, 60, 3, 240],
  ] as const)("%s -> engine prescription only", (text, claims, distance, reps, rest) => {
    const result = preview(text, claims as Partial<RunningIntentClaims>);
    expect(result?.status).toBe("READY");
    if (result?.status !== "READY") throw new Error("Not ready");
    expect([result.prescription.distanceMeters, result.prescription.totalReps, result.prescription.repRestSeconds]).toEqual([distance, reps, rest]);
  });

  it("80m is retained for review", () => {
    const result = preview("高校生100m選手、80mをやりたい", {
      event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), explicitDistances: [quoted(80, "80mをやりたい")],
    });
    expect(result).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "HUMAN_EXPLICIT_UNSUPPORTED_DISTANCE", explicitDistances: [80] });
  });

  it("strong fatigue, unknown age, elementary, and time gate stop without numeric rewriting", () => {
    expect(preview("高校生100m選手、走れないくらい疲れている", {
      event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), fatigueState: quoted("STRONG_OR_UNWELL", "走れないくらい疲れている"),
    })).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "STRONG_FATIGUE_OR_UNWELL" });
    expect(preview("100m選手、今日のメニューを作って", { event: quoted("100m", "100m選手") })).toMatchObject({ status: "NEEDS_INPUT", reason: "AGE_REQUIRED" });
    expect(preview("小学生100m選手、今日のメニューを作って", { event: quoted("100m", "100m選手"), ageGroup: quoted("ELEMENTARY", "小学生") })).toMatchObject({ status: "NEEDS_POLICY", reason: "ELEMENTARY_POLICY_NOT_APPROVED" });
    expect(preview("高校生100m選手、10分で", { event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), availableTimeSeconds: quoted(600, "10分で") })).toMatchObject({ status: "NEEDS_TIME_ADJUSTMENT", reason: "AVAILABLE_TIME_TOO_SHORT" });
  });

  it("junior high 200m gate and human numbers require review", () => {
    expect(preview("中学生100m選手、200mをやりたい", { event: quoted("100m", "100m選手"), ageGroup: quoted("JUNIOR_HIGH", "中学生"), explicitDistances: [quoted(200, "200mをやりたい")] })).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "JUNIOR_HIGH_LONG_DISTANCE_HISTORY_REQUIRED" });
    expect(preview("高校生100m選手、60mを3本やりたい", { event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"), explicitDistances: [quoted(60, "60mを3本やりたい")], humanExplicitReps: quoted(3, "3本") })).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "HUMAN_EXPLICIT_NUMBERS_REQUIRE_REVIEW" });
  });

  it("rejects invented or omitted user facts", () => {
    expect(verifyRunningIntentClaims("100m選手", { ...empty(), explicitDistances: [quoted(100, "100m選手")] }, []).ok).toBe(false);
    expect(verifyRunningIntentClaims("100m選手", { ...empty(), explicitDistances: [quoted(100, "100m")] }, []).ok).toBe(false);
    expect(verifyRunningIntentClaims("80mをやりたい", empty(), []).ok).toBe(false);
    expect(verifyRunningIntentClaims("軽めに", empty(), []).ok).toBe(false);
    expect(verifyRunningIntentClaims("疲れている", { ...empty(), loadReductionRequested: quoted(true, "疲れている") }, []).ok).toBe(false);
    expect(verifyRunningIntentClaims("100m選手", { ...empty(), event: quoted("200m", "100m選手") }, []).ok).toBe(false);
    expect(verifyRunningIntentClaims("補強", { ...empty(), exerciseIds: ["not-reviewed"] }, []).ok).toBe(false);
  });

  it("uses context only when text has no conflicting explicit value", () => {
    expect(preview("今日のメニューを作って", {}, { event: "100m", ageGroup: "JUNIOR_HIGH" })?.status).toBe("READY");
    expect(preview("高校生100m選手、今日のメニューを作って", { event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生") }, { event: "200m" })).toMatchObject({ status: "COACH_REVIEW_REQUIRED", reason: "USER_CONTEXT_CONFLICT" });
  });

  it("passes explicit science context through the preview adapter without deriving it from school grade", () => {
    const result = preview("高校生100m選手、加速力向上を希望", {
      event: quoted("100m", "100m選手"), ageGroup: quoted("HIGH_SCHOOL", "高校生"),
      purpose: quoted("ACCEL", "加速力向上"),
    }, { event: "100m", ageGroup: "HIGH_SCHOOL", science: {
      ageYears: 17, experience: "EXPERIENCED", maturity: "POST", supervised: true,
      symptomFree: true, familiarWithSprint: true, hoursSinceHighIntensity: 72,
      hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 0,
    } });
    expect(result?.status).toBe("READY");
    if (result?.status !== "READY") throw new Error("Not ready");
    expect(result.prescription.science).toMatchObject({
      source: "SCIENCE_INFORMED_DEFAULT", coachApproval: "NOT_COACH_APPROVED", provisional: true,
      ruleId: "SCI_ACC_EXPERIENCED", buildupMeters: 0, flyMeters: 0, decelerationMeters: 0,
    });
    expect(result.message).toContain("コーチ承認済みではありません");
  });

  it("parses a strict OpenAI response without using a catalog of old Running templates", async () => {
    const claims = { ...empty(), event: quoted("100m", "100m選手"), ageGroup: quoted("JUNIOR_HIGH", "中学生") };
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).not.toContain("runningTemplates");
      expect(body.input).not.toContain("templateId");
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(claims) }] }] }), { status: 200 });
    };
    const result = await extractRunningMenuIntent({ requestText: "中学生100m選手", exercises: [] }, { apiKey: "test", fetchImpl });
    expect(result).toMatchObject({ ok: true, claims });
  });
});
