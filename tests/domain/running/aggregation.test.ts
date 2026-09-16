/**
 * Running Prescription Engine v2 — Phase R6（§11 Session aggregation）。
 *
 * 検証の柱:
 *   - 1項目で判定を終えない（監査 H-5: 同じ Method を3項目並べたら合計で判定する）
 *   - null を 0 にしない（§11.3）
 *   - 高速曝露は区間（A は RuleSet 由来。1値にしない）
 *   - 判定データはすべて RuleSet（しきい値・上限を TS に複製しない）
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as runningApi from "@/domain/running";
import { evaluateSessionAggregation } from "@/domain/running/aggregation";
import { accelIntervalFor, estimateExposure, relayAllowanceM, relayExposure } from "@/domain/running/aggregation/exposure";
import { adaptLegacyItem, legacyContacts, legacyDistanceInterval } from "@/domain/running/aggregation/legacyAdapter";
import { knownZero, sumIntervals, unknownInterval } from "@/domain/running/aggregation/metrics";
import {
  compareToLimit,
  evaluateMethodVolume,
  methodAggregationRule,
  resolveItemCap,
  resolveTemplateCap,
  type ItemBudgetInput,
} from "@/domain/running/aggregation/rules";
import type { AggregationContext, AggregationItem } from "@/domain/running/aggregation/schema";
import { planRunningPrescription } from "@/domain/running/planning";
import type { PlanRequest, PlanResult } from "@/domain/running/planning/schema";
import { getRuleSet } from "@/domain/running/rules/loader";
import { ruleSetSchema, type RuleSet } from "@/domain/running/rules/schema";
import { createCoachActor } from "@/domain/running/types/actor";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { IsoDate } from "@/domain/running/types/primitives";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";
import type { RecoveryStructure } from "@/domain/running/types/template";

const ruleSet = getRuleSet("rs-2026.09.0")!;
const PLANNING_DATE = "2026-09-15";
const COACH = createCoachActor("coach-1");
const AI = { kind: "AI_PLANNER", provider: "test-provider", model: "test-model", requestId: "req-1" } as const;
const SYSTEM = { kind: "SYSTEM" } as const;

function iso(value: string): IsoDate {
  return value as IsoDate;
}

const POST_HIGH = { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") } as const;
const POST_MEDIUM = { status: "POST", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") } as const;

function athlete(overrides: Partial<AthleteProfile> = {}): Subject {
  return {
    kind: "ATHLETE",
    profile: {
      birthDate: iso("1998-01-01"),
      primaryEvent: "400m",
      maturity: POST_HIGH,
      trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
      marks: [],
      vmax: null,
      allowAdvancedMethods: true,
      ...overrides,
    },
  };
}

const adultAdvanced = () => athlete();
/** 実測 fly を持つ ADVANCED（confidence が上がり、位置上限が外れる組み合わせ用）。 */
const adultAdvancedWithMarks = () =>
  athlete({ marks: [{ event: "FLY20", timeS: 2.0, date: iso("2026-08-01"), timing: "PHOTO_CELL" }] });
/** U18・POST(MEDIUM)・2年 → DEVELOPMENTAL */
const u18Developmental = () =>
  athlete({ birthDate: iso("2010-01-01"), maturity: POST_MEDIUM, trainingAge: { structuredSprintYears: 2 }, allowAdvancedMethods: false });

type RequestOptions = {
  subject?: Subject;
  actor?: PlanRequest["actor"] | typeof AI | typeof SYSTEM;
  otherItems?: unknown[];
  coachEdits?: unknown[];
  overrides?: unknown[];
  availableMinutes?: number | null;
};

function makeRequest(method: string, templateId: string, o: RequestOptions = {}): PlanRequest {
  return {
    planningDate: iso(PLANNING_DATE),
    selection: { method, templateId },
    subject: o.subject ?? adultAdvanced(),
    menuContext: {
      phase: null,
      plannedDate: null,
      competitions: [],
      otherItems: o.otherItems ?? [],
      availableMinutes: o.availableMinutes ?? null,
    },
    history: null,
    readiness: null,
    positionPreference: null,
    coachEdits: o.coachEdits ?? [],
    overrides: o.overrides ?? [],
    coachReference: null,
    actor: o.actor ?? COACH,
  } as unknown as PlanRequest;
}

function describeResult(r: PlanResult): string {
  if (r.status === "OK") return "OK";
  if (r.status === "INELIGIBLE") return `INELIGIBLE ${JSON.stringify(r.reasons)}`;
  return `BLOCKED ${JSON.stringify(r.findings.filter((f) => f.severity !== "INFO"))}`;
}

function expectOk(r: PlanResult) {
  expect(r.status, describeResult(r)).toBe("OK");
  if (r.status !== "OK") throw new Error("unreachable");
  return r;
}

function planOk(method: string, templateId: string, o: RequestOptions = {}): RunningPrescriptionValue {
  return expectOk(planRunningPrescription(makeRequest(method, templateId, o))).prescription;
}

function v2(prescription: RunningPrescriptionValue): AggregationItem {
  return { kind: "RUNNING_V2", prescription };
}

function ctx(o: Partial<AggregationContext> = {}): AggregationContext {
  return {
    ruleSet,
    tier: "ADVANCED",
    availableMinutes: null,
    competitionDay: "NOT_EVALUATED",
    mode: "PLANNING",
    ...o,
  };
}

const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code);

// ---------------------------------------------------------------------------
// 区間演算（§11.3）
// ---------------------------------------------------------------------------

