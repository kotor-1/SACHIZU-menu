import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as runningApi from "@/domain/running";
import { planRunningPrescription, planRunningPrescriptionWithRuleSet } from "@/domain/running/planning";
import { planRequestSchema, coachOverrideSchema, type PlanRequest, type PlanResult } from "@/domain/running/planning/schema";
import { eligibilityConditionsMet, evaluateEligibilityConditionVerdict, type EligibilityConditionCtx } from "@/domain/running/planning/eligibility";
import { selectEnvelope } from "@/domain/running/planning/envelope";
import { recheckHardSafety } from "@/domain/running/planning/hardSafety";
import { directnessContexts, performanceLevelForTrainingAge } from "@/domain/running/planning/confidence";
import {
  lowestPosition,
  placeValue,
  positionCapForConfidence,
  positionFromPreference,
  positionPoint,
  type PlacedPosition,
} from "@/domain/running/planning/placement";
import { validatePrescriptionAgainstRuleSet } from "@/domain/running/planning/validatePrescription";
import { renderRationaleJa } from "@/domain/running/rationale/render-ja";
import { getActiveRuleSet, getRuleSet } from "@/domain/running/rules/loader";
import { derivePrescriptionConfidence, type UsedEvidenceSummary } from "@/domain/running/evidence/confidence";
import { resolveSubjectProfile } from "@/domain/running/context/subject";
import { createCoachActor } from "@/domain/running/types/actor";
import { runningPrescriptionSchema, type FieldValue, type RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { AthleteProfile, GroupProfile, Subject } from "@/domain/running/types/subject";
import type { IsoDate } from "@/domain/running/types/primitives";
import type { TimedMark } from "@/domain/running/types/intensity";
import type { RuleSet } from "@/domain/running/rules/schema";
import type { Unit } from "@/domain/running/types/primitives";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ruleSet = getRuleSet("rs-2026.09.0")!;
const EXPECTED_HASH = "c73297f8850fe8d6a6bf7a4c918b49ceb6fb9477edc429352aecbeddf6b657ba";
const PLANNING_DATE = "2026-09-15";

function iso(value: string): IsoDate {
  return value as IsoDate;
}

const COACH = createCoachActor("coach-1");
const AI = { kind: "AI_PLANNER", provider: "test-provider", model: "test-model", requestId: "req-1" } as const;
const SYSTEM = { kind: "SYSTEM" } as const;

const POST_HIGH = { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") } as const;
const POST_MEDIUM = { status: "POST", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") } as const;
const PRE_MEDIUM = { status: "PRE", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") } as const;
const UNKNOWN_LOW = { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null } as const;

const FLY20_PHOTO: TimedMark = { event: "FLY20", timeS: 2.0, date: iso("2026-08-01"), timing: "PHOTO_CELL" }; // 45日前
const PB100_HAND: TimedMark = { event: "100m", timeS: 12.5, date: iso("2026-06-01"), timing: "HAND" };

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

/** ADULT・POST・coachAssignedTier=ADVANCED → EnvelopeTier=ADVANCED */
const adultAdvanced = (o: Partial<AthleteProfile> = {}) => athlete(o);
/** U18・POST(MEDIUM)・2年 → DEVELOPING → EnvelopeTier=DEVELOPMENTAL */
const u18PostDeveloping = (o: Partial<AthleteProfile> = {}) =>
  athlete({ birthDate: iso("2010-01-01"), maturity: POST_MEDIUM, trainingAge: { structuredSprintYears: 2 }, allowAdvancedMethods: false, ...o });
/** T-POP-01: U15・maturity UNKNOWN・3年 */
const u15Unknown = (o: Partial<AthleteProfile> = {}) =>
  athlete({ birthDate: iso("2012-01-01"), maturity: UNKNOWN_LOW, trainingAge: { structuredSprintYears: 3 }, allowAdvancedMethods: false, ...o });
/** T-POP-02: U12・PRE */
const u12Pre = (o: Partial<AthleteProfile> = {}) =>
  athlete({ birthDate: iso("2016-01-01"), maturity: PRE_MEDIUM, trainingAge: { structuredSprintYears: 1 }, allowAdvancedMethods: false, ...o });

type RequestOptions = {
  subject?: Subject;
  actor?: PlanRequest["actor"] | typeof AI | typeof SYSTEM;
  coachEdits?: unknown[];
  overrides?: unknown[];
  coachReference?: unknown;
  positionPreference?: "LOWER" | "MIDDLE" | null;
  phase?: string | null;
  plannedDate?: string | null;
  availableMinutes?: number | null;
  history?: unknown;
};

function makeRequest(method: string, templateId: string, o: RequestOptions = {}): PlanRequest {
  return {
    planningDate: iso(PLANNING_DATE),
    selection: { method, templateId },
    subject: o.subject ?? adultAdvanced(),
    menuContext: {
      phase: o.phase ?? null,
      plannedDate: o.plannedDate ?? null,
      plannedAt: null,
      competitions: [],
      otherItems: [],
      availableMinutes: o.availableMinutes ?? null,
    },
    history: o.history ?? null,
    readiness: null,
    positionPreference: o.positionPreference ?? null,
    coachEdits: o.coachEdits ?? [],
    overrides: o.overrides ?? [],
    coachReference: o.coachReference ?? null,
    actor: o.actor ?? COACH,
  } as unknown as PlanRequest;
}

function plan(method: string, templateId: string, o: RequestOptions = {}): PlanResult {
  return planRunningPrescription(makeRequest(method, templateId, o));
}

function describeResult(r: PlanResult): string {
  if (r.status === "OK") return "OK";
  if (r.status === "INELIGIBLE") return `INELIGIBLE ${JSON.stringify(r.reasons)}`;
  return `BLOCKED ${JSON.stringify(r.findings.filter((f) => f.severity !== "INFO"))}`;
}

function expectOk(r: PlanResult): RunningPrescriptionValue {
  expect(r.status, describeResult(r)).toBe("OK");
  if (r.status !== "OK") throw new Error("unreachable");
  return r.prescription;
}

function expectBlocked(r: PlanResult, code: string) {
  expect(r.status, describeResult(r)).toBe("BLOCKED");
  if (r.status !== "BLOCKED") throw new Error("unreachable");
  expect(r.findings.map((f) => f.code)).toContain(code);
  return r.findings;
}

function expectIneligible(r: PlanResult, code: string) {
  expect(r.status, describeResult(r)).toBe("INELIGIBLE");
  if (r.status !== "INELIGIBLE") throw new Error("unreachable");
  // [R4 errata] DRAFT RuleSet を使った INELIGIBLE でも RULESET_DRAFT が観測できる
  expect(r.findings.map((f) => f.code)).toContain("RULESET_DRAFT");
  expect(r.reasons.map((x) => x.code)).toContain(code);
  expect(r.substitutes).toEqual([]);
  return r.reasons;
}

const findingCodes = (p: RunningPrescriptionValue) => p.findings.map((f) => f.code);

const splitRef = (segments: [number, number, number][]) => ({
  kind: "TARGET_SPLIT",
  segments: segments.map(([distanceM, lower, upper]) => ({
    distanceM,
    targetS: { lower, upper, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" },
  })),
});

const override = (target: unknown, extra: Record<string, unknown> = {}) => ({
  target,
  reason: "コーチ判断で本日の例外として実施する",
  confirmedTwice: true,
  actor: COACH,
  at: "2026-09-15T09:00:00+09:00",
  ...extra,
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function readSources(dir: string): { file: string; code: string }[] {
  const abs = path.resolve(__dirname, "../../../src/domain/running", dir);
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: `${dir}/${f}`, code: stripComments(fs.readFileSync(path.join(abs, f), "utf-8")) }));
}

// ---------------------------------------------------------------------------
// PlanRequestSchema（#1, #4〜#6, #21, #22）
// ---------------------------------------------------------------------------

describe("PlanRequestSchema", () => {
  const base = () => makeRequest("ACCELERATION", "ACC_BLOCK_20") as unknown as Record<string, unknown>;

  it("最小の有効な PlanRequest を受け付ける", () => {
    expect(planRequestSchema.safeParse(base()).success).toBe(true);
  });

  it("ruleSetVersion を受け付けない（.strict()）", () => {
    expect(planRequestSchema.safeParse({ ...base(), ruleSetVersion: "rs-2026.09.0" }).success).toBe(false);
  });

  it("planningDate は必須で、実在する日付でなければならない", () => {
    const { planningDate: _omit, ...rest } = base();
    void _omit;
    expect(planRequestSchema.safeParse(rest).success).toBe(false);
    expect(planRequestSchema.safeParse({ ...base(), planningDate: "2026-02-30" }).success).toBe(false);
    expect(planRequestSchema.safeParse({ ...base(), planningDate: "2028-02-29" }).success).toBe(true);
  });

  it("plannedDate は null 可、非 null なら planningDate と一致必須", () => {
    const ctx = (plannedDate: string | null) => ({ ...base(), menuContext: { ...(base().menuContext as object), plannedDate } });
    expect(planRequestSchema.safeParse(ctx(null)).success).toBe(true);
    expect(planRequestSchema.safeParse(ctx(PLANNING_DATE)).success).toBe(true);
    expect(planRequestSchema.safeParse(ctx("2026-09-16")).success).toBe(false);
  });

  it("method × template の不整合を拒否する", () => {
    expect(planRequestSchema.safeParse({ ...base(), selection: { method: "MAX_VELOCITY", templateId: "ACC_BLOCK_20" } }).success).toBe(false);
  });

  it("readiness は ReadinessDecision 以外の形を拒否する（生の ReadinessReport 等）", () => {
    expect(planRequestSchema.safeParse({ ...base(), readiness: { painNow: false } }).success).toBe(false);
  });

  it("[R7] competitions は正式な CompetitionRef を受け付ける（不完全な形は拒否）", () => {
    expect(
      planRequestSchema.safeParse({ ...base(), menuContext: { ...(base().menuContext as object), competitions: [{ date: PLANNING_DATE }] } }).success,
    ).toBe(false);
    const valid = [{ id: "meet-1", date: PLANNING_DATE, priority: "NORMAL" }];
    expect(planRequestSchema.safeParse({ ...base(), menuContext: { ...(base().menuContext as object), competitions: valid } }).success).toBe(true);
    // id の重複は拒否
    expect(
      planRequestSchema.safeParse({ ...base(), menuContext: { ...(base().menuContext as object), competitions: [...valid, ...valid] } }).success,
    ).toBe(false);
  });

  for (const actor of [AI, SYSTEM]) {
    it(`actor=${actor.kind} は coachEdits / overrides / coachReference を持てない`, () => {
      expect(planRequestSchema.safeParse({ ...base(), actor }).success).toBe(true);
      expect(planRequestSchema.safeParse({ ...base(), actor, coachEdits: [{ field: "repRestS", value: 150, unit: "s" }] }).success).toBe(false);
      expect(planRequestSchema.safeParse({ ...base(), actor, overrides: [override({ kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" })] }).success).toBe(false);
      expect(planRequestSchema.safeParse({ ...base(), actor, coachReference: { kind: "COACH_DEFINED", label: "x" } }).success).toBe(false);
    });
  }

  it("positionPreference は LOWER / MIDDLE / null だけ", () => {
    expect(planRequestSchema.safeParse({ ...base(), actor: AI, positionPreference: "LOWER" }).success).toBe(true);
    expect(planRequestSchema.safeParse({ ...base(), actor: AI, positionPreference: "UPPER_HALF" }).success).toBe(false);
  });

  it("coachReference は RACE_PACE / TARGET_SPLIT / VELOCITY_DECREMENT / COACH_DEFINED だけ（実測参照を偽装できない）", () => {
    const mark = { event: "FLY20", timeS: 2, date: PLANNING_DATE, timing: "PHOTO_CELL" };
    const vmax = { valueMps: 10, lowerMps: 9.5, upperMps: 10.5, source: "RADAR_LASER", confidence: "HIGH", measuredAt: PLANNING_DATE };
    for (const ref of [
      { kind: "MEASURED_VMAX", vmax },
      { kind: "FLY_SPLIT", flyZoneM: 20, mark },
      { kind: "SAME_DISTANCE_BEST", distanceM: 20, mark },
      { kind: "MAX_INTENT" },
      { kind: "RELAXED_SUBMAX" },
    ]) {
      expect(planRequestSchema.safeParse({ ...base(), coachReference: ref }).success, ref.kind).toBe(false);
    }
    expect(planRequestSchema.safeParse({ ...base(), coachReference: { kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true } }).success).toBe(true);
    expect(planRequestSchema.safeParse({ ...base(), coachReference: splitRef([[300, 36, 38]]) }).success).toBe(true);
    // 目標区間の bound が null のコーチ入力は受け付けない
    expect(
      planRequestSchema.safeParse({
        ...base(),
        coachReference: { kind: "RACE_PACE", event: "400m", targetTimeS: { lower: null, upper: 50, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } },
      }).success,
    ).toBe(false);
  });

  it("CoachFieldEdit: strict、重複 field・NaN・Infinity を拒否", () => {
    expect(planRequestSchema.safeParse({ ...base(), coachEdits: [{ field: "repRestS", value: 150, unit: "s", note: "x" }] }).success).toBe(false);
    expect(
      planRequestSchema.safeParse({
        ...base(),
        coachEdits: [
          { field: "repRestS", value: 150, unit: "s" },
          { field: "repRestS", value: 160, unit: "s" },
        ],
      }).success,
    ).toBe(false);
    expect(planRequestSchema.safeParse({ ...base(), coachEdits: [{ field: "repRestS", value: Number.NaN, unit: "s" }] }).success).toBe(false);
    expect(planRequestSchema.safeParse({ ...base(), coachEdits: [{ field: "repRestS", value: Number.POSITIVE_INFINITY, unit: "s" }] }).success).toBe(false);
    expect(planRequestSchema.safeParse({ ...base(), coachEdits: [{ field: "notAField", value: 1, unit: "s" }] }).success).toBe(false);
  });

  it("CoachOverride（§8.3）: reason ≥10文字、ELIGIBILITY / HARD_SAFETY は confirmedTwice 必須、FIELD は newValue 必須", () => {
    expect(coachOverrideSchema.safeParse(override({ kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" })).success).toBe(true);
    expect(coachOverrideSchema.safeParse(override({ kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" }, { reason: "短い理由" })).success).toBe(false);
    expect(coachOverrideSchema.safeParse(override({ kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" }, { confirmedTwice: false })).success).toBe(false);
    expect(
      coachOverrideSchema.safeParse(override({ kind: "FIELD", field: "repRestS", layer: "HARD_SAFETY" }, { newValue: 100, confirmedTwice: false })).success,
    ).toBe(false);
    expect(coachOverrideSchema.safeParse(override({ kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" })).success).toBe(false);
    expect(
      coachOverrideSchema.safeParse(override({ kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" }, { newValue: 400, confirmedTwice: false })).success,
    ).toBe(true);
  });

  it("override の actor は PlanRequest の COACH と一致しなければならない", () => {
    const other = createCoachActor("coach-2");
    expect(
      planRequestSchema.safeParse({ ...base(), overrides: [override({ kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" }, { actor: other })] }).success,
    ).toBe(false);
  });

  it("同じ field に coachEdit と FIELD override を同時に指定できない", () => {
    expect(
      planRequestSchema.safeParse({
        ...base(),
        coachEdits: [{ field: "repRestS", value: 150, unit: "s" }],
        overrides: [override({ kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" }, { newValue: 400 })],
      }).success,
    ).toBe(false);
  });

  it("不正な PlanRequest は例外ではなく BLOCKED（PLAN_REQUEST_INVALID）", () => {
    const bad = { ...base(), actor: AI, overrides: [override({ kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" })] } as unknown as PlanRequest;
    expectBlocked(planRunningPrescription(bad), "PLAN_REQUEST_INVALID");
    expectBlocked(planRunningPrescription({ ...base(), planningDate: "2026-13-01" } as unknown as PlanRequest), "PLAN_REQUEST_INVALID");
  });

  it("型: plain object の COACH actor / override actor は PlanRequest に入れられない（branded CoachActor）", () => {
    const req = makeRequest("ACCELERATION", "ACC_BLOCK_20");
    // @ts-expect-error — { kind: "COACH" } の plain object は CoachActor ではない
    const plainActor: PlanRequest["actor"] = { kind: "COACH", ownerId: "coach-1" };
    const plainOverride: PlanRequest["overrides"][number] = {
      target: { kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" },
      reason: "コーチ判断で本日の例外として実施する",
      confirmedTwice: true,
      // @ts-expect-error — AI 経路から override を作れない（CoachActor 以外は型エラー）
      actor: AI,
      at: "2026-09-15T09:00:00+09:00" as PlanRequest["overrides"][number]["at"],
    };
    void plainActor;
    void plainOverride;
    expect(req.actor.kind).toBe("COACH");
  });
});

// ---------------------------------------------------------------------------
// RuleSet 解決（#1〜#3）
// ---------------------------------------------------------------------------

describe("RuleSet binding", () => {
  it("getActiveRuleSet は検証済み manifest の contentHash を返す（DRAFT fallback）", () => {
    const active = getActiveRuleSet(PLANNING_DATE);
    expect(active.ruleSet.ruleSetVersion).toBe("rs-2026.09.0");
    expect(active.isDraftFallback).toBe(true);
    expect(active.contentHash).toBe(EXPECTED_HASH);
  });

  it("処方に version / contentHash / status を埋め込み、RULESET_DRAFT（INFO）を付ける", () => {
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping() }));
    expect(p.ruleSet).toEqual({ version: "rs-2026.09.0", contentHash: EXPECTED_HASH, status: "DRAFT" });
    expect(p.findings).toContainEqual(expect.objectContaining({ code: "RULESET_DRAFT", severity: "INFO" }));
  });

  it("決定的: 同じ PlanRequest は同じ PlanResult", () => {
    const req = makeRequest("TEMPO_EXTENSIVE", "TE_100", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }) });
    expect(planRunningPrescription(req)).toEqual(planRunningPrescription(req));
  });

  it("domain（planning / rationale）は Date.now() / new Date() を使わない", () => {
    for (const { file, code } of [...readSources("planning"), ...readSources("rationale"), { file: "rules/loader.ts", code: stripComments(fs.readFileSync(path.resolve(__dirname, "../../../src/domain/running/rules/loader.ts"), "utf-8")) }]) {
      expect(code, file).not.toMatch(/Date\.now\s*\(/);
      expect(code, file).not.toMatch(/new\s+Date\s*\(/);
      expect(code, file).not.toMatch(/from\s+["']node:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Input plausibility（#7）
// ---------------------------------------------------------------------------

describe("step 1: input plausibility（R3 の評価関数と R2 の閾値を再利用）", () => {
  it("未使用の100m PB = 1.08 秒は無関係なMAX_INTENT計画をBLOCKしない", () => {
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { subject: adultAdvanced({ marks: [{ ...PB100_HAND, timeS: 1.08 }] }) });
    const p = expectOk(r);
    expect(p.findings.some((f) => f.code === "INPUT_MARK_DATA_QUALITY" && f.plausibility?.ruleId === "PLA_INPUT_100M_RECORD")).toBe(true);
  });

  it("未使用の100m PBはF14の選択記録確認Findingを出さない", () => {
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping({ marks: [{ ...PB100_HAND, timeS: 8.5 }] }) }));
    expect(p.findings.some((f) => f.code === "INPUT_PLAUSIBILITY_CONFIRM" && f.metric?.includes("PLA_INPUT_100M_RECORD"))).toBe(false);
  });

  it("成長計算に使う端点が範囲外ならreview-eligible BLOCKED", () => {
    const maturity = { ...POST_MEDIUM, heightHistory: [
      { date: iso("2025-01-01"), heightCm: 170 },
      { date: iso("2026-01-01"), heightCm: 1700 },
    ] };
    expectBlocked(plan("STRIDE", "ST_RELAXED", { subject: u18PostDeveloping({ maturity }) }), "INPUT_PLAUSIBILITY_BLOCK");
  });

  it("未来の birthDate は BLOCKED、未来の記録は使わず DATA_QUALITY を付ける", () => {
    expectBlocked(plan("STRIDE", "ST_RELAXED", { subject: athlete({ birthDate: iso("2027-01-01") }) }), "INPUT_BIRTHDATE_IN_FUTURE");
    const p = expectOk(
      plan("TEMPO_EXTENSIVE", "TE_200", { subject: adultAdvanced({ marks: [{ ...FLY20_PHOTO, date: iso("2026-10-01") }] }) }),
    );
    expect(findingCodes(p)).toContain("INPUT_MARK_IN_FUTURE_IGNORED");
    expect(p.intensity.reference.kind).toBe("RELAXED_SUBMAX");
  });
});

// ---------------------------------------------------------------------------
// Eligibility（#8〜#11, T-POP-01/02/07, T-AI-04, §18.4）
// ---------------------------------------------------------------------------

describe("step 6: eligibility", () => {
  it("resolveSubjectProfile を asOf=planningDate で使う（誕生日前後で ageBand が変わる）", () => {
    // 2014-09-16 生まれ: 2026-09-15 は 11歳（U12）、2026-09-16 は 12歳（U15）
    const subject = athlete({ birthDate: iso("2014-09-16"), maturity: PRE_MEDIUM, trainingAge: { structuredSprintYears: 1 }, allowAdvancedMethods: false });
    expect(resolveSubjectProfile({ subject, asOf: iso("2026-09-15"), ruleSet }).ageBand).toBe("U12");
    // U12 は complexity LOW のみ自動 → ACC_BLOCK_20（MEDIUM）は AI では不可
    expectIneligible(plan("ACCELERATION", "ACC_BLOCK_20", { subject, actor: AI }), "COMPLEXITY_ABOVE_AUTO_CAP");
    const nextDay = { ...makeRequest("ACCELERATION", "ACC_BLOCK_20", { subject, actor: AI }), planningDate: iso("2026-09-16") };
    expect(resolveSubjectProfile({ subject, asOf: iso("2026-09-16"), ruleSet }).ageBand).toBe("U15");
    expect(planRunningPrescription(nextDay).status).toBe("OK");
  });

  it("T-POP-02: U12 PRE は complexity LOW の template だけ自動生成（ACC_STANDING_20 は OK）", () => {
    expectOk(plan("ACCELERATION", "ACC_STANDING_20", { subject: u12Pre(), actor: AI }));
    for (const [method, templateId] of [
      ["LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I"],
      ["ASSISTED_SPRINT", "AS_TOWING"],
      ["TEMPO_INTENSIVE", "TI_COACH_DEFINED"],
      ["RESISTED_SPRINT", "RS_SLED_HEAVY"],
    ] as const) {
      const reasons = expectIneligible(
        plan(method, templateId, { subject: u12Pre(), overrides: [override({ kind: "ELIGIBILITY", ruleId: "CONSTRAINT_U12_HARD" })] }),
        "OVERRIDE_NOT_ALLOWED",
      );
      expect(reasons.some((r) => r.ruleId === "CONSTRAINT_U12_HARD" && r.overrideAllowed === false)).toBe(true);
    }
  });

  it("T-POP-01: U15 maturity UNKNOWN — ACC≤20m・STRIDE・MV_FLY10 は自動、SES は手動+REVIEW、LONG/ASSISTED/RS HEAVY は不適格", () => {
    expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u15Unknown(), actor: AI }));
    expectOk(plan("STRIDE", "ST_WARMUP", { subject: u15Unknown(), actor: AI }));
    const mv = expectOk(plan("MAX_VELOCITY", "MV_FLY10", { subject: u15Unknown(), actor: AI }));
    expect(mv.sets.value * mv.repsPerSet.value).toBeLessThanOrEqual(3);

    expectIneligible(plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject: u15Unknown(), actor: AI }), "AUTOGEN_NOT_ALLOWED_FOR_MANUAL_MODE");
    const ses = plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject: u15Unknown(), coachEdits: [{ field: "totalReps", value: 2, unit: "reps" }] });
    // PRE なら ELIG_SES_PRE で不適格（override 必要）だが、UNKNOWN は手動+REVIEW で選べる
    const sesP = expectOk(ses);
    expect(sesP.findings).toContainEqual(expect.objectContaining({ code: "ELIGIBILITY_MANUAL_REVIEW", severity: "REQUIRE_COACH_REVIEW" }));
    expectIneligible(plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject: athlete({ ...u15Unknown().profile, maturity: PRE_MEDIUM } as AthleteProfile) }), "OVERRIDE_REQUIRED");

    for (const [method, templateId] of [
      ["LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I"],
      ["LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400"],
      ["ASSISTED_SPRINT", "AS_TOWING"],
      ["RESISTED_SPRINT", "RS_SLED_HEAVY"],
    ] as const) {
      expect(plan(method, templateId, { subject: u15Unknown(), actor: AI }).status).toBe("INELIGIBLE");
    }
  });

  it("COACH は MANUAL の template を選べる（REQUIRE_COACH_REVIEW）。AI / SYSTEM は AUTO だけ（§18.4）", () => {
    const subject = u15Unknown();
    const coach = expectOk(plan("ACCELERATION", "ACC_BLOCK_30", { subject, coachEdits: [{ field: "totalReps", value: 3, unit: "reps" }, { field: "repDistanceM", value: 30, unit: "m" }] }));
    expect(findingCodes(coach)).toContain("ELIGIBILITY_MANUAL_REVIEW");
    for (const actor of [AI, SYSTEM]) {
      expectIneligible(plan("ACCELERATION", "ACC_BLOCK_30", { subject, actor }), "AUTOGEN_NOT_ALLOWED_FOR_MANUAL_MODE");
    }
  });

  it("override 可能な INELIGIBLE は有効な ELIGIBILITY override でのみ選べる。対象外の ruleId は BLOCKED", () => {
    const subject = athlete({ ...u15Unknown().profile, maturity: PRE_MEDIUM } as AthleteProfile);
    const edits = [{ field: "totalReps", value: 2, unit: "reps" }];
    expectIneligible(plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject, coachEdits: edits }), "OVERRIDE_REQUIRED");
    const ok = expectOk(
      plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject, coachEdits: edits, overrides: [override({ kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" })] }),
    );
    expect(findingCodes(ok)).toContain("ELIGIBILITY_OVERRIDDEN");
    expectBlocked(
      plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject, coachEdits: edits, overrides: [override({ kind: "ELIGIBILITY", ruleId: "ELIG_LONG_FULL_PRE" })] }),
      "OVERRIDE_TARGET_INVALID",
    );
  });

  it("override 不可の規則（LONG FULL PRE）は override を付けても不可", () => {
    const subject = athlete({ ...u15Unknown().profile, maturity: PRE_MEDIUM } as AthleteProfile);
    expectIneligible(
      plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", {
        subject,
        coachReference: splitRef([[300, 40, 42]]),
        overrides: [override({ kind: "ELIGIBILITY", ruleId: "ELIG_LONG_FULL_PRE" })],
      }),
      "OVERRIDE_NOT_ALLOWED",
    );
  });

  // [R7 correction — PASS WITH CHANGES 対応] §4.5 の SES POST 条件は OR:
  //   tier=ADVANCED  OR  (POST & tier≥DEVELOPING & phase≠TRANSITION)
  // を `EligibilityConditions.anyOf` で正確に表現する。population eligibility（この行の条件を
  // 満たすか）と phase の自動生成停止（TRANSITION の blockedAutogenLoadClasses）は別レイヤーであり、
  // 「最終結果が同じに見える」ことを理由に population 側を MANUAL へ落とす実装は禁止（PASS WITH
  // CHANGES 指摘）。
  describe("[R7 correction] SES conditional eligibility（§4.5 OR: tier=ADVANCED または POST&tier≥DEVELOPING&phase≠TRANSITION）", () => {
    function sesConditions() {
      return ruleSet.eligibility.find((r) => r.ruleId === "ELIG_SES_POST")!.conditions;
    }
    function verdictFor(subject: Subject, phase: string | null): ReturnType<typeof evaluateEligibilityConditionVerdict> {
      const profile = resolveSubjectProfile({ subject, asOf: iso(PLANNING_DATE), ruleSet });
      const ctx: EligibilityConditionCtx = { profile, coachReference: null, vmaxConfidence: null };
      return evaluateEligibilityConditionVerdict(sesConditions(), ctx, phase as never);
    }

    it("Case A: POST・tier=ADVANCED・phase=PREPARATION → ADVANCED branch で population condition 成立（MET）", () => {
      expect(verdictFor(adultAdvanced(), "PREPARATION")).toBe("MET");
      // mode=AUTO の証拠: COACH に MANUAL 系 finding が出ない。
      const coach = expectOk(plan("SPRINT_ENDURANCE_SHORT", "SES_100", { subject: adultAdvanced(), phase: "PREPARATION" }));
      expect(findingCodes(coach)).not.toContain("ELIGIBILITY_MANUAL_REVIEW");
      expect(findingCodes(coach)).not.toContain("ELIGIBILITY_MANUAL_SELECTION");
    });

    it("Case B: POST・tier=ADVANCED・phase=TRANSITION → population は ADVANCED branch で成立したまま（MET）。ただし Phase HIGH_* gate が別レイヤーで自動生成を止める", () => {
      // population eligibility は phase に関わらず MET（ADVANCED branch は phase を見ない）。
      expect(verdictFor(adultAdvanced(), "TRANSITION")).toBe("MET");
      expect(verdictFor(adultAdvanced(), null)).toBe("MET");

      // AI/SYSTEM: 自動生成不可（理由は既存の低 confidence gate が先に発火することもあるが、
      // いずれにせよ AUTO ではない）。
      for (const actor of [AI, SYSTEM]) {
        const r = plan("SPRINT_ENDURANCE_SHORT", "SES_100", { subject: adultAdvanced(), actor, phase: "TRANSITION" });
        expect(r.status, actor.kind).toBe("INELIGIBLE");
        // population eligibility 由来（CONDITIONAL_AUTO_NOT_MET/CONDITIONAL_AUTO_REQUIRES_PHASE）
        // が理由になっていないこと（population は満たしているので、そこを理由に止めていない）。
        if (r.status === "INELIGIBLE") {
          expect(r.reasons.map((x) => x.code), actor.kind).not.toContain("CONDITIONAL_AUTO_NOT_MET");
          expect(r.reasons.map((x) => x.code), actor.kind).not.toContain("CONDITIONAL_AUTO_REQUIRES_PHASE");
        }
      }
      // COACH: manual + review で継続可能。review は phase 由来（PHASE_AUTOGEN_BLOCKED）であり、
      // population eligibility 由来の ELIGIBILITY_MANUAL_REVIEW/SELECTION ではない
      // （population eligibility を落として phase block と同じ結果に見せてはいけない）。
      const coach = expectOk(plan("SPRINT_ENDURANCE_SHORT", "SES_100", { subject: adultAdvanced(), phase: "TRANSITION" }));
      expect(findingCodes(coach)).toContain("PHASE_AUTOGEN_BLOCKED");
      expect(findingCodes(coach)).not.toContain("ELIGIBILITY_MANUAL_REVIEW");
      expect(findingCodes(coach)).not.toContain("ELIGIBILITY_MANUAL_SELECTION");
    });

    it("Case C: POST・tier=DEVELOPMENTAL・trainingAge=DEVELOPING・phase=PREPARATION → 第2 branch で成立（MET）。conditional auto 可能", () => {
      expect(verdictFor(u18PostDeveloping(), "PREPARATION")).toBe("MET");
      const coach = expectOk(plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject: u18PostDeveloping(), phase: "PREPARATION" }));
      expect(findingCodes(coach)).not.toContain("ELIGIBILITY_MANUAL_REVIEW");
      expect(findingCodes(coach)).not.toContain("ELIGIBILITY_MANUAL_SELECTION");
    });

    it("Case D: POST・tier=DEVELOPMENTAL・trainingAge=DEVELOPING・phase=TRANSITION → 第2 branch不成立（UNMET）。ADVANCED branch も不成立なので population 全体が UNMET + Phase HIGH_* gate も重なる", () => {
      expect(verdictFor(u18PostDeveloping(), "TRANSITION")).toBe("UNMET");
      for (const actor of [AI, SYSTEM]) {
        const r = plan("SPRINT_ENDURANCE_SHORT", "SES_100", { subject: u18PostDeveloping(), actor, phase: "TRANSITION" });
        expect(r.status, actor.kind).toBe("INELIGIBLE");
      }
      const coach = expectOk(plan("SPRINT_ENDURANCE_SHORT", "SES_100", { subject: u18PostDeveloping(), phase: "TRANSITION" }));
      // 今度こそ population 側も MANUAL（UNMET の whenUnmet=MANUAL_WITH_REVIEW）。
      expect(findingCodes(coach)).toContain("ELIGIBILITY_MANUAL_REVIEW");
      expect(findingCodes(coach)).toContain("PHASE_AUTOGEN_BLOCKED");
    });

    it("phase=null（未評価）: phase に依存しない branch（ADVANCED tier）は MET のまま。phase 依存の branch しか無ければ PHASE_UNRESOLVED のまま（楽観昇格しない）", () => {
      // ADVANCED tier: phase を必要としない branch だけで成立するので、phase=null でも MET。
      expect(verdictFor(adultAdvanced(), null)).toBe("MET");
      const coachAdvancedNull = expectOk(plan("SPRINT_ENDURANCE_SHORT", "SES_100", { subject: adultAdvanced(), phase: null }));
      expect(findingCodes(coachAdvancedNull)).not.toContain("ELIGIBILITY_MANUAL_REVIEW");

      // DEVELOPMENTAL tier: 唯一使える branch（第2branch）が phase に依存するので、phase=null は
      // 「未評価」のまま（PREPARATION 等と推測して MET にしない）。
      expect(verdictFor(u18PostDeveloping(), null)).toBe("PHASE_UNRESOLVED");
      const aiDevNull = plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject: u18PostDeveloping(), actor: AI, phase: null });
      expect(aiDevNull.status).toBe("INELIGIBLE");
      if (aiDevNull.status === "INELIGIBLE") expect(aiDevNull.reasons.map((r) => r.code)).toContain("CONDITIONAL_AUTO_REQUIRES_PHASE");
      const coachDevNull = expectOk(plan("SPRINT_ENDURANCE_SHORT", "SES_80", { subject: u18PostDeveloping(), phase: null }));
      expect(findingCodes(coachDevNull)).toContain("ELIGIBILITY_MANUAL_REVIEW");
    });

    it("Case E: PRE / CIRCA / EFFECTIVE_UNKNOWN は R3 の既存 eligibility matrix のまま不変（SES POST 行の対象外）", () => {
      for (const ruleId of ["ELIG_SES_PRE", "ELIG_SES_EFFECTIVE_UNKNOWN", "ELIG_SES_CIRCA"]) {
        const row = ruleSet.eligibility.find((r) => r.ruleId === ruleId);
        expect(row, ruleId).toBeDefined();
        expect(row!.conditions.anyOf, ruleId).toBeNull();
        expect(row!.requiresPhaseEvaluation, ruleId).toBe(false);
      }
    });

    it("generic evaluator は SES 専用の分岐を持たない（conditionNote / ruleId のテキスト解析禁止）", () => {
      const source = fs
        .readFileSync(path.resolve(__dirname, "../../../src/domain/running/planning/eligibility.ts"), "utf-8")
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");
      expect(source).not.toMatch(/SPRINT_ENDURANCE_SHORT/);
      expect(source).not.toMatch(/ELIG_SES_POST/);
      expect(source).not.toMatch(/\.conditionNote\b/);
    });
  });

  it("T-AI-04: AI が TI_VITTORI_SE を DEVELOPMENTAL に提案 → INELIGIBLE", () => {
    const r = expectIneligible(plan("TEMPO_INTENSIVE", "TI_VITTORI_SE", { subject: u18PostDeveloping(), actor: AI }), "ADVANCED_ONLY_NOT_PERMITTED");
    expect(r.some((x) => x.ruleId === "ADVANCED_ONLY:TI_VITTORI_SE")).toBe(true);
  });

  it("T-POP-07: ASSISTED は AI では常に INELIGIBLE、U12/U15・非POST は override でも不可", () => {
    const edits = [
      { field: "buildUpM", value: 30, unit: "m" },
      { field: "flyZoneM", value: 20, unit: "m" },
      { field: "totalReps", value: 3, unit: "reps" },
      { field: "repRestS", value: 600, unit: "s" },
      { field: "intensityPercent", value: 102, unit: "percent" },
    ];
    // U18 POST ADVANCED + 実測 fly（HIGH）: COACH の手動候補
    const u18Adv = athlete({ birthDate: iso("2009-06-01"), marks: [FLY20_PHOTO] });
    expectOk(plan("ASSISTED_SPRINT", "AS_TOWING", { subject: u18Adv, coachEdits: edits }));
    expectIneligible(plan("ASSISTED_SPRINT", "AS_TOWING", { subject: u18Adv, actor: AI }), "AUTOGEN_NOT_ALLOWED_FOR_MANUAL_MODE");
    // vmax データ無しは手動候補にならない（override 不可）
    expectIneligible(plan("ASSISTED_SPRINT", "AS_TOWING", { subject: athlete({ birthDate: iso("2009-06-01") }), coachEdits: edits }), "ELIGIBILITY_CONDITIONS_UNMET");
    // U15 POST ADVANCED 相当でも override 不可
    const u15Adv = athlete({ birthDate: iso("2012-01-01"), marks: [FLY20_PHOTO] });
    const reasons = expectIneligible(
      plan("ASSISTED_SPRINT", "AS_TOWING", {
        subject: u15Adv,
        coachEdits: edits,
        overrides: [override({ kind: "ELIGIBILITY", ruleId: "CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE" })],
      }),
      "OVERRIDE_NOT_ALLOWED",
    );
    expect(reasons.some((r) => r.ruleId === "CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE")).toBe(true);
  });

  it("EligibilityRule.conditions（構造化データ）を conditionNote を読まずに評価する", () => {
    const row = ruleSet.eligibility.find((r) => r.ruleId === "ELIG_LONG_FULL_POST")!;
    const profileFor = (subject: Subject) => resolveSubjectProfile({ subject, asOf: iso(PLANNING_DATE), ruleSet });
    const ctx = (subject: Subject) => ({ profile: profileFor(subject), coachReference: null, vmaxConfidence: null });
    expect(eligibilityConditionsMet(row.conditions, ctx(adultAdvanced()))).toBe(true);
    expect(eligibilityConditionsMet(row.conditions, ctx(adultAdvanced({ primaryEvent: "100m" })))).toBe(false);
    expect(eligibilityConditionsMet(row.conditions, ctx(athlete({ trainingAge: { structuredSprintYears: 2 } })))).toBe(false);
  });

  it("GROUP: member の順序を入れ替えても結果が同じ（積集合）", () => {
    const members: GroupProfile["members"] = [
      { birthDate: iso("2012-03-01"), maturity: PRE_MEDIUM, trainingAge: { structuredSprintYears: 1 }, primaryEvent: "100m" },
      { birthDate: iso("2008-03-01"), maturity: POST_HIGH, trainingAge: { structuredSprintYears: 4 }, primaryEvent: "200m" },
    ];
    const group = (m: GroupProfile["members"]): Subject => ({ kind: "GROUP", profile: { label: "g", members: m, allowAdvancedMethods: false } });
    const a = plan("MAX_VELOCITY", "MV_FLY10", { subject: group(members), actor: AI });
    const b = plan("MAX_VELOCITY", "MV_FLY10", { subject: group([...members].reverse()), actor: AI });
    expect(a).toEqual(b);
    const p = expectOk(a);
    expect(p.confidence.inputData).toBe("LOW"); // GROUP は最大 LOW
    expect(p.intensity.target).toBeNull();
    expect(p.sets.value * p.repsPerSet.value).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Selection / LONG（#12〜#15, T-LSR-01, T-LSR-04）
// ---------------------------------------------------------------------------

describe("step 7: selection / LONG_SPRINT_RACE_SPECIFIC", () => {
  it("T-LSR-01: ADULT ADVANCED 400m・LSR_SPECIAL_ENDURANCE_I → recoveryStructure=FULL・SP_LSR_FULL", () => {
    const p = expectOk(
      plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", {
        coachReference: splitRef([[300, 36, 38]]),
        coachEdits: [{ field: "totalReps", value: 2, unit: "reps" }],
      }),
    );
    expect(p.recoveryStructure).toBe("FULL");
    expect(p.stopPolicyId).toBe("SP_LSR_FULL");
    expect(p.intensity.target).toEqual({ lower: 36, upper: 38, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" });
  });

  it("LONG INCOMPLETE: POST+ADVANCED+対象種目は SP_LSR_INCOMPLETE_ADV、条件外の手動 / override は SP_LSR_INCOMPLETE_STRICT", () => {
    const ref = splitRef([[300, 36, 38], [100, 13, 14]]);
    const adv = expectOk(plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", { coachReference: ref }));
    expect(adv.recoveryStructure).toBe("INCOMPLETE");
    expect(adv.stopPolicyId).toBe("SP_LSR_INCOMPLETE_ADV");
    expect(adv.rest.intraRepRestS).not.toBeNull();
    if (adv.rep.kind !== "SPLIT") throw new Error("expected SPLIT");
    expect(adv.rep.segments[0].restAfterS).toEqual(adv.rest.intraRepRestS);
    expect(adv.rep.segments[1].restAfterS).toBeNull();

    const sprinter = expectOk(plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", { coachReference: ref, subject: adultAdvanced({ primaryEvent: "100m" }) }));
    expect(sprinter.stopPolicyId).toBe("SP_LSR_INCOMPLETE_STRICT");

    const notAllowed = adultAdvanced({ allowAdvancedMethods: false });
    expectIneligible(plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", { coachReference: ref, subject: notAllowed }), "OVERRIDE_REQUIRED");
    const overridden = expectOk(
      plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", {
        coachReference: ref,
        subject: notAllowed,
        overrides: [override({ kind: "ELIGIBILITY", ruleId: "ADVANCED_ONLY:LSR_BROKEN_400" })],
      }),
    );
    expect(overridden.stopPolicyId).toBe("SP_LSR_INCOMPLETE_STRICT");
  });

  it("LONG は fallback を持たない: 参照（RACE_PACE / TARGET_SPLIT / 同距離 best）が無ければ INELIGIBLE", () => {
    expectIneligible(plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", { actor: AI }), "REFERENCE_UNAVAILABLE");
    expectIneligible(plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", { subject: adultAdvanced({ marks: [PB100_HAND] }) }), "REFERENCE_UNAVAILABLE");
    // 分割走は 2 区間以上の TARGET_SPLIT が必要
    expectIneligible(plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", { coachReference: splitRef([[400, 50, 52]]) }), "REFERENCE_UNAVAILABLE");
  });

  it("LONG の HIGH_METABOLIC は AI では LOW / POLICY_ONLY のとき自動生成しない", () => {
    const mark: TimedMark = { event: "400m", timeS: 50, date: iso("2026-07-01"), timing: "FAT" };
    expectIneligible(
      plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", { actor: AI, subject: adultAdvanced({ marks: [mark] }) }),
      "LOW_CONFIDENCE_HIGH_METABOLIC_AUTOGEN_BLOCKED",
    );
  });

  it("LONG RACE_PACE: 目標はコーチ入力をそのまま区間化し、表示距離は区間で出す", () => {
    const p = expectOk(
      plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_RACE_MODEL", {
        coachReference: { kind: "RACE_PACE", event: "400m", targetTimeS: { lower: 48, upper: 50, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } },
        coachEdits: [{ field: "repDurationS", value: 40, unit: "s" }, { field: "totalReps", value: 2, unit: "reps" }],
      }),
    );
    expect(p.intensity.target).toEqual({ lower: 48, upper: 50, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" });
    if (p.rep.kind !== "DURATION") throw new Error("expected DURATION");
    expect(p.rep.displayDistanceM.lower).toBe(Math.floor((40 * 400) / 50));
    expect(p.rep.displayDistanceM.upper).toBe(Math.ceil((40 * 400) / 48));
  });

  it("T-LSR-04: RunningPrescriptionSchema は LONG の recoveryStructure 欠落と、非 LONG の recoveryStructure を拒否する", () => {
    const long = expectOk(plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", { coachReference: splitRef([[300, 36, 38]]), coachEdits: [{ field: "totalReps", value: 2, unit: "reps" }] }));
    expect(runningPrescriptionSchema.safeParse(long).success).toBe(true);
    expect(runningPrescriptionSchema.safeParse({ ...long, recoveryStructure: null }).success).toBe(false);
    const acc = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping() }));
    expect(runningPrescriptionSchema.safeParse({ ...acc, recoveryStructure: "FULL" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Envelope（#16〜#17）
// ---------------------------------------------------------------------------

describe("step 8: envelope", () => {
  it("tier × template の Envelope を RuleSet のセルのまま使う（範囲を作らない）", () => {
    const p = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }) }));
    const env = selectEnvelope(ruleSet, { method: "MAX_VELOCITY", templateId: "MV_FLY20" }, "ADVANCED", null);
    if (!env.ok || p.rep.kind !== "FLY") throw new Error("setup");
    expect(p.rep.buildUpDistanceM.recommended).toEqual(env.envelope.fields.buildUpM?.recommended);
    expect(p.rep.buildUpDistanceM.coachEditable).toEqual(env.envelope.fields.buildUpM?.coachEditable);
    expect(validatePrescriptionAgainstRuleSet(p, ruleSet, EXPECTED_HASH)).toEqual([]);
  });

  it("Envelope が無い tier（DEVELOPMENTAL の TI_VITTORI_SE）は他 tier で代用せず ENVELOPE_INFEASIBLE", () => {
    const r = plan("TEMPO_INTENSIVE", "TI_VITTORI_SE", {
      subject: u18PostDeveloping({ allowAdvancedMethods: true, marks: [FLY20_PHOTO] }),
      overrides: [override({ kind: "ELIGIBILITY", ruleId: "ADVANCED_ONLY:TI_VITTORI_SE" })],
    });
    const f = expectBlocked(r, "ENVELOPE_INFEASIBLE");
    expect(f.find((x) => x.code === "ENVELOPE_INFEASIBLE")?.severity).toBe("BLOCK_AUTOGEN");
  });

  it("RESISTED の vdecPercent は分類 snapshot のみで、処方 target を作らない", () => {
    const p = expectOk(plan("RESISTED_SPRINT", "RS_SLED_MODERATE", { coachReference: { kind: "VELOCITY_DECREMENT", band: "MODERATE", measured: true } }));
    expect(p.intensity.target).toBeNull();
    expect(p.monitoringSnapshot.vdecClassificationPolicy?.bands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification: "LIGHT", upperPercent: 10, upperInclusive: false }),
        expect.objectContaining({ classification: "MODERATE", lowerPercent: 10, lowerInclusive: true, upperPercent: 15, upperInclusive: false }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Manual-only cells（#18〜#20）
// ---------------------------------------------------------------------------

describe("manual-only cells（recommended=null）", () => {
  const tiEdits = [
    { field: "repDistanceM", value: 150, unit: "m" },
    { field: "repsPerSet", value: 3, unit: "reps" },
    { field: "sets", value: 1, unit: "sets" },
    { field: "repRestS", value: 180, unit: "s" },
    { field: "intensityPercent", value: 85, unit: "percent" },
  ];

  it("TI_COACH_DEFINED: コーチ入力が無ければ MANUAL_INPUT_REQUIRED（0 を入れない）、AI は不可", () => {
    const subject = adultAdvanced({ marks: [FLY20_PHOTO] });
    expectBlocked(plan("TEMPO_INTENSIVE", "TI_COACH_DEFINED", { subject }), "MANUAL_INPUT_REQUIRED");
    expectBlocked(plan("TEMPO_INTENSIVE", "TI_COACH_DEFINED", { subject, coachEdits: tiEdits.filter((e) => e.field !== "intensityPercent") }), "MANUAL_INPUT_REQUIRED");
    expectIneligible(plan("TEMPO_INTENSIVE", "TI_COACH_DEFINED", { subject, actor: AI }), "AUTOGEN_NOT_ALLOWED_FOR_MANUAL_MODE");
    const p = expectOk(plan("TEMPO_INTENSIVE", "TI_COACH_DEFINED", { subject, coachEdits: tiEdits }));
    for (const fv of [p.sets, p.repsPerSet, p.rest.repRestS, p.rep.kind === "DISTANCE" ? p.rep.distanceM : null]) {
      expect(fv?.recommended).toBeNull();
      expect(fv?.position).toBeNull();
      expect(fv?.origin).toBe("COACH");
    }
  });

  it("ASSISTED: コーチ入力の FlyRep。decelerationM セルが無いので減速距離と合計は null（0 にしない）", () => {
    const subject = athlete({ birthDate: iso("2000-01-01"), marks: [FLY20_PHOTO] });
    const edits = [
      { field: "buildUpM", value: 30, unit: "m" },
      { field: "flyZoneM", value: 20, unit: "m" },
      { field: "totalReps", value: 3, unit: "reps" },
      { field: "repRestS", value: 600, unit: "s" },
      { field: "intensityPercent", value: 103, unit: "percent" },
    ];
    const p = expectOk(plan("ASSISTED_SPRINT", "AS_DOWNHILL", { subject, coachEdits: edits }));
    if (p.rep.kind !== "FLY") throw new Error("expected FLY");
    expect(p.rep.buildUpDistanceM).toMatchObject({ value: 30, recommended: null, position: null, origin: "COACH" });
    expect(p.rep.decelerationDistanceM).toBeNull();
    expect(p.rep.totalRunningDistanceM).toBeNull();
    expect(p.intensity.reference.kind).toBe("MEASURED_VMAX");
    expect(p.intensity.target).toMatchObject({ lower: 103, upper: 103, unit: "percent", source: "COACH_ENTERED" });
    expectBlocked(plan("ASSISTED_SPRINT", "AS_DOWNHILL", { subject, coachEdits: edits.slice(0, 4) }), "MANUAL_INPUT_REQUIRED");
  });

  it("EVENT_APPROACH_SPEED: approachDistanceM は recommended を持たないコーチ入力スカラー（plausibility ≤60m）", () => {
    const ref = { kind: "COACH_DEFINED", label: "本番の助走" };
    const p = expectOk(plan("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH", { coachReference: ref, coachEdits: [{ field: "approachDistanceM", value: 38, unit: "m" }] }));
    if (p.rep.kind !== "ATTEMPTS") throw new Error("expected ATTEMPTS");
    expect(p.rep.approach).toBe("FULL");
    expect(p.rep.approachDistanceM).toEqual({ value: 38, unit: "m", source: "COACH_ENTERED" });
    expect(p.exposure.nearMaxSprintVolumeM.upper).toBe(38 * p.repsPerSet.value);

    const far = expectOk(plan("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH", { coachReference: ref, coachEdits: [{ field: "approachDistanceM", value: 70, unit: "m" }] }));
    expect(far.findings).toContainEqual(expect.objectContaining({ code: "INPUT_PLAUSIBILITY_CONFIRM", severity: "REQUIRE_CONFIRMATION" }));

    const noApproach = expectBlocked(
      plan("EVENT_APPROACH_SPEED", "EA_JUMP_SHORT_APPROACH", { coachReference: ref }),
      "PLAUSIBILITY_NOT_DETERMINABLE",
    );
    expect(noApproach.find((f) => f.code === "PLAUSIBILITY_NOT_DETERMINABLE")?.plausibility).toMatchObject({
      ruleId: "PLA_ITEM_TOTAL_DISTANCE",
      certainty: "UNEVALUABLE",
    });

    expectIneligible(plan("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH", {}), "REFERENCE_UNAVAILABLE");
    expectBlocked(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping(), coachEdits: [{ field: "approachDistanceM", value: 30, unit: "m" }] }), "COACH_EDIT_NOT_APPLICABLE");
  });

  it("FieldValue schema: position（範囲内の位置）と origin（値の由来）を分離して検証する", () => {
    const m = (fv: Partial<FieldValue<"m">>) => ({
      value: 20,
      unit: "m",
      recommended: { min: 10, max: 30, unit: "m" },
      coachEditable: { min: 5, max: 40, unit: "m" },
      hardSafety: null,
      position: "MIDDLE",
      origin: "ENGINE_POSITIONED",
      evidenceIds: [],
      ...fv,
    });
    const s = (v: unknown) =>
      // FlyRep 経由で FieldValue<"m"> の refine を検証する
      runningApi.flyRepSchema.safeParse({
        kind: "FLY",
        buildUpDistanceM: v,
        flyZoneDistanceM: m({}),
        decelerationDistanceM: 20,
        totalRunningDistanceM: (v as { value: number }).value + 20 + 20,
        plannedHighSpeedExposureM: { lower: 20, upper: 40, unit: "m", source: "ESTIMATED", confidence: "LOW" },
      }).success;
    expect(s(m({}))).toBe(true);
    // position を持つのは ENGINE_POSITIONED だけ
    expect(s(m({ position: null }))).toBe(false);
    expect(s(m({ origin: "TEMPLATE_FIXED" }))).toBe(false);
    expect(s(m({ origin: "TEMPLATE_FIXED", position: null }))).toBe(true);
    expect(s(m({ origin: "SOLVER_DERIVED", position: null }))).toBe(true);
    expect(s(m({ origin: "SOLVER_DERIVED", position: null, value: 35 }))).toBe(false); // recommended 外
    expect(s(m({ origin: "TEMPLATE_FIXED", position: null, value: 35 }))).toBe(true); // 固定値は recommended 外もありうる（Finding）
    // recommended=null はコーチ入力だけ
    expect(s(m({ recommended: null }))).toBe(false);
    expect(s(m({ recommended: null, origin: "STRUCTURAL_FIXED", position: null }))).toBe(false);
    expect(s(m({ recommended: null, origin: "COACH", position: null }))).toBe(true);
    // coachEditable の外は COACH_OVERRIDE だけ
    expect(s(m({ value: 45, origin: "COACH", position: null }))).toBe(false);
    expect(s(m({ value: 45, origin: "COACH_OVERRIDE", position: null }))).toBe(true);
    expect(s({ ...m({}), editedBy: "ENGINE" })).toBe(true); // 余分なキーは Zod object が除去（型からは消えている）
  });
});

// ---------------------------------------------------------------------------
// Coach edits / overrides / hard safety（#21〜#24）
// ---------------------------------------------------------------------------

describe("coach edits / overrides / hard safety", () => {
  const subject = u18PostDeveloping(); // ACC DEV: repRestS recommended 120–180 / coachEditable 90–300

  it("recommended 外・coachEditable 内は OK + OUTSIDE_RECOMMENDED（WARN）", () => {
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject, coachEdits: [{ field: "repRestS", value: 250, unit: "s" }] }));
    expect(p.rest.repRestS).toMatchObject({ value: 250, position: null, origin: "COACH" });
    expect(p.findings).toContainEqual(expect.objectContaining({ code: "OUTSIDE_RECOMMENDED", severity: "WARN", metric: "repRestS" }));
  });

  it("coachEditable 外は CoachOverride 必須。override があれば COACH_OVERRIDE として反映", () => {
    expectBlocked(plan("ACCELERATION", "ACC_BLOCK_20", { subject, coachEdits: [{ field: "repRestS", value: 400, unit: "s" }] }), "COACH_EDITABLE_OVERRIDE_REQUIRED");
    const p = expectOk(
      plan("ACCELERATION", "ACC_BLOCK_20", {
        subject,
        overrides: [override({ kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" }, { newValue: 400, confirmedTwice: false })],
      }),
    );
    expect(p.rest.repRestS).toMatchObject({ value: 400, position: null, origin: "COACH_OVERRIDE" });
    expect(findingCodes(p)).toContain("COACH_OVERRIDE_APPLIED");
  });

  it("hardSafety=null のセルへの HARD_SAFETY override は対象不正（null を 0 や上限に読み替えない）", () => {
    expectBlocked(
      plan("ACCELERATION", "ACC_BLOCK_20", { subject, overrides: [override({ kind: "FIELD", field: "repRestS", layer: "HARD_SAFETY" }, { newValue: 400 })] }),
      "OVERRIDE_TARGET_INVALID",
    );
  });

  it("unit 不一致・Envelope に無い field・template 固定値の変更は BLOCKED", () => {
    expectBlocked(plan("ACCELERATION", "ACC_BLOCK_20", { subject, coachEdits: [{ field: "repRestS", value: 150, unit: "m" }] }), "COACH_EDIT_INVALID");
    expectBlocked(plan("ACCELERATION", "ACC_BLOCK_20", { subject, coachEdits: [{ field: "buildUpM", value: 20, unit: "m" }] }), "COACH_EDIT_NOT_APPLICABLE");
    expectBlocked(plan("ACCELERATION", "ACC_BLOCK_20", { subject, coachEdits: [{ field: "repDistanceM", value: 30, unit: "m" }] }), "TEMPLATE_FIXED_FIELD_EDIT");
    expectBlocked(plan("ACCELERATION", "ACC_BLOCK_20", { subject, coachEdits: [{ field: "sets", value: 1.5, unit: "sets" }] }), "COACH_EDIT_INVALID");
  });

  it("template 固定値が coachEditable 外（DEV の ACC_BLOCK_40）: AI は BLOCKED、COACH は override で確認", () => {
    expectBlocked(plan("ACCELERATION", "ACC_BLOCK_40", { subject, actor: AI }), "COACH_EDITABLE_OVERRIDE_REQUIRED");
    const p = expectOk(
      plan("ACCELERATION", "ACC_BLOCK_40", {
        subject,
        coachEdits: [{ field: "totalReps", value: 4, unit: "reps" }],
        overrides: [override({ kind: "FIELD", field: "repDistanceM", layer: "COACH_EDITABLE" }, { newValue: 40, confirmedTwice: false })],
      }),
    );
    if (p.rep.kind !== "DISTANCE") throw new Error("expected DISTANCE");
    expect(p.rep.distanceM).toMatchObject({ value: 40, origin: "COACH_OVERRIDE", position: null });
    expectBlocked(
      plan("ACCELERATION", "ACC_BLOCK_40", {
        subject,
        overrides: [override({ kind: "FIELD", field: "repDistanceM", layer: "COACH_EDITABLE" }, { newValue: 35, confirmedTwice: false })],
      }),
      "TEMPLATE_FIXED_FIELD_EDIT",
    );
  });

  it("コーチの sets×repsPerSet が総本数・総量の coachEditable を超えたら override 必須", () => {
    const r = plan("ACCELERATION", "ACC_BLOCK_20", {
      subject,
      coachEdits: [
        { field: "sets", value: 3, unit: "sets" },
        { field: "repsPerSet", value: 4, unit: "reps" },
      ],
    });
    expectBlocked(r, "COACH_EDITABLE_OVERRIDE_REQUIRED");
  });

  it("recheckHardSafety（汎用）: hardSafety 外は HARD_SAFETY override 必須、null は上限なし", () => {
    const fv = (value: number, hardSafety: { min: number; max: number } | null, origin: FieldValue<Unit>["origin"] = "COACH_OVERRIDE"): FieldValue<Unit> => ({
      value,
      unit: "s",
      recommended: { min: 100, max: 200, unit: "s" },
      coachEditable: { min: 50, max: 300, unit: "s" },
      hardSafety: hardSafety === null ? null : { ...hardSafety, unit: "s" },
      position: null,
      origin,
      evidenceIds: [],
    });
    const ceOverride = coachOverrideSchema.parse(override({ kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" }, { newValue: 500 }));
    const hsOverride = coachOverrideSchema.parse(override({ kind: "FIELD", field: "repRestS", layer: "HARD_SAFETY" }, { newValue: 500 }));
    expect(recheckHardSafety({ records: [{ field: "repRestS", fieldValue: fv(500, { min: 0, max: 400 }) }], overrides: [ceOverride], overriddenEligibilityRuleIds: [] }).map((f) => f.code)).toContain("HARD_SAFETY_VIOLATION");
    expect(recheckHardSafety({ records: [{ field: "repRestS", fieldValue: fv(500, { min: 0, max: 400 }) }], overrides: [hsOverride], overriddenEligibilityRuleIds: [] })).toEqual([]);
    expect(recheckHardSafety({ records: [{ field: "repRestS", fieldValue: fv(5000, null) }], overrides: [ceOverride], overriddenEligibilityRuleIds: [] })).toEqual([]);
    expect(recheckHardSafety({ records: [{ field: "repRestS", fieldValue: fv(500, null, "COACH") }], overrides: [], overriddenEligibilityRuleIds: [] }).map((f) => f.code)).toContain("COACH_EDITABLE_OVERRIDE_REQUIRED");
    expect(recheckHardSafety({ records: [], overrides: [], overriddenEligibilityRuleIds: ["ELIG_SES_PRE"] }).map((f) => f.code)).toContain("ELIGIBILITY_OVERRIDE_WITHOUT_RECORD");
  });
});

// ---------------------------------------------------------------------------
// Position / placement（#25〜#35）
// ---------------------------------------------------------------------------

describe("step 12: position & placement（§7.3, §9.3）", () => {
  it("position → 値（範囲内の位置指定）と丸め", () => {
    expect(placeValue({ min: 10, max: 20 }, "MIDDLE", "DISTANCE")).toBe(15);
    expect(placeValue({ min: 30, max: 60 }, "MIDDLE", "DISTANCE")).toBe(45); // 45 は 50m 未満なので 5m 単位
    expect(placeValue({ min: 30, max: 85 }, "MIDDLE", "DISTANCE")).toBe(50); // 57.5 → 50m 以上は 10m 単位で切り捨て
    expect(placeValue({ min: 80, max: 120 }, "MIDDLE", "DISTANCE")).toBe(100);
    expect(placeValue({ min: 15, max: 25 }, "LOWER_BOUND", "DISTANCE")).toBe(15);
    expect(placeValue({ min: 120, max: 180 }, "MIDDLE", "REST_SECONDS")).toBe(150);
    expect(placeValue({ min: 45, max: 120 }, "MIDDLE", "REST_SECONDS")).toBe(90); // 82.5 → 30秒単位で切り上げ
    expect(placeValue({ min: 45, max: 90 }, "MIDDLE", "REST_SECONDS")).toBe(90);
    expect(placeValue({ min: 30, max: 50 }, "MIDDLE", "REST_SECONDS")).toBe(45); // 40 → 15秒単位で切り上げ
    expect(placeValue({ min: 7, max: 12 }, "MIDDLE", "REP_DURATION_SECONDS")).toBe(9);
    expect(placeValue({ min: 4, max: 8 }, "LOWER_HALF", "COUNT")).toBe(5);
    expect(placeValue({ min: 4, max: 8 }, "MIDDLE", "COUNT")).toBe(6);
    expect(placeValue({ min: 3, max: 6 }, "UPPER_HALF", "COUNT")).toBe(5); // 5.25 → 四捨五入
    expect(placeValue({ min: 3, max: 6 }, "MIDDLE", "COUNT")).toBe(4); // 4.5 → 切り捨て
    expect(placeValue({ min: 1, max: 2 }, "LOWER_HALF", "COUNT")).toBe(1);
    expect(positionPoint({ min: 10, max: 20 }, "LOWER_HALF")).toBe(12.5);
  });

  it("位置は最も低いものを採用。preference LOWER=LOWER_HALF、confidence 上限 HIGH=なし/MODERATE=MIDDLE/LOW・POLICY_ONLY=LOWER_HALF", () => {
    expect(positionFromPreference("LOWER")).toBe("LOWER_HALF");
    expect(positionFromPreference("MIDDLE")).toBe("MIDDLE");
    expect(positionFromPreference(null)).toBe("MIDDLE");
    expect(positionCapForConfidence("HIGH")).toBeNull();
    expect(positionCapForConfidence("MODERATE")).toBe("MIDDLE");
    expect(positionCapForConfidence("LOW")).toBe("LOWER_HALF");
    expect(positionCapForConfidence("POLICY_ONLY")).toBe("LOWER_HALF");
    expect(lowestPosition("MIDDLE", null, "LOWER_HALF")).toBe("LOWER_HALF");
    expect(lowestPosition("MIDDLE", null, null)).toBe("MIDDLE");
  });

  it("§7.3 解決順: 総本数を reps 範囲×総量範囲の最大に → sets 最小 → repsPerSet 範囲内（ACC DEV 20m）", () => {
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject }));
    // confidence=MODERATE → MIDDLE: totalReps ≤ 6、総量 ≤ 110m → 20m×5 = 100m
    expect(p.confidence.prescription).toBe("MODERATE");
    expect(p.sets.value).toBe(1);
    expect(p.repsPerSet.value).toBe(5);
    expect(p.sets).toMatchObject({ origin: "SOLVER_DERIVED", position: null });
    if (p.rep.kind !== "DISTANCE") throw new Error("expected DISTANCE");
    expect(p.rep.distanceM).toMatchObject({ value: 20, position: null, origin: "TEMPLATE_FIXED" });
    expect(p.exposure.totalRunningDistanceM).toMatchObject({ lower: 100, upper: 100 });
  });
  const subject = u18PostDeveloping();

  it("positionPreference=LOWER は量だけを下げ、rest は短くしない", () => {
    const middle = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject, actor: AI, positionPreference: "MIDDLE" }));
    const lower = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject, actor: AI, positionPreference: "LOWER" }));
    expect(lower.sets.value * lower.repsPerSet.value).toBeLessThan(middle.sets.value * middle.repsPerSet.value);
    expect(lower.rest).toEqual(middle.rest);
    expect(lower.rest.repRestS.position).toBe("MIDDLE");
  });

  it("template 固定値は clamp しない（recommended 外は Finding）", () => {
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_10", { coachEdits: [{ field: "totalReps", value: 8, unit: "reps" }] }));
    if (p.rep.kind !== "DISTANCE") throw new Error("expected DISTANCE");
    expect(p.rep.distanceM.value).toBe(10); // ADV recommended 20–50 の外
    expect(findingCodes(p)).toContain("TEMPLATE_FIXED_OUTSIDE_RECOMMENDED");
    expect(p.sets.value * p.repsPerSet.value).toBe(8);
    expect(p.repsPerSet.value).toBeLessThanOrEqual(5); // repsPerSet recommended 3–5 に収めるため sets=2
  });

  it("MV_FLY20 は fly 20m、TE_200 は 200m を template から固定", () => {
    const mv = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }) }));
    if (mv.rep.kind !== "FLY") throw new Error("expected FLY");
    expect(mv.rep.flyZoneDistanceM).toMatchObject({ value: 20, position: null, origin: "TEMPLATE_FIXED" });
    const te = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { subject: adultAdvanced() }));
    if (te.rep.kind !== "DISTANCE") throw new Error("expected DISTANCE");
    expect(te.rep.distanceM.value).toBe(200);
  });

  it("解が無ければ ENVELOPE_INFEASIBLE（BLOCK_AUTOGEN）", () => {
    // ADV の ACC_BLOCK_10: 10m × 最大5本 = 50m < sessionVolumeM.recommended.min 100m
    const f = expectBlocked(plan("ACCELERATION", "ACC_BLOCK_10", { actor: AI }), "ENVELOPE_INFEASIBLE");
    expect(f.find((x) => x.code === "ENVELOPE_INFEASIBLE")?.severity).toBe("BLOCK_AUTOGEN");
  });

  it("R2 JSON の `reps≤N` 修飾子をエンジンの総本数上限に使う（数値は note から読む）", () => {
    // 本番 DEV の MV totalReps recommended は 2–3 のため修飾子が効かない。今回の
    // ENGINE_POLICY provenance による POLICY_ONLY/lower-half 制約と混同しないよう、
    // テスト用に十分広い範囲へ拡張した RuleSet で eligibility 上限を確認する。
    const widened: RuleSet = structuredClone(ruleSet);
    const mvDev = widened.envelopes.find((e) => e.method === "MAX_VELOCITY" && e.tier === "DEVELOPMENTAL")!;
    mvDev.fields.totalReps = { ...mvDev.fields.totalReps!, recommended: { min: 2, max: 20, unit: "reps" }, coachEditable: { min: 1, max: 20, unit: "reps" } };
    mvDev.fields.flyVolumeM = { ...mvDev.fields.flyVolumeM!, recommended: { min: 20, max: 200, unit: "m" }, coachEditable: { min: 10, max: 200, unit: "m" } };
    const req = makeRequest("MAX_VELOCITY", "MV_FLY10", { subject: u15Unknown(), actor: AI });
    const r = planRunningPrescriptionWithRuleSet(req, { ruleSet: widened, contentHash: "test", isDraftFallback: true });
    const p = expectOk(r);
    expect(p.sets.value * p.repsPerSet.value).toBeLessThanOrEqual(3);
    const post = expectOk(planRunningPrescriptionWithRuleSet(makeRequest("MAX_VELOCITY", "MV_FLY10", { subject: u18PostDeveloping({ marks: [FLY20_PHOTO] }), actor: AI }), { ruleSet: widened, contentHash: "test", isDraftFallback: true }));
    expect(post.sets.value * post.repsPerSet.value).toBeGreaterThan(3); // POST（note=null）には上限が付かない
  });
});

// ---------------------------------------------------------------------------
// Rest（#27〜#29）
// ---------------------------------------------------------------------------

describe("rest（§9.4）", () => {
  const subject = u18PostDeveloping();

  it("rest は Envelope から MIDDLE 以上で置き、LOW confidence でも短くしない", () => {
    const low = expectOk(plan("MAX_VELOCITY", "MV_FLY10", { subject: u15Unknown(), actor: AI }));
    expect(low.confidence.prescription === "LOW" || low.confidence.prescription === "POLICY_ONLY").toBe(true);
    expect(low.rest.repRestS.position).toBe("MIDDLE");
    expect(low.rest.repRestS.value).toBeGreaterThanOrEqual(positionPoint(low.rest.repRestS.recommended!, "MIDDLE"));
  });

  it("feasibility: availableMinutes null → UNKNOWN、mandatory rest だけで超過 → EXCEEDS_AVAILABLE_TIME（rest は変えない）、収まっても総所要時間は R4 で確定しないので UNKNOWN（OK と断定しない）", () => {
    const unknown = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject }));
    const short = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject, availableMinutes: 5 }));
    const enough = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject, availableMinutes: 60 }));
    expect(unknown.rest.feasibility).toBe("UNKNOWN");
    expect(short.rest.feasibility).toBe("EXCEEDS_AVAILABLE_TIME");
    expect(short.findings).toContainEqual(expect.objectContaining({ code: "REST_INFEASIBLE_FOR_PRACTICE", severity: "WARN" }));
    expect(enough.rest.feasibility).toBe("UNKNOWN");
    expect(short.rest.repRestS).toEqual(unknown.rest.repRestS);
    expect(short.sets.value * short.repsPerSet.value).toBe(unknown.sets.value * unknown.repsPerSet.value);
    expect(short.rest.displayAsFloor).toBe(true);
  });

  it("regression: planning に距離×秒・10m=60秒・時間×係数・年齢/性別/期分けの係数が無い", () => {
    for (const { file, code } of readSources("planning")) {
      expect(code, file).not.toMatch(/10\s*m\s*=\s*60/);
      expect(code, file).not.toMatch(/distance\w*\s*\*\s*\d/i);
      expect(code, file).not.toMatch(/\bRest\w*\s*=\s*[^;]*distance/i);
      expect(code, file).not.toMatch(/\*\s*60\b/);
      expect(code, file).not.toMatch(/\*\s*0\.\d/); // ×0.6 / ×0.8 等の範囲・量への係数
      expect(code, file).not.toMatch(/sexForNorms/);
      // [R7] phase は正式に接続されたが、build.ts は文字列比較の switch を持たず
      // resolveCompetitionAndPhase（competition/phase.ts の generic resolver）へ丸ごと渡すだけ。
      expect(code, file).not.toMatch(/phase\s*===\s*"(PREPARATION|PRE_COMPETITION|COMPETITION|TRANSITION)"/);
    }
  });

  it("regression: 範囲へ係数を掛けない（Envelope の recommended と FieldValue.recommended が常に一致）", () => {
    for (const pref of [null, "LOWER"] as const) {
      const p = expectOk(plan("STRIDE", "ST_WARMUP", { subject, actor: AI, positionPreference: pref }));
      expect(validatePrescriptionAgainstRuleSet(p, ruleSet, EXPECTED_HASH)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Individualization（#36〜#45, T-MISS-01〜03）
// ---------------------------------------------------------------------------

describe("step 9: individualization", () => {
  it("T-MISS-03: FLY20 PHOTO_CELL 2.00秒（45日前）→ v=10.0 m/s・区間 [20/2.05, 20/1.95]、TE 目標タイムを区間で出す", () => {
    const subject = adultAdvanced({ marks: [FLY20_PHOTO] });
    const mv = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { subject }));
    expect(mv.intensity.reference.kind).toBe("FLY_SPLIT");
    expect(mv.intensity.target).toBeNull();

    const te = expectOk(plan("TEMPO_EXTENSIVE", "TE_100", { subject }));
    if (te.intensity.reference.kind !== "MEASURED_VMAX") throw new Error("expected MEASURED_VMAX");
    expect(te.intensity.reference.vmax.valueMps).toBeCloseTo(10.0, 10);
    expect(te.intensity.reference.vmax.lowerMps).toBeCloseTo(20 / 2.05, 10);
    expect(te.intensity.reference.vmax.upperMps).toBeCloseTo(20 / 1.95, 10);
    // 1本の目標 = distance / (v × p)、p = 60–70%。下端は切り捨て・上端は切り上げ（0.01秒）
    const fastest = Math.floor((100 / ((20 / 1.95) * 0.7)) * 100) / 100;
    const slowest = Math.ceil((100 / ((20 / 2.05) * 0.6)) * 100) / 100;
    expect(te.intensity.target).toEqual({ lower: fastest, upper: slowest, unit: "s", source: "ESTIMATED", confidence: "HIGH" });
  });

  it("HAND 計時由来の目標は 0.1 秒単位で外側に丸める", () => {
    const hand: TimedMark = { event: "FLY20", timeS: 2.0, date: iso("2026-08-01"), timing: "HAND" };
    const te = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { subject: adultAdvanced({ marks: [hand] }) }));
    const target = te.intensity.target!;
    expect(target.lower as number).toBeLessThanOrEqual(200 / ((20 / 1.75) * 0.7));
    expect(target.upper as number).toBeGreaterThanOrEqual(200 / ((20 / 2.25) * 0.6));
    expect(Math.round((target.lower as number) * 10)).toBeCloseTo((target.lower as number) * 10, 9);
    expect(Math.round((target.upper as number) * 10)).toBeCloseTo((target.upper as number) * 10, 9);
    expect(te.confidence.inputData).toBe("LOW");
  });

  it("T-MISS-01: 100m PB（HAND）だけ → MV は MAX_INTENT（LOW）、TE は RELAXED_SUBMAX（数値目標なし・LOWER_HALF + REVIEW）、LONG は INELIGIBLE、Vmax を作らない", () => {
    const adv = adultAdvanced({ marks: [PB100_HAND] });
    const mv = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { subject: adv }));
    expect(mv.intensity).toEqual({ reference: { kind: "MAX_INTENT" }, target: null });
    expect(mv.confidence).toMatchObject({ prescription: "LOW", inputData: "LOW" });
    if (mv.rep.kind !== "FLY") throw new Error("expected FLY");
    expect(mv.rep.buildUpDistanceM.position).toBe("LOWER_HALF");
    expect(findingCodes(mv)).toContain("CONFIDENCE_LOW");

    const teAdv = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { subject: adv }));
    expect(teAdv.intensity).toEqual({ reference: { kind: "RELAXED_SUBMAX" }, target: null });
    expect(teAdv.confidence.prescription).toBe("LOW");
    const teDev = expectOk(plan("TEMPO_EXTENSIVE", "TE_100", { subject: u18PostDeveloping({ marks: [PB100_HAND] }) }));
    expect(teDev.intensity.target).toBeNull();
    // DEV の TE は使ったセルがすべて ENGINE_POLICY（intensityPercent を使わないため）→ POLICY_ONLY（LOW と同じ挙動）
    expect(teDev.confidence.prescription).toBe("POLICY_ONLY");
    for (const p of [teAdv, teDev]) {
      expect(p.findings.some((f) => f.severity === "REQUIRE_COACH_REVIEW")).toBe(true);
    }

    expectIneligible(plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", { subject: adv }), "REFERENCE_UNAVAILABLE");
    for (const p of [mv, teAdv, teDev]) expect(JSON.stringify(p)).not.toContain("MEASURED_VMAX");
  });

  it("T-MISS-02: vmax なし・fly 記録なし → MV の露出は FLY_ZONE 区間（ESTIMATED）、target=null、confidence LOW", () => {
    const p = expectOk(plan("MAX_VELOCITY", "MV_FLY20"));
    if (p.rep.kind !== "FLY") throw new Error("expected FLY");
    const n = p.sets.value * p.repsPerSet.value;
    const fly = p.rep.flyZoneDistanceM.value;
    const build = p.rep.buildUpDistanceM.value;
    expect(p.exposure.plannedHighSpeedExposureM).toEqual({ lower: fly * n, upper: (fly + build) * n, unit: "m", source: "ESTIMATED", confidence: "LOW" });
    expect(p.intensity.target).toBeNull();
    expect(p.confidence.prescription).toBe("LOW");
  });

  it("SAME_DISTANCE_BEST: 同じ距離の記録だけを使い best / p で区間化。100m PB は TE_100 の同距離 best にしない（R3 方針）", () => {
    const mark200: TimedMark = { event: "200m", timeS: 25.0, date: iso("2026-07-01"), timing: "FAT" };
    const te = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { subject: adultAdvanced({ marks: [mark200] }) }));
    expect(te.intensity.reference.kind).toBe("SAME_DISTANCE_BEST");
    expect(te.intensity.target).toEqual({ lower: Math.floor((25 / 0.7) * 100) / 100, upper: Math.ceil((25 / 0.6) * 100) / 100, unit: "s", source: "ESTIMATED", confidence: "HIGH" });
    const te300 = expectOk(plan("TEMPO_EXTENSIVE", "TE_300", { subject: adultAdvanced({ marks: [mark200] }) }));
    expect(te300.intensity.reference.kind).toBe("RELAXED_SUBMAX");
    const te100 = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { subject: adultAdvanced({ marks: [{ ...PB100_HAND, timing: "FAT" }] }) }));
    expect(te100.intensity.reference.kind).toBe("RELAXED_SUBMAX");
  });

  it("GROUP では目標タイムを出さない（inputData 最大 LOW）", () => {
    const group: Subject = {
      kind: "GROUP",
      profile: {
        label: "g",
        members: [{ birthDate: iso("1999-01-01"), maturity: POST_HIGH, trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" }, primaryEvent: "200m" }],
        allowAdvancedMethods: false,
      },
    };
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { subject: group, actor: AI }));
    expect(p.intensity).toEqual({ reference: { kind: "RELAXED_SUBMAX" }, target: null });
    expect(p.confidence.inputData).toBe("LOW");
  });

  it("RESISTED: 実測 vdec は MEDIUM、未実測は LOW、コーチ入力なしは MAX_INTENT fallback（LOW）、HILL は MAX_INTENT（NOT_REQUIRED）、HEAVY は実測必須", () => {
    const light = (ref: unknown) => plan("RESISTED_SPRINT", "RS_SLED_LIGHT", { coachReference: ref });
    expect(expectOk(light({ kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true })).confidence.inputData).toBe("MEDIUM");
    const unmeasured = expectOk(light({ kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: false }));
    expect(unmeasured.confidence.inputData).toBe("LOW");
    expect(unmeasured.intensity.target).toBeNull();
    expect(unmeasured.monitoringSnapshot.vdecClassificationPolicy?.bands).toEqual(expect.any(Array));
    const fallback = expectOk(light(null));
    expect(fallback.intensity).toEqual({ reference: { kind: "MAX_INTENT" }, target: null });
    expect(fallback.confidence.inputData).toBe("LOW");
    const hill = expectOk(plan("RESISTED_SPRINT", "RS_HILL_SHORT", {}));
    expect(hill.intensity.reference.kind).toBe("MAX_INTENT");
    expect(hill.confidence.inputData).toBe("NOT_REQUIRED");
    expectBlocked(plan("RESISTED_SPRINT", "RS_HILL_SHORT", { coachReference: { kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true } }), "COACH_REFERENCE_INVALID");
    expectBlocked(light({ kind: "VELOCITY_DECREMENT", band: "MODERATE", measured: true }), "COACH_REFERENCE_INVALID");
    expectIneligible(plan("RESISTED_SPRINT", "RS_SLED_HEAVY", { coachReference: { kind: "VELOCITY_DECREMENT", band: "HEAVY", measured: false } }), "ELIGIBILITY_CONDITIONS_UNMET");
    expectOk(plan("RESISTED_SPRINT", "RS_SLED_HEAVY", { coachReference: { kind: "VELOCITY_DECREMENT", band: "HEAVY", measured: true } }));
  });

  it("MethodMeta で許可されない coachReference は BLOCKED（MV に RACE_PACE）", () => {
    expectBlocked(
      plan("MAX_VELOCITY", "MV_FLY20", {
        coachReference: { kind: "RACE_PACE", event: "100m", targetTimeS: { lower: 11, upper: 12, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } },
      }),
      "COACH_REFERENCE_INVALID",
    );
  });
});

// ---------------------------------------------------------------------------
// Confidence（#46〜#53, T-POP-06, T-EV-02）
// ---------------------------------------------------------------------------

describe("step 10: confidence", () => {
  it("T-POP-06: elite（ADULT・coachAssignedTier=ADVANCED・PHOTO_CELL fly）→ tier=ADVANCED・MV envelope は ADV 値・confidence ≤ MODERATE", () => {
    const p = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }) }));
    expect(p.tier).toBe("ADVANCED");
    if (p.rep.kind !== "FLY") throw new Error("expected FLY");
    expect(p.rep.buildUpDistanceM.recommended).toEqual({ min: 30, max: 60, unit: "m" });
    expect(p.confidence.prescription).not.toBe("HIGH");
    expect(p.confidence.prescription).toBe("MODERATE");
  });

  it("[R7] plannedAt が無ければ history の中身に関わらず NOT_EVALUATED（中立）", () => {
    // plannedAt が無いので、history の内容（48h 以内の HIGH event 等）があっても weekly は評価しない
    // （厳密な 48h/72h window を計算できないため。§12 [R7 errata]）。
    const history = {
      events: [
        {
          at: "2026-09-13T10:00:00+09:00",
          category: "RUNNING_HIGH_INTENSITY",
          method: "MAX_VELOCITY",
          templateId: null,
          sessionKey: "s1",
          intensityTag: "HIGH",
          magnitude: {},
          source: "SESSION_RECORD",
          completion: "DONE",
        },
      ],
      coverage72h: "COMPLETE",
      coverage7d: "COMPLETE",
      coverage28d: "COMPLETE",
      dailyActivity7d: [],
    };
    const withNull = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping() }));
    const withHistory = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping(), history }));
    expect(withHistory).toEqual(withNull);
    expect(findingCodes(withNull)).toContain("WEEKLY_CONTEXT_NOT_EVALUATED");
    // R1 の導出関数でも NOT_EVALUATED は NONE（LOW 条件）として扱わない
    const summary = [{ sourceType: "COACHING_BEST_PRACTICE" as const, verification: "PRIMARY_CHECKED" as const, directness: "DIRECT" as const }];
    expect(derivePrescriptionConfidence({ usedEvidence: summary, inputDataConfidence: "HIGH", historyCoverage72h: "NOT_EVALUATED" })).toBe("HIGH");
    expect(derivePrescriptionConfidence({ usedEvidence: summary, inputDataConfidence: "HIGH", historyCoverage72h: "NONE" })).toBe("LOW");
  });

  it("[R4 provisional policy] performanceLevel: TRAINED/ADVANCED→TRAINED、BEGINNER/DEVELOPING→YOUTH_DEVELOPING（ELITE にしない）", () => {
    expect(performanceLevelForTrainingAge("ADVANCED")).toBe("TRAINED");
    expect(performanceLevelForTrainingAge("TRAINED")).toBe("TRAINED");
    expect(performanceLevelForTrainingAge("DEVELOPING")).toBe("YOUTH_DEVELOPING");
    expect(performanceLevelForTrainingAge("BEGINNER")).toBe("YOUTH_DEVELOPING");
  });

  it("ageBand UNKNOWN / EFFECTIVE_UNKNOWN はありうる context すべてで評価する（最弱を採用）", () => {
    const req = makeRequest("TEMPO_EXTENSIVE", "TE_200", { subject: athlete({ birthDate: null, maturity: UNKNOWN_LOW }) });
    const profile = resolveSubjectProfile({ subject: req.subject, asOf: req.planningDate, ruleSet });
    const contexts = directnessContexts(req, profile);
    expect(new Set(contexts.map((c) => c.ageBand))).toEqual(new Set(["U12", "U15", "U18", "ADULT"]));
    expect(new Set(contexts.map((c) => c.maturity))).toEqual(new Set(["PRE", "CIRCA", "POST", "UNKNOWN"]));
  });

  it("T-EV-02: confidence=LOW → 量は LOWER_HALF 以下、REQUIRE_COACH_REVIEW、HIGH_METABOLIC は AI で自動生成しない", () => {
    const p = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { subject: adultAdvanced({ marks: [PB100_HAND] }) }));
    expect(p.confidence.prescription).toBe("LOW");
    const env = selectEnvelope(ruleSet, { method: "MAX_VELOCITY", templateId: "MV_FLY20" }, "ADVANCED", null);
    if (!env.ok || p.rep.kind !== "FLY") throw new Error("setup");
    expect(p.rep.buildUpDistanceM.position).toBe("LOWER_HALF");
    expect(p.sets.value * p.repsPerSet.value).toBeLessThanOrEqual(placeValue(env.envelope.fields.totalReps!.recommended!, "LOWER_HALF", "COUNT"));
    expect(p.findings).toContainEqual(expect.objectContaining({ code: "CONFIDENCE_LOW", severity: "REQUIRE_COACH_REVIEW" }));
    expect(ruleSet.methods.find((m) => m.method === "LONG_SPRINT_RACE_SPECIFIC")?.loadClass).toBe("HIGH_METABOLIC");
  });

  it("POLICY_ONLY は REQUIRE_COACH_REVIEW + 暫定ルール表示", () => {
    const p = expectOk(plan("RESISTED_SPRINT", "RS_HILL_SHORT", {}));
    expect(p.confidence.prescription).toBe("POLICY_ONLY");
    expect(p.confidence.directness).toBe("NOT_APPLICABLE");
    expect(findingCodes(p)).toEqual(expect.arrayContaining(["CONFIDENCE_POLICY_ONLY", "PROVISIONAL_RULE_ONLY"]));
  });
});

