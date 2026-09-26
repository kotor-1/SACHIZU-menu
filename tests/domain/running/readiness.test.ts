/**
 * Running Prescription Engine v2 — Phase R5（§13 Readiness / Pain gate）。
 *
 * 検証の柱:
 *   - §13.2 の hard gate（STOP は誰の override でも解除できない）
 *   - §13.3 の action は**離散値だけ**（倍率・割合・readinessFactor を一切作らない）
 *   - 判定データ（しきい値・red flag グループ・SWAP 先）は RuleSet 側にあり、RuleSet を変えれば判定も変わる
 *   - 健康情報は処方にも AI 文脈にも残さない（§13.5 / T-AI-06）
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as runningApi from "@/domain/running";
import { resolveReadinessAction } from "@/domain/running/readiness";
import { evaluatePainGate } from "@/domain/running/readiness/painGate";
import { deriveReadinessActions } from "@/domain/running/readiness/actions";
import { resolveSwapTargets } from "@/domain/running/readiness/swap";
import { buildAiSafeSubjectContext } from "@/domain/running/readiness/aiSafeContext";
import {
  normalizeReadinessActions,
  readinessDecisionSchema,
  type ReadinessContext,
  type ReadinessDecision,
} from "@/domain/running/readiness/schema";
import { planRunningPrescription, planRunningPrescriptionWithRuleSet } from "@/domain/running/planning";
import { selectEnvelope } from "@/domain/running/planning/envelope";
import { planRequestSchema, type PlanRequest, type PlanResult } from "@/domain/running/planning/schema";
import { getActiveRuleSet, getRuleSet } from "@/domain/running/rules/loader";
import { ruleSetSchema, type RuleSet } from "@/domain/running/rules/schema";
import { resolveSubjectProfile } from "@/domain/running/context/subject";
import { renderRationaleJa } from "@/domain/running/rationale/render-ja";
import { createCoachActor } from "@/domain/running/types/actor";
import {
  BODY_REGIONS,
  READINESS_ACTION_CODES,
  RED_FLAGS,
  SAFETY_OUTCOMES,
  readinessReportSchema,
  type PainReport,
  type ReadinessReport,
} from "@/domain/running/types/readiness";
import { runtimeSafetyPolicySnapshotSchema } from "@/domain/running/types/monitoring";
import type { IsoDate, Unit } from "@/domain/running/types/primitives";
import type { FieldValue, RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PLANNING_DATE = "2026-09-15";
const ruleSet = getRuleSet("rs-2026.09.0")!;
const active = getActiveRuleSet(PLANNING_DATE);
const EXPECTED_HASH = active.contentHash;

function iso(value: string): IsoDate {
  return value as IsoDate;
}

const COACH = createCoachActor("coach-1");
const AI = { kind: "AI_PLANNER", provider: "test-provider", model: "test-model", requestId: "req-1" } as const;
const SYSTEM = { kind: "SYSTEM" } as const;

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

const adultAdvanced = (o: Partial<AthleteProfile> = {}) => athlete(o);
const u18PostDeveloping = (o: Partial<AthleteProfile> = {}) =>
  athlete({
    birthDate: iso("2010-01-01"),
    maturity: POST_MEDIUM,
    trainingAge: { structuredSprintYears: 2 },
    allowAdvancedMethods: false,
    ...o,
  });

const NO_PAIN: PainReport = { status: "NONE_REPORTED", regions: [], redFlags: [] };

function report(o: Partial<ReadinessReport> = {}): ReadinessReport {
  return readinessReportSchema.parse({
    pain: NO_PAIN,
    soreness: 1,
    fatigue: 1,
    sleepQuality: 5,
    performanceStatus: "NORMAL",
    reporter: "ATHLETE",
    reportedAt: "2026-09-15T07:00:00.000Z",
    ...o,
  });
}

function context(o: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    planningDate: iso(PLANNING_DATE),
    ageBand: "ADULT",
    method: "ACCELERATION",
    readinessWindowState: "NOT_EVALUATED",
    ...o,
  } as ReadinessContext;
}

type RequestOptions = {
  subject?: Subject;
  actor?: PlanRequest["actor"] | typeof AI | typeof SYSTEM;
  readiness?: unknown;
  overrides?: unknown[];
  positionPreference?: "LOWER" | "MIDDLE" | null;
  availableMinutes?: number | null;
};

function makeRequest(method: string, templateId: string, o: RequestOptions = {}): PlanRequest {
  return {
    planningDate: iso(PLANNING_DATE),
    selection: { method, templateId },
    subject: o.subject ?? adultAdvanced(),
    menuContext: { phase: null, plannedDate: null, plannedAt: null, competitions: [], otherItems: [], availableMinutes: o.availableMinutes ?? null },
    history: null,
    readiness: o.readiness ?? null,
    positionPreference: o.positionPreference ?? null,
    coachEdits: [],
    overrides: o.overrides ?? [],
    coachReference: null,
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

function expectOk(r: PlanResult) {
  expect(r.status, describeResult(r)).toBe("OK");
  if (r.status !== "OK") throw new Error("unreachable");
  return r.prescription;
}

const READINESS_OVERRIDE = {
  target: { kind: "READINESS", action: "CANCEL_HIGH_INTENSITY" },
  reason: "本人と確認のうえ、本日の実施をコーチ判断で継続する",
  confirmedTwice: false,
  actor: COACH,
  at: "2026-09-15T08:00:00.000Z",
};

// ---------------------------------------------------------------------------
// §13.1 入力の型（自由記述なし・矛盾を受け付けない）
// ---------------------------------------------------------------------------

describe("§13.1 ReadinessReport / PainReport", () => {
  it("自由記述欄や未知のキーを受け付けない（.strict()）", () => {
    expect(readinessReportSchema.safeParse({ ...report(), note: "膝が痛いです" }).success).toBe(false);
    expect(
      readinessReportSchema.safeParse({ ...report(), pain: { status: "PRESENT", regions: ["KNEE"], redFlags: [], memo: "昨日から" } }).success,
    ).toBe(false);
  });

  it("尺度は 1–5 の選択式だけ（NaN / Infinity / 小数 / 範囲外は型として入らない）", () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, 6, 3.5]) {
      expect(readinessReportSchema.safeParse({ ...report(), fatigue: bad }).success, `fatigue=${bad}`).toBe(false);
    }
    expect(readinessReportSchema.safeParse({ ...report(), fatigue: null }).success).toBe(true);
  });

  it("status=NONE_REPORTED / NOT_ASKED で regions・redFlags があるのは矛盾として拒否する", () => {
    for (const status of ["NONE_REPORTED", "NOT_ASKED"] as const) {
      expect(readinessReportSchema.safeParse({ ...report(), pain: { status, regions: ["KNEE"], redFlags: [] } }).success).toBe(false);
      expect(readinessReportSchema.safeParse({ ...report(), pain: { status, regions: [], redFlags: ["SWELLING"] } }).success).toBe(false);
    }
  });

  it("status=PRESENT は regions が空でもよい（勝手に OTHER へ変換しない）", () => {
    const parsed = readinessReportSchema.parse({ ...report(), pain: { status: "PRESENT", regions: [], redFlags: [] } });
    expect(parsed.pain.regions).toEqual([]);
  });

  it("regions / redFlags の重複は拒否する（同じ入力を2回数えない）", () => {
    expect(readinessReportSchema.safeParse({ ...report(), pain: { status: "PRESENT", regions: ["KNEE", "KNEE"], redFlags: [] } }).success).toBe(false);
    expect(
      readinessReportSchema.safeParse({ ...report(), pain: { status: "PRESENT", regions: [], redFlags: ["SWELLING", "SWELLING"] } }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-SAFE-01 / T-SAFE-02: pain gate
// ---------------------------------------------------------------------------

describe("T-SAFE-01: red flag は STOP（§13.2 hard gate）", () => {
  const medical = report({ pain: { status: "PRESENT", regions: ["KNEE"], redFlags: ["SWELLING"] } });

  it("医療系 red flag → stopPlanning + MEDICAL_EVALUATION_RECOMMENDED", () => {
    const d = resolveReadinessAction(medical, context());
    expect(d.stopPlanning).toBe(true);
    expect(d.safetyOutcome).toBe("MEDICAL_EVALUATION_RECOMMENDED");
    expect(d.highIntensityAllowedToday).toBe(false);
    expect(d.transientFindings.map((f) => f.code)).toContain("READINESS_STOP_SAFETY");
  });

  it("コーチ確認系 red flag → stopPlanning + COACH_REVIEW（STOP は同じ、outcome だけ違う）", () => {
    const d = resolveReadinessAction(report({ pain: { status: "PRESENT", regions: [], redFlags: ["SUDDEN_SHARP_PAIN"] } }), context());
    expect(d.stopPlanning).toBe(true);
    expect(d.safetyOutcome).toBe("COACH_REVIEW");
  });

  it("両方の group に該当したら重い方（MEDICAL）を採用し、redFlags の順序に依存しない", () => {
    const flags = ["SUDDEN_SHARP_PAIN", "SWELLING", "PAIN_WORSENING_DURING_SESSION", "LIMPING"] as const;
    const outcomes = new Set<string>();
    for (const order of [flags, [...flags].reverse(), [flags[1], flags[3], flags[0], flags[2]]]) {
      const d = resolveReadinessAction(report({ pain: { status: "PRESENT", regions: [], redFlags: [...order] } }), context());
      outcomes.add(`${d.stopPlanning}:${d.safetyOutcome}`);
    }
    expect([...outcomes]).toEqual(["true:MEDICAL_EVALUATION_RECOMMENDED"]);
  });

  it("STOP はどの actor でも、どんな override でも解除できない（負荷の低い STRIDE でも計画しない）", () => {
    const decision = resolveReadinessAction(medical, context({ method: "STRIDE" }));
    for (const actor of [COACH, AI, SYSTEM]) {
      for (const overrides of [[], [READINESS_OVERRIDE]]) {
        if (actor !== COACH && overrides.length > 0) continue; // 非 COACH は override を持てない（§18）
        const r = plan("STRIDE", "ST_RELAXED", { readiness: decision, actor, overrides });
        expect(r.status, `${actor.kind}/${overrides.length}`).toBe("BLOCKED");
        if (r.status !== "BLOCKED") throw new Error("unreachable");
        expect(r.findings.map((f) => f.code)).toContain("READINESS_STOP_SAFETY");
      }
    }
  });

  it("STOP は envelope / placement より前に止まる（数値の配置に関する finding を出さない）", () => {
    const decision = resolveReadinessAction(medical, context({ method: "ACCELERATION" }));
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision });
    if (r.status !== "BLOCKED") throw new Error(describeResult(r));
    expect(r.findings.map((f) => f.code)).not.toContain("ENVELOPE_INFEASIBLE");
    expect(r.findings.map((f) => f.code)).not.toContain("REST_INFEASIBLE_FOR_PRACTICE");
  });
});

describe("T-SAFE-02: PRESENT（red flag なし）", () => {
  const present = report({ pain: { status: "PRESENT", regions: ["HAMSTRING"], redFlags: [] } });

  it("STOP ではなく COACH_REVIEW + CANCEL_HIGH_INTENSITY + REQUIRE_COACH_REVIEW", () => {
    const d = resolveReadinessAction(present, context());
    expect(d.stopPlanning).toBe(false);
    expect(d.safetyOutcome).toBe("COACH_REVIEW");
    expect(d.actions).toEqual(["CANCEL_HIGH_INTENSITY", "REQUIRE_COACH_REVIEW"]);
    expect(d.highIntensityAllowedToday).toBe(false);
  });

  it("成長期の部位（膝）×未成年は表示用の finding を足す（診断ではない・処方には残さない）", () => {
    const d = resolveReadinessAction(
      report({ pain: { status: "PRESENT", regions: ["KNEE"], redFlags: [] } }),
      context({ ageBand: "U15" }),
    );
    expect(d.transientFindings.map((f) => f.code)).toContain("GROWTH_PERIOD_PAIN_GUIDANCE");
    // 成人には付かない
    const adult = resolveReadinessAction(report({ pain: { status: "PRESENT", regions: ["KNEE"], redFlags: [] } }), context());
    expect(adult.transientFindings.map((f) => f.code)).not.toContain("GROWTH_PERIOD_PAIN_GUIDANCE");
  });

  it("高強度 Method は override 無しでは計画できない（AI / SYSTEM は override 自体が持てない）", () => {
    const decision = resolveReadinessAction(present, context());
    for (const actor of [COACH, AI, SYSTEM]) {
      const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision, actor });
      expect(r.status, actor.kind).toBe("INELIGIBLE");
      if (r.status !== "INELIGIBLE") throw new Error("unreachable");
      expect(r.reasons.map((x) => x.code)).toContain("READINESS_HIGH_INTENSITY_CANCELLED");
      expect(r.reasons[0].overrideAllowed).toBe(actor.kind === "COACH");
    }
  });

  it("負荷の低い Method（STRIDE）は CANCEL では止めず、コーチ確認を求めて実施できる", () => {
    const decision = resolveReadinessAction(present, context({ method: "STRIDE" }));
    const p = expectOk(plan("STRIDE", "ST_RELAXED", { readiness: decision }));
    expect(p.readinessApplied).toEqual(["REQUIRE_COACH_REVIEW"]);
    expect(p.safetyOutcome).toBe("COACH_REVIEW");
    expect(p.findings.map((f) => f.code)).toContain("READINESS_CANCEL_NOT_APPLICABLE");
  });
});

// ---------------------------------------------------------------------------
// T-SAFE-03: NOT_ASKED（痛みを確認していない日）
// ---------------------------------------------------------------------------

describe("T-SAFE-03: NOT_ASKED は「痛みなし」ではない", () => {
  const notAsked = report({ pain: { status: "NOT_ASKED", regions: [], redFlags: [] } });

  it("未成年 → painCheckRequired・highIntensityAllowedToday=UNKNOWN・REQUIRE_COACH_REVIEW", () => {
    const d = resolveReadinessAction(notAsked, context({ ageBand: "U15" }));
    expect(d.stopPlanning).toBe(false);
    expect(d.painCheckRequired).toBe(true);
    expect(d.highIntensityAllowedToday).toBe("UNKNOWN");
    expect(d.actions).toContain("REQUIRE_COACH_REVIEW");
  });

  it("年齢帯 UNKNOWN も「確認できていない」側に寄せる（ADULT と決めつけない）", () => {
    const d = resolveReadinessAction(notAsked, context({ ageBand: "UNKNOWN" }));
    expect(d.painCheckRequired).toBe(true);
    expect(d.highIntensityAllowedToday).toBe("UNKNOWN");
  });

  it("AI / SYSTEM は未成年の高強度を自動生成できない（override 不可）", () => {
    const decision = resolveReadinessAction(notAsked, context({ ageBand: "U18" }));
    for (const actor of [AI, SYSTEM]) {
      const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision, actor, subject: u18PostDeveloping() });
      expect(r.status, actor.kind).toBe("INELIGIBLE");
      if (r.status !== "INELIGIBLE") throw new Error("unreachable");
      expect(r.reasons.map((x) => x.code)).toContain("READINESS_CHECK_REQUIRED");
      expect(r.reasons.find((x) => x.code === "READINESS_CHECK_REQUIRED")?.overrideAllowed).toBe(false);
    }
  });

  it("コーチは確認要求付きで手動作成できる", () => {
    const decision = resolveReadinessAction(notAsked, context({ ageBand: "U18" }));
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision, subject: u18PostDeveloping() }));
    expect(p.readinessApplied).toContain("REQUIRE_COACH_REVIEW");
    expect(p.findings.map((f) => f.code)).toContain("READINESS_CHECK_REQUIRED");
  });

  it("NONE_REPORTED は高強度の許可ではない（§13.3 を続けて評価する）", () => {
    const d = resolveReadinessAction(report({ soreness: 4 }), context());
    expect(d.actions).toContain("SWAP_TO_LOWER_LOAD_METHOD");
  });
});

// ---------------------------------------------------------------------------
// T-SAFE-04: §13.3 の action（離散値のみ）
// ---------------------------------------------------------------------------

describe("T-SAFE-04: wellness の action 選択", () => {
  it("すべて良好 → NO_CHANGE 単独", () => {
    expect(resolveReadinessAction(report(), context()).actions).toEqual(["NO_CHANGE"]);
  });

  it("performanceStatus=DOWN → SWAP + REQUIRE_COACH_REVIEW", () => {
    expect(resolveReadinessAction(report({ performanceStatus: "DOWN" }), context()).actions).toEqual([
      "SWAP_TO_LOWER_LOAD_METHOD",
      "REQUIRE_COACH_REVIEW",
    ]);
  });

  it("soreness ≥ 4 → SWAP", () => {
    expect(resolveReadinessAction(report({ soreness: 4 }), context()).actions).toEqual(["SWAP_TO_LOWER_LOAD_METHOD"]);
    expect(resolveReadinessAction(report({ soreness: 5 }), context()).actions).toEqual(["SWAP_TO_LOWER_LOAD_METHOD"]);
  });

  it("シグナル1つ（fatigue ≥ 4）→ USE_LOWER_BOUND + INCREASE_REST", () => {
    expect(resolveReadinessAction(report({ fatigue: 4 }), context()).actions).toEqual(["USE_LOWER_BOUND", "INCREASE_REST"]);
  });

  it("シグナル2つ（soreness=3 かつ sleepQuality ≤ 2）→ SWAP", () => {
    const d = resolveReadinessAction(report({ soreness: 3, sleepQuality: 2 }), context());
    expect(d.actions).toEqual(["SWAP_TO_LOWER_LOAD_METHOD"]);
  });

  it("readiness 窓が ACTIVE のときだけ、未記入 → USE_LOWER_BOUND", () => {
    const blank = report({ soreness: null, fatigue: null, sleepQuality: null });
    expect(resolveReadinessAction(blank, context({ readinessWindowState: "ACTIVE" })).actions).toEqual(["USE_LOWER_BOUND"]);
    for (const state of ["INACTIVE", "NOT_EVALUATED"] as const) {
      expect(resolveReadinessAction(blank, context({ readinessWindowState: state })).actions, state).toEqual(["NO_CHANGE"]);
    }
  });

  it("action は離散値だけ（数値・倍率・割合を返さない）", () => {
    const d = resolveReadinessAction(report({ fatigue: 4 }), context());
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/factor|multiplier|percentage|readinessFactor/i);
    for (const a of d.actions) expect(typeof a).toBe("string");
    // 判断そのものに数値「値」は現れない（RuleSet identity と rule id 以外は enum と boolean だけ）
    expect(JSON.stringify({ ...d, ruleSet: null, triggers: d.triggers.map((t) => t.actions) })).not.toMatch(/:\s*-?[0-9]/);
  });
});

describe("§13.3 action の優先順位", () => {
  it("CANCEL > SWAP > (USE_LOWER_BOUND + INCREASE_REST) > NO_CHANGE の順に並ぶ", () => {
    expect(normalizeReadinessActions(["NO_CHANGE", "INCREASE_REST", "SWAP_TO_LOWER_LOAD_METHOD", "CANCEL_HIGH_INTENSITY", "USE_LOWER_BOUND"])).toEqual([
      "CANCEL_HIGH_INTENSITY",
      "SWAP_TO_LOWER_LOAD_METHOD",
      "USE_LOWER_BOUND",
      "INCREASE_REST",
    ]);
  });

  it("NO_CHANGE は他の action と併存しない", () => {
    expect(normalizeReadinessActions(["NO_CHANGE", "USE_LOWER_BOUND"])).toEqual(["USE_LOWER_BOUND"]);
    expect(normalizeReadinessActions(["NO_CHANGE"])).toEqual(["NO_CHANGE"]);
  });

  it("REQUIRE_COACH_REVIEW は加算的（他の action を消さない）", () => {
    const d = resolveReadinessAction(report({ pain: { status: "PRESENT", regions: [], redFlags: [] }, fatigue: 4 }), context());
    expect(d.actions).toEqual(["CANCEL_HIGH_INTENSITY", "USE_LOWER_BOUND", "INCREASE_REST", "REQUIRE_COACH_REVIEW"]);
  });

  it("入力の順序・ルール配列の順序に依存しない", () => {
    const shuffled: RuleSet = { ...ruleSet, readinessRules: [...ruleSet.readinessRules].reverse() };
    const base = deriveReadinessActions({ report: report({ soreness: 3, fatigue: 4 }), windowState: "NOT_EVALUATED", rules: ruleSet.readinessRules });
    const rev = deriveReadinessActions({ report: report({ soreness: 3, fatigue: 4 }), windowState: "NOT_EVALUATED", rules: shuffled.readinessRules });
    expect(normalizeReadinessActions(rev.actions)).toEqual(normalizeReadinessActions(base.actions));

    const painBase = evaluatePainGate({
      pain: { status: "PRESENT", regions: ["KNEE"], redFlags: ["SWELLING", "LIMPING"] },
      ageBand: "U15",
      loadClass: "HIGH_NEURAL",
      rules: ruleSet.readinessRules,
    });
    const painRev = evaluatePainGate({
      pain: { status: "PRESENT", regions: ["KNEE"], redFlags: ["LIMPING", "SWELLING"] },
      ageBand: "U15",
      loadClass: "HIGH_NEURAL",
      rules: shuffled.readinessRules,
    });
    expect(painRev.stopPlanning).toBe(painBase.stopPlanning);
    expect(painRev.safetyOutcome).toBe(painBase.safetyOutcome);
  });
});

// ---------------------------------------------------------------------------
// §13.4 SWAP（黙って変換しない）
// ---------------------------------------------------------------------------

describe("§13.4 SWAP は候補を返すだけ（自動変換しない）", () => {
  const down = report({ performanceStatus: "DOWN" });

  it("SWAP 対象の Method は INELIGIBLE + substitutes（処方を作らない）", () => {
    const decision = resolveReadinessAction(down, context({ method: "ACCELERATION" }));
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision });
    expect(r.status, describeResult(r)).toBe("INELIGIBLE");
    if (r.status !== "INELIGIBLE") throw new Error("unreachable");
    expect(r.reasons.map((x) => x.code)).toContain("READINESS_SWAP_RECOMMENDED");
    expect(r.reasons[0].overrideAllowed).toBe(false);
    expect(r.substitutes.length).toBeGreaterThan(0);
    expect(r.substitutes.every((s) => s.method === "STRIDE")).toBe(true);
  });

  it("substitutes は RuleSet の SWAP 先から列挙し、eligibility を通ったものだけになる", () => {
    const targets = resolveSwapTargets(ruleSet, "SPRINT_ENDURANCE_SHORT");
    if (targets.outcome !== "SWAP") throw new Error("setup");
    // RuleSet 上の候補は TEMPO_EXTENSIVE の全 template と STRIDE の ST_RELAXED
    expect(targets.candidates.some((c) => c.method === "TEMPO_EXTENSIVE")).toBe(true);
    expect(targets.candidates.some((c) => c.method === "STRIDE" && c.templateId === "ST_RELAXED")).toBe(true);
    // 候補はすべて RuleSet に実在する template（存在しない SWAP 先を作らない）
    for (const c of targets.candidates) {
      expect(ruleSet.templates.some((t) => t.method === c.method && t.id === c.templateId), `${c.method}:${c.templateId}`).toBe(true);
    }

    const decision = resolveReadinessAction(down, context({ method: "SPRINT_ENDURANCE_SHORT" }));
    const r = plan("SPRINT_ENDURANCE_SHORT", "SES_150", { readiness: decision, subject: u18PostDeveloping(), actor: COACH });
    if (r.status !== "INELIGIBLE") throw new Error(describeResult(r));
    const rsCandidates = targets.candidates.map((c) => `${c.method}:${c.templateId}`);
    for (const s of r.substitutes) expect(rsCandidates).toContain(`${s.method}:${s.templateId}`);
  });

  it("STRIDE は「変更なし」（Method を変えず、確認を求めたうえで実施できる）", () => {
    const decision = resolveReadinessAction(down, context({ method: "STRIDE" }));
    expect(resolveSwapTargets(ruleSet, "STRIDE").outcome).toBe("KEEP_CURRENT");
    const p = expectOk(plan("STRIDE", "ST_RELAXED", { readiness: decision }));
    expect(p.method).toBe("STRIDE");
    // 実際に適用したのは確認要求だけ（SWAP は適用されていない）と明示する
    expect(p.readinessApplied).toEqual(["REQUIRE_COACH_REVIEW"]);
    expect(p.findings.map((f) => f.code)).toContain("READINESS_SWAP_KEEP_CURRENT");
  });

  it("候補が eligibility を通らなければ substitutes は空になる（無理に候補を作らない）", () => {
    const noStride: RuleSet = {
      ...ruleSet,
      eligibility: ruleSet.eligibility.map((rule) => (rule.method === "STRIDE" ? { ...rule, outcome: "INELIGIBLE" as const } : rule)),
    };
    const decision = resolveReadinessAction(down, context({ method: "TEMPO_EXTENSIVE" }));
    const r = planRunningPrescriptionWithRuleSet(
      makeRequest("TEMPO_EXTENSIVE", "TE_200", { readiness: decision }),
      { ruleSet: noStride, contentHash: EXPECTED_HASH, isDraftFallback: true },
    );
    if (r.status !== "INELIGIBLE") throw new Error(describeResult(r));
    expect(r.substitutes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §13.3 量の調整（位置だけを動かす）
// ---------------------------------------------------------------------------

describe("USE_LOWER_BOUND / INCREASE_REST は位置だけを動かす", () => {
  const oneSignal = report({ fatigue: 4 });

  it("USE_LOWER_BOUND → rest 以外のエンジン配置値が LOWER_BOUND になる", () => {
    const decision = resolveReadinessAction(oneSignal, context({ method: "MAX_VELOCITY" }));
    const p = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { readiness: decision }));
    if (p.rep.kind !== "FLY") throw new Error("setup");
    expect(p.rep.buildUpDistanceM.origin).toBe("ENGINE_POSITIONED");
    expect(p.rep.buildUpDistanceM.position).toBe("LOWER_BOUND");
    // rest は下げない（同じ decision でも rest だけは上半分）
    expect(p.rest.repRestS.position).toBe("UPPER_HALF");
    expect(p.readinessApplied).toEqual(["USE_LOWER_BOUND", "INCREASE_REST"]);
  });

  it("USE_LOWER_BOUND は量を減らす向きにだけ働く（総量・本数が基準より増えない）", () => {
    for (const [method, templateId] of [
      ["ACCELERATION", "ACC_BLOCK_20"],
      ["TEMPO_EXTENSIVE", "TE_200"],
      ["MAX_VELOCITY", "MV_FLY20"],
    ] as const) {
      const decision = resolveReadinessAction(oneSignal, context({ method }));
      const lowered = expectOk(plan(method, templateId, { readiness: decision }));
      const baseline = expectOk(plan(method, templateId));
      const reps = (p: typeof lowered) => p.sets.value * p.repsPerSet.value;
      expect(reps(lowered), `${method} reps`).toBeLessThanOrEqual(reps(baseline));
      expect(lowered.exposure.totalRunningDistanceM.lower ?? 0, `${method} volume`).toBeLessThanOrEqual(
        baseline.exposure.totalRunningDistanceM.lower ?? 0,
      );
    }
  });

  it("INCREASE_REST → rest は UPPER_HALF（レストは短くしない側にだけ動く）", () => {
    const decision = resolveReadinessAction(oneSignal, context({ method: "TEMPO_EXTENSIVE" }));
    const withReadiness = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { readiness: decision }));
    const baseline = expectOk(plan("TEMPO_EXTENSIVE", "TE_200"));
    expect(withReadiness.rest.repRestS.position).toBe("UPPER_HALF");
    expect(baseline.rest.repRestS.position).toBe("MIDDLE");
    expect(withReadiness.rest.repRestS.value).toBeGreaterThanOrEqual(baseline.rest.repRestS.value);
  });

  it("位置の制約は順序に依存せず積み重なる（positionPreference=LOWER と併用しても同じ結果）", () => {
    const decision = resolveReadinessAction(oneSignal, context({ method: "TEMPO_EXTENSIVE" }));
    const a = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { readiness: decision, positionPreference: "LOWER" }));
    const b = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { readiness: decision }));
    expect(a.repsPerSet.value).toBe(b.repsPerSet.value);
    expect(a.sets.value).toBe(b.sets.value);
  });

  it("recommended の範囲自体は readiness で書き換わらない（範囲に係数を掛けない）", () => {
    const decision = resolveReadinessAction(oneSignal, context({ method: "TEMPO_EXTENSIVE" }));
    const withReadiness = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { readiness: decision }));
    const baseline = expectOk(plan("TEMPO_EXTENSIVE", "TE_200"));
    expect(withReadiness.repsPerSet.recommended).toEqual(baseline.repsPerSet.recommended);
    expect(withReadiness.rest.repRestS.recommended).toEqual(baseline.rest.repRestS.recommended);
    expect(withReadiness.rest.repRestS.coachEditable).toEqual(baseline.rest.repRestS.coachEditable);
  });
});

// ---------------------------------------------------------------------------
// CoachOverride（READINESS）
// ---------------------------------------------------------------------------

describe("READINESS override（CANCEL_HIGH_INTENSITY だけ）", () => {
  const present = report({ pain: { status: "PRESENT", regions: ["HAMSTRING"], redFlags: [] } });

  it("コーチの override で高強度を実施できる。確認要求と safetyOutcome は残り、CANCEL は「適用済み」にしない", () => {
    const decision = resolveReadinessAction(present, context());
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision, overrides: [READINESS_OVERRIDE] }));
    // §13.6: readinessApplied は「実際に適用した effective action」だけ。解除された CANCEL は入らない。
    expect(p.readinessApplied).toEqual(["REQUIRE_COACH_REVIEW"]);
    // override しても健康上の事象そのものは消えない
    expect(p.safetyOutcome).toBe("COACH_REVIEW");
    expect(p.findings.map((f) => f.code)).toContain("READINESS_CANCEL_OVERRIDDEN");
  });

  it("override の理由は10文字以上、actor は COACH、AI / SYSTEM は持てない", () => {
    const short = { ...READINESS_OVERRIDE, reason: "短い" };
    expect(planRequestSchema.safeParse(makeRequest("ACCELERATION", "ACC_BLOCK_20", { overrides: [short] })).success).toBe(false);
    for (const actor of [AI, SYSTEM]) {
      expect(
        planRequestSchema.safeParse(makeRequest("ACCELERATION", "ACC_BLOCK_20", { actor, overrides: [READINESS_OVERRIDE] })).success,
        actor.kind,
      ).toBe(false);
    }
  });

  it("READINESS override の対象は CANCEL_HIGH_INTENSITY のみ（STOP / SWAP / 下限 / レストは指定できない）", () => {
    for (const action of ["STOP", "MEDICAL_EVALUATION_RECOMMENDED", "SWAP_TO_LOWER_LOAD_METHOD", "USE_LOWER_BOUND", "INCREASE_REST", "READINESS_CHECK_REQUIRED"]) {
      const bad = { ...READINESS_OVERRIDE, target: { kind: "READINESS", action } };
      expect(planRequestSchema.safeParse(makeRequest("ACCELERATION", "ACC_BLOCK_20", { overrides: [bad] })).success, action).toBe(false);
    }
  });

  it("解除すべき CANCEL が無い override は対象なしとして BLOCK する", () => {
    const decision = resolveReadinessAction(report(), context());
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision, overrides: [READINESS_OVERRIDE] });
    expect(r.status).toBe("BLOCKED");
    if (r.status !== "BLOCKED") throw new Error("unreachable");
    expect(r.findings.map((f) => f.code)).toContain("OVERRIDE_TARGET_INVALID");
  });

  it("SWAP は override できない（override を付けても INELIGIBLE のまま）", () => {
    const decision = resolveReadinessAction(report({ performanceStatus: "DOWN" }), context());
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision, overrides: [READINESS_OVERRIDE] });
    expect(r.status).toBe("INELIGIBLE");
  });
});

// ---------------------------------------------------------------------------
// PlanRequest の contract
// ---------------------------------------------------------------------------

describe("PlanRequest は判断だけを受け取る（生の健康情報を受け取らない）", () => {
  it("ReadinessReport をそのまま渡すと拒否される（.strict()）", () => {
    const raw = makeRequest("ACCELERATION", "ACC_BLOCK_20", { readiness: report() });
    expect(planRequestSchema.safeParse(raw).success).toBe(false);
    expect(plan("ACCELERATION", "ACC_BLOCK_20", { readiness: report() }).status).toBe("BLOCKED");
  });

  it("readinessReport というキー自体を受け付けない", () => {
    const raw = { ...makeRequest("ACCELERATION", "ACC_BLOCK_20"), readinessReport: report() };
    expect(planRequestSchema.safeParse(raw).success).toBe(false);
  });

  it("別 RuleSet の判断は適用せず BLOCKED にする（§13 の判断と計画の RuleSet は一致必須）", () => {
    const decision = resolveReadinessAction(report(), context());
    for (const broken of [
      { ...decision, ruleSet: { ...decision.ruleSet, version: "rs-2026.08.0" } },
      { ...decision, ruleSet: { ...decision.ruleSet, contentHash: "0".repeat(64) } },
      { ...decision, ruleSet: { ...decision.ruleSet, status: "DRAFT" as const } },
    ]) {
      const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: broken });
      expect(r.status).toBe("BLOCKED");
      if (r.status !== "BLOCKED") throw new Error("unreachable");
      expect(r.findings.map((f) => f.code)).toContain("READINESS_RULESET_MISMATCH");
    }
  });

  it("readiness=null は R4 と同じ挙動（readinessApplied=[]、safetyOutcome=NONE）", () => {
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20"));
    expect(p.readinessApplied).toEqual([]);
    expect(p.safetyOutcome).toBe("NONE");
    expect(p.rationale.map((l) => l.code)).toContain("READINESS_NOT_EVALUATED");
  });

  it("readiness を評価したら readinessApplied は空にしない（NO_CHANGE でも記録する）", () => {
    const decision = resolveReadinessAction(report(), context());
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision }));
    expect(p.readinessApplied).toEqual(["NO_CHANGE"]);
    expect(p.rationale.map((l) => l.code)).toContain("READINESS_NO_CHANGE");
  });
});

// ---------------------------------------------------------------------------
// §13.5 privacy（処方・AI 文脈に健康情報を残さない）
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = [
  "pain",
  "region",
  "redFlag",
  "soreness",
  "fatigue",
  "sleep",
  "reporter",
  "reportedAt",
  "birthDate",
  "sexForNorms",
  "maturity",
];

describe("T-AI-06 / §13.5: 健康情報を持ち出さない", () => {
  const present = report({ pain: { status: "PRESENT", regions: ["KNEE", "HAMSTRING"], redFlags: [] }, soreness: 4, fatigue: 5, sleepQuality: 1 });

  // [R8 scope correction — privacy を弱める変更ではない]
  // R5 のこのテストは「処方 JSON 全体に "pain" が1文字でもあってはならない」という文字列走査で §13.5 を近似していた。
  // R8 で monitor 用に `monitoringSnapshot.safetyPolicy`（RuleSet からコピーした全選手共通の red flag → safetyOutcome の
  // versioned runtime policy）を処方へ保存するようになり、その定義に含まれる RedFlag の enum 名（PAIN_AT_REST_OR_NIGHT 等）
  // まで誤検出する。§13.5 が禁じるのは **選手本人の health observation**（報告された BodyRegion・選択された RedFlag・
  // pain/soreness/fatigue/sleep の値・reporter 等）であり、static policy 定義ではない（§13.5 / §17.1 [R8 errata]）。
  // そこで検査を2層に分ける:
  //   A. 個人 health data の走査 — safetyPolicy を除いた処方全体（既存 R5 invariant をそのまま維持）
  //   B. safetyPolicy 専用の検証 — strict・RuleSet と完全一致・自由記述/部位/報告者/尺度/選択値/rule id を含まない
  //   C. safetyPolicy は選手・readiness 入力・action・safetyOutcome から独立（個人入力が混入していない）
  it("A: safetyPolicy を除いた処方全体に、個人の health data（痛み・部位・尺度・報告者・生年月日・成熟度）が現れない", () => {
    const decision = resolveReadinessAction(present, context({ method: "STRIDE", ageBand: "U15" }));
    const p = expectOk(plan("STRIDE", "ST_RELAXED", { readiness: decision, subject: u18PostDeveloping() }));
    const individualScope = JSON.stringify({ ...p, monitoringSnapshot: { ...p.monitoringSnapshot, safetyPolicy: null } }).toLowerCase();
    for (const key of [...FORBIDDEN_KEYS, "athleteReport", "readinessReport", "painNow", "painRegion"]) {
      expect(individualScope, key).not.toContain(key.toLowerCase());
    }
    // 残ってよいのは「適用した action」と safetyOutcome だけ
    expect(p.readinessApplied.length).toBeGreaterThan(0);
    expect(p.safetyOutcome).toBe("COACH_REVIEW");
    // 選手が報告した部位の値・尺度の名前は、safetyPolicy を含む処方全体のどこにも現れない
    const fullJson = JSON.stringify(p);
    for (const region of present.pain.regions) expect(fullJson, region).not.toContain(region);
    for (const word of ["region", "soreness", "fatigue", "sleep", "reporter"]) expect(fullJson.toLowerCase(), word).not.toContain(word);
  });

  it("B: safetyPolicy は strict な static policy — RuleSet の red flag グループと完全一致し、自由記述・部位・報告者・尺度・rule id を持たない", () => {
    const decision = resolveReadinessAction(present, context({ method: "STRIDE", ageBand: "U15" }));
    const policy = expectOk(plan("STRIDE", "ST_RELAXED", { readiness: decision, subject: u18PostDeveloping() })).monitoringSnapshot.safetyPolicy;

    // RuleSet の PAIN_RED_FLAG_GROUP 行（redFlags / safetyOutcome / severityRank）と PAIN_PRESENT 行の safetyOutcome のコピーだけ
    expect(policy).toEqual({
      redFlagGroups: ruleSet.readinessRules.flatMap((r) =>
        r.kind === "PAIN_RED_FLAG_GROUP" ? [{ redFlags: r.redFlags, safetyOutcome: r.safetyOutcome, severityRank: r.severityRank }] : [],
      ),
      painPresentOutcome: ruleSet.readinessRules.find((r) => r.kind === "PAIN_PRESENT")!.safetyOutcome,
    });

    // 構造: 許されるキーだけ・文字列は RedFlag / SafetyOutcome の enum 値だけ（自由記述・BodyRegion を含まない）・数値は severityRank だけ
    const ALLOWED_KEYS = new Set(["redFlagGroups", "redFlags", "safetyOutcome", "severityRank", "painPresentOutcome"]);
    const ALLOWED_STRINGS = new Set<string>([...RED_FLAGS, ...SAFETY_OUTCOMES]);
    const walk = (value: unknown, key: string | null): void => {
      if (Array.isArray(value)) return value.forEach((v) => walk(v, key));
      if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          expect(ALLOWED_KEYS.has(k), k).toBe(true);
          walk(v, k);
        }
        return;
      }
      if (typeof value === "string") {
        expect(ALLOWED_STRINGS.has(value), value).toBe(true);
        expect((BODY_REGIONS as readonly string[]).includes(value), value).toBe(false);
      } else {
        expect(key, String(value)).toBe("severityRank");
        expect(Number.isInteger(value)).toBe(true);
      }
    };
    walk(policy, null);
    const policyJson = JSON.stringify(policy);
    expect(policyJson).not.toContain("RDN_");
    for (const word of ["reporter", "reportedAt", "soreness", "fatigue", "sleep", "region"]) expect(policyJson.toLowerCase(), word).not.toContain(word.toLowerCase());

    // strict: 選手の値や rule id・自由記述を混ぜた snapshot は schema が拒否する
    const group0 = policy.redFlagGroups[0];
    const rejects = [
      { ...policy, regions: ["KNEE"] },
      { ...policy, reporter: "ATHLETE" },
      { ...policy, selectedRedFlags: ["LIMPING"] },
      { ...policy, note: "膝が痛い" },
      { ...policy, redFlagGroups: [{ ...group0, sourceRuleId: "RDN_RED_FLAG_MEDICAL" }, ...policy.redFlagGroups.slice(1)] },
      { ...policy, redFlagGroups: [{ ...group0, soreness: 4 }, ...policy.redFlagGroups.slice(1)] },
    ];
    expect(runtimeSafetyPolicySnapshotSchema.safeParse(policy).success).toBe(true);
    for (const bad of rejects) expect(runtimeSafetyPolicySnapshotSchema.safeParse(bad).success, JSON.stringify(Object.keys(bad))).toBe(false);
  });

  it("C: safetyPolicy は選手・readiness 入力・readiness action・safetyOutcome から独立（個人入力が混入しない）", () => {
    const variants: [string, RunningPrescriptionValue][] = [
      ["readiness なし・ADULT", expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { subject: adultAdvanced() }))],
      ["痛みあり（部位2つ・尺度高）・U18", expectOk(plan("STRIDE", "ST_RELAXED", { readiness: resolveReadinessAction(present, context({ method: "STRIDE", ageBand: "U15" })), subject: u18PostDeveloping() }))],
      ["疲労のみ（USE_LOWER_BOUND 等・safetyOutcome NONE）", expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { readiness: resolveReadinessAction(report({ fatigue: 4 }), context({ method: "TEMPO_EXTENSIVE" })) }))],
      ["痛みなし・NO_CHANGE", expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { readiness: resolveReadinessAction(report(), context()) }))],
      ["別部位の痛み", expectOk(plan("STRIDE", "ST_RELAXED", { readiness: resolveReadinessAction(report({ pain: { status: "PRESENT", regions: ["HEEL"], redFlags: [] } }), context({ method: "STRIDE" })) }))],
    ];
    const outcomes = new Set(variants.map(([, p]) => p.safetyOutcome));
    const actions = new Set(variants.map(([, p]) => JSON.stringify(p.readinessApplied)));
    expect(outcomes.size).toBeGreaterThan(1);
    expect(actions.size).toBeGreaterThan(1);
    const [, first] = variants[0];
    for (const [label, p] of variants) expect(p.monitoringSnapshot.safetyPolicy, label).toEqual(first.monitoringSnapshot.safetyPolicy);
  });

  it("rationale の日本語も、行った調整だけを述べて入力内容を述べない", () => {
    const decision = resolveReadinessAction(report({ fatigue: 4 }), context({ method: "TEMPO_EXTENSIVE" }));
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { readiness: decision }));
    const ja = renderRationaleJa(p.rationale);
    for (const line of ja) {
      expect(line).not.toMatch(/痛み|部位|膝|かかと|睡眠|筋肉痛|疲労度|保護者/);
    }
  });

  it("transientFindings は処方に保存しない（表示用）", () => {
    const decision = resolveReadinessAction(present, context({ method: "STRIDE", ageBand: "U15" }));
    expect(decision.transientFindings.length).toBeGreaterThan(0);
    const p = expectOk(plan("STRIDE", "ST_RELAXED", { readiness: decision, subject: u18PostDeveloping() }));
    const codes = p.findings.map((f) => f.code);
    for (const t of decision.transientFindings) expect(codes).not.toContain(t.code);
  });

  it("AI に渡す文脈は tier / 年齢帯 / Method の可否 / 当日の高強度可否だけ", () => {
    const profile = resolveSubjectProfile({ subject: u18PostDeveloping(), asOf: iso(PLANNING_DATE), ruleSet });
    const decision = resolveReadinessAction(present, context({ method: "ACCELERATION", ageBand: "U18" }));
    const ctx = buildAiSafeSubjectContext({ profile, ruleSet, decision });
    expect(Object.keys(ctx).sort()).toEqual(
      ["ageBand", "allowedMethods", "autogenBlockedMethods", "highIntensityAllowedToday", "primaryEvent", "tier"].sort(),
    );
    const json = JSON.stringify(ctx);
    for (const key of FORBIDDEN_KEYS) expect(json.toLowerCase(), key).not.toContain(key.toLowerCase());
    expect(ctx.highIntensityAllowedToday).toBe(false);
    // 高強度 Method は当日の自動生成から外れる
    expect(ctx.autogenBlockedMethods).toContain("ACCELERATION");
  });

  it("年齢帯が観測できないときは UNKNOWN のまま（U12 等へ偽装しない）", () => {
    const profile = resolveSubjectProfile({
      subject: athlete({ birthDate: null }),
      asOf: iso(PLANNING_DATE),
      ruleSet,
    });
    const ctx = buildAiSafeSubjectContext({ profile, ruleSet, decision: null });
    expect(ctx.ageBand).toBe("UNKNOWN");
    expect(ctx.highIntensityAllowedToday).toBe(true);
  });

  it("痛み未確認の日は UNKNOWN を AI へそのまま伝える（true と偽らない）", () => {
    const profile = resolveSubjectProfile({ subject: u18PostDeveloping(), asOf: iso(PLANNING_DATE), ruleSet });
    const decision = resolveReadinessAction(report({ pain: { status: "NOT_ASKED", regions: [], redFlags: [] } }), context({ ageBand: "U18" }));
    const ctx = buildAiSafeSubjectContext({ profile, ruleSet, decision });
    expect(ctx.highIntensityAllowedToday).toBe("UNKNOWN");
    expect(ctx.autogenBlockedMethods).toContain("ACCELERATION");
  });
});

// ---------------------------------------------------------------------------
// RuleSet 由来であることの検証（TS 側に数値を複製していない）
// ---------------------------------------------------------------------------

describe("判定データは RuleSet 側にある（RuleSet を変えれば判定が変わる）", () => {
  function withRules(mutate: (rules: RuleSet["readinessRules"]) => RuleSet["readinessRules"]): RuleSet {
    return ruleSetSchema.parse({ ...ruleSet, readinessRules: mutate(ruleSet.readinessRules) });
  }

  it("fatigue のしきい値を 4 → 5 に変えると fatigue=4 の判定が変わる", () => {
    const raised = withRules((rules) => rules.map((r) => (r.kind === "WELLNESS_SIGNAL" && r.id === "RDN_FATIGUE_HIGH" ? { ...r, threshold: 5 } : r)));
    const base = deriveReadinessActions({ report: report({ fatigue: 4 }), windowState: "NOT_EVALUATED", rules: ruleSet.readinessRules });
    const changed = deriveReadinessActions({ report: report({ fatigue: 4 }), windowState: "NOT_EVALUATED", rules: raised.readinessRules });
    expect(normalizeReadinessActions(base.actions)).toEqual(["USE_LOWER_BOUND", "INCREASE_REST"]);
    expect(normalizeReadinessActions(changed.actions)).toEqual(["NO_CHANGE"]);
  });

  it("SWAP 先を変えると候補が変わる", () => {
    const changed = withRules((rules) =>
      rules.map((r) =>
        r.kind === "SWAP_TARGET" && r.id === "RDN_SWAP_HIGH_NEURAL"
          ? { ...r, targets: [{ method: "TEMPO_EXTENSIVE" as const, templateIds: ["TE_200"] }] }
          : r,
      ),
    );
    expect(resolveSwapTargets(ruleSet, "ACCELERATION")).toEqual({ outcome: "SWAP", candidates: [{ method: "STRIDE", templateId: "ST_RELAXED" }] });
    expect(resolveSwapTargets(changed, "ACCELERATION")).toEqual({
      outcome: "SWAP",
      candidates: [{ method: "TEMPO_EXTENSIVE", templateId: "TE_200" }],
    });
  });

  it("red flag のグループを変えると STOP の outcome が変わる", () => {
    const changed = withRules((rules) =>
      rules.map((r) => (r.kind === "PAIN_RED_FLAG_GROUP" && r.id === "RDN_RED_FLAG_MEDICAL" ? { ...r, safetyOutcome: "COACH_REVIEW" as const } : r)),
    );
    const pain: PainReport = { status: "PRESENT", regions: [], redFlags: ["SWELLING"] };
    expect(evaluatePainGate({ pain, ageBand: "ADULT", loadClass: "HIGH_NEURAL", rules: ruleSet.readinessRules }).safetyOutcome).toBe(
      "MEDICAL_EVALUATION_RECOMMENDED",
    );
    expect(evaluatePainGate({ pain, ageBand: "ADULT", loadClass: "HIGH_NEURAL", rules: changed.readinessRules }).safetyOutcome).toBe("COACH_REVIEW");
  });

  it("TS 側に閾値・グループ・SWAP 先を複製していない（readiness/ に数値リテラルを置かない）", () => {
    const dir = path.join(process.cwd(), "src/domain/running/readiness");
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), "utf-8");
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
        .join("\n");
      // 倍率・割合の類を作らない（§13 は離散 action のみ）
      expect(code, file).not.toMatch(/\*\s*0\./);
      expect(code, file).not.toMatch(/\/\s*100/);
      expect(code, file).not.toMatch(/readinessFactor|multiplier|percentage/i);
      // red flag 名・部位名・しきい値を TS 側に書かない
      expect(code, file).not.toContain("PAIN_AT_REST_OR_NIGHT");
      expect(code, file).not.toContain("HIP_PELVIS");
      expect(code, file).not.toMatch(/soreness\s*[><=]=?\s*[0-9]/);
    }
  });

  it("planning 側にも readiness 由来の係数が無い", () => {
    const build = fs.readFileSync(path.join(process.cwd(), "src/domain/running/planning/build.ts"), "utf-8");
    expect(build).not.toMatch(/readinessFactor|readinessMultiplier/i);
  });
});

// ---------------------------------------------------------------------------
// 公開 API の範囲
// ---------------------------------------------------------------------------

describe("root public API", () => {
  it("resolveReadinessAction と型だけを公開し、内部ロジックは公開しない", () => {
    expect(typeof runningApi.resolveReadinessAction).toBe("function");
    for (const name of ["evaluatePainGate", "deriveReadinessActions", "resolveSwapTargets", "buildAiSafeSubjectContext"]) {
      expect(Object.keys(runningApi), name).not.toContain(name);
    }
  });

  it("決定的: 同じ入力は同じ判断（RuleSet の identity 付き）", () => {
    const a = resolveReadinessAction(report({ soreness: 3, sleepQuality: 2 }), context());
    const b = resolveReadinessAction(report({ soreness: 3, sleepQuality: 2 }), context());
    expect(a).toEqual(b);
    expect(a.ruleSet).toEqual({ version: "rs-2026.09.0", contentHash: EXPECTED_HASH, status: "ACTIVE" });
    expect(a.evaluatedFor).toEqual({ method: "ACCELERATION", loadClass: "HIGH_NEURAL" });
  });

  it("ctx.loadClass を渡す場合は RuleSet の MethodMeta と一致していなければならない", () => {
    expect(() => resolveReadinessAction(report(), { ...context(), loadClass: "LOW" } as ReadinessContext)).toThrow();
    expect(() => resolveReadinessAction(report(), { ...context(), loadClass: "HIGH_NEURAL" } as ReadinessContext)).not.toThrow();
  });

  it("ReadinessDecision は健康情報そのものを持たない形しか受け付けない（.strict()）", () => {
    const decision = resolveReadinessAction(report(), context()) as ReadinessDecision & { pain?: unknown };
    const withPain = { ...decision, pain: NO_PAIN };
    expect(planRequestSchema.safeParse(makeRequest("ACCELERATION", "ACC_BLOCK_20", { readiness: withPain })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [R5 pre-commit correction] LOWER_BOUND = 全 recommended 制約を満たす最小 feasible 解
// ---------------------------------------------------------------------------

/** OK 処方に含まれる FieldValue（rest かどうかも持つ）。 */
type FieldRecord = { name: string; rest: boolean; fv: FieldValue<Unit> };

