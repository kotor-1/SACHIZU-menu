/**
 * Running Prescription Engine v2 — Phase R8（§10 Runtime monitoring）。
 *
 * 検証の柱:
 *   - monitor は RuleSet を読まない（処方の monitoringSnapshot だけで判定する）
 *   - safety gate が最優先（timeS=null でも止める・phase で緩めない）
 *   - 計時法ごとの tolerance / 比率条件 / 参照の確立。UNKNOWN を FAIL にしない
 *   - stop policy の挙動は snapshot の構造化 runtime metadata だけで決まる（id / 説明文を解析しない）
 *   - RepLogEntry に健康情報を残さない
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import * as runningApi from "@/domain/running";
import { TRAINING_PHASES } from "@/domain/menu/constants";
import { monitorRunningPrescription, type MonitorDecision, type RepLogEntry, type RepObservation } from "@/domain/running/monitoring";
import { MONITOR_ACTION_RANK, resolveDecision, strongestAction } from "@/domain/running/monitoring/decision";
import { exceedsToleranceRatio, isNumericStopEvaluable, isReferenceCandidate, priorSessionBest } from "@/domain/running/monitoring/timing";
import { repLogEntrySchema, repObservationSchema } from "@/domain/running/monitoring/schema";
import { planRunningPrescription, planRunningPrescriptionWithRuleSet } from "@/domain/running/planning";
import type { PlanRequest, PlanResult } from "@/domain/running/planning/schema";
import * as loader from "@/domain/running/rules/loader";
import { getRuleSet } from "@/domain/running/rules/loader";
import type { RuleSet } from "@/domain/running/rules/schema";
import { createCoachActor } from "@/domain/running/types/actor";
import { MONITOR_ACTIONS, type MonitorAction } from "@/domain/running/types/monitoring";
import { runningPrescriptionSchema, type RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { IsoDate } from "@/domain/running/types/primitives";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ruleSet = getRuleSet("rs-2026.09.0")!;
const PLANNING_DATE = "2026-09-15";
const COACH = createCoachActor("coach-1");
const iso = (v: string) => v as IsoDate;
const FLY20_PHOTO = { event: "FLY20", timeS: 2.0, date: iso("2026-08-01"), timing: "PHOTO_CELL" } as const;

function athlete(o: Partial<AthleteProfile> = {}): Subject {
  return {
    kind: "ATHLETE",
    profile: {
      birthDate: iso("1998-01-01"),
      primaryEvent: "400m",
      maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") },
      trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
      marks: [],
      vmax: null,
      allowAdvancedMethods: true,
      ...o,
    },
  } as Subject;
}
const u15Unknown = () =>
  athlete({
    birthDate: iso("2012-01-01"),
    maturity: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
    trainingAge: { structuredSprintYears: 3 },
    allowAdvancedMethods: false,
  } as Partial<AthleteProfile>);

const splitRef = (segments: [number, number, number][]) => ({
  kind: "TARGET_SPLIT",
  segments: segments.map(([distanceM, lower, upper]) => ({ distanceM, targetS: { lower, upper, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } })),
});
const fieldOverride = (field: string, newValue: number) => ({
  target: { kind: "FIELD", field, layer: "COACH_EDITABLE" },
  newValue,
  reason: "コーチ判断で本日の例外として実施する",
  confirmedTwice: false,
  actor: COACH,
  at: "2026-09-15T09:00:00+09:00",
});

type RequestOptions = { subject?: Subject; phase?: string | null; coachEdits?: unknown[]; overrides?: unknown[]; coachReference?: unknown };

function makeRequest(method: string, templateId: string, o: RequestOptions = {}): PlanRequest {
  return {
    planningDate: iso(PLANNING_DATE),
    selection: { method, templateId },
    subject: o.subject ?? athlete(),
    menuContext: { phase: o.phase ?? null, plannedDate: null, plannedAt: null, competitions: [], otherItems: [], availableMinutes: null },
    history: null,
    readiness: null,
    positionPreference: null,
    coachEdits: o.coachEdits ?? [],
    overrides: o.overrides ?? [],
    coachReference: o.coachReference ?? null,
    actor: COACH,
  } as unknown as PlanRequest;
}

function expectOk(r: PlanResult): RunningPrescriptionValue {
  if (r.status !== "OK") throw new Error(`plan failed: ${JSON.stringify(r)}`);
  return r.prescription;
}
const planned = (method: string, templateId: string, o: RequestOptions = {}) => expectOk(planRunningPrescription(makeRequest(method, templateId, o)));

const acc = () => planned("ACCELERATION", "ACC_BLOCK_30"); // SP_ACC, 1×5, rest 300 (coachEditable.max 600)
const mvFly20 = () => planned("MAX_VELOCITY", "MV_FLY20", { subject: athlete({ marks: [FLY20_PHOTO] }) }); // SP_MV, 1×4
const mvFly10 = () => planned("MAX_VELOCITY", "MV_FLY10", { subject: u15Unknown() }); // SP_MV
const ses = () => planned("SPRINT_ENDURANCE_SHORT", "SES_100", { subject: athlete({ marks: [FLY20_PHOTO] }) }); // SP_SES, target=null
const lsrFull = () =>
  planned("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", { coachReference: splitRef([[300, 36, 38]]), coachEdits: [{ field: "totalReps", value: 3, unit: "reps" }] });
const lsrIncomplete = (subject?: Subject) =>
  planned("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", {
    subject,
    coachReference: splitRef([[300, 36, 38], [100, 13, 14]]),
    overrides: [fieldOverride("totalReps", 3), fieldOverride("sessionVolumeM", 1200)],
  });
const te = () => planned("TEMPO_EXTENSIVE", "TE_200", { subject: athlete({ marks: [FLY20_PHOTO] }) }); // SP_TE, target 27.85–34.17
const ti = () => planned("TEMPO_INTENSIVE", "TI_VITTORI_SE", { subject: athlete({ marks: [FLY20_PHOTO] }) }); // SP_TI, 3×4, target upper 7.98
const rs = () => planned("RESISTED_SPRINT", "RS_SLED_LIGHT", { coachReference: { kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true } }); // band 0–10%
const as = () =>
  planned("ASSISTED_SPRINT", "AS_DOWNHILL", {
    subject: athlete({ birthDate: iso("2000-01-01"), marks: [FLY20_PHOTO] }),
    coachEdits: [
      { field: "buildUpM", value: 30, unit: "m" },
      { field: "flyZoneM", value: 20, unit: "m" },
      { field: "totalReps", value: 3, unit: "reps" },
      { field: "repRestS", value: 600, unit: "s" },
      { field: "intensityPercent", value: 103, unit: "percent" },
    ],
  });
const ea = () => planned("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH", { coachReference: { kind: "COACH_DEFINED", label: "助走" } }); // SP_EA, 5 attempts
const stride = () => planned("STRIDE", "ST_RELAXED"); // SP_STRIDE, 1×3

type ObsInput = Partial<RepObservation>;

/** 観測を順に monitor へ渡し、ログを積み上げる（R11 の保存を模す）。 */
function runSequence(p: RunningPrescriptionValue, inputs: ObsInput[], priorLogs: RepLogEntry[] = []) {
  const logs: RepLogEntry[] = [...priorLogs];
  const decisions: MonitorDecision[] = [];
  for (const input of inputs) {
    const obs = { setIndex: 1, repIndex: logs.length + 1, timeS: null, timing: "HAND", ...input } as RepObservation;
    const d = monitorRunningPrescription({ prescription: p, priorLogs: logs }, obs);
    decisions.push(d);
    logs.push(d.logEntry);
  }
  return { decisions, logs, last: decisions[decisions.length - 1] };
}

function toleranceOf(p: RunningPrescriptionValue, timing: string): number {
  return p.monitoringSnapshot.timingTolerances.find((t) => t.timing === timing)!.toleranceS!;
}

/** 数値評価済み（PASS）の過去ログを直接作る（参照ベストを固定したいテスト用。schema を通したものだけ）。 */
function passLog(p: RunningPrescriptionValue, timing: RepLogEntry["timing"], timeS: number, repIndex = 1): RepLogEntry {
  return repLogEntrySchema.parse({
    stopPolicyId: p.stopPolicyId,
    setIndex: 1,
    repIndex,
    timeS,
    timing,
    effectiveTiming: timing,
    toleranceS: toleranceOf(p, timing),
    referenceTimeS: null,
    referenceSource: null,
    quality: "PASS",
    fasterThanTargetLower: null,
    startQuality: null,
    measuredVelocityDecrementPercent: null,
    action: "CONTINUE",
    safetyOutcome: "NONE",
    restTakenS: null,
    highSpeedExposureM: { lower: null, upper: null, unit: "m", source: "PLANNED", confidence: "NONE" },
    reasons: ["REFERENCE_ESTABLISHED"],
  });
}

function withSnapshot(p: RunningPrescriptionValue, mutate: (clone: RunningPrescriptionValue) => void): RunningPrescriptionValue {
  const clone = structuredClone(p);
  mutate(clone);
  return runningPrescriptionSchema.parse(clone);
}

// ---------------------------------------------------------------------------
// Snapshot 構造（R8 metadata）
// ---------------------------------------------------------------------------