// ---------------------------------------------------------------------------
// STRIDE（T-STR-01, T-STR-03）
// ---------------------------------------------------------------------------

describe("STRIDE", () => {
  it("T-STR-01: 流し 100m × 4 → RELAXED_SUBMAX・数値%なし・target=null・露出 0（RULE_DEFINITION）", () => {
    const p = expectOk(
      plan("STRIDE", "ST_RELAXED", {
        subject: u15Unknown(),
        coachEdits: [
          { field: "repDistanceM", value: 100, unit: "m" },
          { field: "repsPerSet", value: 4, unit: "reps" },
        ],
      }),
    );
    expect(p.method).toBe("STRIDE");
    if (p.rep.kind !== "DISTANCE") throw new Error("expected DISTANCE");
    expect(p.rep.distanceM.value).toBe(100);
    expect(p.sets.value * p.repsPerSet.value).toBe(4);
    expect(p.intensity).toEqual({ reference: { kind: "RELAXED_SUBMAX" }, target: null });
    expect(JSON.stringify(p)).not.toContain("intensityPercent");
    expect(p.exposure.plannedHighSpeedExposureM).toEqual({ lower: 0, upper: 0, unit: "m", source: "RULE_DEFINITION", confidence: "HIGH" });
    expect(p.exposure.nearMaxSprintVolumeM).toEqual({ lower: 0, upper: 0, unit: "m", source: "RULE_DEFINITION", confidence: "HIGH" });
  });

  it("T-STR-03: STRIDE は ACCELERATION / MAX_INTENT にならない（全 template・全 actor）", () => {
    for (const templateId of ["ST_WARMUP", "ST_RELAXED", "ST_BETWEEN_SETS"]) {
      for (const actor of [COACH, AI, SYSTEM]) {
        const p = expectOk(plan("STRIDE", templateId, { subject: u12Pre(), actor }));
        expect(p.method).toBe("STRIDE");
        expect(p.intensity.reference.kind).toBe("RELAXED_SUBMAX");
        expect(p.intensity.target).toBeNull();
        expect(p.stopPolicyId).toBe("SP_STRIDE");
        // STRIDE の総量は STRIDE Envelope（≤480m）から。TE の 1000–2000m を使わない
        expect(p.exposure.totalRunningDistanceM.upper as number).toBeLessThanOrEqual(480);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Exposure（#54〜#58）
// ---------------------------------------------------------------------------

describe("exposure（項目単位）", () => {
  it("FlyRep: total = build + fly + decel、項目の総走行距離には decel を含めない", () => {
    const p = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }) }));
    if (p.rep.kind !== "FLY") throw new Error("expected FLY");
    const { buildUpDistanceM: b, flyZoneDistanceM: f, decelerationDistanceM: d } = p.rep;
    expect(p.rep.totalRunningDistanceM).toBe(b.value + f.value + (d as number));
    const n = p.sets.value * p.repsPerSet.value;
    expect(p.exposure.totalRunningDistanceM).toMatchObject({ lower: (b.value + f.value) * n, upper: (b.value + f.value) * n });
    expect(p.rep.plannedHighSpeedExposureM).toMatchObject({ lower: f.value, upper: f.value + b.value, source: "ESTIMATED" });
  });

  it("ACCELERATION（DISTANCE_MINUS_ACCEL_INTERVAL）: 加速距離の数値を持たないので下端は null（0 にしない）", () => {
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping() }));
    const n = p.sets.value * p.repsPerSet.value;
    expect(p.exposure.plannedHighSpeedExposureM).toEqual({ lower: null, upper: 20 * n, unit: "m", source: "ESTIMATED", confidence: "LOW" });
    expect(p.exposure.nearMaxSprintVolumeM).toMatchObject({ lower: 20 * n, upper: 20 * n, source: "PLANNED" });
  });

  it("SPRINT_ENDURANCE_SHORT: 一次軸は時間（DURATION）、表示距離は template から", () => {
    const p = expectOk(plan("SPRINT_ENDURANCE_SHORT", "SES_100", {}));
    if (p.rep.kind !== "DURATION") throw new Error("expected DURATION");
    expect(p.rep.durationS.unit).toBe("s");
    expect(p.rep.displayDistanceM).toEqual({ lower: 100, upper: 100, unit: "m", source: "RULE_DEFINITION", confidence: "MEDIUM" });
    expect(p.exposure.plannedHighSpeedExposureM.lower).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rationale（#60〜#63）
// ---------------------------------------------------------------------------

describe("rationale（日本語レンダラ）", () => {
  const INTERNAL_KEYS = /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\b(ACCELERATION|STRIDE|DEVELOPMENTAL|ADVANCED|MODERATE|POLICY_ONLY|RELAXED_SUBMAX|DIRECT|PARTIAL|INDIRECT|FULL|INCOMPLETE|DRAFT|HIGH|LOW|MIDDLE)\b/;

  const samples: [string, PlanResult][] = [
    ["ACC DEV", plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping(), availableMinutes: 5 })],
    ["MV fly", plan("MAX_VELOCITY", "MV_FLY20", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }) })],
    ["TE vmax", plan("TEMPO_EXTENSIVE", "TE_100", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }) })],
    ["TE low", plan("TEMPO_EXTENSIVE", "TE_100", { subject: u18PostDeveloping(), positionPreference: "LOWER" })],
    ["LSR full", plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", { coachReference: splitRef([[300, 36, 38]]), coachEdits: [{ field: "totalReps", value: 2, unit: "reps" }] })],
    ["LSR incomplete", plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", { coachReference: splitRef([[300, 36, 38], [100, 13, 14]]) })],
    ["STRIDE", plan("STRIDE", "ST_RELAXED", { subject: u15Unknown() })],
    ["RS vdec", plan("RESISTED_SPRINT", "RS_SLED_LIGHT", { coachReference: { kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true } })],
    ["EA", plan("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH", { coachReference: { kind: "COACH_DEFINED", label: "助走" }, coachEdits: [{ field: "approachDistanceM", value: 38, unit: "m" }] })],
    ["ACC override", plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping(), overrides: [override({ kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" }, { newValue: 400, confirmedTwice: false })] })],
    ["MV_FLY10 youth", plan("MAX_VELOCITY", "MV_FLY10", { subject: u15Unknown() })],
  ];

  it("rationale は RationaleLine（code + params）で、レンダリング結果に内部 enum キーが出ない", () => {
    for (const [label, r] of samples) {
      const p = expectOk(r);
      expect(p.rationale.length, label).toBeGreaterThan(5);
      const lines = renderRationaleJa(p.rationale);
      for (const line of lines) {
        expect(line, `${label}: ${line}`).not.toMatch(INTERNAL_KEYS);
        expect(line).not.toContain("rs-2026");
        expect(line).not.toContain("undefined");
        expect(line).not.toContain("NaN");
      }
    }
  });

  it("tier・template・根拠・位置・参照・confidence・rest・コーチ入力・暫定ルールを説明する", () => {
    const acc = expectOk(samples[0][1]);
    const codes = acc.rationale.map((l) => l.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "RULESET_DRAFT",
        "TEMPLATE_SELECTED",
        "TIER",
        "ELIGIBILITY",
        "ENVELOPE_EVIDENCE",
        "POSITION",
        "REFERENCE",
        "CONFIDENCE",
        "REST_FROM_ENVELOPE",
        "REST_NOT_SHORTENED",
        "REST_EXCEEDS_AVAILABLE_TIME",
        "STOP_POLICY",
      ]),
    );
    const override = expectOk(samples[9][1]);
    expect(override.rationale.map((l) => l.code)).toContain("COACH_OVERRIDE_APPLIED");
    const text = renderRationaleJa(acc.rationale).join("\n");
    expect(text).toContain("暫定");
    expect(text).toContain("レスト");
  });

  it("未知のコードも内部キーを出さない", () => {
    expect(renderRationaleJa([{ code: "SOME_FUTURE_CODE", params: { x: "LOWER_HALF" } }])[0]).not.toMatch(INTERNAL_KEYS);
  });
});

// ---------------------------------------------------------------------------
// AI boundary / generatedBy / result shape（#64〜#68）
// ---------------------------------------------------------------------------

describe("AI boundary / generatedBy", () => {
  it("generatedBy は actor を反映する（AI を数値の作者として COACH に見せない）", () => {
    const subject = u18PostDeveloping();
    expect(expectOk(plan("STRIDE", "ST_WARMUP", { subject })).generatedBy).toEqual({ proposer: { kind: "ENGINE" }, createdByCoach: true, acceptedByCoachAt: null });
    expect(expectOk(plan("STRIDE", "ST_WARMUP", { subject, actor: AI })).generatedBy).toEqual({
      proposer: { kind: "AI_PLANNER", provider: "test-provider", model: "test-model", requestId: "req-1" },
      createdByCoach: false,
      acceptedByCoachAt: null,
    });
    expect(expectOk(plan("STRIDE", "ST_WARMUP", { subject, actor: SYSTEM })).generatedBy).toEqual({ proposer: { kind: "ENGINE" }, createdByCoach: false, acceptedByCoachAt: null });
  });

  it("OK の sessionFindings は空（R6 未接続）、readinessApplied も空（R5 未接続）", () => {
    const r = plan("STRIDE", "ST_WARMUP", { subject: u18PostDeveloping() });
    if (r.status !== "OK") throw new Error("expected OK");
    expect(r.sessionFindings).toEqual([]);
    expect(r.prescription.readinessApplied).toEqual([]);
  });

  it("[R7] phase は dose の位置だけを動かす。intensity reference・rest 下限・hard stop 系は不変", () => {
    const results = ["PREPARATION", "PRE_COMPETITION", "COMPETITION", "TRANSITION"].map((phase) => ({
      phase,
      r: plan("TEMPO_EXTENSIVE", "TE_200", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }), phase }),
    }));
    const baseline = plan("TEMPO_EXTENSIVE", "TE_200", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }), phase: null });
    if (baseline.status !== "OK") throw new Error("setup");
    for (const { phase, r } of results) {
      if (r.status !== "OK") continue; // 低い位置で ENVELOPE_INFEASIBLE になるのは正しい副作用（別途 competition.test.ts で検証）
      expect(r.prescription.intensity.reference, phase).toEqual(baseline.prescription.intensity.reference);
      expect(r.prescription.rest.repRestS.value, phase).toBeGreaterThanOrEqual(baseline.prescription.rest.repRestS.recommended!.min);
      expect(r.prescription.stopPolicyId, phase).toBe(baseline.prescription.stopPolicyId);
      expect(r.prescription.tier, phase).toBe(baseline.prescription.tier);
    }
  });
});