function collectFieldValues(p: RunningPrescriptionValue): FieldRecord[] {
  const out: FieldRecord[] = [
    { name: "sets", rest: false, fv: p.sets },
    { name: "repsPerSet", rest: false, fv: p.repsPerSet },
    { name: "repRestS", rest: true, fv: p.rest.repRestS },
  ];
  if (p.rest.setRestS) out.push({ name: "setRestS", rest: true, fv: p.rest.setRestS });
  if (p.rest.intraRepRestS) out.push({ name: "intraRepRestS", rest: true, fv: p.rest.intraRepRestS });
  const rep = p.rep;
  if (rep.kind === "DISTANCE") out.push({ name: "repDistanceM", rest: false, fv: rep.distanceM });
  if (rep.kind === "FLY") {
    out.push({ name: "buildUpM", rest: false, fv: rep.buildUpDistanceM }, { name: "flyZoneM", rest: false, fv: rep.flyZoneDistanceM });
  }
  if (rep.kind === "DURATION") out.push({ name: "repDurationS", rest: false, fv: rep.durationS });
  return out;
}

const inRange = (v: number, r: { min: number; max: number } | null) => r !== null && v >= r.min - 1e-9 && v <= r.max + 1e-9;

/** エンジンが導出した総量（sessionVolumeM / flyVolumeM）を処方から再計算する。 */
function derivedVolumes(p: RunningPrescriptionValue, subject: Subject) {
  const profile = resolveSubjectProfile({ subject, asOf: iso(PLANNING_DATE), ruleSet });
  const env = selectEnvelope(ruleSet, { method: p.method, templateId: p.templateId } as never, profile.envelopeTier, p.recoveryStructure);
  if (!env.ok) throw new Error("envelope");
  const totalReps = p.sets.value * p.repsPerSet.value;
  const out: { field: string; derived: number; recommended: { min: number; max: number } | null }[] = [];
  const session = env.envelope.fields.sessionVolumeM;
  const fly = env.envelope.fields.flyVolumeM;
  if (session && p.rep.kind === "DISTANCE") {
    out.push({ field: "sessionVolumeM", derived: totalReps * p.rep.distanceM.value, recommended: session.recommended });
  }
  if (fly && p.rep.kind === "FLY") {
    out.push({ field: "flyVolumeM", derived: totalReps * p.rep.flyZoneDistanceM.value, recommended: fly.recommended });
  }
  return out;
}

