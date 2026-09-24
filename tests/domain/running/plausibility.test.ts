/**
 * Running Prescription Engine v2 — Phase R6（§8.5 Plausibility）。
 *
 * 検証の柱:
 *   - 入力（step 1）と出力（step 14）の両方が RuleSet の閾値だけで動く
 *   - 監査 C-1 の2事例（80km / 25.6km）が v2 と legacy の両方で検出される
 *   - plausibility は CoachOverride で消えない（入力の訂正・確認の層）
 */
import { describe, expect, it } from "vitest";

import { checkLegacyItemPlausibility, checkOutputPlausibility, checkSessionPlausibility } from "@/domain/running/plausibility/output";
import { evaluateInputPlausibility, evaluateInputPlausibilityFor, evaluatePlausibilityBoundary, evaluatePlausibilityThreshold } from "@/domain/running/plausibility/input";
import * as contextPlausibility from "@/domain/running/context/plausibility";
import { checkInputPlausibility, checkSelectedPerformanceInputPlausibility, normalizePlanRequest } from "@/domain/running/planning/normalize";
import { selectHeightHistoryForGrowth } from "@/domain/running/context/maturity";
import { evaluateSessionAggregation } from "@/domain/running/aggregation";
import { planRunningPrescription } from "@/domain/running/planning";
import type { PlanRequest, PlanResult } from "@/domain/running/planning/schema";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { getRuleSet } from "@/domain/running/rules/loader";
import { ruleSetSchema, type RuleSet } from "@/domain/running/rules/schema";
import { createCoachActor } from "@/domain/running/types/actor";
import { suggestPrescription } from "@/domain/prescription/calculate";
import type { IsoDate } from "@/domain/running/types/primitives";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";

import goldenFixture from "../../fixtures/prescription-legacy-golden.json";

const ruleSet = getRuleSet("rs-2026.09.0")!;
const PLANNING_DATE = "2026-09-15";
const COACH = createCoachActor("coach-1");
const AI = { kind: "AI_PLANNER", provider: "test-provider", model: "test-model", requestId: "req-1" } as const;
const SYSTEM = { kind: "SYSTEM" } as const;

function iso(value: string): IsoDate {
  return value as IsoDate;
}

function athlete(overrides: Partial<AthleteProfile> = {}): Subject {
  return {
    kind: "ATHLETE",
    profile: {
      birthDate: iso("1998-01-01"),
      primaryEvent: "400m",
      maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") },
      trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
      marks: [{ event: "FLY20", timeS: 2.0, date: iso("2026-08-01"), timing: "PHOTO_CELL" }],
      vmax: null,
      allowAdvancedMethods: true,
      ...overrides,
    },
  };
}

type RequestOptions = {
  subject?: Subject;
  actor?: PlanRequest["actor"] | typeof AI | typeof SYSTEM;
  coachEdits?: unknown[];
  overrides?: unknown[];
  otherItems?: unknown[];
};

function makeRequest(method: string, templateId: string, o: RequestOptions = {}): PlanRequest {
  return {
    planningDate: iso(PLANNING_DATE),
    selection: { method, templateId },
    subject: o.subject ?? athlete(),
    menuContext: { phase: null, plannedDate: null, plannedAt: null, competitions: [], otherItems: o.otherItems ?? [], availableMinutes: null },
    history: null,
    readiness: null,
    positionPreference: null,
    coachEdits: o.coachEdits ?? [],
    overrides: o.overrides ?? [],
    coachReference: null,
    actor: o.actor ?? COACH,
  } as unknown as PlanRequest;
}

const fieldOverride = (field: string, newValue: number, layer: "COACH_EDITABLE" | "HARD_SAFETY" = "COACH_EDITABLE") => ({
  target: { kind: "FIELD", field, layer },
  newValue,
  reason: "監査ケース再現のためのコーチ入力",
  confirmedTwice: true,
  actor: COACH,
  at: "2026-09-15T08:00:00.000Z",
});

/**
 * T-PLA-01（80km）の再現。§20 T-PLA-01 / §11.6-15 の正式仕様どおり `TI_COACH_DEFINED`（TEMPO_INTENSIVE。
 * distance がコーチ入力）を使う。rs-2026.09.0 の TE テンプレートは `fixedDistanceField=repDistanceM`
 * （距離が template 固定）でコーチが distance=5000 を入力できないため、§11.6-15 で正式ケースを
 * TI_COACH_DEFINED へ修正した（§8.5 の「1本の距離（TE/TI）」行は TE と TI の両方に適用される）。
 */
function eightyKmRequest(o: RequestOptions = {}): PlanRequest {
  return makeRequest("TEMPO_INTENSIVE", "TI_COACH_DEFINED", {
    ...o,
    coachEdits: [
      { field: "sets", value: 2, unit: "sets" },
      { field: "repsPerSet", value: 8, unit: "reps" },
      { field: "intensityPercent", value: 75, unit: "percent" },
      { field: "repRestS", value: 120, unit: "s" },
      { field: "setRestS", value: 300, unit: "s" },
    ],
    overrides: [fieldOverride("repDistanceM", 5000), fieldOverride("sessionVolumeM", 80000), ...(o.overrides ?? [])],
  });
}