// ---------------------------------------------------------------------------
// Public API（#85）
// ---------------------------------------------------------------------------

describe("public API", () => {
  it("root index は planRunningPrescription と [R10-B1] planRunningPrescriptionWithRuleSet だけを追加し、各 step の内部関数を export しない", () => {
    const api = runningApi as Record<string, unknown>;
    expect(typeof api.planRunningPrescription).toBe("function");
    // [R10-B1] RuleSet を明示して計画する production API（§16）へ昇格した（テスト専用から変更）。
    expect(typeof api.planRunningPrescriptionWithRuleSet).toBe("function");
    for (const internal of [
      "selectEnvelope",
      "placeValue",
      "individualize",
      "resolvePlanningReference",
      "derivePlanningConfidence",
      "validateSelection",
      "buildPrescription",
      "planWithResolvedRuleSet",
      "evaluateEligibility",
      "recheckHardSafety",
      "renderRationaleJa",
      "planRequestSchema",
      "selectActiveRuleSet",
    ]) {
      expect(api[internal], internal).toBeUndefined();
    }
  });

  it("位置の型（PlacedPosition）は4値", () => {
    const positions: PlacedPosition[] = ["LOWER_BOUND", "LOWER_HALF", "MIDDLE", "UPPER_HALF"];
    expect(positions).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// R4 pre-commit correction: 人間向け文字列・ID 命名を実行ロジックにしない
// ---------------------------------------------------------------------------

describe("R4 correction: structured rule logic（conditionNote / ID / 名前を解析しない）", () => {
  const resolved = (rs: RuleSet) => ({ ruleSet: rs, contentHash: EXPECTED_HASH, isDraftFallback: true });
  const subjects: [string, Subject][] = [
    ["u15Unknown", u15Unknown()],
    ["u18PostDeveloping", u18PostDeveloping()],
    ["adultAdvancedMeasured", adultAdvanced({ marks: [FLY20_PHOTO, { event: "400m", timeS: 50, date: iso("2026-07-01"), timing: "FAT" }] })],
  ];

  function sweep(rs: RuleSet): PlanResult[] {
    const out: PlanResult[] = [];
    for (const t of ruleSet.templates) {
      for (const [, subject] of subjects) {
        for (const actor of [COACH, AI] as const) {
          out.push(planRunningPrescriptionWithRuleSet(makeRequest(t.method, t.id, { subject, actor }), resolved(rs)));
        }
      }
    }
    return out;
  }

  it("conditionNote の文章をすべて書き換えても、全 template × 代表 subject × actor の結果が完全に同じ", () => {
    const mutated: RuleSet = structuredClone(ruleSet);
    for (const row of mutated.eligibility) row.conditionNote = row.conditionNote === null ? null : "（説明文だけを書き換えたテスト）";
    const baseline = sweep(ruleSet);
    expect(sweep(mutated)).toEqual(baseline);
    expect(baseline.filter((r) => r.status === "OK").length).toBeGreaterThan(20);
  });

  it("EligibilityRule / StopPolicy / PlausibilityRule の id を rename しても判断は同じ（id は参照にだけ使う）", () => {
    const renamed: RuleSet = structuredClone(ruleSet);
    for (const row of renamed.eligibility) row.ruleId = `RENAMED_${row.ruleId.length}_${renamed.eligibility.indexOf(row)}`;
    const idMap = new Map(renamed.stopPolicies.map((sp, i) => [sp.id as string, `POLICY_${i}`]));
    for (const sp of renamed.stopPolicies) sp.id = idMap.get(sp.id) as typeof sp.id;
    for (const m of renamed.methods) m.stopPolicyIds = m.stopPolicyIds.map((id) => idMap.get(id) as typeof id);
    for (const pl of renamed.plausibility) pl.ruleId = `RULE_${renamed.plausibility.indexOf(pl)}`;

    const a = sweep(ruleSet);
    const b = sweep(renamed);
    const shape = (r: PlanResult) =>
      r.status === "OK"
        ? { status: r.status, counts: [r.prescription.sets.value, r.prescription.repsPerSet.value], rest: r.prescription.rest.repRestS.value, snapshot: { ...r.prescription.monitoringSnapshot.stopPolicy, id: "-" } }
        : r.status === "INELIGIBLE"
          ? { status: r.status, codes: r.reasons.map((x) => x.code) }
          : { status: r.status, codes: r.findings.map((f) => f.code) };
    expect(b.map(shape)).toEqual(a.map(shape));

    // LONG INCOMPLETE の policy 選択は appliesToEligibilityPath で決まる（id 文字列ではない）
    const ref = splitRef([[300, 36, 38], [100, 13, 14]]);
    const adv = expectOk(planRunningPrescriptionWithRuleSet(makeRequest("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", { coachReference: ref }), resolved(renamed)));
    expect(adv.monitoringSnapshot.stopPolicy.appliesToEligibilityPath).toBe("AUTO_CONDITIONS_MET");
    // plausibility は inputTarget で選ばれる
    const unusedMarkPlan = expectOk(
      planRunningPrescriptionWithRuleSet(makeRequest("STRIDE", "ST_RELAXED", { subject: adultAdvanced({ marks: [{ ...PB100_HAND, timeS: 1.08 }] }) }), resolved(renamed)),
    );
    expect(unusedMarkPlan.findings.some((f) => f.code === "INPUT_MARK_DATA_QUALITY" && f.plausibility?.policy === "DATA_QUALITY" && f.plausibility.ruleId.startsWith("RULE_"))).toBe(true);
  });

  it("構造化 metadata を変えると挙動がそれに従う（approachType / fixedDistanceField / resistanceBand / autoGenerationLimits / appliesToEligibilityPath / inputTarget）", () => {
    const rs: RuleSet = structuredClone(ruleSet);
    const tpl = (id: string) => rs.templates.find((t) => t.id === id)!;
    tpl("EA_JUMP_FULL_APPROACH").approachType = "SHORT";
    tpl("TE_200").fixedDistanceField = null;
    tpl("RS_SLED_LIGHT").resistanceBand = null;
    for (const id of ["ELIG_MV_FLY10_PRE", "ELIG_MV_FLY10_EFFECTIVE_UNKNOWN", "ELIG_MV_FLY10_CIRCA"]) {
      rs.eligibility.find((r) => r.ruleId === id)!.autoGenerationLimits.maxTotalReps = 2; // conditionNote は "reps≤3" のまま
    }
    const mvDev = rs.envelopes.find((e) => e.method === "MAX_VELOCITY" && e.tier === "DEVELOPMENTAL")!;
    mvDev.fields.totalReps = { ...mvDev.fields.totalReps!, recommended: { min: 2, max: 8, unit: "reps" }, coachEditable: { min: 1, max: 8, unit: "reps" } };
    mvDev.fields.flyVolumeM = { ...mvDev.fields.flyVolumeM!, recommended: { min: 20, max: 200, unit: "m" }, coachEditable: { min: 10, max: 200, unit: "m" } };
    for (const sp of rs.stopPolicies) {
      if (sp.appliesToEligibilityPath === "AUTO_CONDITIONS_MET") sp.appliesToEligibilityPath = "MANUAL_OR_OVERRIDE";
      else if (sp.appliesToEligibilityPath === "MANUAL_OR_OVERRIDE") sp.appliesToEligibilityPath = "AUTO_CONDITIONS_MET";
    }
    const pla100 = rs.plausibility.find((p) => p.inputTarget?.kind === "TIMED_MARK" && p.inputTarget.event === "100m")!;
    pla100.inputTarget = { kind: "TIMED_MARK", event: "200m" };

    const ea = expectOk(planRunningPrescriptionWithRuleSet(makeRequest("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH", {
      coachReference: { kind: "COACH_DEFINED", label: "助走" },
      coachEdits: [{ field: "approachDistanceM", value: 38, unit: "m" }],
    }), resolved(rs)));
    if (ea.rep.kind !== "ATTEMPTS") throw new Error("expected ATTEMPTS");
    expect(ea.rep.approach).toBe("SHORT");

    // 本番（fixedDistanceField=repDistanceM）の DEV TE_200 は 200m 固定で ENVELOPE_INFEASIBLE、固定を外すと位置で置かれる
    expectBlocked(plan("TEMPO_EXTENSIVE", "TE_200", { subject: u18PostDeveloping() }), "ENVELOPE_INFEASIBLE");
    const te = expectOk(planRunningPrescriptionWithRuleSet(makeRequest("TEMPO_EXTENSIVE", "TE_200", { subject: u18PostDeveloping() }), resolved(rs)));
    if (te.rep.kind !== "DISTANCE") throw new Error("expected DISTANCE");
    expect(te.rep.distanceM.origin).toBe("ENGINE_POSITIONED");

    expectBlocked(
      planRunningPrescriptionWithRuleSet(makeRequest("RESISTED_SPRINT", "RS_SLED_LIGHT", { coachReference: { kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true } }), resolved(rs)),
      "COACH_REFERENCE_INVALID",
    );

    const mv = expectOk(planRunningPrescriptionWithRuleSet(makeRequest("MAX_VELOCITY", "MV_FLY10", { subject: u15Unknown(), actor: AI }), resolved(rs)));
    expect(mv.sets.value * mv.repsPerSet.value).toBeLessThanOrEqual(2);

    const lsr = expectOk(
      planRunningPrescriptionWithRuleSet(makeRequest("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", { coachReference: splitRef([[300, 36, 38], [100, 13, 14]]) }), resolved(rs)),
    );
    expect(lsr.stopPolicyId).toBe("SP_LSR_INCOMPLETE_STRICT"); // path を入れ替えたので AUTO 経路でも STRICT 側が選ばれる

    expect(planRunningPrescriptionWithRuleSet(makeRequest("STRIDE", "ST_RELAXED", { subject: adultAdvanced({ marks: [{ ...PB100_HAND, timeS: 1.08 }] }) }), resolved(rs)).status).toBe("OK");
    // The 200m mark is assessed only when selected by the current reference plan.
    expectBlocked(
      planRunningPrescriptionWithRuleSet(
        makeRequest("TEMPO_EXTENSIVE", "TE_200", { subject: adultAdvanced({ marks: [{ event: "200m", timeS: 1.08, date: iso("2026-06-01"), timing: "HAND" }] }) }),
        resolved(rs),
      ),
      "INPUT_PLAUSIBILITY_BLOCK",
    );
  });

  it("FLY_SPLIT の区間距離は eventDefinitions から読む（event 名を解析しない）", () => {
    const rs: RuleSet = structuredClone(ruleSet);
    rs.eventDefinitions.timedMarks.find((d) => d.event === "FLY20")!.distanceM = 25;
    const mv = expectOk(planRunningPrescriptionWithRuleSet(makeRequest("MAX_VELOCITY", "MV_FLY20", { subject: adultAdvanced({ marks: [FLY20_PHOTO] }) }), resolved(rs)));
    expect(mv.intensity.reference).toMatchObject({ kind: "FLY_SPLIT", flyZoneM: 25 });
  });

  it("regression: planning のコードは startsWith / endsWith / split / 正規表現 / id・template 名の文字列リテラルで挙動を決めない", () => {
    // RuleSet の行 id（ELIG_* / SP_* / PLA_* / CONSTRAINT_U12… 等）と template id（ACC_* 等）の文字列リテラル。
    // Finding / EligibilityReason のコード（例: "CONSTRAINT_DISALLOWED"）は対象外。
    const ID_LITERAL = /["'`](ELIG|SP|PLA|ACC|MV|SES|LSR|TE|TI|RS|AS|EA|ST)_[A-Z0-9_]*|["'`]CONSTRAINT_(U\d|MATURITY|TRAINING)/;
    for (const { file, code } of readSources("planning")) {
      expect(code, file).not.toMatch(/\.startsWith\(|\.endsWith\(|\.split\(|\.match\(|new RegExp|\.replace\(/);
      expect(code, file).not.toMatch(ID_LITERAL);
      expect(code, file).not.toMatch(/conditionNote/);
      const execCount = (code.match(/\.exec\(|\.test\(/g) ?? []).length;
      // 例外: schema.ts の isValidCalendarDate（入力日付の形式検証のみ。処方の意味は決めない）
      expect(execCount, file).toBe(file === "planning/schema.ts" ? 1 : 0);
    }
  });
});

describe("R4 correction: monitoringSnapshot（§17.1）", () => {
  it("選ばれた StopPolicy と全 TimingTolerance のデータを処方に埋め込み、RuleSet を後で変えても snapshot は変わらない", () => {
    const rs: RuleSet = structuredClone(ruleSet);
    const req = makeRequest("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping() });
    const p = expectOk(planRunningPrescriptionWithRuleSet(req, { ruleSet: rs, contentHash: "test-hash", isDraftFallback: true }));
    const stored = JSON.parse(JSON.stringify(p)); // 保存（prescriptionJson 相当）

    expect(p.stopPolicyId).toBe(p.monitoringSnapshot.stopPolicy.id);
    expect(p.monitoringSnapshot.stopPolicy).toEqual(rs.stopPolicies.find((sp) => sp.id === p.stopPolicyId));
    expect(p.monitoringSnapshot.timingTolerances).toEqual(rs.timingTolerances);
    expect(p.monitoringSnapshot.timingTolerances.map((t) => t.timing).sort()).toEqual(["FAT", "HAND", "PHOTO_CELL", "RADAR_LASER", "UNKNOWN", "VIDEO"]);
    expect(p.monitoringSnapshot.stopPolicy).not.toBe(rs.stopPolicies.find((sp) => sp.id === p.stopPolicyId));

    // plan 後に test 用 RuleSet の stop / tolerance を変更する
    const sp = rs.stopPolicies.find((x) => x.id === p.stopPolicyId)!;
    sp.consecutiveFailuresToStop = 9;
    sp.ruleDescriptionJa = "変更後の説明";
    for (const t of rs.timingTolerances) {
      if (t.toleranceS !== null) t.toleranceS = 9.99;
    }

    expect(p.monitoringSnapshot).toEqual(stored.monitoringSnapshot);
    expect(runningPrescriptionSchema.parse(stored).monitoringSnapshot).toEqual(stored.monitoringSnapshot);
    expect(stored.monitoringSnapshot.stopPolicy.consecutiveFailuresToStop).toBe(2);
    expect(stored.monitoringSnapshot.timingTolerances.find((t: { timing: string }) => t.timing === "HAND").toleranceS).toBe(0.25);

    // 変更後の RuleSet で計画し直した処方だけが新しい値を持つ
    const replanned = expectOk(planRunningPrescriptionWithRuleSet(req, { ruleSet: rs, contentHash: "test-hash", isDraftFallback: true }));
    expect(replanned.monitoringSnapshot.stopPolicy.consecutiveFailuresToStop).toBe(9);
  });

  it("snapshot の stopPolicy.id が stopPolicyId と一致しない処方は Zod で拒否", () => {
    const p = expectOk(plan("STRIDE", "ST_WARMUP", { subject: u18PostDeveloping() }));
    const bad = { ...p, monitoringSnapshot: { ...p.monitoringSnapshot, stopPolicy: { ...p.monitoringSnapshot.stopPolicy, id: "SP_ACC" } } };
    expect(runningPrescriptionSchema.safeParse(bad).success).toBe(false);
  });
});

describe("R4 correction: PlanResult findings", () => {
  it("DRAFT RuleSet を選んだ後の結果（OK / INELIGIBLE / BLOCKED）はすべて RULESET_DRAFT を持つ。parse 不能な PlanRequest には付けない", () => {
    const ok = expectOk(plan("STRIDE", "ST_WARMUP", { subject: u18PostDeveloping() }));
    expect(findingCodes(ok)).toContain("RULESET_DRAFT");

    const inel = plan("ACCELERATION", "ACC_BLOCK_30", { subject: u15Unknown(), actor: AI });
    if (inel.status !== "INELIGIBLE") throw new Error("expected INELIGIBLE");
    expect(inel.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["RULESET_DRAFT", "PHASE_COMPETITION_NOT_EVALUATED", "WEEKLY_CONTEXT_NOT_EVALUATED"]));
    // 理由（EligibilityReason）と Finding を二重化しない
    const reasonCodes = new Set<string>(inel.reasons.map((r) => r.code));
    expect(inel.findings.some((f) => reasonCodes.has(f.code))).toBe(false);

    const blocked = plan("ACCELERATION", "ACC_BLOCK_10", { actor: AI });
    if (blocked.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(blocked.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["RULESET_DRAFT", "ENVELOPE_INFEASIBLE"]));

    const invalid = planRunningPrescription({ ...makeRequest("STRIDE", "ST_WARMUP"), ruleSetVersion: "x" } as unknown as PlanRequest);
    if (invalid.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(invalid.findings.map((f) => f.code)).not.toContain("RULESET_DRAFT");
  });
});

describe("R4 correction: inputData NOT_REQUIRED", () => {
  it("データ不要の参照は NOT_REQUIRED、データ参照からの fallback は LOW（HIGH と偽装しない）", () => {
    const acc = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping() }));
    expect(acc.intensity.reference.kind).toBe("MAX_INTENT");
    expect(acc.confidence.inputData).toBe("NOT_REQUIRED");
    const stride = expectOk(plan("STRIDE", "ST_WARMUP", { subject: u18PostDeveloping() }));
    expect(stride.confidence.inputData).toBe("NOT_REQUIRED");
    const mvFallback = expectOk(plan("MAX_VELOCITY", "MV_FLY20"));
    expect(mvFallback.intensity.reference.kind).toBe("MAX_INTENT");
    expect(mvFallback.confidence.inputData).toBe("LOW");
    // v2 初期（全 Evidence SECONDARY_REPORT_ONLY）では NOT_REQUIRED でも最高 MODERATE
    expect(acc.confidence.prescription).toBe("MODERATE");
    expect(renderRationaleJa(acc.rationale).join("\n")).toContain("この方式では不要");
  });

  it("GROUP の上限（最大 LOW）は参照依存のときだけ。データ不要の参照は NOT_REQUIRED のまま（§4.1）", () => {
    const group: Subject = {
      kind: "GROUP",
      profile: {
        label: "g",
        members: [{ birthDate: iso("2008-03-01"), maturity: POST_HIGH, trainingAge: { structuredSprintYears: 2 }, primaryEvent: "100m" }],
        allowAdvancedMethods: false,
      },
    };
    expect(expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: group, actor: AI })).confidence.inputData).toBe("NOT_REQUIRED");
    expect(expectOk(plan("TEMPO_EXTENSIVE", "TE_100", { subject: group, actor: AI })).confidence.inputData).toBe("LOW");
  });

  it("derivePrescriptionConfidence: NOT_REQUIRED は中立（LOW に落とさず、HIGH にも押し上げない）", () => {
    const secondary: UsedEvidenceSummary[] = [{ sourceType: "COACHING_BEST_PRACTICE", verification: "SECONDARY_REPORT_ONLY", directness: "DIRECT" }];
    const primary: UsedEvidenceSummary[] = [{ sourceType: "COACHING_BEST_PRACTICE", verification: "PRIMARY_CHECKED", directness: "DIRECT" }];
    const partial: UsedEvidenceSummary[] = [{ sourceType: "COACHING_BEST_PRACTICE", verification: "PRIMARY_CHECKED", directness: "PARTIAL" }];
    const run = (usedEvidence: UsedEvidenceSummary[], inputDataConfidence: "NOT_REQUIRED" | "HIGH") =>
      derivePrescriptionConfidence({ usedEvidence, inputDataConfidence, historyCoverage72h: "COMPLETE" });
    expect(run(secondary, "NOT_REQUIRED")).toBe("MODERATE");
    expect(run(primary, "NOT_REQUIRED")).toBe(run(primary, "HIGH"));
    expect(run(partial, "NOT_REQUIRED")).toBe("MODERATE");
  });
});

describe("R4 correction: sets=1 の構造正規化規則", () => {
  it("sets セルの無い template は sets=1（STRUCTURAL_FIXED・evidence なし・position なし）を snapshot し、rationale で推奨でないことを示す", () => {
    const cases: PlanResult[] = [
      plan("RESISTED_SPRINT", "RS_HILL_SHORT", {}),
      plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", { coachReference: splitRef([[300, 36, 38], [100, 13, 14]]) }),
    ];
    for (const r of cases) {
      const p = expectOk(r);
      expect(p.sets).toEqual({
        value: 1,
        unit: "sets",
        recommended: { min: 1, max: 1, unit: "sets" },
        coachEditable: { min: 1, max: 1, unit: "sets" },
        hardSafety: null,
        position: null,
        origin: "STRUCTURAL_FIXED",
        evidenceIds: [],
      });
      expect(p.rationale.map((l) => l.code)).toContain("STRUCTURAL_SINGLE_SET");
    }
    // 走行距離が未確定の項目は「安全」とみなさず、F1では保存を止める。
    expectBlocked(
      plan("EVENT_APPROACH_SPEED", "EA_JUMP_SHORT_APPROACH", { coachReference: { kind: "COACH_DEFINED", label: "助走" } }),
      "PLAUSIBILITY_NOT_DETERMINABLE",
    );
    // sets セルを持つ Method は構造正規化を使わない
    expect(expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: u18PostDeveloping() })).sets.origin).toBe("SOLVER_DERIVED");
  });

  it("RuleSet に sets セルが追加されたら必ずそちらを使う", () => {
    const rs: RuleSet = structuredClone(ruleSet);
    const env = rs.envelopes.find((e) => e.method === "RESISTED_SPRINT" && e.tier === "ADVANCED" && e.fields.repDistanceM)!;
    env.fields.sets = { recommended: { min: 1, max: 3, unit: "sets" }, coachEditable: { min: 1, max: 4, unit: "sets" }, hardSafety: null, evidenceIds: ["EV_ENGINE_POLICY" as never], judgement: "ENGINE_POLICY" };
    const p = expectOk(planRunningPrescriptionWithRuleSet(makeRequest("RESISTED_SPRINT", "RS_HILL_SHORT", {}), { ruleSet: rs, contentHash: "t", isDraftFallback: true }));
    expect(p.sets.origin).toBe("SOLVER_DERIVED");
    expect(p.sets.recommended).toEqual({ min: 1, max: 3, unit: "sets" });
    expect(p.sets.evidenceIds).toEqual(["EV_ENGINE_POLICY"]);
    expect(p.rationale.map((l) => l.code)).not.toContain("STRUCTURAL_SINGLE_SET");
  });
});