/** readiness 有無の代表ケース（すべて engine 生成・coach 入力なし）。 */
const VOLUME_CASES = [
  { method: "ACCELERATION", templateId: "ACC_BLOCK_20", subject: adultAdvanced() },
  { method: "ACCELERATION", templateId: "ACC_BLOCK_20", subject: u18PostDeveloping() },
  { method: "TEMPO_EXTENSIVE", templateId: "TE_200", subject: adultAdvanced() },
  { method: "TEMPO_EXTENSIVE", templateId: "TE_200", subject: u18PostDeveloping() },
  { method: "STRIDE", templateId: "ST_RELAXED", subject: adultAdvanced() },
  { method: "MAX_VELOCITY", templateId: "MV_FLY20", subject: adultAdvanced() },
] as const;

const READINESS_VARIANTS = [
  { label: "null", build: () => null },
  { label: "NO_CHANGE", build: (method: string) => resolveReadinessAction(report(), context({ method } as never)) },
  { label: "USE_LOWER_BOUND+INCREASE_REST", build: (method: string) => resolveReadinessAction(report({ fatigue: 4 }), context({ method } as never)) },
  {
    label: "USE_LOWER_BOUND(window)",
    build: (method: string) =>
      resolveReadinessAction(report({ soreness: null, fatigue: null, sleepQuality: null }), context({ method, readinessWindowState: "ACTIVE" } as never)),
  },
] as const;