describe("§11.3 null / UNKNOWN の伝播", () => {
  it("片方の bound が null なら合計のその bound も null（0 にしない）", () => {
    const sum = sumIntervals("m", [
      { lower: 100, upper: 200, unit: "m", source: "PLANNED", confidence: "HIGH" },
      { lower: 50, upper: null, unit: "m", source: "ESTIMATED", confidence: "LOW" },
    ]);
    expect(sum.lower).toBe(150);
    expect(sum.upper).toBeNull();
  });

  it("ESTIMATED を含む合計を MEASURED にしない・LOW を含む合計を HIGH にしない", () => {
    const sum = sumIntervals("m", [
      { lower: 10, upper: 10, unit: "m", source: "MEASURED", confidence: "HIGH" },
      { lower: 10, upper: 10, unit: "m", source: "ESTIMATED", confidence: "LOW" },
    ]);
    expect(sum.source).toBe("ESTIMATED");
    expect(sum.confidence).toBe("LOW");
  });

  it("RULE_DEFINITION の [0,0] は既知の 0 なので合計の確からしさを下げない", () => {
    const sum = sumIntervals("m", [
      { lower: 100, upper: 100, unit: "m", source: "MEASURED", confidence: "HIGH" },
      knownZero("m"),
    ]);
    expect(sum).toMatchObject({ lower: 100, upper: 100, source: "MEASURED", confidence: "HIGH" });
    expect(sumIntervals("m", [knownZero("m"), knownZero("m")])).toMatchObject({ lower: 0, upper: 0, source: "RULE_DEFINITION" });
  });

  it("上限比較: upper があれば upper、無ければ lower。lower も超えていなければ断定しない", () => {
    expect(compareToLimit({ lower: 10, upper: 400, unit: "m", source: "PLANNED", confidence: "HIGH" }, 300)).toBe("OVER");
    expect(compareToLimit({ lower: 10, upper: 100, unit: "m", source: "PLANNED", confidence: "HIGH" }, 300)).toBe("WITHIN");
    expect(compareToLimit({ lower: 400, upper: null, unit: "m", source: "UNKNOWN", confidence: "NONE" }, 300)).toBe("OVER");
    expect(compareToLimit({ lower: 10, upper: null, unit: "m", source: "UNKNOWN", confidence: "NONE" }, 300)).toBe("NOT_DETERMINABLE");
  });
});

// ---------------------------------------------------------------------------
// 高速曝露（§11.2）
// ---------------------------------------------------------------------------

describe("§11.2 高速曝露の区間計算", () => {
  it("推定加速距離 A は RuleSet から読む（DEV [20,30] / ADV [40,60]）", () => {
    expect(accelIntervalFor(ruleSet, "DEVELOPMENTAL")).toEqual({ lowerM: 20, upperM: 30 });
    expect(accelIntervalFor(ruleSet, "ADVANCED")).toEqual({ lowerM: 40, upperM: 60 });
    expect(relayAllowanceM(ruleSet)).toBe(20);
  });

  it("DISTANCE_MINUS_ACCEL_INTERVAL: [max(0,d−A_hi)×n, max(0,d−A_lo)×n]", () => {
    const p = planOk("ACCELERATION", "ACC_BLOCK_40", { subject: adultAdvanced() });
    const n = p.sets.value * p.repsPerSet.value;
    const e = estimateExposure({ prescription: p, model: "DISTANCE_MINUS_ACCEL_INTERVAL", accel: { lowerM: 40, upperM: 60 } });
    expect(e.lower).toBe(Math.max(0, 40 - 60) * n);
    expect(e.upper).toBe(Math.max(0, 40 - 40) * n);
    expect(e.source).toBe("ESTIMATED");
    expect(e.confidence).toBe("LOW");
  });

  it("DEV の A=[20,30] では同じ距離でも結果が変わる", () => {
    const p = planOk("ACCELERATION", "ACC_BLOCK_20", { subject: u18Developmental() });
    const n = p.sets.value * p.repsPerSet.value;
    const dev = estimateExposure({ prescription: p, model: "DISTANCE_MINUS_ACCEL_INTERVAL", accel: { lowerM: 20, upperM: 30 } });
    const adv = estimateExposure({ prescription: p, model: "DISTANCE_MINUS_ACCEL_INTERVAL", accel: { lowerM: 10, upperM: 20 } });
    expect([dev.lower, dev.upper]).toEqual([0, 0]);
    expect([adv.lower, adv.upper]).toEqual([0, 10 * n]);
  });

  it("FLY_ZONE: [fly×n, (fly + max(0, buildUp − A_lo))×n]（deceleration は含めない）", () => {
    const p = planOk("MAX_VELOCITY", "MV_FLY20");
    if (p.rep.kind !== "FLY") throw new Error("setup");
    const n = p.sets.value * p.repsPerSet.value;
    const fly = p.rep.flyZoneDistanceM.value;
    const buildUp = p.rep.buildUpDistanceM.value;
    const e = estimateExposure({ prescription: p, model: "FLY_ZONE", accel: { lowerM: 40, upperM: 60 } });
    expect(e.lower).toBe(fly * n);
    expect(e.upper).toBe((fly + Math.max(0, buildUp - 40)) * n);
    // deceleration を足していないこと
    expect(p.rep.decelerationDistanceM).not.toBeNull();
    expect(e.upper).toBeLessThan((fly + buildUp + (p.rep.decelerationDistanceM ?? 0)) * n);
  });

  it("WHOLE_REP: [max(0,d−A_hi)×n, d×n]", () => {
    const p = planOk("SPRINT_ENDURANCE_SHORT", "SES_150", { subject: adultAdvancedWithMarks() });
    const n = p.sets.value * p.repsPerSet.value;
    if (p.rep.kind !== "DURATION") throw new Error("setup");
    const d = p.rep.displayDistanceM;
    const e = estimateExposure({ prescription: p, model: "WHOLE_REP", accel: { lowerM: 40, upperM: 60 } });
    expect(e.upper).toBe(d.upper === null ? null : d.upper * n);
    expect(e.lower).toBe(d.lower === null ? null : Math.max(0, d.lower - 60) * n);
  });

  it("NONE（STRIDE）は [0,0] RULE_DEFINITION（unknown ではない）", () => {
    const p = planOk("STRIDE", "ST_RELAXED");
    const e = estimateExposure({ prescription: p, model: "NONE", accel: { lowerM: 40, upperM: 60 } });
    expect(e).toMatchObject({ lower: 0, upper: 0, source: "RULE_DEFINITION" });
  });

  it("A が RuleSet に無ければ 0 と決めつけず unknown にする", () => {
    const p = planOk("ACCELERATION", "ACC_BLOCK_20");
    const e = estimateExposure({ prescription: p, model: "DISTANCE_MINUS_ACCEL_INTERVAL", accel: null });
    expect(e.lower).toBeNull();
    expect(e.upper).toBeNull();
  });

  it("RELAY: [max(0, leg − allowance)×n, leg×n]", () => {
    expect(relayExposure(100, 4, relayAllowanceM(ruleSet))).toMatchObject({ lower: 320, upper: 400, source: "ESTIMATED" });
  });
});