function blockedFindings(r: PlanResult) {
  expect(r.status, JSON.stringify(r)).toBe("BLOCKED");
  if (r.status !== "BLOCKED") throw new Error("unreachable");
  return r.findings;
}

const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code);
const metrics = (findings: readonly { metric?: string }[]) => findings.map((f) => f.metric);

// ---------------------------------------------------------------------------
// T-PLA-03 / 入力 plausibility（R3 回帰）
// ---------------------------------------------------------------------------

describe("T-PLA-03: 入力 plausibility（canonical 化しても R3 の挙動を壊さない）", () => {
  it("100m PB = 1.08 秒は BLOCK", () => {
    expect(evaluateInputPlausibility(ruleSet, "PLA_INPUT_100M_RECORD", 1.08)).toBe("BLOCK");
    expect(evaluateInputPlausibility(ruleSet, "PLA_INPUT_100M_RECORD", 8.5)).toBe("REQUIRE_CONFIRMATION");
    expect(evaluateInputPlausibility(ruleSet, "PLA_INPUT_100M_RECORD", 11.5)).toBe("OK");
  });

  it("context/plausibility.ts は canonical 実装の再 export（判定を2箇所に持たない）", () => {
    expect(contextPlausibility.evaluateInputPlausibility).toBe(evaluateInputPlausibility);
    expect(contextPlausibility.CONTEXT_PLAUSIBILITY_RULE_IDS.MARK_100M).toBe("PLA_INPUT_100M_RECORD");
    expect(contextPlausibility.evaluateInputPlausibility(ruleSet, "PLA_INPUT_100M_RECORD", 1.08)).toBe("BLOCK");
  });

  it("inputTarget（構造化メタデータ）でも同じ判定になる（ruleId 文字列を呼び出し側に書かせない）", () => {
    expect(evaluateInputPlausibilityFor(ruleSet, { kind: "TIMED_MARK", event: "100m" }, 1.08)).toBe("BLOCK");
    expect(evaluateInputPlausibilityFor(ruleSet, { kind: "HEIGHT_CM" }, 30)).toBe("BLOCK");
    expect(evaluateInputPlausibilityFor(ruleSet, { kind: "TIMED_MARK", event: "FLY10" }, 1.2)).toBe("OK");
  });

  it("未使用の100m記録は極端な値でも無関係なMAX_INTENT計画をBLOCKしない", () => {
    const subject = athlete({ marks: [{ event: "100m", timeS: 1.08, date: iso("2026-08-01"), timing: "HAND" }] });
    const r = planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20", { subject }));
    expect(r.status).toBe("OK");
    expect(r.status === "OK" && r.prescription.findings.some((f) => f.code === "INPUT_MARK_DATA_QUALITY" && f.plausibility?.ruleId === "PLA_INPUT_100M_RECORD")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-PLA-01: 80km 事故
// ---------------------------------------------------------------------------

describe("T-PLA-01: 80km 事故（項目 BLOCK と Session BLOCK の二重で止める）", () => {
  it("1項目 80,000m は項目 plausibility で BLOCK される", () => {
    const findings = blockedFindings(planRunningPrescription(eightyKmRequest()));
    expect(codes(findings)).toContain("PLAUSIBILITY_BLOCK");
    expect(metrics(findings)).toContain("PLA_ITEM_TOTAL_DISTANCE");
    // 1本の距離（TE/TI: > 1000m）でも止まる
    expect(metrics(findings)).toContain("PLA_ITEM_DISTANCE_TEMPO");
  });

  it("どの actor でも処方は出ない（override を足しても plausibility は消えない）", () => {
    // COACH: 入力は作れるが plausibility で BLOCKED
    expect(planRunningPrescription(eightyKmRequest()).status).toBe("BLOCKED");
    // AI / SYSTEM: そもそもこの入力自体を持てない（coachEdits / overrides を持てず、自動生成もできない）
    for (const actor of [AI, SYSTEM]) {
      const r = planRunningPrescription(makeRequest("TEMPO_INTENSIVE", "TI_COACH_DEFINED", { actor }));
      expect(r.status, actor.kind).not.toBe("OK");
    }
    // hardSafety 層の override を足しても plausibility は消えない
    const withHardSafety = eightyKmRequest({ overrides: [fieldOverride("repsPerSet", 8, "HARD_SAFETY")] });
    expect(planRunningPrescription(withHardSafety).status).toBe("BLOCKED");
  });

  it("Session 合計 80,000m は §11 の MENU_TOTAL 行でも BLOCK される", () => {
    const session = checkSessionPlausibility({ lower: 80000, upper: 80000, unit: "m", source: "PLANNED", confidence: "HIGH" }, ruleSet);
    expect(session.blocked).toBe(true);
    expect(codes(session.findings)).toContain("AGG_TOTAL_RUNNING_BLOCK");
  });

  it("Session 合計 8,000m 超〜30,000m 以下は確認（BLOCK ではない）", () => {
    const session = checkSessionPlausibility({ lower: 9000, upper: 9000, unit: "m", source: "PLANNED", confidence: "HIGH" }, ruleSet);
    expect(session.blocked).toBe(false);
    expect(codes(session.findings)).toContain("AGG_TOTAL_RUNNING_CONFIRM");
  });

  it("Session 合計の upper が不明なら「安全」と断定しない", () => {
    const session = checkSessionPlausibility({ lower: 100, upper: null, unit: "m", source: "UNKNOWN", confidence: "NONE" }, ruleSet);
    expect(session.blocked).toBe(true);
    expect(session.findings.find((f) => f.code === "PLAUSIBILITY_NOT_DETERMINABLE")?.plausibility?.certainty).toBe("UNEVALUABLE");
  });
});

describe("F1: policy-normalized plausibility certainty and selected input scope", () => {
  it("MAX/MIN interval classification distinguishes confirmed, possible, within, unevaluable, and equality", () => {
    expect(evaluatePlausibilityThreshold({ lower: 301, upper: 350 }, { min: null, max: 300 })).toMatchObject({ certainty: "CONFIRMED_EXCEED", side: "MAX", threshold: 300 });
    expect(evaluatePlausibilityThreshold({ lower: null, upper: 301 }, { min: null, max: 300 })).toMatchObject({ certainty: "POSSIBLE_EXCEED", side: "MAX", threshold: 300 });
    expect(evaluatePlausibilityThreshold({ lower: 100, upper: 300 }, { min: null, max: 300 }).certainty).toBe("CONFIRMED_WITHIN");
    expect(evaluatePlausibilityThreshold({ lower: 100, upper: null }, { min: null, max: 300 }).certainty).toBe("UNEVALUABLE");
    expect(evaluatePlausibilityBoundary({ lower: 5, upper: 5 }, 5, "MIN")).toBe("CONFIRMED_WITHIN");
    expect(evaluatePlausibilityBoundary({ lower: 4, upper: 5 }, 5, "MIN")).toBe("POSSIBLE_EXCEED");
    expect(evaluatePlausibilityBoundary({ lower: 4, upper: 4.9 }, 5, "MIN")).toBe("CONFIRMED_EXCEED");
  });

  it("F14 ignores unused 100m history in data-free MAX_INTENT and is invariant to record order", () => {
    const old = { event: "100m" as const, timeS: 61, date: iso("2024-08-01"), timing: "HAND" as const };
    const recent = { event: "100m" as const, timeS: 11, date: iso("2026-08-01"), timing: "HAND" as const };
    const run = (marks: typeof old[]) => planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20", {
      subject: athlete({ marks }),
    }));
    const oldFirst = run([old, recent]);
    const recentFirst = run([recent, old]);

    expect(oldFirst.status).toBe("OK");
    expect(recentFirst.status).toBe("OK");
    expect(oldFirst).toEqual(recentFirst);
    expect(oldFirst.status === "OK" && oldFirst.prescription.intensity.reference.kind).toBe("MAX_INTENT");
    expect(oldFirst.status === "OK" && oldFirst.prescription.findings.some((f) => f.code === "INPUT_MARK_DATA_QUALITY" && f.plausibility?.ruleId === "PLA_INPUT_100M_RECORD")).toBe(true);
    expect(oldFirst.status === "BLOCKED" && oldFirst.findings.some((f) => f.plausibility?.ruleId === "PLA_INPUT_100M_RECORD")).toBe(false);
  });

  it("100m is not a selected reference in the current planner: even extreme marks remain data quality on unrelated plans", () => {
    for (const timeS of [4.99, 5, 60, 60.01]) {
      const result = planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20", {
        subject: athlete({ marks: [{ event: "100m", timeS, date: iso("2026-08-01"), timing: "HAND" }] }),
      }));
      expect(result.status).toBe("OK");
      expect(result.status === "OK" && result.prescription.findings.some((f) => f.code === "INPUT_PLAUSIBILITY_BLOCK" && f.plausibility?.ruleId === "PLA_INPUT_100M_RECORD")).toBe(false);
    }
  });

  it("unused extreme performance history is data quality, not a global plan blocker", () => {
    const request = makeRequest("ACCELERATION", "ACC_BLOCK_20", {
      subject: athlete({ marks: [{ event: "100m", timeS: 61, date: iso("2026-08-01"), timing: "HAND" }] }),
    });
    const checked = checkSelectedPerformanceInputPlausibility(request, ruleSet, []);
    expect(checked.blocking).toHaveLength(0);
    expect(checked.findings.find((f) => f.code === "INPUT_MARK_DATA_QUALITY")?.plausibility).toMatchObject({
      ruleId: "PLA_INPUT_100M_RECORD", policy: "DATA_QUALITY", certainty: "DATA_QUALITY", presentationKind: "DATA_QUALITY",
    });
  });

  it("F16 checks the same dated endpoints used for growth; future and unused outliers are quarantined", () => {
    const profile = (heightHistory: { date: IsoDate; heightCm: number }[]) => athlete({
      maturity: { status: "POST", confidence: "HIGH", method: "GROWTH_VELOCITY", assessedAt: iso("2026-01-01"), heightHistory },
    });
    const endpointOutlier = profile([
      { date: iso("2025-01-01"), heightCm: 170 },
      { date: iso("2026-01-01"), heightCm: 49.9 },
    ]);
    const blocked = checkInputPlausibility(makeRequest("ACCELERATION", "ACC_BLOCK_20", { subject: endpointOutlier }), ruleSet);
    expect(blocked.blocking[0]?.plausibility).toMatchObject({
      ruleId: "PLA_INPUT_HEIGHT", policy: "DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW", certainty: "CONFIRMED_EXCEED",
    });

    const history = [
      { date: iso("2025-01-01"), heightCm: 170 },
      { date: iso("2025-06-01"), heightCm: 999 },
      { date: iso("2026-01-01"), heightCm: 173 },
      { date: iso("2027-01-01"), heightCm: 999 },
    ];
    const selected = selectHeightHistoryForGrowth(history, iso("2026-01-01"));
    expect(selected.endpoints.map((p) => p.heightCm)).toEqual([170, 173]);
    expect(selected.futurePoints.map((p) => p.heightCm)).toEqual([999]);
    const quality = checkInputPlausibility(makeRequest("ACCELERATION", "ACC_BLOCK_20", { subject: profile(history) }), ruleSet);
    expect(quality.blocking).toHaveLength(0);
    expect(quality.findings.filter((f) => f.code === "INPUT_HEIGHT_DATA_QUALITY")).toHaveLength(1);
    expect(quality.findings.filter((f) => f.code === "INPUT_HEIGHT_FUTURE_IGNORED")).toHaveLength(1);
  });

  it("F07–F12 retain a BLOCK gate with strong-review policy metadata until F2 approval exists", () => {
    const planned = planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20"));
    if (planned.status !== "OK") throw new Error(JSON.stringify(planned));
    const mutated = structuredClone(planned.prescription);
    mutated.repsPerSet.value = 31;
    const reviewed = checkOutputPlausibility(mutated, ruleSet);
    expect(reviewed.blocked).toBe(true);
    expect(reviewed.findings.find((f) => f.plausibility?.ruleId === "PLA_REPS_PER_SET")?.plausibility).toMatchObject({
      policy: "COACH_OVERRIDABLE_STRONG_REVIEW", certainty: "CONFIRMED_EXCEED",
    });
    const atBoundary = structuredClone(planned.prescription);
    atBoundary.repsPerSet.value = 30;
    expect(checkOutputPlausibility(atBoundary, ruleSet).blocked).toBe(false);
  });

  it("F01–F06 confirmed method-boundary violations remain typed method-policy blocks", () => {
    const planned = planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20"));
    if (planned.status !== "OK") throw new Error(JSON.stringify(planned));
    const makeRep = (method: RunningPrescriptionValue["method"], rep: unknown) => ({
      ...structuredClone(planned.prescription), method, rep,
    }) as RunningPrescriptionValue;
    const field = (value: number, unit: "m" | "s") => ({ value, unit });
    const cases: { ruleId: string; prescription: RunningPrescriptionValue }[] = [
      { ruleId: "PLA_ITEM_DISTANCE_STANDARD", prescription: makeRep("ACCELERATION", { kind: "DISTANCE", distanceM: field(301, "m") }) },
      { ruleId: "PLA_ITEM_DISTANCE_LONG", prescription: makeRep("LONG_SPRINT_RACE_SPECIFIC", { kind: "DISTANCE", distanceM: field(1001, "m") }) },
      { ruleId: "PLA_ITEM_DISTANCE_TEMPO", prescription: makeRep("TEMPO_INTENSIVE", { kind: "DISTANCE", distanceM: field(1001, "m") }) },
      { ruleId: "PLA_BUILD_UP_M", prescription: makeRep("MAX_VELOCITY", { kind: "FLY", buildUpDistanceM: field(121, "m"), flyZoneDistanceM: field(10, "m") }) },
      { ruleId: "PLA_FLY_ZONE_M", prescription: makeRep("ASSISTED_SPRINT", { kind: "FLY", buildUpDistanceM: field(10, "m"), flyZoneDistanceM: field(81, "m") }) },
      { ruleId: "PLA_REP_DURATION_NON_LONG", prescription: makeRep("SPRINT_ENDURANCE_SHORT", { kind: "DURATION", durationS: field(121, "s"), displayDistanceM: { lower: null, upper: null, unit: "m", source: "UNKNOWN", confidence: "NONE" } }) },
    ];
    for (const { ruleId, prescription } of cases) {
      const checked = checkOutputPlausibility(prescription, ruleSet);
      expect(checked.blocked, ruleId).toBe(true);
      expect(checked.findings.find((f) => f.plausibility?.ruleId === ruleId)?.plausibility, ruleId).toMatchObject({
        policy: "METHOD_POLICY_HARD", certainty: "CONFIRMED_EXCEED", presentationKind: "METHOD_POLICY",
      });
    }
    const standard = makeRep("ACCELERATION", { kind: "DISTANCE", distanceM: field(300, "m") });
    expect(checkOutputPlausibility(standard, ruleSet).findings.some((f) => f.plausibility?.ruleId === "PLA_ITEM_DISTANCE_STANDARD" && f.severity === "BLOCK")).toBe(false);
  });

  it("F13 is a product/data boundary; a possible or unevaluable interval blocks without claiming confirmed exceedance", () => {
    const equal = checkSessionPlausibility({ lower: 30000, upper: 30000, unit: "m", source: "PLANNED", confidence: "HIGH" }, ruleSet);
    expect(equal.blocked).toBe(false);
    const possible = checkSessionPlausibility({ lower: null, upper: 30001, unit: "m", source: "UNKNOWN", confidence: "LOW" }, ruleSet);
    expect(possible.blocked).toBe(true);
    expect(possible.findings[0]?.plausibility).toMatchObject({
      ruleId: "PLA_MENU_TOTAL_DISTANCE", policy: "PRODUCT_DATA_SANITY_HARD", certainty: "POSSIBLE_EXCEED", presentationKind: "INTERVAL_UNCERTAIN",
    });
    const unevaluable = checkSessionPlausibility({ lower: null, upper: null, unit: "m", source: "UNKNOWN", confidence: "NONE" }, ruleSet);
    expect(unevaluable.blocked).toBe(true);
    expect(unevaluable.findings[0]?.plausibility?.certainty).toBe("UNEVALUABLE");
  });

  it("F15 gates the exact Fly10 mark that supplied MEASURED_VMAX; unused and direct-reference records do not block", () => {
    const selected = (timeS: number, date = "2026-08-01") => planRunningPrescription(makeRequest("TEMPO_EXTENSIVE", "TE_100", {
      subject: athlete({ marks: [{ event: "FLY10", timeS, date: iso(date), timing: "PHOTO_CELL" }] }),
    }));
    const below = selected(0.49);
    expect(below.status).toBe("BLOCKED");
    expect(below.status === "BLOCKED" && below.findings.find((f) => f.code === "INPUT_PLAUSIBILITY_BLOCK")?.plausibility).toMatchObject({
      ruleId: "PLA_INPUT_FLY_10M", policy: "NON_OVERRIDABLE_DATA_SANITY_HARD", certainty: "CONFIRMED_EXCEED",
    });
    expect(below.status === "BLOCKED" && below.findings.some((f) => f.metric === "selected.FLY10@2026-08-01")).toBe(true);
    const above = selected(5.1);
    expect(above.status).toBe("BLOCKED");
    expect(above.status === "BLOCKED" && above.findings.find((f) => f.code === "INPUT_PLAUSIBILITY_BLOCK")?.plausibility).toMatchObject({
      ruleId: "PLA_INPUT_FLY_10M", policy: "COACH_OVERRIDABLE_STRONG_REVIEW", certainty: "CONFIRMED_EXCEED",
    });
    expect(above.status === "BLOCKED" && above.findings.some((f) => f.metric === "selected.FLY10@2026-08-01")).toBe(true);

    for (const timeS of [0.5, 5]) {
      const boundary = selected(timeS);
      expect(boundary.status === "BLOCKED" && boundary.findings.some((f) => f.plausibility?.ruleId === "PLA_INPUT_FLY_10M" && f.code === "INPUT_PLAUSIBILITY_BLOCK")).toBe(false);
    }

    const latest = { event: "FLY10" as const, timeS: 0.7, date: iso("2026-08-01"), timing: "PHOTO_CELL" as const };
    const oldExtreme = { event: "FLY10" as const, timeS: 5.1, date: iso("2025-08-01"), timing: "PHOTO_CELL" as const };
    const multi = planRunningPrescription(makeRequest("TEMPO_EXTENSIVE", "TE_100", {
      subject: athlete({ marks: [oldExtreme, latest] }),
    }));
    expect(multi.status).toBe("OK");
    expect(multi.status === "OK" && multi.prescription.intensity.reference.kind).toBe("MEASURED_VMAX");
    expect(multi.status === "OK" && multi.prescription.findings.some((f) => f.code === "INPUT_MARK_DATA_QUALITY" && f.metric?.includes("FLY10@2025-08-01"))).toBe(true);
    expect(multi.status === "OK" && multi.prescription.findings.some((f) => f.code === "INPUT_PLAUSIBILITY_CONFIRM" && f.metric === "PLA_INPUT_FLY_10M:selected.FLY10@2026-08-01")).toBe(true);
    expect(multi.status === "OK" && multi.prescription.findings.some((f) => f.plausibility?.ruleId === "PLA_INPUT_FLY_10M" && f.code === "INPUT_PLAUSIBILITY_BLOCK")).toBe(false);

    const future = planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20", {
      subject: athlete({ marks: [{ event: "FLY10", timeS: 5.1, date: iso("2026-10-01"), timing: "PHOTO_CELL" }] }),
    }));
    expect(future.status, JSON.stringify(future)).toBe("OK");
    expect(future.status === "OK" && future.prescription.intensity.reference.kind).toBe("MAX_INTENT");
    expect(future.status === "OK" && future.prescription.findings.some((f) => f.code === "INPUT_MARK_IN_FUTURE_IGNORED" && f.metric?.includes("FLY10"))).toBe(true);
    expect(future.status === "OK" && future.prescription.findings.some((f) => f.code === "INPUT_PLAUSIBILITY_BLOCK" && f.plausibility?.ruleId === "PLA_INPUT_FLY_10M")).toBe(false);

    const directVmax = planRunningPrescription(makeRequest("TEMPO_EXTENSIVE", "TE_100", { subject: athlete({ vmax: {
      valueMps: 9, lowerMps: 8.9, upperMps: 9.1, source: "RADAR_LASER", confidence: "HIGH", measuredAt: iso("2026-08-01"),
    }, marks: [{ event: "FLY10", timeS: 5.1, date: iso("2026-08-01"), timing: "PHOTO_CELL" }] }) }));
    expect(directVmax.status).toBe("OK");
    expect(directVmax.status === "OK" && directVmax.prescription.findings.some((f) => f.code === "INPUT_MARK_DATA_QUALITY" && f.metric?.includes("FLY10@2026-08-01"))).toBe(true);
    expect(directVmax.status === "OK" && directVmax.prescription.findings.some((f) => f.code === "INPUT_PLAUSIBILITY_BLOCK" && f.plausibility?.ruleId === "PLA_INPUT_FLY_10M")).toBe(false);
  });

  it("F16 endpoints at 50/260 are not review blocks; structurally invalid measurement dates fail normalization", () => {
    const subject = athlete({ maturity: {
      status: "POST", confidence: "HIGH", method: "GROWTH_VELOCITY", assessedAt: iso("2026-01-01"),
      heightHistory: [{ date: iso("2025-01-01"), heightCm: 170 }, { date: iso("2026-01-01"), heightCm: 260 }],
    } });
    const checked = checkInputPlausibility(makeRequest("ACCELERATION", "ACC_BLOCK_20", { subject }), ruleSet);
    expect(checked.blocking.some((f) => f.plausibility?.ruleId === "PLA_INPUT_HEIGHT")).toBe(false);
    const invalid = makeRequest("ACCELERATION", "ACC_BLOCK_20", {
      subject: athlete({ marks: [{ event: "100m", timeS: 11, date: iso("2026-02-30"), timing: "HAND" }] }),
    });
    expect(normalizePlanRequest(invalid).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-PLA-02: sets/reps 取り違え
// ---------------------------------------------------------------------------

describe("T-PLA-02: sets/reps 取り違え疑い", () => {
  it("totalReps が recommended.max × 3 に達したら REQUIRE_CONFIRMATION", () => {
    const request = makeRequest("ACCELERATION", "ACC_BLOCK_20", {
      coachEdits: [
        { field: "sets", value: 3, unit: "sets" },
        { field: "repsPerSet", value: 8, unit: "reps" },
      ],
      overrides: [fieldOverride("sessionVolumeM", 480), fieldOverride("totalReps", 24)],
    });
    const findings = blockedFindings(planRunningPrescription(request));
    expect(codes(findings)).toContain("PLAUSIBILITY_REQUIRE_CONFIRMATION");
    expect(metrics(findings)).toContain("PLA_SETS_REPS_MIXUP");
  });

  it("[R10-B4A] REQUIRE_CONFIRMATION は未確認なら BLOCKED（override では突破しない）", () => {
    const base = {
      coachEdits: [
        { field: "sets", value: 3, unit: "sets" },
        { field: "repsPerSet", value: 8, unit: "reps" },
      ],
      overrides: [fieldOverride("sessionVolumeM", 480), fieldOverride("totalReps", 24)],
    };
    expect(planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20", base)).status).toBe("BLOCKED");
    // 別の code を確認しても通らない（code 単位）
    const wrong = { ...makeRequest("ACCELERATION", "ACC_BLOCK_20", base), confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM"] };
    expect(planRunningPrescription(wrong).status).toBe("BLOCKED");
  });

  it("[R10-B4A] COACH がその code を明示確認すれば OK。Finding は処方に残る（確認しても消さない）", () => {
    const base = {
      coachEdits: [
        { field: "sets", value: 3, unit: "sets" },
        { field: "repsPerSet", value: 8, unit: "reps" },
      ],
      overrides: [fieldOverride("sessionVolumeM", 480), fieldOverride("totalReps", 24)],
    };
    const r = planRunningPrescription({ ...makeRequest("ACCELERATION", "ACC_BLOCK_20", base), confirmedFindingCodes: ["PLAUSIBILITY_REQUIRE_CONFIRMATION"] });
    expect(r.status).toBe("OK");
    if (r.status !== "OK") throw new Error("unreachable");
    expect(r.prescription.findings).toContainEqual(expect.objectContaining({ code: "PLAUSIBILITY_REQUIRE_CONFIRMATION", severity: "REQUIRE_CONFIRMATION" }));
  });

  it("[R10-B4A] AI / SYSTEM は confirmedFindingCodes を持てない（§18。確認はコーチの明示操作だけ）", () => {
    for (const actor of [AI, SYSTEM]) {
      const r = planRunningPrescription({ ...makeRequest("STRIDE", "ST_RELAXED", { actor }), confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM"] });
      expect(r.status, actor.kind).toBe("BLOCKED");
      if (r.status !== "BLOCKED") throw new Error("unreachable");
      expect(r.findings.map((f) => f.code), actor.kind).toContain("PLAN_REQUEST_INVALID");
    }
  });

  it("ratioMultiplier は RuleSet から読む（TS に 3 を持たない）", () => {
    const rule = ruleSet.plausibility.find((r) => r.ruleId === "PLA_SETS_REPS_MIXUP");
    expect(rule?.ratioMultiplier).toBe(3);
    expect(rule?.outputTarget).toBe("TOTAL_REPS_VS_RECOMMENDED");
  });
});

// ---------------------------------------------------------------------------
// 出力 plausibility の RuleSet 追従
// ---------------------------------------------------------------------------

describe("出力 plausibility は RuleSet 駆動", () => {
  function withPlausibility(mutate: (rows: RuleSet["plausibility"]) => RuleSet["plausibility"]): RuleSet {
    return ruleSetSchema.parse({ ...ruleSet, plausibility: mutate(ruleSet.plausibility) });
  }

  it("1項目の総走行距離の BLOCK 閾値を変えると判定が変わる", () => {
    const p = (() => {
      const r = planRunningPrescription(makeRequest("TEMPO_EXTENSIVE", "TE_200"));
      if (r.status !== "OK") throw new Error(JSON.stringify(r));
      return r.prescription;
    })();
    const strict = withPlausibility((rows) =>
      rows.map((r) => (r.ruleId === "PLA_ITEM_TOTAL_DISTANCE" ? { ...r, blockThreshold: { min: null, max: 100 } } : r)),
    );
    expect(checkOutputPlausibility(p, ruleSet).blocked).toBe(false);
    expect(checkOutputPlausibility(p, strict).blocked).toBe(true);
  });

  it("Session の BLOCK 閾値を 30000 → 100000 にすると 80,000m が通る（TS に閾値を持たない）", () => {
    const value = { lower: 80000, upper: 80000, unit: "m" as const, source: "PLANNED" as const, confidence: "HIGH" as const };
    expect(checkSessionPlausibility(value, ruleSet).blocked).toBe(true);
    const relaxed = withPlausibility((rows) =>
      rows.map((r) => (r.ruleId === "PLA_MENU_TOTAL_DISTANCE" ? { ...r, blockThreshold: { min: null, max: 100000 } } : r)),
    );
    expect(checkSessionPlausibility(value, relaxed).blocked).toBe(false);
  });

  it("appliesToMethods に無い Method の行は適用しない", () => {
    const longRule = ruleSet.plausibility.find((r) => r.ruleId === "PLA_ITEM_DISTANCE_LONG");
    expect(longRule?.appliesToMethods).toEqual(["LONG_SPRINT_RACE_SPECIFIC"]);
    const r = planRunningPrescription(makeRequest("TEMPO_EXTENSIVE", "TE_200"));
    if (r.status !== "OK") throw new Error(JSON.stringify(r));
    // TE の 200m は LONG 行（>600 で確認）に掛からない
    expect(checkOutputPlausibility(r.prescription, ruleSet).findings).toEqual([]);
  });

  it("scope=INPUT の行は出力 plausibility では評価しない", () => {
    const inputRows = ruleSet.plausibility.filter((r) => r.scope === "INPUT");
    expect(inputRows.length).toBeGreaterThan(0);
    for (const row of inputRows) expect(row.outputTarget).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-PLA-04: legacy 警告フック
// ---------------------------------------------------------------------------

type GoldenCase = {
  id: string;
  input: { exercise: Parameters<typeof suggestPrescription>[0]; context: Parameters<typeof suggestPrescription>[1] };
  output: { prescription: Record<string, number | null>; rationale: string[] };
};
const golden = goldenFixture as unknown as { cases: GoldenCase[] };

describe("T-PLA-04: legacy 警告フック（数値は変えず warning だけ足す）", () => {
  const paceRun = golden.cases.find((c) => c.id === "defaultPattern__D1_pace_run_5000m_extreme_volume")!;
  const interval400 = golden.cases.find((c) => c.id === "defaultPattern__D2_interval_400m_extreme_volume")!;

  it("監査 C-1 の「ペース走 5000m」: 数値は golden と同一、警告だけ増える", () => {
    const actual = suggestPrescription(paceRun.input.exercise, paceRun.input.context);
    expect(actual.prescription).toEqual(paceRun.output.prescription);
    expect(actual.rationale).toEqual(paceRun.output.rationale);
    expect(actual.warnings.length).toBeGreaterThan(0);
    expect(actual.warnings.join("\n")).toContain("80000m");
  });

  it("監査 C-1 の「インターバル 400m」（25.6km）も legacy 経路で警告される", () => {
    const actual = suggestPrescription(interval400.input.exercise, interval400.input.context);
    expect(actual.prescription).toEqual(interval400.output.prescription);
    expect(actual.warnings.join("\n")).toContain("25600m");
  });

  it("legacy の数値・rationale は全 golden ケースで1件も変わっていない", () => {
    for (const c of golden.cases) {
      const actual = suggestPrescription(c.input.exercise, c.input.context);
      expect(actual.prescription, c.id).toEqual(c.output.prescription);
      expect(actual.rationale, c.id).toEqual(c.output.rationale);
    }
  });

  it("既存の warning を置き換えず、重複も作らない", () => {
    const actual = suggestPrescription(paceRun.input.exercise, paceRun.input.context);
    expect(new Set(actual.warnings).size).toBe(actual.warnings.length);
    // 既存の legacy 警告（総量上限）が出るケースでは、それが残ったまま追加される
    const kind = golden.cases.find((c) => c.id === "matrix__SPEED_ACCELERATION__JHS__PREPARATION__D")!;
    const withLegacyWarning = suggestPrescription(kind.input.exercise, kind.input.context);
    expect(withLegacyWarning.warnings.some((w) => w.includes("1回の練習の目安"))).toBe(true);
  });

  it("走らない category（CORE 等）には警告を足さない", () => {
    const core = suggestPrescription({ category: "CORE", targets: [] }, {});
    expect(core.warnings.join("\n")).not.toContain("総走行距離");
    expect(core.warnings.join("\n")).not.toContain("距離・本数・セット数");
  });

  it("legacy の判定も RuleSet の閾値に従う（TS に 10000 を持たない）", () => {
    const item = { category: "ENDURANCE", sets: 2, reps: 8, distanceMeters: 5000, durationSeconds: null, restSeconds: 60 };
    expect(checkLegacyItemPlausibility(item, ruleSet).blocked).toBe(true);
    const relaxed = ruleSetSchema.parse({
      ...ruleSet,
      plausibility: ruleSet.plausibility.map((r) =>
        r.ruleId === "PLA_ITEM_TOTAL_DISTANCE" ? { ...r, blockThreshold: { min: null, max: 100000 }, confirmThreshold: { min: null, max: 90000 } } : r,
      ),
    });
    expect(checkLegacyItemPlausibility(item, relaxed).blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 監査 C-1 の2事例を v2 の集計でも検出する
// ---------------------------------------------------------------------------

describe("監査 C-1 の2事例は v2 の集計でも検出される", () => {
  it("legacy 項目として集計しても Session BLOCK に達する", () => {
    const agg = evaluateSessionAggregation(
      [{ kind: "LEGACY", item: { category: "ENDURANCE", sets: 2, reps: 8, distanceMeters: 5000, durationSeconds: null, restSeconds: 60 } }],
      { ruleSet, tier: "ADVANCED", availableMinutes: null, competitionDay: "NOT_EVALUATED", mode: "PLANNING" },
    );
    expect(agg.totalRunningDistanceM.upper).toBe(80000);
    expect(checkSessionPlausibility(agg.totalRunningDistanceM, ruleSet).blocked).toBe(true);
  });

  it("インターバル 400m（8set × 8本）は 25,600m として集計される", () => {
    const agg = evaluateSessionAggregation(
      [{ kind: "LEGACY", item: { category: "ENDURANCE", sets: 8, reps: 8, distanceMeters: 400, durationSeconds: null, restSeconds: 90 } }],
      { ruleSet, tier: "ADVANCED", availableMinutes: null, competitionDay: "NOT_EVALUATED", mode: "PLANNING" },
    );
    expect(agg.totalRunningDistanceM.upper).toBe(25600);
    // Session の BLOCK 閾値（30,000m）には届かないが、項目としては BLOCK 対象
    expect(checkSessionPlausibility(agg.totalRunningDistanceM, ruleSet).blocked).toBe(false);
    expect(
      checkLegacyItemPlausibility({ category: "ENDURANCE", sets: 8, reps: 8, distanceMeters: 400, durationSeconds: null, restSeconds: 90 }, ruleSet)
        .blocked,
    ).toBe(true);
  });
});