describe("[R5 correction] LOWER_BOUND は recommended を満たす最小 feasible 解", () => {
  it("ACC: 20m 固定 × sessionVolume recommended [100,300] → 5本=100m（4本=80m へ落とさない）", () => {
    const decision = resolveReadinessAction(report({ fatigue: 4 }), context({ method: "ACCELERATION" }));
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { readiness: decision }));
    expect(p.sets.value * p.repsPerSet.value).toBe(5);
    const volumes = derivedVolumes(p, adultAdvanced());
    expect(volumes).toEqual([{ field: "sessionVolumeM", derived: 100, recommended: { min: 100, max: 300, unit: "m" } }]);
  });

  it("TEMPO_EXTENSIVE: 200m 固定 × sessionVolume recommended [1000,2000] → 5本=1000m（4本=800m へ落とさない）", () => {
    const decision = resolveReadinessAction(report({ fatigue: 4 }), context({ method: "TEMPO_EXTENSIVE" }));
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { readiness: decision }));
    expect(p.sets.value * p.repsPerSet.value).toBe(5);
    expect(derivedVolumes(p, adultAdvanced())).toEqual([
      { field: "sessionVolumeM", derived: 1000, recommended: { min: 1000, max: 2000, unit: "m" } },
    ]);
  });

  it("STRIDE: scalar 距離は LOWER_BOUND（80m）まで下がり、総量は recommended 下限（240m）を満たす", () => {
    const decision = resolveReadinessAction(report({ fatigue: 4 }), context({ method: "STRIDE" }));
    const p = expectOk(plan("STRIDE", "ST_RELAXED", { readiness: decision }));
    if (p.rep.kind !== "DISTANCE") throw new Error("setup");
    expect(p.rep.distanceM).toMatchObject({ value: 80, origin: "ENGINE_POSITIONED", position: "LOWER_BOUND" });
    const [volume] = derivedVolumes(p, adultAdvanced());
    expect(volume.derived).toBe(240);
    expect(inRange(volume.derived, volume.recommended)).toBe(true);
  });

  it("engine 生成の sessionVolume / flyVolume は必ず recommended 範囲内（readiness 有無を問わず）", () => {
    for (const c of VOLUME_CASES) {
      for (const variant of READINESS_VARIANTS) {
        const readiness = variant.build(c.method);
        const r = plan(c.method, c.templateId, { subject: c.subject, readiness });
        if (r.status !== "OK") continue; // eligibility で作れない組み合わせは対象外
        for (const v of derivedVolumes(r.prescription, c.subject)) {
          expect(
            inRange(v.derived, v.recommended),
            `${c.method}/${c.templateId}/${variant.label}: ${v.field}=${v.derived} ∉ ${JSON.stringify(v.recommended)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("R4 PROPERTY 維持: override が無ければ engine 生成値は必ず recommended 内（readiness ありでも同じ）", () => {
    for (const c of VOLUME_CASES) {
      for (const variant of READINESS_VARIANTS) {
        const r = plan(c.method, c.templateId, { subject: c.subject, readiness: variant.build(c.method) });
        if (r.status !== "OK") continue;
        for (const f of collectFieldValues(r.prescription)) {
          if (f.fv.origin !== "ENGINE_POSITIONED" && f.fv.origin !== "SOLVER_DERIVED") continue;
          expect(inRange(f.fv.value, f.fv.recommended), `${c.method}/${variant.label}/${f.name}=${f.fv.value}`).toBe(true);
        }
      }
    }
  });

  it("readiness だけを理由に OUTSIDE_RECOMMENDED は出ない", () => {
    for (const c of VOLUME_CASES) {
      for (const variant of READINESS_VARIANTS) {
        const r = plan(c.method, c.templateId, { subject: c.subject, readiness: variant.build(c.method) });
        if (r.status !== "OK") continue;
        expect(r.prescription.findings.map((f) => f.code), `${c.method}/${variant.label}`).not.toContain("OUTSIDE_RECOMMENDED");
      }
    }
  });

  it("SOLVER_DERIVED の回数は position=null のまま（LOWER_BOUND へ偽装しない）", () => {
    const decision = resolveReadinessAction(report({ fatigue: 4 }), context({ method: "TEMPO_EXTENSIVE" }));
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { readiness: decision }));
    for (const f of collectFieldValues(p)) {
      if (f.fv.origin === "SOLVER_DERIVED") expect(f.fv.position, f.name).toBeNull();
    }
  });

  it("recommended を満たす解が無ければ readiness を理由に下回らず ENVELOPE_INFEASIBLE にする", () => {
    // sessionVolume recommended の下限を、どの回数でも届かない値へ上げた RuleSet
    const impossible: RuleSet = ruleSetSchema.parse({
      ...ruleSet,
      envelopes: ruleSet.envelopes.map((e) =>
        e.templateIds.includes("TE_200") && e.tier === "ADVANCED" && e.fields.sessionVolumeM
          ? {
              ...e,
              fields: {
                ...e.fields,
                sessionVolumeM: {
                  ...e.fields.sessionVolumeM,
                  recommended: { min: 9999, max: 10000, unit: "m" },
                  coachEditable: { min: 1, max: 20000, unit: "m" },
                },
              },
            }
          : e,
      ),
    });
    const decision = resolveReadinessAction(report({ fatigue: 4 }), context({ method: "TEMPO_EXTENSIVE" }));
    const r = planRunningPrescriptionWithRuleSet(makeRequest("TEMPO_EXTENSIVE", "TE_200", { readiness: decision }), {
      ruleSet: impossible,
      contentHash: EXPECTED_HASH,
      isDraftFallback: true,
    });
    expect(r.status).toBe("BLOCKED");
    if (r.status !== "BLOCKED") throw new Error("unreachable");
    expect(r.findings.map((f) => f.code)).toContain("ENVELOPE_INFEASIBLE");
  });
});

// ---------------------------------------------------------------------------
// [R5 pre-commit correction] raw trigger と effective action の分離（§13.6）
// ---------------------------------------------------------------------------

describe("[R5 correction] override / 適用不能は「その action だけ」を外して再正規化する", () => {
  const painDown = report({ pain: { status: "PRESENT", regions: [], redFlags: [] }, performanceStatus: "DOWN" });
  const painOnly = report({ pain: { status: "PRESENT", regions: [], redFlags: [] } });

  it("判断は signal 単位の raw trigger を保持する（effective action は正規化結果）", () => {
    const d = resolveReadinessAction(painDown, context());
    expect(d.triggers).toEqual([
      { ruleId: "RDN_PAIN_PRESENT", actions: ["CANCEL_HIGH_INTENSITY", "REQUIRE_COACH_REVIEW"] },
      { ruleId: "RDN_PERFORMANCE_DOWN", actions: ["SWAP_TO_LOWER_LOAD_METHOD", "REQUIRE_COACH_REVIEW"] },
    ]);
    expect(d.actions).toEqual(["CANCEL_HIGH_INTENSITY", "SWAP_TO_LOWER_LOAD_METHOD", "REQUIRE_COACH_REVIEW"]);
  });

  it("pain PRESENT + DOWN / HIGH_* / override なし → CANCEL が効く", () => {
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: resolveReadinessAction(painDown, context()) });
    if (r.status !== "INELIGIBLE") throw new Error(describeResult(r));
    expect(r.reasons.map((x) => x.code)).toEqual(["READINESS_HIGH_INTENSITY_CANCELLED"]);
  });

  it("pain PRESENT + DOWN / HIGH_* / valid override → CANCEL だけ外れ、独立した SWAP は残る", () => {
    const r = plan("ACCELERATION", "ACC_BLOCK_20", {
      readiness: resolveReadinessAction(painDown, context()),
      overrides: [READINESS_OVERRIDE],
    });
    if (r.status !== "INELIGIBLE") throw new Error(describeResult(r));
    expect(r.reasons.map((x) => x.code)).toEqual(["READINESS_SWAP_RECOMMENDED"]);
    expect(r.substitutes.length).toBeGreaterThan(0);
  });

  it("pain PRESENT + DOWN / MODERATE Method → CANCEL は適用不能だが NO_CHANGE へ落ちず SWAP が残る", () => {
    const decision = resolveReadinessAction(painDown, context({ method: "TEMPO_EXTENSIVE" }));
    const r = plan("TEMPO_EXTENSIVE", "TE_200", { readiness: decision });
    if (r.status !== "INELIGIBLE") throw new Error(describeResult(r));
    expect(r.reasons.map((x) => x.code)).toEqual(["READINESS_SWAP_RECOMMENDED"]);
  });

  it("pain PRESENT のみ / valid override → 他の trigger が無いので REQUIRE_COACH_REVIEW だけで続行", () => {
    const p = expectOk(
      plan("ACCELERATION", "ACC_BLOCK_20", { readiness: resolveReadinessAction(painOnly, context()), overrides: [READINESS_OVERRIDE] }),
    );
    expect(p.readinessApplied).toEqual(["REQUIRE_COACH_REVIEW"]);
    expect(p.safetyOutcome).toBe("COACH_REVIEW");
  });

  it("同じ signal から CANCEL と SWAP が出ている場合、override 後に SWAP を復活させない", () => {
    const base = resolveReadinessAction(painOnly, context());
    const sameSignal = readinessDecisionSchema.parse({
      ...base,
      triggers: [{ ruleId: "RDN_PAIN_PRESENT", actions: ["CANCEL_HIGH_INTENSITY", "SWAP_TO_LOWER_LOAD_METHOD", "REQUIRE_COACH_REVIEW"] }],
      actions: ["CANCEL_HIGH_INTENSITY", "SWAP_TO_LOWER_LOAD_METHOD", "REQUIRE_COACH_REVIEW"],
    });
    const p = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { readiness: sameSignal, overrides: [READINESS_OVERRIDE] }));
    expect(p.readinessApplied).toEqual(["REQUIRE_COACH_REVIEW"]);

    // 別 signal から出ていれば SWAP は残る（同じ action 集合でも扱いが違う）
    const twoSignals = readinessDecisionSchema.parse({
      ...base,
      triggers: [
        { ruleId: "RDN_PAIN_PRESENT", actions: ["CANCEL_HIGH_INTENSITY", "REQUIRE_COACH_REVIEW"] },
        { ruleId: "RDN_PERFORMANCE_DOWN", actions: ["SWAP_TO_LOWER_LOAD_METHOD"] },
      ],
      actions: ["CANCEL_HIGH_INTENSITY", "SWAP_TO_LOWER_LOAD_METHOD", "REQUIRE_COACH_REVIEW"],
    });
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: twoSignals, overrides: [READINESS_OVERRIDE] });
    expect(r.status).toBe("INELIGIBLE");
  });

  it("actions と triggers が食い違う判断は受け付けない（片方だけ書き換えられない）", () => {
    const base = resolveReadinessAction(painDown, context());
    expect(readinessDecisionSchema.safeParse({ ...base, actions: ["NO_CHANGE"] }).success).toBe(false);
    expect(readinessDecisionSchema.safeParse({ ...base, triggers: [] }).success).toBe(false);
  });

  it("hard STOP は再正規化の対象外（override も trigger の除去も効かない）", () => {
    const stop = resolveReadinessAction(report({ pain: { status: "PRESENT", regions: [], redFlags: ["SWELLING"] } }), context());
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { readiness: stop, overrides: [READINESS_OVERRIDE] });
    expect(r.status).toBe("BLOCKED");
  });
});

describe("[R5 correction] highIntensityAllowedToday の一覧", () => {
  const cases = [
    { label: "medical STOP", rep: report({ pain: { status: "PRESENT", regions: [], redFlags: ["SWELLING"] } }), expected: false },
    { label: "coach STOP", rep: report({ pain: { status: "PRESENT", regions: [], redFlags: ["SUDDEN_SHARP_PAIN"] } }), expected: false },
    { label: "CANCEL", rep: report({ pain: { status: "PRESENT", regions: [], redFlags: [] } }), expected: false },
    { label: "SWAP", rep: report({ performanceStatus: "DOWN" }), expected: false },
    { label: "SWAP(soreness>=4)", rep: report({ soreness: 4 }), expected: false },
    { label: "LOWER_BOUND+INCREASE_REST", rep: report({ fatigue: 4 }), expected: true },
    { label: "NO_CHANGE", rep: report(), expected: true },
  ] as const;

  it("CANCEL / SWAP / STOP の日は true にならない", () => {
    for (const c of cases) {
      expect(resolveReadinessAction(c.rep, context()).highIntensityAllowedToday, c.label).toBe(c.expected);
    }
  });

  it("未成年の痛み未確認は UNKNOWN（true とも false とも断定しない）", () => {
    const d = resolveReadinessAction(report({ pain: { status: "NOT_ASKED", regions: [], redFlags: [] } }), context({ ageBand: "U15" }));
    expect(d.highIntensityAllowedToday).toBe("UNKNOWN");
  });
});

describe("[R5 correction] raw trigger の provenance は処方へ出さない", () => {
  it("prescription JSON に RuleSet の rule id（RDN_*）が現れない", () => {
    const decision = resolveReadinessAction(report({ pain: { status: "PRESENT", regions: ["KNEE"], redFlags: [] }, fatigue: 4 }), context({ method: "STRIDE" }));
    expect(decision.triggers.length).toBeGreaterThan(0);
    const p = expectOk(plan("STRIDE", "ST_RELAXED", { readiness: decision }));
    expect(JSON.stringify(p)).not.toContain("RDN_");
  });

  it("triggers も rule id と action しか持たない（健康情報の値を含まない）", () => {
    const decision = resolveReadinessAction(report({ pain: { status: "PRESENT", regions: ["KNEE"], redFlags: [] }, soreness: 4 }), context());
    for (const t of decision.triggers) {
      expect(Object.keys(t).sort()).toEqual(["actions", "ruleId"]);
      for (const a of t.actions) expect(READINESS_ACTION_CODES).toContain(a);
    }
  });

  it("readinessRules の順序を入れ替えても trigger 集合は変わらない", () => {
    const shuffled = [...ruleSet.readinessRules].reverse();
    const rep = report({ soreness: 3, sleepQuality: 2, performanceStatus: "DOWN" });
    const base = deriveReadinessActions({ report: rep, windowState: "NOT_EVALUATED", rules: ruleSet.readinessRules });
    const rev = deriveReadinessActions({ report: rep, windowState: "NOT_EVALUATED", rules: shuffled });
    expect(rev.triggers).toEqual(base.triggers);
  });
});