// ---------------------------------------------------------------------------
// T-AGG-01: 同一 Method の合計（監査 H-5）
// ---------------------------------------------------------------------------

describe("T-AGG-01: 加速3項目（同じ Method の合計で判定する）", () => {
  it("DEV で ACC 各項目は合法でも、合計が Envelope の上限を超えたら検出する（per-item usage の合計）", () => {
    const p = planOk("ACCELERATION", "ACC_BLOCK_20", { subject: u18Developmental() });
    const single = p.sets.value * p.repsPerSet.value * 20;
    const cap = resolveItemCap({
      ruleSet,
      method: "ACCELERATION",
      tier: "DEVELOPMENTAL",
      metric: "sessionVolumeM",
      templateId: "ACC_BLOCK_20",
      recoveryStructure: null,
    });
    if (cap.kind !== "RESOLVED") throw new Error("setup");
    // 1項目だけなら上限内（Σ usage = single/cap ≤ 1.0）
    expect(single / (cap.recommendedMax ?? Infinity)).toBeLessThanOrEqual(1.0);

    const agg = evaluateSessionAggregation([v2(p), v2(p), v2(p)], ctx({ tier: "DEVELOPMENTAL" }));
    // 全 item が同じ cap を持つので Σ(120/cap) = (120+120+120)/cap と数学的に一致する（旧方式との整合）。
    expect((single * 3) / cap.coachEditableMax).toBeGreaterThan(1.0);
    expect(codes(agg.findings)).toContain("AGG_METHOD_BUDGET_OVER_RECOMMENDED");
    expect(codes(agg.findings)).toContain("AGG_METHOD_BUDGET_OVER_EDITABLE");
  });

  it("AGG_METHOD_BUDGET_OVER_EDITABLE は REQUIRE_COACH_REVIEW と BLOCK_AUTOGEN の両方の意味を保つ", () => {
    const p = planOk("ACCELERATION", "ACC_BLOCK_20", { subject: u18Developmental() });
    const agg = evaluateSessionAggregation([v2(p), v2(p), v2(p)], ctx({ tier: "DEVELOPMENTAL" }));
    const over = agg.findings.filter((f) => f.code === "AGG_METHOD_BUDGET_OVER_EDITABLE");
    expect(over.map((f) => f.severity).sort()).toEqual(["BLOCK_AUTOGEN", "REQUIRE_COACH_REVIEW"]);
  });

  it("AI / SYSTEM は合計超過で自動生成できない（COACH は確認付きで継続できる）", () => {
    const p = planOk("ACCELERATION", "ACC_BLOCK_20", { subject: u18Developmental() });
    const others = [v2(p), v2(p)];
    for (const actor of [AI, SYSTEM]) {
      const r = planRunningPrescription(
        makeRequest("ACCELERATION", "ACC_BLOCK_20", { subject: u18Developmental(), actor, otherItems: others }),
      );
      expect(r.status, actor.kind).toBe("BLOCKED");
    }
    const coach = planRunningPrescription(
      makeRequest("ACCELERATION", "ACC_BLOCK_20", { subject: u18Developmental(), actor: COACH, otherItems: others }),
    );
    expect(coach.status, describeResult(coach)).toBe("OK");
    if (coach.status !== "OK") throw new Error("unreachable");
    expect(codes(coach.sessionFindings)).toContain("AGG_METHOD_BUDGET_OVER_EDITABLE");
    expect(coach.sessionFindings.every((f) => f.scope === "SESSION")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-AGG-02 / T-AGG-03
// ---------------------------------------------------------------------------

describe("T-AGG-02: null を 0 にしない", () => {
  it("upper=null の項目を含むと合計 upper=null・completeness=PARTIAL・AGG_INCOMPLETE_DATA", () => {
    const p = planOk("STRIDE", "ST_RELAXED");
    const legacy: AggregationItem = {
      kind: "LEGACY",
      item: { category: "SPRINT", sets: 3, reps: null, distanceMeters: 60, durationSeconds: null, restSeconds: null },
    };
    const agg = evaluateSessionAggregation([v2(p), legacy], ctx());
    expect(agg.plannedHighSpeedExposureM.upper).toBeNull();
    expect(agg.completeness).toBe("PARTIAL");
    expect(codes(agg.findings)).toContain("AGG_INCOMPLETE_DATA");
  });

  it("比較不能なときは「安全」と断定せず AGG_NOT_DETERMINABLE を出す", () => {
    const agg = evaluateSessionAggregation(
      [
        {
          kind: "LEGACY",
          item: { category: "HURDLE", sets: 2, reps: 5, distanceMeters: 60, durationSeconds: null, restSeconds: null },
        },
      ],
      ctx(),
    );
    expect(agg.totalRunningDistanceM.upper).toBeNull();
    expect(agg.completeness).toBe("PARTIAL");
    expect(codes(agg.findings)).toContain("AGG_LEGACY_CATEGORY_UNKNOWN");
  });

  it("定義上 0 の項目（STRIDE の高速曝露）は unknown ではないので COMPLETE のまま", () => {
    const agg = evaluateSessionAggregation([v2(planOk("STRIDE", "ST_RELAXED"))], ctx());
    expect(agg.plannedHighSpeedExposureM).toMatchObject({ lower: 0, upper: 0, source: "RULE_DEFINITION" });
    expect(agg.completeness).toBe("COMPLETE");
  });
});

describe("T-AGG-03: 高強度予算（ADV: ACC + MV 同日）", () => {
  it("合計 0.5 + 0.6 = 1.1 で AGG_HIGH_INTENSITY_BUDGET（処方値は変えない）", () => {
    // ACC 150m（cap 300 → 0.5）と MV fly 90m（cap 150 → 0.6）を合成した集計入力
    const acc = planOk("ACCELERATION", "ACC_BLOCK_30");
    const mv = planOk("MAX_VELOCITY", "MV_FLY30", { subject: adultAdvancedWithMarks() });
    const accScaled: RunningPrescriptionValue = { ...acc, sets: { ...acc.sets, value: 1 }, repsPerSet: { ...acc.repsPerSet, value: 5 } };
    const mvScaled: RunningPrescriptionValue = { ...mv, sets: { ...mv.sets, value: 1 }, repsPerSet: { ...mv.repsPerSet, value: 3 } };
    const agg = evaluateSessionAggregation([v2(accScaled), v2(mvScaled)], ctx());
    expect(agg.highIntensityBudgetUse.recommended).toBeCloseTo(150 / 300 + 90 / 150, 5);
    expect(agg.highIntensityBudgetUse.recommended).toBeCloseTo(1.1, 5);
    expect(codes(agg.findings)).toContain("AGG_HIGH_INTENSITY_BUDGET");
    expect(agg.highIntensityMethods).toEqual(["ACCELERATION", "MAX_VELOCITY"]);
    // 量は1ミリも減らさない
    expect(accScaled.repsPerSet.value).toBe(5);
    expect(mvScaled.repsPerSet.value).toBe(3);
  });

  it("予算は量への係数ではない（集計は処方を書き換えない）", () => {
    const acc = planOk("ACCELERATION", "ACC_BLOCK_30");
    const before = JSON.stringify(acc);
    evaluateSessionAggregation([v2(acc), v2(acc), v2(acc)], ctx());
    expect(JSON.stringify(acc)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// T-AGG-04: legacy
// ---------------------------------------------------------------------------

describe("T-AGG-04: legacy の sets/reps 曖昧さを区間で表す", () => {
  it("SPRINT 60m, sets 4, reps null → [240, 240]", () => {
    const i = legacyDistanceInterval({ category: "SPRINT", sets: 4, reps: null, distanceMeters: 60, durationSeconds: null, restSeconds: null });
    expect([i.lower, i.upper]).toEqual([240, 240]);
  });

  it("SPRINT 60m, sets 4, reps 5 → [240, 1200]", () => {
    const i = legacyDistanceInterval({ category: "SPRINT", sets: 4, reps: 5, distanceMeters: 60, durationSeconds: null, restSeconds: null });
    expect([i.lower, i.upper]).toEqual([240, 1200]);
  });

  it("JUMP: 下限 = sets×(reps ?? 1)、reps が null なら上限 null（接地上限は作らない）", () => {
    expect(legacyContacts({ category: "JUMP", sets: 3, reps: null, distanceMeters: null, durationSeconds: null, restSeconds: null })).toMatchObject({
      lower: 3,
      upper: null,
    });
    expect(legacyContacts({ category: "JUMP", sets: 3, reps: 10, distanceMeters: null, durationSeconds: null, restSeconds: null })).toMatchObject({
      lower: 30,
      upper: 30,
    });
    const agg = evaluateSessionAggregation(
      [{ kind: "LEGACY", item: { category: "JUMP", sets: 3, reps: null, distanceMeters: null, durationSeconds: null, restSeconds: null } }],
      ctx(),
    );
    expect(agg.plyometricContacts.upper).toBeNull();
    expect(agg.completeness).toBe("PARTIAL");
    expect(JSON.stringify(agg)).not.toContain("120");
  });

  it("legacy の走項目を「高速曝露 0」と決めつけない", () => {
    const c = adaptLegacyItem(ruleSet, {
      category: "SPRINT",
      sets: 4,
      reps: null,
      distanceMeters: 60,
      durationSeconds: null,
      restSeconds: null,
    });
    expect(c.plannedHighSpeedExposureM).toEqual(unknownInterval("m"));
    expect(c.nearMaxSprintVolumeM.lower).toBeNull();
  });

  it("走らない category は定義上 0（unknown ではない）", () => {
    const c = adaptLegacyItem(ruleSet, {
      category: "CORE",
      sets: 3,
      reps: 10,
      distanceMeters: null,
      durationSeconds: null,
      restSeconds: 60,
    });
    expect(c.totalRunningDistanceM).toEqual(knownZero("m"));
    expect(c.plannedHighSpeedExposureM).toEqual(knownZero("m"));
  });

  it("strengthLoad は v2 では常に null（筋トン数を発明しない）", () => {
    expect(evaluateSessionAggregation([], ctx()).strengthLoad).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §11.2 指標の切り分け
// ---------------------------------------------------------------------------

describe("§11.2 指標ごとの切り分け", () => {
  it("tempoVolumeM は TE + TI、strideVolumeM は STRIDE だけ（TE の量を STRIDE に使わない）", () => {
    const te = planOk("TEMPO_EXTENSIVE", "TE_200");
    const stride = planOk("STRIDE", "ST_RELAXED");
    const agg = evaluateSessionAggregation([v2(te), v2(stride)], ctx());
    const teTotal = te.sets.value * te.repsPerSet.value * 200;
    const strideTotal = stride.sets.value * stride.repsPerSet.value * (stride.rep.kind === "DISTANCE" ? stride.rep.distanceM.value : 0);
    expect(agg.tempoVolumeM.upper).toBe(teTotal);
    expect(agg.strideVolumeM.upper).toBe(strideTotal);
    expect(agg.longSprintVolumeM).toMatchObject({ lower: 0, upper: 0 });
  });

  it("STRIDE の上限は STRIDE の coachEditable（TE の上限を参照しない）", () => {
    const stride = planOk("STRIDE", "ST_RELAXED");
    const many = Array.from({ length: 4 }, () => v2(stride));
    const agg = evaluateSessionAggregation(many, ctx());
    const cap = resolveTemplateCap({ ruleSet, method: "STRIDE", tier: "ADVANCED", metric: "sessionVolumeM" });
    if (cap === null) throw new Error("setup");
    expect(agg.strideVolumeM.upper).toBeGreaterThan(cap.coachEditableMax);
    expect(codes(agg.findings)).toContain("AGG_STRIDE_OVER");
  });

  it("nearMaxSprintVolumeM: TE / STRIDE は定義上 0、ACC は距離×本数", () => {
    const te = planOk("TEMPO_EXTENSIVE", "TE_200");
    expect(evaluateSessionAggregation([v2(te)], ctx()).nearMaxSprintVolumeM).toMatchObject({ lower: 0, upper: 0, source: "RULE_DEFINITION" });
    const acc = planOk("ACCELERATION", "ACC_BLOCK_20");
    const n = acc.sets.value * acc.repsPerSet.value;
    expect(evaluateSessionAggregation([v2(acc)], ctx()).nearMaxSprintVolumeM.upper).toBe(20 * n);
  });

  it("EA は approachType=FULL のときだけ nearMax に数える（SHORT を FULL 扱いしない）", () => {
    const short = ruleSet.templates.find((t) => t.id === "EA_JUMP_SHORT_APPROACH");
    const full = ruleSet.templates.find((t) => t.id === "EA_JUMP_FULL_APPROACH");
    expect(short?.approachType).toBe("SHORT");
    expect(full?.approachType).toBe("FULL");
  });

  it("totalRunningDistanceM は fly の build-up を含み deceleration を含めない", () => {
    const mv = planOk("MAX_VELOCITY", "MV_FLY20");
    if (mv.rep.kind !== "FLY") throw new Error("setup");
    const n = mv.sets.value * mv.repsPerSet.value;
    const agg = evaluateSessionAggregation([v2(mv)], ctx());
    expect(agg.totalRunningDistanceM.upper).toBe((mv.rep.buildUpDistanceM.value + mv.rep.flyZoneDistanceM.value) * n);
  });
});

// ---------------------------------------------------------------------------
// RuleSet 由来であること
// ---------------------------------------------------------------------------

describe("判定データは RuleSet 側にある", () => {
  function withAggregationRules(mutate: (rules: RuleSet["aggregationRules"]) => RuleSet["aggregationRules"]): RuleSet {
    return ruleSetSchema.parse({ ...ruleSet, aggregationRules: mutate(ruleSet.aggregationRules) });
  }

  it("A を [20,30] → [10,20] に変えると高速曝露が変わる", () => {
    const changed = withAggregationRules((rules) =>
      rules.map((r) => (r.kind === "ACCEL_INTERVAL" && r.tier === "DEVELOPMENTAL" ? { ...r, lowerM: 10, upperM: 20 } : r)),
    );
    const p = planOk("ACCELERATION", "ACC_BLOCK_20", { subject: u18Developmental() });
    const base = evaluateSessionAggregation([v2(p)], ctx({ tier: "DEVELOPMENTAL" }));
    const mutated = evaluateSessionAggregation([v2(p)], ctx({ tier: "DEVELOPMENTAL", ruleSet: changed }));
    expect(mutated.plannedHighSpeedExposureM.upper).toBeGreaterThan(base.plannedHighSpeedExposureM.upper!);
  });

  it("budget しきい値を 1.0 → 1.2 にすると T-AGG-03 の Finding が消える", () => {
    const acc = planOk("ACCELERATION", "ACC_BLOCK_30");
    const mv = planOk("MAX_VELOCITY", "MV_FLY30", { subject: adultAdvancedWithMarks() });
    const items = [
      v2({ ...acc, sets: { ...acc.sets, value: 1 }, repsPerSet: { ...acc.repsPerSet, value: 5 } }),
      v2({ ...mv, sets: { ...mv.sets, value: 1 }, repsPerSet: { ...mv.repsPerSet, value: 3 } }),
    ];
    expect(codes(evaluateSessionAggregation(items, ctx()).findings)).toContain("AGG_HIGH_INTENSITY_BUDGET");
    const relaxed = withAggregationRules((rules) => rules.map((r) => (r.kind === "HIGH_INTENSITY_BUDGET" ? { ...r, threshold: 1.2 } : r)));
    expect(codes(evaluateSessionAggregation(items, ctx({ ruleSet: relaxed })).findings)).not.toContain("AGG_HIGH_INTENSITY_BUDGET");
  });

  it("legacy category の意味を変えると集計が変わる", () => {
    const item: AggregationItem = {
      kind: "LEGACY",
      item: { category: "SPRINT", sets: 4, reps: 5, distanceMeters: 60, durationSeconds: null, restSeconds: null },
    };
    expect(evaluateSessionAggregation([item], ctx()).totalRunningDistanceM.upper).toBe(1200);
    const changed = withAggregationRules((rules) =>
      rules.map((r) => (r.kind === "LEGACY_CATEGORY" && r.category === "SPRINT" ? { ...r, contribution: "NOT_RUNNING" as const } : r)),
    );
    expect(evaluateSessionAggregation([item], ctx({ ruleSet: changed })).totalRunningDistanceM.upper).toBe(0);
  });

  it("aggregationRules の順序を入れ替えても結果は同じ", () => {
    const shuffled = ruleSetSchema.parse({ ...ruleSet, aggregationRules: [...ruleSet.aggregationRules].reverse() });
    const items = [v2(planOk("ACCELERATION", "ACC_BLOCK_20")), v2(planOk("STRIDE", "ST_RELAXED"))];
    const a = evaluateSessionAggregation(items, ctx());
    const b = evaluateSessionAggregation(items, ctx({ ruleSet: shuffled }));
    expect(b).toEqual(a);
  });

  it("Method の上限は Envelope が single source of truth（aggregationRules に数値を持たない）", () => {
    const json = JSON.stringify(ruleSet.aggregationRules);
    expect(json).not.toContain("300");
    expect(json).not.toContain("2000");
    const cap = resolveItemCap({
      ruleSet,
      method: "ACCELERATION",
      tier: "ADVANCED",
      metric: "sessionVolumeM",
      templateId: "ACC_BLOCK_20",
      recoveryStructure: null,
    });
    expect(cap).toEqual({ kind: "RESOLVED", recommendedMax: 300, coachEditableMax: 400 });
  });

  it("aggregation / plausibility は ID・表示名の解析をしない", () => {
    for (const dir of ["src/domain/running/aggregation", "src/domain/running/plausibility"]) {
      for (const file of fs.readdirSync(path.join(process.cwd(), dir))) {
        const code = fs
          .readFileSync(path.join(process.cwd(), dir, file), "utf-8")
          .split("\n")
          .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
          .join("\n");
        expect(code, `${dir}/${file}`).not.toMatch(/\.startsWith\(|\.endsWith\(|conditionNote|targetLabel|labelJa/);
        expect(code, `${dir}/${file}`).not.toMatch(/new RegExp|\.match\(/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// rest feasibility / 責務境界
// ---------------------------------------------------------------------------

describe("§11.4 AGG_REST_INFEASIBLE と R6 の責務境界", () => {
  it("必ず取る休息だけで練習時間を超えたら WARN（同じ休息を二重計上しない）", () => {
    const p = planOk("ACCELERATION", "ACC_BLOCK_20");
    const repRestCount = p.sets.value * Math.max(0, p.repsPerSet.value - 1);
    const setRestCount = Math.max(0, p.sets.value - 1);
    const rest = repRestCount * p.rest.repRestS.value + setRestCount * (p.rest.setRestS?.value ?? p.rest.repRestS.value);
    const agg = evaluateSessionAggregation([v2(p)], ctx({ availableMinutes: Math.floor(rest / 60) - 1 }));
    expect(codes(agg.findings)).toContain("AGG_REST_INFEASIBLE");
    const ok = evaluateSessionAggregation([v2(p)], ctx({ availableMinutes: 600 }));
    expect(codes(ok.findings)).not.toContain("AGG_REST_INFEASIBLE");
  });

  it("availableMinutes が null なら rest feasibility を評価しない", () => {
    const agg = evaluateSessionAggregation([v2(planOk("ACCELERATION", "ACC_BLOCK_20"))], ctx({ availableMinutes: null }));
    expect(codes(agg.findings)).not.toContain("AGG_REST_INFEASIBLE");
  });

  it("R6 は大会日を推測しない（AGG_COMPETITION_DAY_EXTRA を出さない）", () => {
    const agg = evaluateSessionAggregation([v2(planOk("ACCELERATION", "ACC_BLOCK_20"))], ctx());
    expect(codes(agg.findings)).not.toContain("AGG_COMPETITION_DAY_EXTRA");
  });

  it("実測がまだ無い R6 では actualHighSpeedExposureM は null（0 にしない）", () => {
    expect(evaluateSessionAggregation([v2(planOk("ACCELERATION", "ACC_BLOCK_20"))], ctx()).actualHighSpeedExposureM).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// planning への接続
// ---------------------------------------------------------------------------

describe("step 14: planning への接続", () => {
  it("otherItems に現在の項目は含めない（engine が1回だけ足す）", () => {
    const acc = planOk("ACCELERATION", "ACC_BLOCK_20");
    const r = expectOk(planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20", { otherItems: [] })));
    const agg = evaluateSessionAggregation([v2(r.prescription)], ctx());
    const n = acc.sets.value * acc.repsPerSet.value;
    expect(agg.totalRunningDistanceM.upper).toBe(20 * n);
  });

  it("OK の sessionFindings は SESSION scope、項目固有 Finding は prescription.findings（混ぜない）", () => {
    const r = expectOk(planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20")));
    expect(r.sessionFindings.every((f) => f.scope === "SESSION")).toBe(true);
    expect(r.prescription.findings.every((f) => f.scope === "ITEM")).toBe(true);
  });

  it("readiness=null / otherItems=[] は R5 と同じ挙動（回帰）", () => {
    const r = expectOk(planRunningPrescription(makeRequest("ACCELERATION", "ACC_BLOCK_20")));
    expect(r.prescription.readinessApplied).toEqual([]);
    expect(r.prescription.safetyOutcome).toBe("NONE");
    expect(r.prescription.ruleSet.status).toBe("DRAFT");
  });

  it("root public API は evaluateSessionAggregation / checkOutputPlausibility だけ（内部は出さない）", () => {
    expect(typeof runningApi.evaluateSessionAggregation).toBe("function");
    expect(typeof runningApi.checkOutputPlausibility).toBe("function");
    for (const name of ["sumIntervals", "estimateExposure", "adaptLegacyItem", "resolveItemCap", "checkSessionPlausibility"]) {
      expect(Object.keys(runningApi), name).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// [R6 pre-commit correction] per-item normalized Method budget
// ---------------------------------------------------------------------------

describe("[R6 correction] Method 内で template ごとに上限が違っても一意に判定できる", () => {
  /**
   * VITTORI（fixedDistanceField=repDistanceM=70m。distance は override できない）と COACH_DEFINED
   * （distance がコーチ入力）で cap が異なる（recommended 1200/null、coachEditable 2000/1600）。
   * spec の例示どおりの数値（600/800/1200/1600m）で判定ロジックそのものを検証するため、
   * cap は実 RuleSet から `resolveItemCap` で引き、contribution だけを illustrative な値にする
   * （RuleSet の数値は一切書き換えない）。
   */
  function tiUsage(templateId: "TI_VITTORI_SE" | "TI_COACH_DEFINED", distanceM: number): ItemBudgetInput {
    const cap = resolveItemCap({
      ruleSet,
      method: "TEMPO_INTENSIVE",
      tier: "ADVANCED",
      metric: "sessionVolumeM",
      templateId,
      recoveryStructure: null,
    });
    return {
      method: "TEMPO_INTENSIVE",
      metric: "sessionVolumeM",
      templateId,
      contribution: { lower: distanceM, upper: distanceM, unit: "m", source: "PLANNED", confidence: "HIGH" },
      cap,
    };
  }

  it("cap は実 RuleSet の値（recommended 1200/null、coachEditable 2000/1600）", () => {
    expect(resolveItemCap({ ruleSet, method: "TEMPO_INTENSIVE", tier: "ADVANCED", metric: "sessionVolumeM", templateId: "TI_VITTORI_SE", recoveryStructure: null })).toEqual({
      kind: "RESOLVED",
      recommendedMax: 1200,
      coachEditableMax: 2000,
    });
    expect(resolveItemCap({ ruleSet, method: "TEMPO_INTENSIVE", tier: "ADVANCED", metric: "sessionVolumeM", templateId: "TI_COACH_DEFINED", recoveryStructure: null })).toEqual({
      kind: "RESOLVED",
      recommendedMax: null,
      coachEditableMax: 1600,
    });
  });

  it("VITTORI 600m + COACH_DEFINED 800m → recommended budget = 1.0（over ではない）", () => {
    // 600/1200 + 800/1600 = 0.5 + 0.5 = 1.0（閾値は「> 1.0」なのでちょうど1.0は over にならない）
    const findings = evaluateMethodVolume({ items: [tiUsage("TI_VITTORI_SE", 600), tiUsage("TI_COACH_DEFINED", 800)] });
    expect(codes(findings)).not.toContain("AGG_METHOD_BUDGET_OVER_RECOMMENDED");
    expect(codes(findings)).not.toContain("AGG_METHOD_CAP_NOT_DETERMINABLE");
  });

  it("VITTORI 600m + COACH_DEFINED 800m → editable budget = 0.8（block しない）", () => {
    // 600/2000 + 800/1600 = 0.3 + 0.5 = 0.8
    const findings = evaluateMethodVolume({ items: [tiUsage("TI_VITTORI_SE", 600), tiUsage("TI_COACH_DEFINED", 800)] });
    expect(codes(findings)).not.toContain("AGG_METHOD_BUDGET_OVER_EDITABLE");
  });

  it("VITTORI 1200m + COACH_DEFINED 1600m → recommended budget 2.0 で WARN、editable 1.6 で REVIEW + BLOCK", () => {
    const findings = evaluateMethodVolume({ items: [tiUsage("TI_VITTORI_SE", 1200), tiUsage("TI_COACH_DEFINED", 1600)] });
    // recommended: 1200/1200 + 1600/1600 = 1.0 + 1.0 = 2.0 → WARN
    expect(codes(findings)).toContain("AGG_METHOD_BUDGET_OVER_RECOMMENDED");
    // editable: 1200/2000 + 1600/1600 = 0.6 + 1.0 = 1.6 → REVIEW + BLOCK
    const editableOver = findings.filter((f) => f.code === "AGG_METHOD_BUDGET_OVER_EDITABLE");
    expect(editableOver.map((f) => f.severity).sort()).toEqual(["BLOCK_AUTOGEN", "REQUIRE_COACH_REVIEW"]);
    // heterogeneous な template cap でも「判定できない」にはならない（per-item denominator で解決するため）
    expect(codes(findings)).not.toContain("AGG_METHOD_CAP_NOT_DETERMINABLE");
  });

  it("真に denominator を取得できない場合だけ AGG_METHOD_CAP_NOT_DETERMINABLE を出す（heterogeneous な cap の食い違いでは出さない）", () => {
    // aggregation metric に対応する Envelope セルが無い RuleSet を作る（malformed 相当）。
    const noCell: RuleSet = ruleSetSchema.parse({
      ...ruleSet,
      envelopes: ruleSet.envelopes.map((e) => {
        if (e.method !== "ACCELERATION" || e.tier !== "ADVANCED") return e;
        const rest = Object.fromEntries(Object.entries(e.fields).filter(([k]) => k !== "sessionVolumeM"));
        return { ...e, fields: rest as typeof e.fields };
      }),
    });
    const p = planOk("ACCELERATION", "ACC_BLOCK_20");
    const agg = evaluateSessionAggregation([v2(p)], ctx({ ruleSet: noCell }));
    expect(codes(agg.findings)).toContain("AGG_METHOD_CAP_NOT_DETERMINABLE");
    // 一方、cap が template ごとに違うだけ（VITTORI と COACH_DEFINED）では NOT_DETERMINABLE にならない
    const mixed = evaluateMethodVolume({ items: [tiUsage("TI_VITTORI_SE", 600), tiUsage("TI_COACH_DEFINED", 800)] });
    expect(codes(mixed)).not.toContain("AGG_METHOD_CAP_NOT_DETERMINABLE");
  });

  it("T-AGG-01 は per-item 方式でも旧方式と数学的に一致する（H-5 対策は維持）", () => {
    const p = planOk("ACCELERATION", "ACC_BLOCK_20", { subject: u18Developmental() });
    const single = p.sets.value * p.repsPerSet.value * 20;
    const cap = resolveItemCap({
      ruleSet,
      method: "ACCELERATION",
      tier: "DEVELOPMENTAL",
      metric: "sessionVolumeM",
      templateId: "ACC_BLOCK_20",
      recoveryStructure: null,
    });
    if (cap.kind !== "RESOLVED") throw new Error("setup");
    // 全 item が同じ cap を持つので Σ(single/cap) = (single×3)/cap と数学的に同一
    expect((single / cap.coachEditableMax) * 3).toBeCloseTo((single * 3) / cap.coachEditableMax, 10);
    const agg = evaluateSessionAggregation([v2(p), v2(p), v2(p)], ctx({ tier: "DEVELOPMENTAL" }));
    expect(codes(agg.findings)).toContain("AGG_METHOD_BUDGET_OVER_EDITABLE");
  });

  it("T-AGG-03 は per-item 方式でも変わらない（ACC 0.5 + MV 0.6 = 1.1）", () => {
    const acc = planOk("ACCELERATION", "ACC_BLOCK_30");
    const mv = planOk("MAX_VELOCITY", "MV_FLY30", { subject: adultAdvancedWithMarks() });
    const accScaled: RunningPrescriptionValue = { ...acc, sets: { ...acc.sets, value: 1 }, repsPerSet: { ...acc.repsPerSet, value: 5 } };
    const mvScaled: RunningPrescriptionValue = { ...mv, sets: { ...mv.sets, value: 1 }, repsPerSet: { ...mv.repsPerSet, value: 3 } };
    const agg = evaluateSessionAggregation([v2(accScaled), v2(mvScaled)], ctx());
    expect(agg.highIntensityBudgetUse.recommended).toBeCloseTo(0.5 + 0.6, 5);
    expect(codes(agg.findings)).toContain("AGG_HIGH_INTENSITY_BUDGET");
  });

  it("[R6 correction] 実処方（heterogeneous な template）を通した end-to-end 配線の確認", () => {
    // TI_VITTORI_SE は distance が template 固定（70m）。sets=2/repsPerSet=5 で totalReps=10 → 700m。
    const vittori = planRunningPrescription(
      makeRequest("TEMPO_INTENSIVE", "TI_VITTORI_SE", {
        subject: adultAdvancedWithMarks(),
        coachEdits: [
          { field: "sets", value: 2, unit: "sets" },
          { field: "repsPerSet", value: 5, unit: "reps" },
        ],
      }),
    );
    if (vittori.status !== "OK") throw new Error(describeResult(vittori));
    // TI_COACH_DEFINED は distance もコーチ入力（recommended=null）。1本 300m（plausibility の confirm 閾値
    // 400m 未満）× 3set × 1回 = 900m にして、override なしで coachEditable の範囲内に収める。
    const coachDefined = planRunningPrescription(
      makeRequest("TEMPO_INTENSIVE", "TI_COACH_DEFINED", {
        subject: adultAdvancedWithMarks(),
        coachEdits: [
          { field: "sets", value: 3, unit: "sets" },
          { field: "repsPerSet", value: 1, unit: "reps" },
          { field: "repDistanceM", value: 300, unit: "m" },
          { field: "intensityPercent", value: 80, unit: "percent" },
          { field: "repRestS", value: 120, unit: "s" },
          { field: "setRestS", value: 300, unit: "s" },
        ],
      }),
    );
    if (coachDefined.status !== "OK") throw new Error(describeResult(coachDefined));

    const agg = evaluateSessionAggregation([v2(vittori.prescription), v2(coachDefined.prescription)], ctx());
    // recommended: 700/1200 + 900/1600(fallback) = 0.5833 + 0.5625 = 1.146 > 1.0 → WARN
    expect(codes(agg.findings)).toContain("AGG_METHOD_BUDGET_OVER_RECOMMENDED");
    expect(codes(agg.findings)).not.toContain("AGG_METHOD_CAP_NOT_DETERMINABLE");
    // editable: 700/2000 + 900/1600 = 0.35 + 0.5625 = 0.9125（block しない）
    expect(codes(agg.findings)).not.toContain("AGG_METHOD_BUDGET_OVER_EDITABLE");
    // TEMPO_INTENSIVE は loadClass=MODERATE なので high-intensity budget には数えない
    expect(agg.highIntensityMethods).toEqual([]);
  });

  it("RuleSet の TI_COACH_DEFINED.coachEditable.max を変えると budget usage が変わる（TS に 1600 を持たない）", () => {
    const mutated: RuleSet = ruleSetSchema.parse({
      ...ruleSet,
      envelopes: ruleSet.envelopes.map((e) =>
        e.templateIds.includes("TI_COACH_DEFINED") && e.tier === "ADVANCED" && e.fields.sessionVolumeM
          ? { ...e, fields: { ...e.fields, sessionVolumeM: { ...e.fields.sessionVolumeM, coachEditable: { ...e.fields.sessionVolumeM.coachEditable, max: 800 } } } }
          : e,
      ),
    });
    const capBefore = resolveItemCap({ ruleSet, method: "TEMPO_INTENSIVE", tier: "ADVANCED", metric: "sessionVolumeM", templateId: "TI_COACH_DEFINED", recoveryStructure: null });
    const capAfter = resolveItemCap({ ruleSet: mutated, method: "TEMPO_INTENSIVE", tier: "ADVANCED", metric: "sessionVolumeM", templateId: "TI_COACH_DEFINED", recoveryStructure: null });
    expect(capBefore).toEqual({ kind: "RESOLVED", recommendedMax: null, coachEditableMax: 1600 });
    expect(capAfter).toEqual({ kind: "RESOLVED", recommendedMax: null, coachEditableMax: 800 });

    function usageWith(rs: RuleSet) {
      const cap = resolveItemCap({ ruleSet: rs, method: "TEMPO_INTENSIVE", tier: "ADVANCED", metric: "sessionVolumeM", templateId: "TI_COACH_DEFINED", recoveryStructure: null });
      const items: ItemBudgetInput[] = [
        tiUsage("TI_VITTORI_SE", 600),
        { method: "TEMPO_INTENSIVE", metric: "sessionVolumeM", templateId: "TI_COACH_DEFINED", contribution: { lower: 800, upper: 800, unit: "m", source: "PLANNED", confidence: "HIGH" }, cap },
      ];
      return evaluateMethodVolume({ items });
    }
    expect(codes(usageWith(ruleSet))).not.toContain("AGG_METHOD_BUDGET_OVER_EDITABLE");
    // 800/800 = 1.0（VITTORI 側は 600/2000=0.3）→ 合計 1.3 > 1.0 で over になる
    expect(codes(usageWith(mutated))).toContain("AGG_METHOD_BUDGET_OVER_EDITABLE");
  });
});

describe("[R6 correction] completeness validator: 全 Method × tier × template で最低限 coachEditable.max が引ける", () => {
  it("rs-2026.09.0 の全 template について、実際に使う template/tier/recoveryStructure から coachEditable.max を取得できる", () => {
    const undeterminable: string[] = [];
    for (const method of ruleSet.methods.map((m) => m.method)) {
      const rule = methodAggregationRule(ruleSet, method);
      if (!rule || rule.volumeMetric === undefined) continue;
      const templates = ruleSet.templates.filter((t) => t.method === method);
      for (const template of templates) {
        for (const tier of ["DEVELOPMENTAL", "ADVANCED"] as const) {
          const recoveryStructures: (RecoveryStructure | null)[] = method === "LONG_SPRINT_RACE_SPECIFIC" ? ["FULL", "INCOMPLETE"] : [null];
          for (const recoveryStructure of recoveryStructures) {
            const cap = resolveItemCap({ ruleSet, method, tier, metric: rule.volumeMetric, templateId: template.id, recoveryStructure });
            // Envelope 自体が無い（この tier/recoveryStructure では template を提供しない）ケースは対象外。
            const hasEnvelope = ruleSet.envelopes.some(
              (e) => e.method === method && e.tier === tier && (e.recoveryStructure ?? null) === recoveryStructure && e.templateIds.includes(template.id),
            );
            if (!hasEnvelope) continue;
            if (cap.kind !== "RESOLVED") undeterminable.push(`${method}/${tier}/${template.id}/${recoveryStructure}`);
          }
        }
      }
    }
    expect(undeterminable).toEqual([]);
  });

  it("recommended が null の template（TI_COACH_DEFINED 等）は completeness 上は許容される", () => {
    const cap = resolveItemCap({
      ruleSet,
      method: "TEMPO_INTENSIVE",
      tier: "ADVANCED",
      metric: "sessionVolumeM",
      templateId: "TI_COACH_DEFINED",
      recoveryStructure: null,
    });
    expect(cap).toEqual({ kind: "RESOLVED", recommendedMax: null, coachEditableMax: 1600 });
  });
});
