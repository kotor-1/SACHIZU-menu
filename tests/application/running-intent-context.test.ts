import { describe, expect, it } from "vitest";
import { verifyRunningIntentClaims, type RunningIntentClaims } from "@/application/running-menu/intent";
import { numericEvidence } from "@/application/running-menu/numeric-evidence";
import { createRunningMenuPreview } from "@/application/running-menu/preview";

const quoted = <T>(value: T, sourceText: string) => ({ value, sourceText });
const claims = (patch: Partial<RunningIntentClaims> = {}): RunningIntentClaims => ({
  runningRequested: true, event: null, ageGroup: null, explicitDistances: [], distancePreference: null,
  loadReductionRequested: null, fatigueState: null, availableTimeSeconds: null,
  humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [], ...patch,
});
const original = "今週に２００mのレースがある。中学2年男子です。あと3日で試合ですが、疲労が抜けすぎています。少し疲労を溜めるメニューを消化したい";

describe("contextual numeric evidence, without numeric prescription authority", () => {
  it.each(["中学生200m選手", "200mのレースがあります", "200mに出ます", "200mに出場する", "200mが専門", "２００ｍのレースがあります"])("event only: %s", (text) => {
    expect(verifyRunningIntentClaims(text, claims({ event: quoted("200m", text) }), [])).toMatchObject({ ok: true, intent: { event: { value: "200m" }, explicitDistances: [] } });
  });
  it.each(["今日は200mを走りたい", "200mをやりたい", "練習は200mで", "今日は２００m", "200mを2本"])("training distance: %s", (text) => {
    expect(verifyRunningIntentClaims(text, claims({ explicitDistances: [quoted(200, text)], ...(text.includes("2本") ? { humanExplicitReps: quoted(2, "2本") } : {}) }), [])).toMatchObject({ ok: true, intent: { explicitDistances: [{ value: 200 }] } });
  });
  it("keeps event and today's distance separate even with a minimal quote", () => {
    const text = "200mのレースがある。今日は60m";
    expect(verifyRunningIntentClaims(text, claims({ event: quoted("200m", "200m"), explicitDistances: [quoted(60, "60m")] }), [])).toMatchObject({ ok: true, intent: { event: { value: "200m" }, explicitDistances: [{ value: 60 }] } });
  });
  it.each(["あと3日で試合", "3日後に試合", "試合まで3日"])("competition days are not reps or available time: %s", (text) => {
    expect(verifyRunningIntentClaims(text, claims(), []).ok).toBe(true);
    expect(numericEvidence(text)).toMatchObject([{ role: "COMPETITION_DAYS", value: 3 }]);
    expect(verifyRunningIntentClaims(text, claims({ humanExplicitReps: quoted(3, text) }), [])).toMatchObject({ ok: false, field: "humanExplicitReps" });
    expect(verifyRunningIntentClaims(text, claims({ availableTimeSeconds: quoted(3, text) }), []).ok).toBe(false);
  });
  it("requires the reps with their own unit even when days have the same value", () => {
    const text = "3日後に試合、60mを3本";
    const patch = { explicitDistances: [quoted(60, "60mを3本")] };
    expect(verifyRunningIntentClaims(text, claims({ ...patch, humanExplicitReps: quoted(3, "3本") }), []).ok).toBe(true);
    expect(verifyRunningIntentClaims(text, claims({ ...patch, humanExplicitReps: quoted(3, "3日後") }), [])).toMatchObject({ ok: false, field: "humanExplicitReps" });
    expect(verifyRunningIntentClaims(text, claims(patch), [])).toMatchObject({ ok: false, reason: "MISSING_EXPLICIT_REPS" });
  });
  it("cannot reclassify a clipped race distance as a training distance", () => {
    const text = "中学生200mのレースがあります";
    expect(verifyRunningIntentClaims(text, claims({ explicitDistances: [quoted(200, "200m")] }), [])).toMatchObject({ ok: false, field: "explicitDistances" });
    expect(verifyRunningIntentClaims("中学生、今日は200mを走りたい", claims({ event: quoted("200m", "中学生、今日は200mを走りたい"), explicitDistances: [quoted(200, "200mを走りたい")] }), [])).toMatchObject({ ok: false, field: "event" });
  });
  it("distinguishes rest, available time, school year, and event units", () => {
    const text = "中学2年、200mのレースがある。30分で練習。休憩3分で60mを3本";
    const patch = { event: quoted("200m", "200mのレース"), ageGroup: quoted("JUNIOR_HIGH" as const, "中学2年"), explicitDistances: [quoted(60, "60mを3本")], humanExplicitReps: quoted(3, "3本"), humanExplicitRestSeconds: quoted(180, "休憩3分"), availableTimeSeconds: quoted(1800, "30分で") };
    expect(verifyRunningIntentClaims(text, claims(patch), []).ok).toBe(true);
    expect(verifyRunningIntentClaims(text, claims({ ...patch, humanExplicitRestSeconds: quoted(1800, "30分") }), [])).toMatchObject({ ok: false, field: "humanExplicitRestSeconds" });
    expect(verifyRunningIntentClaims(text, claims({ ...patch, availableTimeSeconds: quoted(180, "3分") }), [])).toMatchObject({ ok: false, field: "availableTimeSeconds" });
    expect(numericEvidence(text)[0]).toMatchObject({ role: "OTHER", value: 2 });
  });
  it("does not turn a target running time into session available time", () => {
    const text = "200mを30秒で走りたい";
    expect(numericEvidence(text).find((entry) => entry.value === 30)?.role).toBe("OTHER");
    expect(verifyRunningIntentClaims(text, claims({ availableTimeSeconds: quoted(30, "30秒で") }), [])).toMatchObject({ ok: false, field: "availableTimeSeconds" });
  });
  it("does not read per-rep rest as a request to run one rep", () => {
    expect(verifyRunningIntentClaims("1本ごとの休憩3分", claims({ humanExplicitRestSeconds: quoted(180, "休憩3分") }), []).ok).toBe(true);
  });
  it.each([original, original.replace("２００", "200")])("original sentence reaches the existing normal Engine policy: %s", (text) => {
    const checked = verifyRunningIntentClaims(text, claims({ event: quoted("200m", text.includes("２００") ? "２００mのレース" : "200mのレース"), ageGroup: quoted("JUNIOR_HIGH", "中学2年") }), []);
    expect(checked).toMatchObject({ ok: true, intent: { explicitDistances: [], humanExplicitReps: null, humanExplicitRestSeconds: null, fatigueState: null, loadReductionRequested: null } });
    if (!checked.ok) throw new Error(checked.reason);
    expect(createRunningMenuPreview(checked.intent, {}, text)).toMatchObject({ status: "READY", prescription: { distanceMeters: 120, totalReps: 3, repRestSeconds: 900, repsReductionApplied: false } });
  });
  it.each(["疲労が抜けすぎています", "疲れていない", "少し疲労を溜めたい"])("recovery/desire is not a fatigue report or reduction: %s", (text) => {
    expect(verifyRunningIntentClaims(text, claims(), []).ok).toBe(true);
    expect(verifyRunningIntentClaims(text, claims({ fatigueState: quoted("REPORTED", text) }), []).ok).toBe(false);
    expect(verifyRunningIntentClaims(text, claims({ loadReductionRequested: quoted(true, text) }), []).ok).toBe(false);
  });
  it("a recovered clause does not suppress a separate actual fatigue report", () => {
    const text = "昨日は疲労が抜けすぎていた。今日は疲れている";
    expect(verifyRunningIntentClaims(text, claims(), [])).toMatchObject({ ok: false, reason: "MISSING_FATIGUE_CONTEXT" });
    expect(verifyRunningIntentClaims(text, claims({ fatigueState: quoted("REPORTED", "疲れている") }), []).ok).toBe(true);
  });
  it("does not accept a fabricated distance or a different source number", () => {
    expect(verifyRunningIntentClaims(original, claims({ explicitDistances: [quoted(120, "２００mのレース")] }), []).ok).toBe(false);
    expect(verifyRunningIntentClaims("休憩30秒", claims({ humanExplicitRestSeconds: quoted(30, "休憩30秒") }), []).ok).toBe(true);
    expect(verifyRunningIntentClaims("60mを3本", claims({ explicitDistances: [quoted(60, "60m")], humanExplicitReps: quoted(6, "3本") }), []).ok).toBe(false);
  });
});