describe("R8 snapshot: StopPolicy.runtime と safetyPolicy", () => {
  it("処方の monitoringSnapshot は plan 時点の StopPolicy 行（runtime を含む）と R5 red flag グループのコピー", () => {
    const p = acc();
    expect(p.monitoringSnapshot.stopPolicy).toEqual(ruleSet.stopPolicies.find((sp) => sp.id === p.stopPolicyId));
    expect(p.monitoringSnapshot.stopPolicy.runtime.timingEvaluation).toBe("SLOWER_THAN_REFERENCE_FAILS");
    expect(p.monitoringSnapshot.safetyPolicy.redFlagGroups.length).toBe(ruleSet.readinessRules.filter((r) => r.kind === "PAIN_RED_FLAG_GROUP").length);
  });

  it("§10.3 の表が runtime metadata として表現されている（id ごとの期待値。monitor 本体は id を見ない）", () => {
    const byId = new Map(ruleSet.stopPolicies.map((sp) => [sp.id as string, sp.runtime]));
    expect(byId.get("SP_ACC")).toMatchObject({ reference: "PRIOR_SESSION_BEST", firstFailureAction: "EXTEND_REST", consecutiveFailureAction: "END_SESSION_QUALITY", poorStartConsecutiveThreshold: 2 });
    expect(byId.get("SP_MV")).toEqual(byId.get("SP_ACC"));
    expect(byId.get("SP_SES")).toMatchObject({ reference: "TARGET_UPPER_ELSE_PRIOR_SESSION_BEST", firstFailureAction: null, consecutiveFailureAction: "END_SESSION_QUALITY" });
    expect(byId.get("SP_LSR_FULL")).toMatchObject({ reference: "TARGET_UPPER", consecutiveFailureAction: "END_SESSION_QUALITY" });
    expect(byId.get("SP_LSR_INCOMPLETE_ADV")).toMatchObject({ reference: "TARGET_UPPER", consecutiveFailureAction: "COACH_REVIEW" });
    expect(byId.get("SP_LSR_INCOMPLETE_STRICT")).toEqual(byId.get("SP_LSR_FULL"));
    expect(byId.get("SP_TE")).toMatchObject({ timingEvaluation: "FASTER_THAN_TARGET_LOWER_WARNS", reference: "TARGET_LOWER", tooFastConsecutiveThreshold: 2, consecutiveFailureAction: null });
    expect(byId.get("SP_TI")).toMatchObject({ reference: "TARGET_UPPER", consecutiveFailureAction: "END_SET" });
    expect(byId.get("SP_RS")).toMatchObject({ timingEvaluation: "NONE", velocityDecrementOutOfBandAction: "COACH_REVIEW" });
    expect(byId.get("SP_AS")).toMatchObject({ timingEvaluation: "NONE", techniqueNotGoodAction: "STOP_SAFETY", techniqueMissingAction: "COACH_REVIEW", techniqueDeterioratingAction: null });
    expect(byId.get("SP_EA")).toMatchObject({ timingEvaluation: "NONE", plannedCountUnit: "ATTEMPTS" });
    expect(byId.get("SP_STRIDE")).toMatchObject({ timingEvaluation: "NONE", effortBecameMaximalAction: "COACH_REVIEW" });
    // 既存の数値 policy とも一致する（consecutiveFailuresToStop / numericStopAvailable は変更していない）
    for (const sp of ruleSet.stopPolicies) {
      expect(sp.numericStopAvailable, sp.id).toBe(sp.runtime.timingEvaluation === "SLOWER_THAN_REFERENCE_FAILS");
    }
  });

  it("runtime metadata の矛盾は RuleSet / snapshot の schema で拒否する", () => {
    const p = acc();
    const bad = structuredClone(p);
    (bad.monitoringSnapshot.stopPolicy.runtime as { consecutiveFailureAction: string | null }).consecutiveFailureAction = null;
    expect(runningPrescriptionSchema.safeParse(bad).success).toBe(false);
    const noSafety = structuredClone(p) as unknown as { monitoringSnapshot: Record<string, unknown> };
    delete noSafety.monitoringSnapshot.safetyPolicy;
    expect(runningPrescriptionSchema.safeParse(noSafety).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RepObservation validation（§19 + R8 errata）
// ---------------------------------------------------------------------------

describe("RepObservationSchema", () => {
  const base = { setIndex: 1, repIndex: 1, timeS: 4.5, timing: "HAND" };

  it("最小の観測を受け付ける（index は 1 始まり）", () => {
    expect(repObservationSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    ["setIndex=0", { setIndex: 0 }],
    ["repIndex 小数", { repIndex: 1.5 }],
    ["timeS=0", { timeS: 0 }],
    ["timeS 負", { timeS: -1 }],
    ["timeS NaN", { timeS: Number.NaN }],
    ["timeS Infinity", { timeS: Number.POSITIVE_INFINITY }],
    ["videoFps=0", { timing: "VIDEO", videoFps: 0 }],
    ["measuredVelocityMps 負", { measuredVelocityMps: -3 }],
    ["vdec > 100", { measuredVelocityDecrementPercent: 101 }],
    ["restTakenS 負", { restTakenS: -1 }],
    ["露出 lower>upper", { actualHighSpeedExposureM: { lower: 30, upper: 20, unit: "m", source: "MEASURED", confidence: "HIGH" } }],
    ["露出 Infinity", { actualHighSpeedExposureM: { lower: 0, upper: Number.POSITIVE_INFINITY, unit: "m", source: "MEASURED", confidence: "HIGH" } }],
    ["露出 ESTIMATED を実測として渡す", { actualHighSpeedExposureM: { lower: 10, upper: 20, unit: "m", source: "ESTIMATED", confidence: "LOW" } }],
    ["未知のキー", { comment: "自由記述" }],
    ["painNow=false で部位", { athleteReport: { painNow: false, painRegion: "KNEE" } }],
    ["redFlags 重複", { athleteReport: { painNow: true, redFlags: ["LIMPING", "LIMPING"] } }],
    ["coachJudgment 未知キー", { coachJudgment: { note: "x" } }],
  ])("拒否: %s", (_label, patch) => {
    expect(repObservationSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it("T-TIM-05: VIDEO で fps が無い / null の観測は拒否しない", () => {
    expect(repObservationSchema.safeParse({ ...base, timing: "VIDEO" }).success).toBe(true);
    expect(repObservationSchema.safeParse({ ...base, timing: "VIDEO", videoFps: null }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Safety gate（§10.3 共通行・T-TIM-06・T-PH-01）
// ---------------------------------------------------------------------------

describe("Safety gate（最優先）", () => {
  it("T-TIM-06: timeS=null + painNow=true → STOP_SAFETY（timing より前）", () => {
    const d = monitorRunningPrescription({ prescription: acc(), priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: null, timing: "HAND", athleteReport: { painNow: true } });
    expect(d.action).toBe("STOP_SAFETY");
    expect(d.quality).toBe("NOT_EVALUATED_COACH_ONLY");
    expect(d.reasons).toEqual(["SAFETY_STOP_ATHLETE"]);
  });

  it.each([
    ["painNow", { athleteReport: { painNow: true } }],
    ["red flag + 良いタイム", { athleteReport: { painNow: false, redFlags: ["DIZZINESS_OR_BREATHING_DIFFICULTY"] } }],
    ["requestsStop", { athleteReport: { painNow: false, requestsStop: true } }],
    ["environmentUnsafe", { coachJudgment: { environmentUnsafe: true } }],
    ["technique UNSAFE", { coachJudgment: { technique: "UNSAFE" } }],
  ])("%s → STOP_SAFETY（どの method でも）", (_label, patch) => {
    for (const p of [acc(), te(), stride(), ea(), rs()]) {
      const d = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 4.4, timing: "PHOTO_CELL", ...patch } as RepObservation);
      expect(d.action, p.stopPolicyId).toBe("STOP_SAFETY");
      expect(d.safetyOutcome, p.stopPolicyId).not.toBe("NONE");
    }
  });

  it("2回目の timing FAIL + painNow → END_SESSION_QUALITY ではなく STOP_SAFETY", () => {
    const p = acc();
    const { logs } = runSequence(p, [{ timeS: 4.5 }, { timeS: 4.8 }]); // 確立 → FAIL（EXTEND_REST）
    const d = monitorRunningPrescription({ prescription: p, priorLogs: logs }, { setIndex: 1, repIndex: 3, timeS: 4.8, timing: "HAND", athleteReport: { painNow: true } });
    expect(d.action).toBe("STOP_SAFETY");
    // 同じ観測から痛みを除けば END_SESSION_QUALITY（safety が勝っていることの対照）
    const control = monitorRunningPrescription({ prescription: p, priorLogs: logs }, { setIndex: 1, repIndex: 3, timeS: 4.8, timing: "HAND" });
    expect(control.action).toBe("END_SESSION_QUALITY");
  });

  it("safetyOutcome: MEDICAL グループの red flag → MEDICAL_EVALUATION_RECOMMENDED。その他の中止 → COACH_REVIEW", () => {
    const p = acc();
    const decide = (patch: ObsInput) => monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: null, timing: "HAND", ...patch } as RepObservation);
    const medical = ruleSet.readinessRules.find((r) => r.kind === "PAIN_RED_FLAG_GROUP" && r.safetyOutcome === "MEDICAL_EVALUATION_RECOMMENDED");
    const review = ruleSet.readinessRules.find((r) => r.kind === "PAIN_RED_FLAG_GROUP" && r.safetyOutcome === "COACH_REVIEW");
    if (medical?.kind !== "PAIN_RED_FLAG_GROUP" || review?.kind !== "PAIN_RED_FLAG_GROUP") throw new Error("fixture");
    expect(decide({ athleteReport: { painNow: true, redFlags: [medical.redFlags[0]] } }).safetyOutcome).toBe("MEDICAL_EVALUATION_RECOMMENDED");
    expect(decide({ athleteReport: { painNow: true, redFlags: [review.redFlags[0]] } }).safetyOutcome).toBe("COACH_REVIEW");
    // 複数グループに該当 → 重い方（順序非依存）
    expect(decide({ athleteReport: { painNow: true, redFlags: [review.redFlags[0], medical.redFlags[0]] } }).safetyOutcome).toBe("MEDICAL_EVALUATION_RECOMMENDED");
    expect(decide({ athleteReport: { painNow: true } }).safetyOutcome).toBe("COACH_REVIEW");
    expect(decide({ athleteReport: { painNow: false, requestsStop: true } }).safetyOutcome).toBe("COACH_REVIEW");
    expect(decide({ coachJudgment: { technique: "UNSAFE" } }).safetyOutcome).toBe("COACH_REVIEW");
    expect(decide({ coachJudgment: { environmentUnsafe: true } }).safetyOutcome).toBe("COACH_REVIEW");
  });

  it("T-PH-01（monitor）: どの phase で計画した処方でも painNow → STOP_SAFETY（phase を再評価しない・緩めない）", () => {
    for (const phase of [null, ...TRAINING_PHASES]) {
      for (const p of [planned("ACCELERATION", "ACC_BLOCK_30", { phase }), planned("STRIDE", "ST_RELAXED", { phase })]) {
        const d = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 4.4, timing: "PHOTO_CELL", athleteReport: { painNow: true } });
        expect(d.action, `${phase}/${p.stopPolicyId}`).toBe("STOP_SAFETY");
        expect(d.safetyOutcome, `${phase}/${p.stopPolicyId}`).toBe("COACH_REVIEW");
      }
    }
  });

  it("red flag の safetyPolicy グループの順序を入れ替えても outcome は同じ", () => {
    const p = acc();
    const reversed = withSnapshot(p, (c) => {
      c.monitoringSnapshot.safetyPolicy.redFlagGroups.reverse();
    });
    const allFlags = p.monitoringSnapshot.safetyPolicy.redFlagGroups.flatMap((g) => g.redFlags);
    for (const flag of allFlags) {
      const obs: RepObservation = { setIndex: 1, repIndex: 1, timeS: null, timing: "HAND", athleteReport: { painNow: true, redFlags: [flag] } };
      expect(monitorRunningPrescription({ prescription: reversed, priorLogs: [] }, obs).safetyOutcome).toBe(
        monitorRunningPrescription({ prescription: p, priorLogs: [] }, obs).safetyOutcome,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Privacy（§13.5）
// ---------------------------------------------------------------------------

describe("§13.5: RepLogEntry に健康情報を残さない", () => {
  const FORBIDDEN = ["pain", "region", "redflag", "heel", "knee", "hamstring", "calf", "swelling", "limping", "numbness", "reported"];

  it("部位・red flag・痛みの有無が logEntry / reasons の JSON に出ない（case-insensitive）", () => {
    const p = acc();
    const d = monitorRunningPrescription(
      { prescription: p, priorLogs: [] },
      {
        setIndex: 1,
        repIndex: 1,
        timeS: 4.6,
        timing: "HAND",
        athleteReport: { painNow: true, painRegion: "KNEE", redFlags: ["SWELLING", "LIMPING", "NUMBNESS_TINGLING"], requestsStop: true },
        coachJudgment: { technique: "DETERIORATING" },
      },
    );
    expect(d.safetyOutcome).toBe("MEDICAL_EVALUATION_RECOMMENDED");
    const logJson = JSON.stringify(d.logEntry).toLowerCase();
    const reasonsJson = JSON.stringify(d.reasons).toLowerCase();
    for (const word of FORBIDDEN) {
      expect(logJson, word).not.toContain(word);
      expect(reasonsJson, word).not.toContain(word);
    }
    for (const key of ["athleteReport", "painNow", "painRegion", "redFlags"]) expect(Object.keys(d.logEntry)).not.toContain(key);
  });

  it("red flag の種類が違っても logEntry は（safetyOutcome 以外）同じ generic 表現", () => {
    const p = acc();
    const a = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: null, timing: "HAND", athleteReport: { painNow: true, redFlags: ["LIMPING"] } });
    const b = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: null, timing: "HAND", athleteReport: { painNow: true, redFlags: ["SWELLING"], painRegion: "HEEL" } });
    expect(a.logEntry).toEqual(b.logEntry);
  });
});

// ---------------------------------------------------------------------------
// Timing（§10.2・T-TIM-01〜05）
// ---------------------------------------------------------------------------

describe("Timing tolerance（snapshot の値だけを使う）", () => {
  it("T-TIM-01: SP_ACC・HAND・ベスト 4.50 → 4.70 PASS（≤4.75）、4.80 FAIL → EXTEND_REST、連続 FAIL → END_SESSION_QUALITY", () => {
    const p = acc();
    expect(toleranceOf(p, "HAND")).toBe(0.25);
    const { decisions } = runSequence(p, [{ timeS: 4.5 }, { timeS: 4.7 }, { timeS: 4.8 }, { timeS: 4.8 }]);
    expect(decisions.map((d) => d.quality)).toEqual(["PASS", "PASS", "FAIL", "FAIL"]);
    expect(decisions[0].reasons).toContain("REFERENCE_ESTABLISHED");
    expect(decisions[1].logEntry.referenceTimeS).toBe(4.5);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "CONTINUE", "EXTEND_REST", "END_SESSION_QUALITY"]);
    expect(decisions.map((d) => d.consecutiveFailures)).toEqual([0, 0, 1, 2]);
    expect(decisions[3].reasons).toContain("CONSECUTIVE_TIMING_FAILURES");
  });

  it("FAIL の境界: timeS = 参照 + tolerance は PASS（`>` のみ FAIL）", () => {
    const p = acc();
    expect(runSequence(p, [{ timeS: 4.5 }, { timeS: 4.75 }]).last.quality).toBe("PASS");
    expect(runSequence(p, [{ timeS: 4.5 }, { timeS: 4.76 }]).last.quality).toBe("FAIL");
  });

  it("T-TIM-02: MV_FLY10・HAND・参照 1.10 → tol/参照 > 0.10 → NOT_EVALUATED_COACH_ONLY（遅くても FAIL にしない）", () => {
    const p = mvFly10();
    expect(p.stopPolicyId).toBe("SP_MV");
    expect(p.sets.value * p.repsPerSet.value).toBe(2); // 2本目は予定本数到達（timing とは無関係の END）
    for (const timeS of [1.12, 1.6, 3.0]) {
      const d = monitorRunningPrescription({ prescription: p, priorLogs: [passLog(p, "HAND", 1.1)] }, { setIndex: 1, repIndex: 2, timeS, timing: "HAND" });
      expect(d.quality).toBe("NOT_EVALUATED_COACH_ONLY");
      expect(d.consecutiveFailures).toBe(0);
      expect(d.reasons).toContain("TIMING_TOLERANCE_RATIO_EXCEEDED");
      expect(d.reasons).not.toContain("TIMING_FAIL");
      expect(d.reasons).not.toContain("CONSECUTIVE_TIMING_FAILURES");
      expect(d.reasons.filter((r) => r !== "TIMING_TOLERANCE_RATIO_EXCEEDED")).toEqual(["PLANNED_REPS_COMPLETE"]);
      expect(d.logEntry.referenceTimeS).toBe(1.1);
    }
    // 予定本数に達しない fly（MV_FLY20 × HAND、参照 2.0 → 0.25/2.0 > 0.10）でも数値の END/FAIL は出ない
    const fly20 = mvFly20();
    const hand = runSequence(fly20, [{ timeS: 2.0 }, { timeS: 2.6 }, { timeS: 2.6 }]);
    expect(hand.decisions.map((d) => d.quality)).toEqual(["NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY"]);
    expect(hand.decisions.map((d) => d.action)).toEqual(["CONTINUE", "CONTINUE", "CONTINUE"]);
    // 最初の本（参照の確立）でも HAND の fly10 は自分のタイムに対して比率条件を満たさないので COACH_ONLY
    const first = runSequence(p, [{ timeS: 1.1 }, { timeS: 1.5 }]);
    expect(first.decisions.map((d) => d.quality)).toEqual(["NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY"]);
  });

  it("比率条件の境界: tol/参照 がちょうど 0.10 は数値評価、超えたら COACH_ONLY", () => {
    const p = acc();
    expect(exceedsToleranceRatio(0.25, 2.5, 0.1)).toBe(false);
    expect(exceedsToleranceRatio(0.25, 2.49, 0.1)).toBe(true);
    const exact = monitorRunningPrescription({ prescription: p, priorLogs: [passLog(p, "HAND", 2.5)] }, { setIndex: 1, repIndex: 2, timeS: 2.8, timing: "HAND" });
    expect(exact.quality).toBe("FAIL");
    const over = monitorRunningPrescription({ prescription: p, priorLogs: [passLog(p, "HAND", 2.49)] }, { setIndex: 1, repIndex: 2, timeS: 2.8, timing: "HAND" });
    expect(over.quality).toBe("NOT_EVALUATED_COACH_ONLY");
  });

  it("T-TIM-03: MV_FLY20・PHOTO_CELL（tol 0.05）→ 数値判定。参照+0.05 ちょうどは PASS、超えたら FAIL", () => {
    const p = mvFly20();
    expect(toleranceOf(p, "PHOTO_CELL")).toBe(0.05);
    const { decisions } = runSequence(p, [
      { timeS: 2.0, timing: "PHOTO_CELL" },
      { timeS: 2.05, timing: "PHOTO_CELL" },
      { timeS: 2.06, timing: "PHOTO_CELL" },
    ]);
    expect(decisions.map((d) => d.quality)).toEqual(["PASS", "PASS", "FAIL"]);
    expect(decisions[2].action).toBe("EXTEND_REST");
  });

  it("T-TIM-04: UNKNOWN / RADAR_LASER は COACH_ONLY（どれだけ遅くても FAIL・END にしない）", () => {
    const p = acc();
    for (const timing of ["UNKNOWN", "RADAR_LASER"] as const) {
      const { decisions } = runSequence(p, [
        { timeS: 4.5, timing },
        { timeS: 9.0, timing, measuredVelocityMps: 6 },
        { timeS: 9.0, timing },
      ]);
      expect(decisions.map((d) => d.quality), timing).toEqual(["NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY"]);
      expect(decisions.map((d) => d.action), timing).toEqual(["CONTINUE", "CONTINUE", "CONTINUE"]);
      expect(decisions[1].reasons).toContain("TIMING_METHOD_COACH_ONLY");
    }
  });

  it("T-TIM-05: VIDEO で fps が無い / null → effective timing UNKNOWN → COACH_ONLY。fps があれば 2/fps", () => {
    const p = acc();
    for (const videoFps of [undefined, null]) {
      const d = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 4.5, timing: "VIDEO", ...(videoFps === undefined ? {} : { videoFps }) });
      expect(d.logEntry.timing).toBe("VIDEO");
      expect(d.logEntry.effectiveTiming).toBe("UNKNOWN");
      expect(d.quality).toBe("NOT_EVALUATED_COACH_ONLY");
      expect(d.reasons).toContain("TIMING_VIDEO_FPS_MISSING");
    }
    const withFps = runSequence(p, [
      { timeS: 4.5, timing: "VIDEO", videoFps: 50 },
      { timeS: 4.55, timing: "VIDEO", videoFps: 50 },
    ]);
    const perFps = p.monitoringSnapshot.timingTolerances.find((t) => t.timing === "VIDEO")!.toleranceSPerFps!;
    expect(withFps.last.logEntry.toleranceS).toBeCloseTo(perFps / 50, 12);
    expect(withFps.last.quality).toBe("FAIL"); // 4.55 > 4.50 + 0.04
  });

  it("参照は同じ effective timing の過去ログだけ（HAND のベストと PHOTO_CELL を混ぜない）", () => {
    const p = acc();
    const { decisions } = runSequence(p, [
      { timeS: 4.2, timing: "HAND" },
      { timeS: 4.5, timing: "PHOTO_CELL" },
    ]);
    expect(decisions[1].reasons).toContain("REFERENCE_ESTABLISHED");
    expect(decisions[1].logEntry.referenceTimeS).toBeNull();
  });

  it("timeS=null（計時なし）は COACH_ONLY。参照を捏造しない", () => {
    const d = runSequence(acc(), [{ timeS: 4.5 }, { timeS: null }]).last;
    expect(d.quality).toBe("NOT_EVALUATED_COACH_ONLY");
    expect(d.reasons).toContain("TIMING_NOT_RECORDED");
  });
});

// ---------------------------------------------------------------------------
// Session-best の参照候補（isReferenceCandidate と isNumericStopEvaluable を分ける）
// ---------------------------------------------------------------------------

describe("[R8 correction] session-best の参照候補", () => {
  it("A: HAND fly10 1.10 は比率条件で COACH_ONLY だが参照候補。次の本の参照は 1.10 で、数値 stop は引き続き COACH_ONLY", () => {
    const p = mvFly10();
    const { decisions, logs } = runSequence(p, [{ timeS: 1.1 }, { timeS: 1.3 }]);
    expect(decisions[0].quality).toBe("NOT_EVALUATED_COACH_ONLY");
    expect(decisions[0].reasons).toContain("TIMING_TOLERANCE_RATIO_EXCEEDED");
    expect(isReferenceCandidate(logs[0])).toBe(true);
    expect(isNumericStopEvaluable(logs[0].toleranceS!, 1.1, p.monitoringSnapshot.timingTolerances.find((t) => t.timing === "HAND")!.coachOnlyRatioThreshold)).toBe(false);
    expect(decisions[1].logEntry.referenceTimeS).toBe(1.1);
    expect(decisions[1].logEntry.referenceSource).toBe("PRIOR_SESSION_BEST");
    expect(decisions[1].quality).toBe("NOT_EVALUATED_COACH_ONLY");
    expect(decisions[1].reasons).not.toContain("TIMING_FAIL");
  });

  it("遅い本が後から「参照の確立」を起こさない（真のベストが COACH_ONLY でも参照に残る）", () => {
    const p = mvFly20();
    const { decisions } = runSequence(p, [{ timeS: 2.0 }, { timeS: 2.6 }, { timeS: 2.6 }]); // HAND
    expect(decisions.map((d) => d.logEntry.referenceTimeS)).toEqual([null, 2.0, 2.0]);
    expect(decisions.map((d) => d.quality)).toEqual(["NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY"]);
    expect(decisions.every((d) => !d.reasons.includes("REFERENCE_ESTABLISHED"))).toBe(true);
  });

  it("B: UNKNOWN 1.10 は COACH_ONLY かつ参照候補にならない", () => {
    const p = acc();
    const { decisions, logs } = runSequence(p, [{ timeS: 1.1, timing: "UNKNOWN" }]);
    expect(decisions[0].quality).toBe("NOT_EVALUATED_COACH_ONLY");
    expect(isReferenceCandidate(logs[0])).toBe(false);
    expect(priorSessionBest(logs, "UNKNOWN")).toBeNull();
  });

  it("RADAR_LASER のタイムも時間の参照候補にしない（速度 policy とは別）", () => {
    const { logs } = runSequence(acc(), [{ timeS: 1.1, timing: "RADAR_LASER", measuredVelocityMps: 9 }]);
    expect(isReferenceCandidate(logs[0])).toBe(false);
    expect(priorSessionBest(logs, "RADAR_LASER")).toBeNull();
  });

  it("C: VIDEO で fps が無い 1.10 は effective UNKNOWN → 参照候補にならない（次の fps 付き VIDEO は参照の確立）", () => {
    const p = acc();
    const { decisions, logs } = runSequence(p, [
      { timeS: 1.1, timing: "VIDEO" },
      { timeS: 4.5, timing: "VIDEO", videoFps: 60 },
    ]);
    expect(logs[0].effectiveTiming).toBe("UNKNOWN");
    expect(isReferenceCandidate(logs[0])).toBe(false);
    expect(decisions[1].logEntry.referenceTimeS).toBeNull();
    expect(decisions[1].reasons).toContain("REFERENCE_ESTABLISHED");
  });

  it("D: painNow + 速いタイム → STOP_SAFETY。そのタイムは後続の参照に使わない", () => {
    const p = mvFly20();
    const { decisions, logs } = runSequence(p, [
      { timeS: 1.8, timing: "PHOTO_CELL", athleteReport: { painNow: true } },
      { timeS: 2.0, timing: "PHOTO_CELL" },
      { timeS: 2.04, timing: "PHOTO_CELL" },
    ]);
    expect(decisions[0].action).toBe("STOP_SAFETY");
    expect(isReferenceCandidate(logs[0])).toBe(false);
    expect(decisions[1].logEntry.referenceTimeS).toBeNull();
    expect(decisions[1].reasons).toContain("REFERENCE_ESTABLISHED");
    expect(decisions[2].logEntry.referenceTimeS).toBe(2.0); // 1.8 ではない
    expect(decisions[2].quality).toBe("PASS");
  });

  it("参照の確立: 候補が無い最初の本は自分自身に対して FAIL 判定しない（PASS + REFERENCE_ESTABLISHED）", () => {
    const d = runSequence(acc(), [{ timeS: 9.9, timing: "PHOTO_CELL" }]).last;
    expect(d.quality).toBe("PASS");
    expect(d.reasons).toContain("REFERENCE_ESTABLISHED");
    expect(d.logEntry.referenceTimeS).toBeNull();
    expect(d.consecutiveFailures).toBe(0);
  });

  it("quality / streak と参照候補は別: FAIL の本も候補（ベストを更新しないだけ）", () => {
    const { decisions, logs } = runSequence(acc(), [{ timeS: 4.5 }, { timeS: 4.9 }]);
    expect(decisions[1].quality).toBe("FAIL");
    expect(isReferenceCandidate(logs[1])).toBe(true);
    expect(priorSessionBest(logs, "HAND")).toBe(4.5);
  });
});

// ---------------------------------------------------------------------------
// Consecutive failures（streak の意味）
// ---------------------------------------------------------------------------

describe("連続 FAIL の定義", () => {
  it("PASS で途切れる", () => {
    const { decisions } = runSequence(acc(), [{ timeS: 4.5 }, { timeS: 4.8 }, { timeS: 4.6 }, { timeS: 4.8 }]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "EXTEND_REST", "CONTINUE", "EXTEND_REST"]);
  });

  it("FAIL → COACH_ONLY → FAIL は2回連続にしない（COACH_ONLY で途切れる）", () => {
    const { decisions } = runSequence(acc(), [{ timeS: 4.5 }, { timeS: 4.8 }, { timeS: 5.0, timing: "UNKNOWN" }, { timeS: 4.8 }]);
    expect(decisions.map((d) => d.quality)).toEqual(["PASS", "FAIL", "NOT_EVALUATED_COACH_ONLY", "FAIL"]);
    expect(decisions[3].consecutiveFailures).toBe(1);
    expect(decisions[3].action).toBe("EXTEND_REST");
  });
});

// ---------------------------------------------------------------------------
// Stop policies（Method × recoveryStructure）
// ---------------------------------------------------------------------------

describe("§10.3 stop policy の実挙動", () => {
  it("SP_MV も SP_ACC と同じ（1回目 FAIL → EXTEND_REST、連続 → END_SESSION_QUALITY）", () => {
    const { decisions } = runSequence(mvFly20(), [
      { timeS: 2.0, timing: "PHOTO_CELL" },
      { timeS: 2.2, timing: "PHOTO_CELL" },
      { timeS: 2.2, timing: "PHOTO_CELL" },
    ]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "EXTEND_REST", "END_SESSION_QUALITY"]);
  });

  it("SP_SES: 目標が無ければセッション内ベスト。1回目 FAIL は CONTINUE、連続 → END_SESSION_QUALITY", () => {
    const p = ses();
    expect(p.intensity.target).toBeNull();
    const { decisions } = runSequence(p, [{ timeS: 12.0 }, { timeS: 12.5 }, { timeS: 12.5 }]);
    expect(decisions.map((d) => d.quality)).toEqual(["PASS", "FAIL", "FAIL"]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "CONTINUE", "END_SESSION_QUALITY"]);
    expect(decisions[1].reasons).toContain("TIMING_FAIL");
  });

  it("SP_SES: snapshot に目標（秒）があれば上端を参照にする（ベストより優先。100m PB 等を再推定しない）", () => {
    const p = withSnapshot(ses(), (c) => {
      c.intensity.target = { lower: 12.0, upper: 12.6, unit: "s", source: "ESTIMATED", confidence: "MEDIUM" };
    });
    const { decisions } = runSequence(p, [{ timeS: 11.0 }, { timeS: 12.8 }, { timeS: 12.8 }]);
    expect(decisions[0].logEntry.referenceSource).toBe("TARGET_UPPER");
    expect(decisions[0].logEntry.referenceTimeS).toBe(12.6);
    expect(decisions.map((d) => d.quality)).toEqual(["PASS", "PASS", "PASS"]); // 12.8 ≤ 12.6 + 0.25
    const fail = runSequence(p, [{ timeS: 12.9 }, { timeS: 12.9 }]);
    expect(fail.decisions.map((d) => d.action)).toEqual(["CONTINUE", "END_SESSION_QUALITY"]);
  });

  it("SP_LSR_FULL: 目標スプリット上端（38秒）。連続 FAIL → END_SESSION_QUALITY。目標が無ければ COACH_ONLY", () => {
    const p = lsrFull();
    expect(p.stopPolicyId).toBe("SP_LSR_FULL");
    const { decisions } = runSequence(p, [{ timeS: 38.5 }, { timeS: 38.5 }]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "END_SESSION_QUALITY"]);
    expect(decisions[0].logEntry.referenceSource).toBe("TARGET_UPPER");
    const noTarget = withSnapshot(p, (c) => {
      c.intensity.target = null;
    });
    const d = runSequence(noTarget, [{ timeS: 50 }, { timeS: 50 }]).last;
    expect(d.quality).toBe("NOT_EVALUATED_COACH_ONLY");
    expect(d.reasons).toContain("NO_NUMERIC_REFERENCE");
    expect(d.action).toBe("CONTINUE");
  });

  it("T-LSR-02（monitor）: SP_LSR_INCOMPLETE_ADV は目標超過1回では継続、2回連続でも END にせず COACH_REVIEW。共通 hard stop は即 STOP", () => {
    const p = lsrIncomplete();
    expect(p.stopPolicyId).toBe("SP_LSR_INCOMPLETE_ADV");
    expect(p.sets.value * p.repsPerSet.value).toBe(3);
    const { decisions, logs } = runSequence(p, [{ timeS: 53 }, { timeS: 53 }]);
    expect(decisions.map((d) => d.quality)).toEqual(["FAIL", "FAIL"]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "COACH_REVIEW"]);
    const hard = monitorRunningPrescription({ prescription: p, priorLogs: logs.slice(0, 1) }, { setIndex: 1, repIndex: 2, timeS: 53, timing: "HAND", athleteReport: { painNow: true } });
    expect(hard.action).toBe("STOP_SAFETY");
  });

  it("T-LSR-03（monitor）: SP_LSR_INCOMPLETE_STRICT は同じ2回連続の目標超過で END_SESSION_QUALITY（ADV との差）", () => {
    const strict = lsrIncomplete(athlete({ primaryEvent: "100m" }));
    const adv = lsrIncomplete();
    expect(strict.stopPolicyId).toBe("SP_LSR_INCOMPLETE_STRICT");
    const observations: ObsInput[] = [{ timeS: 53 }, { timeS: 53 }];
    expect(runSequence(strict, observations).decisions.map((d) => d.action)).toEqual(["CONTINUE", "END_SESSION_QUALITY"]);
    expect(runSequence(adv, observations).decisions.map((d) => d.action)).toEqual(["CONTINUE", "COACH_REVIEW"]);
    // 差は snapshot の runtime.consecutiveFailureAction だけから来る（id を入れ替えても挙動は runtime に従う）
    const advWithStrictId = withSnapshot(adv, (c) => {
      c.stopPolicyId = strict.stopPolicyId;
      c.monitoringSnapshot.stopPolicy.id = strict.stopPolicyId;
    });
    expect(runSequence(advWithStrictId, observations).decisions.map((d) => d.action)).toEqual(["CONTINUE", "COACH_REVIEW"]);
  });

  it("SP_TE: 数値 stop なし（常に COACH_ONLY）。目標下端より速すぎが2回連続 → reason だけ（END にしない）", () => {
    const p = te();
    const lower = p.intensity.target!.lower!;
    const tooFast = lower - 1;
    const { decisions } = runSequence(p, [{ timeS: tooFast }, { timeS: tooFast }, { timeS: tooFast }]);
    expect(decisions.map((d) => d.quality)).toEqual(["NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY", "NOT_EVALUATED_COACH_ONLY"]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "CONTINUE", "CONTINUE"]);
    expect(decisions[0].reasons).not.toContain("TEMPO_FASTER_THAN_TARGET_REPEATED");
    expect(decisions[1].reasons).toContain("TEMPO_FASTER_THAN_TARGET_REPEATED");
    expect(decisions[1].safetyOutcome).toBe("NONE");
    // 遅すぎても止めない
    expect(runSequence(p, [{ timeS: 60 }, { timeS: 60 }]).decisions.map((d) => d.action)).toEqual(["CONTINUE", "CONTINUE"]);
    // 速すぎ → 目標内 → 速すぎ は連続にしない
    const broken = runSequence(p, [{ timeS: tooFast }, { timeS: lower + 1 }, { timeS: tooFast }]);
    expect(broken.last.reasons).not.toContain("TEMPO_FASTER_THAN_TARGET_REPEATED");
  });

  it("SP_TI: 目標上端を2回連続で超過 → END_SET（session 終了ではない）。END_SET 後の set に FAIL を持ち越さない", () => {
    const p = ti();
    const upper = p.intensity.target!.upper!;
    const slow = upper + 1;
    const { decisions, logs } = runSequence(p, [
      { setIndex: 1, repIndex: 1, timeS: slow },
      { setIndex: 1, repIndex: 2, timeS: slow },
    ]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "END_SET"]);
    const nextSet = monitorRunningPrescription({ prescription: p, priorLogs: logs }, { setIndex: 2, repIndex: 1, timeS: slow, timing: "HAND" });
    expect(nextSet.consecutiveFailures).toBe(1);
    expect(nextSet.action).toBe("CONTINUE");
  });

  it("SP_RS: 実測 vdec が band（0–10%）外 → COACH_REVIEW。band 内・未入力は継続", () => {
    const p = rs();
    const decide = (vdec: number | null) =>
      monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 5.0, timing: "HAND", measuredVelocityDecrementPercent: vdec });
    expect(decide(12).action).toBe("COACH_REVIEW");
    expect(decide(12).reasons).toContain("VELOCITY_DECREMENT_OUT_OF_BAND");
    // E10: LIGHT は 10% 未満。境界値 10% は MODERATE で、LIGHT reference には一致しない。
    expect(decide(9.999).action).toBe("CONTINUE");
    expect(decide(10).action).toBe("COACH_REVIEW");
    expect(decide(0).action).toBe("CONTINUE");
    expect(decide(null).action).toBe("CONTINUE");
    // 速度 m/s だけでは vdec を推定しない（基準速度が snapshot に無い）
    const velocityOnly = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 5.0, timing: "HAND", measuredVelocityMps: 3 });
    expect(velocityOnly.action).toBe("CONTINUE");
    expect(velocityOnly.logEntry.measuredVelocityDecrementPercent).toBeNull();
  });

  it("E10: Vdec classification の境界は重複せず、15–30% は review、30%超は VERY_HEAVY review", () => {
    const moderate = planned("RESISTED_SPRINT", "RS_SLED_MODERATE", {
      coachReference: { kind: "VELOCITY_DECREMENT", band: "MODERATE", measured: true },
    });
    const decide = (prescription: RunningPrescriptionValue, vdec: number) =>
      monitorRunningPrescription(
        { prescription, priorLogs: [] },
        { setIndex: 1, repIndex: 1, timeS: 5.0, timing: "HAND", measuredVelocityDecrementPercent: vdec },
      );

    expect(decide(rs(), 9.999).action).toBe("CONTINUE");
    expect(decide(moderate, 10.0).action).toBe("CONTINUE");
    expect(decide(moderate, 14.999).action).toBe("CONTINUE");
    expect(decide(moderate, 15.0).action).toBe("COACH_REVIEW");
    expect(decide(moderate, 30.0).action).toBe("COACH_REVIEW");
    expect(decide(moderate, 30.001).action).toBe("COACH_REVIEW");
  });

  it("SP_AS: technique GOOD は継続、ACCEPTABLE / DETERIORATING / UNSAFE は STOP_SAFETY、未入力は GOOD と推測せず COACH_REVIEW", () => {
    const p = as();
    const decide = (coachJudgment: RepObservation["coachJudgment"]) =>
      monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 2.0, timing: "PHOTO_CELL", coachJudgment });
    expect(decide({ technique: "GOOD" }).action).toBe("CONTINUE");
    for (const technique of ["ACCEPTABLE", "DETERIORATING", "UNSAFE"] as const) {
      const d = decide({ technique });
      expect(d.action, technique).toBe("STOP_SAFETY");
      expect(d.safetyOutcome, technique).toBe("COACH_REVIEW");
    }
    expect(decide(null).action).toBe("COACH_REVIEW");
    expect(decide(null).reasons).toContain("TECHNIQUE_NOT_ASSESSED");
    expect(decide({ startQuality: "GOOD" }).action).toBe("COACH_REVIEW");
  });

  it("SP_EA: timing は COACH_ONLY。attempts 上限到達 → END_SESSION_QUALITY + ATTEMPTS_COMPLETE", () => {
    const p = ea();
    const plannedAttempts = p.sets.value * p.repsPerSet.value;
    const { decisions } = runSequence(p, Array.from({ length: plannedAttempts }, () => ({ timeS: 3.0, timing: "PHOTO_CELL" as const })));
    expect(decisions.slice(0, -1).every((d) => d.action === "CONTINUE" && d.quality === "NOT_EVALUATED_COACH_ONLY")).toBe(true);
    expect(decisions[decisions.length - 1].action).toBe("END_SESSION_QUALITY");
    expect(decisions[decisions.length - 1].reasons).toContain("ATTEMPTS_COMPLETE");
    expect(decisions[decisions.length - 1].reasons).not.toContain("CONSECUTIVE_TIMING_FAILURES");
  });

  it("SP_STRIDE: 数値 timing だけでは止めない。コーチの全力化判定（明示フィールド）→ COACH_REVIEW。DETERIORATING を全力化と読み替えない", () => {
    const p = stride();
    expect(runSequence(p, [{ timeS: 30 }, { timeS: 40 }]).decisions.map((d) => d.action)).toEqual(["CONTINUE", "CONTINUE"]);
    const effort = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 13, timing: "HAND", coachJudgment: { effortBecameMaximal: true } });
    expect(effort.action).toBe("COACH_REVIEW");
    expect(effort.reasons).toContain("EFFORT_BECAME_MAXIMAL");
    const notEffort = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 13, timing: "HAND", coachJudgment: { effortBecameMaximal: false } });
    expect(notEffort.action).toBe("CONTINUE");
    const deteriorating = monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: 13, timing: "HAND", coachJudgment: { technique: "DETERIORATING" } });
    expect(deteriorating.reasons).not.toContain("EFFORT_BECAME_MAXIMAL");
  });

  it("予定本数に到達 → END_SESSION_QUALITY だが reason は PLANNED_REPS_COMPLETE（品質低下と区別）", () => {
    const p = stride();
    const { decisions } = runSequence(p, [{ timeS: 13 }, { timeS: 13 }, { timeS: 13 }]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "CONTINUE", "END_SESSION_QUALITY"]);
    expect(decisions[2].reasons).toEqual(expect.arrayContaining(["PLANNED_REPS_COMPLETE"]));
    expect(decisions[2].reasons).not.toContain("CONSECUTIVE_TIMING_FAILURES");
    expect(decisions[2].completedRepCount).toBe(3);
    expect(decisions[2].plannedRepCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Coach judgment（startQuality / technique）
// ---------------------------------------------------------------------------

describe("§10.4 step 5: coach judgment", () => {
  const start = (startQuality?: "GOOD" | "POOR"): ObsInput => ({ timeS: null, coachJudgment: startQuality === undefined ? {} : { startQuality } });

  it("ACC / MV: startQuality POOR → POOR は COACH_REVIEW", () => {
    for (const p of [acc(), mvFly20()]) {
      const { decisions } = runSequence(p, [start("POOR"), start("POOR")]);
      expect(decisions.map((d) => d.action), p.stopPolicyId).toEqual(["CONTINUE", "COACH_REVIEW"]);
      expect(decisions[1].reasons).toContain("START_QUALITY_POOR_REPEATED");
    }
  });

  it("POOR → GOOD → POOR、POOR → 未入力 → POOR は2回連続ではない", () => {
    expect(runSequence(acc(), [start("POOR"), start("GOOD"), start("POOR")]).last.action).toBe("CONTINUE");
    expect(runSequence(acc(), [start("POOR"), start(), start("POOR")]).last.action).toBe("CONTINUE");
  });

  it("startQuality の連続判定が無い policy（SP_TI 等）では POOR が続いても review しない", () => {
    expect(runSequence(ti(), [start("POOR"), start("POOR")]).last.action).toBe("CONTINUE");
  });

  it("ASSISTED 以外: technique=DETERIORATING → COACH_REVIEW、ACCEPTABLE だけでは止めない", () => {
    const p = acc();
    const decide = (technique: "ACCEPTABLE" | "DETERIORATING") =>
      monitorRunningPrescription({ prescription: p, priorLogs: [] }, { setIndex: 1, repIndex: 1, timeS: null, timing: "HAND", coachJudgment: { technique } });
    expect(decide("DETERIORATING").action).toBe("COACH_REVIEW");
    expect(decide("DETERIORATING").reasons).toContain("TECHNIQUE_DETERIORATING");
    expect(decide("ACCEPTABLE").action).toBe("CONTINUE");
  });
});

// ---------------------------------------------------------------------------
// Rest extension（§10.5）
// ---------------------------------------------------------------------------

describe("EXTEND_REST（延長量の式を作らない）", () => {
  it("次の rest は [計画 repRest, coachEditable.max] の範囲（+30秒・割合を発明しない）", () => {
    const p = acc();
    const d = runSequence(p, [{ timeS: 4.5 }, { timeS: 4.9 }]).last;
    expect(d.action).toBe("EXTEND_REST");
    expect(d.nextRepRestS).toEqual({ min: p.rest.repRestS.value, max: p.rest.repRestS.coachEditable.max, unit: "s" });
    expect(d.nextRepRestS!.max).toBeLessThanOrEqual(p.rest.repRestS.coachEditable.max);
  });

  it("EXTEND_REST 以外の action では nextRepRestS=null", () => {
    expect(runSequence(acc(), [{ timeS: 4.5 }]).last.nextRepRestS).toBeNull();
  });

  it("延長の余地が無い（計画 rest = coachEditable.max）→ EXTEND_REST を返さず COACH_REVIEW", () => {
    const p = withSnapshot(acc(), (c) => {
      c.rest.repRestS.coachEditable = { ...c.rest.repRestS.coachEditable, max: c.rest.repRestS.value };
    });
    const d = runSequence(p, [{ timeS: 4.5 }, { timeS: 4.9 }]).last;
    expect(d.action).toBe("COACH_REVIEW");
    expect(d.nextRepRestS).toBeNull();
    expect(d.reasons).toEqual(expect.arrayContaining(["TIMING_FAIL", "REST_EXTENSION_UNAVAILABLE"]));
  });

  it("restTakenS はログに残すが、短くても自動 FAIL にしない", () => {
    const p = acc();
    const d = runSequence(p, [{ timeS: 4.5 }, { timeS: 4.6, restTakenS: 10 }]).last;
    expect(d.logEntry.restTakenS).toBe(10);
    expect(d.quality).toBe("PASS");
    expect(d.action).toBe("CONTINUE");
  });

  it("同じ本（setIndex+repIndex）を2回判定しない: 既にログ済み・順序が逆の観測は拒否（EXTEND_REST の二重発行を防ぐ）", () => {
    const p = acc();
    const { logs, last } = runSequence(p, [{ timeS: 4.5 }, { timeS: 4.9 }]);
    expect(last.action).toBe("EXTEND_REST");
    expect(() => monitorRunningPrescription({ prescription: p, priorLogs: logs }, { setIndex: 1, repIndex: 2, timeS: 4.9, timing: "HAND" })).toThrow();
    expect(() => monitorRunningPrescription({ prescription: p, priorLogs: logs }, { setIndex: 1, repIndex: 1, timeS: 4.9, timing: "HAND" })).toThrow();
  });

  it("MonitorState の検証: ログの重複・逆順・別処方のログは拒否", () => {
    const p = acc();
    const { logs } = runSequence(p, [{ timeS: 4.5 }, { timeS: 4.6 }]);
    const obs: RepObservation = { setIndex: 1, repIndex: 3, timeS: 4.6, timing: "HAND" };
    expect(() => monitorRunningPrescription({ prescription: p, priorLogs: [logs[0], logs[0]] }, obs)).toThrow();
    expect(() => monitorRunningPrescription({ prescription: p, priorLogs: [logs[1], logs[0]] }, obs)).toThrow();
    const otherPolicy = stride();
    expect(() => monitorRunningPrescription({ prescription: otherPolicy, priorLogs: logs }, obs)).toThrow();
    const broken = { ...p, monitoringSnapshot: { ...p.monitoringSnapshot, stopPolicy: { ...p.monitoringSnapshot.stopPolicy, id: "SP_OTHER" } } };
    expect(() => monitorRunningPrescription({ prescription: broken as RunningPrescriptionValue, priorLogs: [] }, { ...obs, repIndex: 1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Exposure（§10.5）
// ---------------------------------------------------------------------------

describe("実測露出（MEASURED / PLANNED fallback / 累積）", () => {
  it("観測が無ければ計画の1本分を PLANNED でコピー（null bound は null のまま）", () => {
    const p = acc(); // planned {lower:null, upper:150} × 5本
    const d = runSequence(p, [{ timeS: 4.5 }]).last;
    const count = p.sets.value * p.repsPerSet.value;
    expect(d.logEntry.highSpeedExposureM).toEqual({
      lower: null,
      upper: p.exposure.plannedHighSpeedExposureM.upper! / count,
      unit: "m",
      source: "PLANNED",
      confidence: p.exposure.plannedHighSpeedExposureM.confidence,
    });
  });

  it("MEASURED の観測はそのまま採用。累積は完了した本数分だけ（未来の予定本数を足さない）", () => {
    const p = mvFly20(); // planned {80, 260} × 4本 → 1本 {20, 65}
    const { decisions } = runSequence(p, [
      { timeS: 2.0, timing: "PHOTO_CELL", actualHighSpeedExposureM: { lower: 18, upper: 22, unit: "m", source: "MEASURED", confidence: "MEDIUM" } },
      { timeS: 2.0, timing: "PHOTO_CELL" },
    ]);
    expect(decisions[0].logEntry.highSpeedExposureM.source).toBe("MEASURED");
    expect(decisions[0].cumulativeHighSpeedExposureM).toMatchObject({ lower: 18, upper: 22, source: "MEASURED" });
    expect(decisions[1].logEntry.highSpeedExposureM).toMatchObject({ lower: 20, upper: 65, source: "PLANNED" });
    expect(decisions[1].cumulativeHighSpeedExposureM).toMatchObject({ lower: 38, upper: 87, source: "PLANNED" });
    expect(decisions[1].cumulativeHighSpeedExposureM.upper).toBeLessThan(p.exposure.plannedHighSpeedExposureM.upper!);
  });

  it("露出が不明な処方（EA 助走距離なし）は累積も null（0 にしない）", () => {
    const d = runSequence(ea(), [{ timeS: null }, { timeS: null }]).last;
    expect(d.cumulativeHighSpeedExposureM.lower).toBeNull();
    expect(d.cumulativeHighSpeedExposureM.upper).toBeNull();
  });

  it("セッション全体の曝露上限は評価しない（NOT_EVALUATED。上限内と楽観しない）", () => {
    const d = runSequence(acc(), [{ timeS: 4.5 }]).last;
    expect(d.exposureLimitEvaluation).toBe("NOT_EVALUATED");
  });
});

// ---------------------------------------------------------------------------
// Action priority
// ---------------------------------------------------------------------------

describe("action の優先順位（1か所の順位表）", () => {
  const ORDER: MonitorAction[] = ["STOP_SAFETY", "END_SESSION_QUALITY", "END_SET", "EXTEND_REST", "COACH_REVIEW", "CONTINUE"];

  it("順位表は STOP > END_SESSION > END_SET > EXTEND_REST > REVIEW > CONTINUE", () => {
    const sorted = [...MONITOR_ACTIONS].sort((a, b) => MONITOR_ACTION_RANK[b] - MONITOR_ACTION_RANK[a]);
    expect(sorted).toEqual(ORDER);
  });

  it("全ての部分集合・全ての並び順で、最も強い action が選ばれる（順序非依存）", () => {
    const subsets: MonitorAction[][] = [];
    for (let mask = 1; mask < 1 << ORDER.length; mask++) subsets.push(ORDER.filter((_, i) => mask & (1 << i)));
    for (const subset of subsets) {
      const expected = ORDER.find((a) => subset.includes(a))!;
      expect(strongestAction(subset)).toBe(expected);
      expect(strongestAction([...subset].reverse())).toBe(expected);
      const p = stride();
      const candidates = subset.map((action) => ({ action, reasons: [] as never[] }));
      expect(resolveDecision(p, candidates, []).action).toBe(expected);
      expect(resolveDecision(p, [...candidates].reverse(), []).action).toBe(expected);
    }
  });

  it("同じ本で複数 trigger: 1回目 FAIL（EXTEND_REST）+ POOR 連続（REVIEW）→ EXTEND_REST、reason は両方残す", () => {
    const p = acc();
    const { decisions } = runSequence(p, [
      { timeS: 4.5, coachJudgment: { startQuality: "POOR" } },
      { timeS: 4.9, coachJudgment: { startQuality: "POOR" } },
    ]);
    expect(decisions[1].action).toBe("EXTEND_REST");
    expect(decisions[1].reasons).toEqual(expect.arrayContaining(["TIMING_FAIL", "START_QUALITY_POOR_REPEATED"]));
  });

  it("予定本数到達 + 1回目 FAIL → END_SESSION_QUALITY（EXTEND_REST より強い）", () => {
    const p = mvFly10(); // 2本
    const d = runSequence(p, [{ timeS: 2.0, timing: "PHOTO_CELL" }, { timeS: 2.3, timing: "PHOTO_CELL" }]).last;
    expect(d.action).toBe("END_SESSION_QUALITY");
    expect(d.reasons).toEqual(expect.arrayContaining(["TIMING_FAIL", "PLANNED_REPS_COMPLETE"]));
  });

  it("TE の速すぎ WARN は他の trigger が無くても END に昇格しない（CONTINUE のまま）", () => {
    const p = te();
    const tooFast = p.intensity.target!.lower! - 1;
    const d = runSequence(p, [{ timeS: tooFast }, { timeS: tooFast }]).last;
    expect(MONITOR_ACTION_RANK[d.action]).toBe(MONITOR_ACTION_RANK.CONTINUE);
  });
});

// ---------------------------------------------------------------------------
// Snapshot independence / mutation / shuffle
// ---------------------------------------------------------------------------

describe("monitor は snapshot だけを使う（RuleSet を読まない）", () => {
  it("test RuleSet A で計画 → 保存 → RuleSet を B（tolerance / 連続閾値 / runtime）に変えても、A の snapshot で判定する", () => {
    const rsA: RuleSet = structuredClone(ruleSet);
    const p = expectOk(planRunningPrescriptionWithRuleSet(makeRequest("ACCELERATION", "ACC_BLOCK_30"), { ruleSet: rsA, contentHash: "test-a", isDraftFallback: true }));
    const stored = JSON.parse(JSON.stringify(p)) as RunningPrescriptionValue;

    // B へ変更（HAND tolerance を大きく、連続閾値と action を変える）
    for (const t of rsA.timingTolerances) if (t.toleranceS !== null) t.toleranceS = 9.99;
    const sp = rsA.stopPolicies.find((x) => x.id === p.stopPolicyId)!;
    sp.consecutiveFailuresToStop = 9;
    sp.runtime.consecutiveFailureAction = "COACH_REVIEW";

    const { decisions } = runSequence(stored, [{ timeS: 4.5 }, { timeS: 4.8 }, { timeS: 4.8 }]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "EXTEND_REST", "END_SESSION_QUALITY"]);
    expect(decisions[1].logEntry.toleranceS).toBe(0.25);
  });

  it("safetyPolicy も snapshot: RuleSet A で計画した処方は、B で medical red flag のグループを変えても A の policy で判定する。B で計画した処方だけが B の policy", () => {
    const rsA: RuleSet = structuredClone(ruleSet);
    const req = makeRequest("ACCELERATION", "ACC_BLOCK_30");
    const prescriptionA = JSON.parse(JSON.stringify(expectOk(planRunningPrescriptionWithRuleSet(req, { ruleSet: rsA, contentHash: "test-a", isDraftFallback: true })))) as RunningPrescriptionValue;

    // B: LIMPING を MEDICAL グループから COACH_REVIEW グループへ移す
    const rsB: RuleSet = structuredClone(rsA);
    const groups = rsB.readinessRules.filter((r) => r.kind === "PAIN_RED_FLAG_GROUP");
    const medical = groups.find((g) => g.kind === "PAIN_RED_FLAG_GROUP" && g.safetyOutcome === "MEDICAL_EVALUATION_RECOMMENDED");
    const review = groups.find((g) => g.kind === "PAIN_RED_FLAG_GROUP" && g.safetyOutcome === "COACH_REVIEW");
    if (medical?.kind !== "PAIN_RED_FLAG_GROUP" || review?.kind !== "PAIN_RED_FLAG_GROUP") throw new Error("fixture");
    medical.redFlags = medical.redFlags.filter((f) => f !== "LIMPING");
    review.redFlags = [...review.redFlags, "LIMPING"];
    const prescriptionB = expectOk(planRunningPrescriptionWithRuleSet(req, { ruleSet: rsB, contentHash: "test-b", isDraftFallback: true }));

    const limping: RepObservation = { setIndex: 1, repIndex: 1, timeS: null, timing: "HAND", athleteReport: { painNow: true, redFlags: ["LIMPING"] } };
    expect(monitorRunningPrescription({ prescription: prescriptionA, priorLogs: [] }, limping).safetyOutcome).toBe("MEDICAL_EVALUATION_RECOMMENDED");
    expect(monitorRunningPrescription({ prescription: prescriptionB, priorLogs: [] }, limping).safetyOutcome).toBe("COACH_REVIEW");
    expect(prescriptionA.monitoringSnapshot.safetyPolicy).not.toEqual(prescriptionB.monitoringSnapshot.safetyPolicy);

    // safetyPolicy は monitoring 用の metadata だけ: policy 以外の処方内容（量・rest・強度・露出・findings）は同一
    const withoutSnapshot = (p: RunningPrescriptionValue) => ({ ...JSON.parse(JSON.stringify(p)), monitoringSnapshot: null, ruleSet: null });
    expect(withoutSnapshot(prescriptionB)).toEqual(withoutSnapshot(prescriptionA));
  });

  it("monitor 実行中に RuleSet loader が呼ばれない（spy）", () => {
    const p = acc();
    const spies = [vi.spyOn(loader, "getRuleSet"), vi.spyOn(loader, "getActiveRuleSet")];
    try {
      runSequence(p, [{ timeS: 4.5 }, { timeS: 4.8 }, { timeS: 4.8, athleteReport: { painNow: true } }]);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("mutation: snapshot の HAND tolerance 0.25→0.10 で同じ観測の結果が変わる（TS に 0.25 を持たない）", () => {
    const p = acc();
    const tight = withSnapshot(p, (c) => {
      c.monitoringSnapshot.timingTolerances.find((t) => t.timing === "HAND")!.toleranceS = 0.1;
    });
    const observations: ObsInput[] = [{ timeS: 4.5 }, { timeS: 4.7 }];
    expect(runSequence(p, observations).last.quality).toBe("PASS");
    expect(runSequence(tight, observations).last.quality).toBe("FAIL");
  });

  it("mutation: consecutiveFailuresToStop 2→3 なら2回連続 FAIL では終わらず、3回目で END", () => {
    const p = withSnapshot(acc(), (c) => {
      c.monitoringSnapshot.stopPolicy.consecutiveFailuresToStop = 3;
    });
    const { decisions } = runSequence(p, [{ timeS: 4.5 }, { timeS: 4.8 }, { timeS: 4.8 }, { timeS: 4.8 }]);
    expect(decisions.map((d) => d.action)).toEqual(["CONTINUE", "EXTEND_REST", "CONTINUE", "END_SESSION_QUALITY"]);
  });

  it("mutation: tolerance/参照の閾値（coachOnlyRatioThreshold）も snapshot から読む", () => {
    const p = mvFly10();
    const loose = withSnapshot(p, (c) => {
      c.monitoringSnapshot.timingTolerances.find((t) => t.timing === "HAND")!.coachOnlyRatioThreshold = 0.5;
    });
    const obs: RepObservation = { setIndex: 1, repIndex: 2, timeS: 1.6, timing: "HAND" };
    expect(monitorRunningPrescription({ prescription: p, priorLogs: [passLog(p, "HAND", 1.1)] }, obs).quality).toBe("NOT_EVALUATED_COACH_ONLY");
    expect(monitorRunningPrescription({ prescription: loose, priorLogs: [passLog(loose, "HAND", 1.1)] }, obs).quality).toBe("FAIL");
  });

  it("shuffle: timingTolerances の順序を反転しても結果は同じ（TimingMethod で引く）", () => {
    const p = acc();
    const reversed = withSnapshot(p, (c) => {
      c.monitoringSnapshot.timingTolerances.reverse();
    });
    const observations: ObsInput[] = [
      { timeS: 4.5 },
      { timeS: 4.8, timing: "HAND" },
      { timeS: 4.8, timing: "VIDEO", videoFps: 60 },
      { timeS: 4.8, timing: "UNKNOWN" },
    ];
    const strip = (ds: MonitorDecision[]) => ds.map((d) => ({ action: d.action, quality: d.quality, reasons: d.reasons, tol: d.logEntry.toleranceS }));
    expect(strip(runSequence(reversed, observations).decisions)).toEqual(strip(runSequence(p, observations).decisions));
  });
});

// ---------------------------------------------------------------------------
// Static audits（import boundary / 普遍閾値なし / id 解析なし）
// ---------------------------------------------------------------------------

const MONITORING_DIR = path.resolve(__dirname, "../../../src/domain/running/monitoring");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** runtime import（`import type` / `export type` を除く）の specifier を集める。 */
function runtimeImports(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[2]) continue;
    out.push(m[3]);
  }
  return out;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const srcRoot = path.resolve(__dirname, "../../../src");
  const base = specifier.startsWith("@/") ? path.join(srcRoot, specifier.slice(2)) : specifier.startsWith(".") ? path.resolve(path.dirname(fromFile), specifier) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unresolved import ${specifier} from ${fromFile}`);
}

describe("static audits（monitoring/**）", () => {
  it("runtime import graph に RuleSet loader・manifest・production JSON・Prisma・React・Next・node:* が無い（zod と domain だけ）", () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const queue = [path.join(MONITORING_DIR, "index.ts")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of runtimeImports(fs.readFileSync(file, "utf-8"))) {
        const resolved = resolveImport(file, specifier);
        if (resolved === null) bare.add(specifier);
        else queue.push(resolved);
      }
    }
    const rel = [...seen].map((f) => path.relative(path.resolve(__dirname, "../../../src"), f));
    expect(rel).toContain("domain/running/monitoring/index.ts");
    expect(rel.filter((f) => /rules\/loader|manifest\.json|rules\/sets\//.test(f))).toEqual([]);
    expect([...bare]).toEqual(["zod"]);
    expect(rel.every((f) => f.startsWith("domain/"))).toBe(true);
  });

  it("monitoring/** のソースに loader / manifest / JSON の import 文字列が無い", () => {
    for (const file of fs.readdirSync(MONITORING_DIR)) {
      const source = fs.readFileSync(path.join(MONITORING_DIR, file), "utf-8");
      expect(source, file).not.toMatch(/rules\/loader|manifest\.json|sets\/rs-|\.json"/);
      expect(source, file).not.toMatch(/@prisma|from "react|from "next|from "node:/);
    }
  });

  it("普遍的な速度低下%・Method 共通の 3% / 5% 閾値・production の数値 tolerance を持たない", () => {
    for (const file of fs.readdirSync(MONITORING_DIR)) {
      const code = stripComments(fs.readFileSync(path.join(MONITORING_DIR, file), "utf-8"));
      expect(code, file).not.toMatch(/universalDropoff|dropoffPercent/i);
      expect(code, file).not.toMatch(/\b\d+(\.\d+)?\s*%/);
      expect(code, file).not.toMatch(/\b0\.\d+\b/); // 0.25 / 0.05 / 0.10 / 0.03 等の小数を TS に置かない
    }
  });

  it("stop policy id・説明文・conditionNote・ruleId を解析しない（method 名で分岐しない）", () => {
    const METHOD_NAMES = ["ACCELERATION", "MAX_VELOCITY", "SPRINT_ENDURANCE_SHORT", "LONG_SPRINT_RACE_SPECIFIC", "TEMPO_EXTENSIVE", "TEMPO_INTENSIVE", "RESISTED_SPRINT", "ASSISTED_SPRINT", "EVENT_APPROACH_SPEED", "STRIDE"];
    for (const file of fs.readdirSync(MONITORING_DIR)) {
      const code = stripComments(fs.readFileSync(path.join(MONITORING_DIR, file), "utf-8"));
      expect(code, file).not.toMatch(/"SP_/);
      expect(code, file).not.toMatch(/startsWith\(|\.includes\("(SP|LSR|ELIG)/);
      expect(code, file).not.toMatch(/ruleDescriptionJa|referenceDescription|conditionNote|ruleId/);
      for (const method of METHOD_NAMES) expect(code, `${file}:${method}`).not.toContain(`"${method}"`);
    }
  });

  it("phase / readiness / weekly / competition を再評価しない（それらのモジュールを import しない）", () => {
    for (const file of fs.readdirSync(MONITORING_DIR)) {
      const imports = runtimeImports(fs.readFileSync(path.join(MONITORING_DIR, file), "utf-8"));
      expect(imports.filter((s) => /planning|readiness\/|weekly|competition|context\//.test(s)), file).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

describe("root public API（R8）", () => {
  it("monitorRunningPrescription と入出力型だけを公開し、内部 helper は公開しない", () => {
    expect(typeof runningApi.monitorRunningPrescription).toBe("function");
    expect(typeof runningApi.repObservationSchema.parse).toBe("function");
    for (const name of ["normalizeInput", "normalizeTiming", "evaluateSafetyGate", "evaluateStopPolicy", "resolveDecision", "strongestAction", "exceedsToleranceRatio"]) {
      expect(Object.keys(runningApi), name).not.toContain(name);
    }
  });
});
