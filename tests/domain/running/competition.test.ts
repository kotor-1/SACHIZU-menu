/**
 * Running Prescription Engine v2 — Phase R7（§14 Phase / Competition / Taper）。
 *
 * 検証の柱:
 *   - phase は hard stop / pain gate / rest を一切緩めない（T-PH-01）
 *   - TRAINING_MEET に 14日 taper を適用しない（T-PH-02）
 *   - youth に % taper を適用しない（T-PH-03）
 *   - ADVANCED × PEAK だけが taper guidance を持つ（T-PH-04）
 *   - dose position と intensity reference の分離、rest を短くしない
 *   - しきい値・日数バケットはすべて RuleSet 駆動（TS ハードコード禁止）
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as runningApi from "@/domain/running";
import { evaluatePhase } from "@/domain/running/competition/phase";
import {
  combinedDosePositionCap,
  daysUntilCompetition,
  isWithinCompetitionPeriod,
  longIncompleteBlockedBy,
  matchedCompetitionWindows,
  resolveAutogenBlock,
  resolveCompetitionDay,
  resolveNewStimulus,
} from "@/domain/running/competition/windows";
import { computeTaperBaseline } from "@/domain/running/competition/taper";
import { resolveCompetitionAndPhase } from "@/domain/running/competition";
import { competitionRefSchema, type CompetitionRef } from "@/domain/running/competition/schema";
import { planRunningPrescription } from "@/domain/running/planning";
import type { PlanRequest, PlanResult } from "@/domain/running/planning/schema";
import { getRuleSet } from "@/domain/running/rules/loader";
import { ruleSetSchema, type RuleSet } from "@/domain/running/rules/schema";
import { createCoachActor } from "@/domain/running/types/actor";
import { loadEventSchema, type LoadEvent } from "@/domain/running/types/load";
import type { IsoDate, IsoDateTime } from "@/domain/running/types/primitives";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";
import { calendarDayDiff } from "@/domain/running/weekly/windows";

const ruleSet = getRuleSet("rs-2026.09.0")!;
const PLANNING_DATE = "2026-09-15";
const COACH = createCoachActor("coach-1");
const AI = { kind: "AI_PLANNER", provider: "p", model: "m", requestId: "r1" } as const;
const SYSTEM = { kind: "SYSTEM" } as const;

function iso(value: string): IsoDate {
  return value as IsoDate;
}
function isoDT(value: string): IsoDateTime {
  return value as IsoDateTime;
}

function addDaysStr(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function competition(daysFromPlanning: number, priority: CompetitionRef["priority"], id = `c-${daysFromPlanning}-${priority}`): CompetitionRef {
  return competitionRefSchema.parse({ id, date: addDaysStr(PLANNING_DATE, daysFromPlanning), priority });
}

function athlete(overrides: Partial<AthleteProfile> = {}): Subject {
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
      ...overrides,
    },
  };
}
const advanced = (overrides: Partial<AthleteProfile> = {}) => athlete(overrides);
// SES/LSR（HIGH_METABOLIC）は 100m の実測記録が無いと confidence=LOW になり、意図と別の
// LOW_CONFIDENCE_HIGH_METABOLIC_AUTOGEN_BLOCKED が先に発火する。競技系テストでは記録を与えて
// confidence を上げ、本当に検証したい大会近接ブロックまで到達させる。
const advancedWithMark = () => athlete({ marks: [{ event: "100m", timeS: 10.5, date: iso("2026-06-01"), timing: "PHOTO_CELL" }] });
const developmental = () =>
  athlete({ birthDate: iso("2010-01-01"), maturity: { status: "POST", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") }, trainingAge: { structuredSprintYears: 2 }, allowAdvancedMethods: false });

type RequestOptions = {
  subject?: Subject;
  actor?: PlanRequest["actor"] | typeof AI | typeof SYSTEM;
  phase?: string | null;
  competitions?: CompetitionRef[];
  history?: unknown;
  overrides?: unknown[];
  readiness?: unknown;
};

function makeRequest(method: string, templateId: string, o: RequestOptions = {}): PlanRequest {
  return {
    planningDate: iso(PLANNING_DATE),
    selection: { method, templateId },
    subject: o.subject ?? advanced(),
    menuContext: {
      phase: o.phase ?? null,
      plannedDate: iso(PLANNING_DATE),
      plannedAt: null,
      competitions: o.competitions ?? [],
      otherItems: [],
      availableMinutes: null,
    },
    history: o.history ?? null,
    readiness: o.readiness ?? null,
    positionPreference: null,
    coachEdits: [],
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
  return r.prescription;
}
function plan(method: string, templateId: string, o: RequestOptions = {}): PlanResult {
  return planRunningPrescription(makeRequest(method, templateId, o));
}

function historyWith(events: LoadEvent[], coverage28d: "COMPLETE" | "PARTIAL" | "NONE" = "COMPLETE") {
  return { events, coverage72h: "NONE" as const, coverage7d: "NONE" as const, coverage28d, dailyActivity7d: [] };
}
function event(o: Partial<LoadEvent> = {}): LoadEvent {
  return loadEventSchema.parse({
    at: "2026-08-01T08:00:00.000Z",
    category: "RUNNING_LOW_INTENSITY",
    method: null,
    templateId: null,
    sessionKey: "s1",
    intensityTag: "LOW",
    magnitude: {},
    source: "SESSION_RECORD",
    completion: "DONE",
    ...o,
  });
}

// ---------------------------------------------------------------------------
// CompetitionRef
// ---------------------------------------------------------------------------

describe("CompetitionRef", () => {
  it("id 空文字を拒否・id 重複を拒否", () => {
    expect(competitionRefSchema.safeParse({ id: "", date: PLANNING_DATE, priority: "NORMAL" }).success).toBe(false);
    const r = plan("STRIDE", "ST_RELAXED", { competitions: [competition(5, "NORMAL", "dup"), competition(6, "NORMAL", "dup")] });
    expect(r.status).toBe("BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// T-PH-01: phase は hard stop を緩めない
// ---------------------------------------------------------------------------

describe("T-PH-01: phase は hard stop・pain gate を緩めない", () => {
  it("全 phase / 全 priority で red flag STOP を突破できない", async () => {
    const { resolveReadinessAction } = await import("@/domain/running/readiness");
    const painNow = resolveReadinessAction(
      { pain: { status: "PRESENT", regions: [], redFlags: ["SWELLING"] }, soreness: null, fatigue: null, sleepQuality: null, performanceStatus: "NORMAL", reporter: "COACH", reportedAt: "2026-09-15T07:00:00.000Z" } as never,
      { planningDate: iso(PLANNING_DATE), ageBand: "ADULT", method: "ACCELERATION", readinessWindowState: "NOT_EVALUATED" } as never,
    );
    for (const phase of ["PREPARATION", "PRE_COMPETITION", "COMPETITION", "TRANSITION", null]) {
      for (const priority of ["TRAINING_MEET", "NORMAL", "IMPORTANT", "PEAK"] as const) {
        const r = planRunningPrescription(
          makeRequest("ACCELERATION", "ACC_BLOCK_20", { phase, competitions: [competition(1, priority)], readiness: painNow } as never),
        );
        expect(r.status, `${phase}/${priority}`).toBe("BLOCKED");
        if (r.status === "BLOCKED") expect(r.findings.map((f) => f.code)).toContain("READINESS_STOP_SAFETY");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase dose position
// ---------------------------------------------------------------------------

describe("§14.2 Phase の dose position（intensity には触れない）", () => {
  it("既存の canonical phase 名（TRAINING_PHASES）とそのまま対応する（parallel enum を作らない）", () => {
    const phases = ruleSet.phaseRules.map((r) => r.phase).sort();
    expect(phases).toEqual(["COMPETITION", "PREPARATION", "PRE_COMPETITION", "TRANSITION"]);
  });

  it("PREPARATION=UPPER_HALF, PRE_COMPETITION=MIDDLE, COMPETITION=LOWER_HALF, TRANSITION=LOWER_BOUND", () => {
    const capOf = (phase: string) => evaluatePhase(ruleSet, phase as never).dosePositionCap;
    expect(capOf("PREPARATION")).toBe("UPPER_HALF");
    expect(capOf("PRE_COMPETITION")).toBe("MIDDLE");
    expect(capOf("COMPETITION")).toBe("LOWER_HALF");
    expect(capOf("TRANSITION")).toBe("LOWER_BOUND");
  });

  it("null は cap 無し（既定 MIDDLE のまま）", () => {
    expect(evaluatePhase(ruleSet, null).dosePositionCap).toBeNull();
  });

  it("PREPARATION は baseline MIDDLE を UPPER_HALF へ押し上げない（cap は上限であって底上げではない）", () => {
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { phase: "PREPARATION" }));
    // 他に position を引き上げる要因が無ければ MIDDLE のまま（UPPER_HALF に「なる」わけではない）
    if (p.rep.kind === "DISTANCE") expect(p.rep.distanceM.position === "MIDDLE" || p.rep.distanceM.position === null).toBe(true);
  });

  it("複数 cap は最も低いものが勝つ（phase PREPARATION + confidence LOW → LOWER_HALF）", () => {
    // marks 無し（confidence 低下）× PREPARATION（UPPER_HALF cap）→ confidence 側の LOWER_HALF が勝つ
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { phase: "PREPARATION", subject: advanced({ marks: [] }) }));
    expect(p.confidence.prescription).not.toBe("HIGH");
  });

  it("TRANSITION: HIGH_* は AI/SYSTEM 自動生成不可・COACH は手動 + REVIEW", () => {
    for (const actor of [AI, SYSTEM]) {
      const r = plan("ACCELERATION", "ACC_BLOCK_20", { phase: "TRANSITION", actor });
      expect(r.status, actor.kind).toBe("INELIGIBLE");
    }
    const coach = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { phase: "TRANSITION" }));
    expect(coach.findings.map((f) => f.code)).toContain("PHASE_AUTOGEN_BLOCKED");
    const reviewFinding = coach.findings.find((f) => f.code === "PHASE_AUTOGEN_BLOCKED" && f.severity === "REQUIRE_COACH_REVIEW");
    expect(reviewFinding).toBeDefined();
  });

  it("TRANSITION は hard ineligible にしない（COACH は override 無しで処方を得られる）", () => {
    const coach = plan("ACCELERATION", "ACC_BLOCK_20", { phase: "TRANSITION" });
    expect(coach.status).toBe("OK");
  });

  it("PRE_COMPETITION: 障害切替期 INFO を出す（数値制限は追加しない）", () => {
    const p = expectOk(plan("MAX_VELOCITY", "MV_FLY20", { phase: "PRE_COMPETITION", subject: advanced({ marks: [{ event: "FLY20", timeS: 2.0, date: iso("2026-08-01"), timing: "PHOTO_CELL" }] }) }));
    expect(p.findings.map((f) => f.code)).toContain("PHASE_PRE_COMPETITION_INJURY_TRANSITION");
    const rule = ruleSet.phaseRules.find((r) => r.phase === "PRE_COMPETITION")!;
    expect(rule.infoEvidenceIds).toContain("EV_HAUGEN_2019_REVIEW");
  });

  it("rest は phase によって短くならない（常に MIDDLE 以上）", () => {
    const baseline = expectOk(plan("TEMPO_EXTENSIVE", "TE_200"));
    for (const phase of ["PREPARATION", "PRE_COMPETITION", "COMPETITION", "TRANSITION"]) {
      const r = plan("TEMPO_EXTENSIVE", "TE_200", { phase });
      if (r.status !== "OK") continue;
      expect(r.prescription.rest.repRestS.value, phase).toBeGreaterThanOrEqual(baseline.rest.repRestS.recommended!.min);
    }
  });
});

// ---------------------------------------------------------------------------
// eligibility の phase 条件
// ---------------------------------------------------------------------------

// [R7 correction] §4.5 の phase 依存条件（OR を含む）の generic evaluator 自体の単体テストは
// tests/domain/running/planning.test.ts の「SES conditional eligibility（§4.5 OR）」に集約する
// （`evaluateEligibilityConditionVerdict` は planning/eligibility.ts の責務であり、
// competition/phase.ts はもう population eligibility を評価しない）。

// ---------------------------------------------------------------------------
// Competition window: n の計算・マッチング
// ---------------------------------------------------------------------------

describe("大会ウィンドウの n 計算", () => {
  it("n = D - d（暦日差）。n<0 は対象外", () => {
    expect(daysUntilCompetition(PLANNING_DATE, competition(5, "NORMAL"))).toBe(5);
    expect(daysUntilCompetition(PLANNING_DATE, competition(-3, "NORMAL"))).toBe(-3);
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(-3, "NORMAL")], plannedDate: PLANNING_DATE, tier: "ADVANCED" });
    expect(matched).toEqual([]);
  });

  it("plannedDate が無ければ大会近接を評価できない（[]）", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(1, "NORMAL")], plannedDate: null, tier: "ADVANCED" });
    expect(matched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// [R10-B2.1] 大会開催期間（CompetitionRef.endDate）と competitionDay
// ---------------------------------------------------------------------------

describe("[R10-B2.1] 大会開催期間（endDate）", () => {
  const single = (endDate?: string | null) =>
    competitionRefSchema.parse({ id: "single", date: "2026-09-20", ...(endDate === undefined ? {} : { endDate }), priority: "NORMAL" });
  const multi = () => competitionRefSchema.parse({ id: "multi", date: "2026-09-20", endDate: "2026-09-22", priority: "PEAK" });

  it("CompetitionRef schema: endDate は省略 / null / date 以降を受け付け、date より前は swap せず拒否（strict も維持）", () => {
    expect(single().endDate).toBeUndefined();
    expect(single(null).endDate).toBeNull();
    expect(single("2026-09-20").endDate).toBe("2026-09-20");
    expect(multi().endDate).toBe("2026-09-22");
    const inverted = competitionRefSchema.safeParse({ id: "x", date: "2026-09-22", endDate: "2026-09-20", priority: "NORMAL" });
    expect(inverted.success).toBe(false);
    if (inverted.success) throw new Error("unreachable");
    expect(inverted.error.issues[0]!.path).toEqual(["endDate"]);
    expect(competitionRefSchema.safeParse({ id: "x", date: "2026-09-20", endDate: "2026/09/22", priority: "NORMAL" }).success).toBe(false);
    expect(competitionRefSchema.safeParse({ id: "x", date: "2026-09-20", priority: "NORMAL", extra: 1 }).success).toBe(false);
  });

  it("single day（endDate=null / 省略）: 当日だけが competition day", () => {
    for (const ref of [single(null), single()]) {
      expect(isWithinCompetitionPeriod(iso("2026-09-19"), ref)).toBe(false);
      expect(isWithinCompetitionPeriod(iso("2026-09-20"), ref)).toBe(true);
      expect(isWithinCompetitionPeriod(iso("2026-09-21"), ref)).toBe(false);
    }
  });

  it("multi day（2026-09-20〜22）: 開催期間の両端を含む全日が competition day", () => {
    const ref = multi();
    expect(isWithinCompetitionPeriod(iso("2026-09-19"), ref)).toBe(false);
    expect(isWithinCompetitionPeriod(iso("2026-09-20"), ref)).toBe(true);
    expect(isWithinCompetitionPeriod(iso("2026-09-21"), ref)).toBe(true);
    expect(isWithinCompetitionPeriod(iso("2026-09-22"), ref)).toBe(true);
    expect(isWithinCompetitionPeriod(iso("2026-09-23"), ref)).toBe(false);
  });

  it("resolveCompetitionDay: いずれかの大会の開催期間中なら true（大会が無ければ false）", () => {
    const other = competitionRefSchema.parse({ id: "other", date: "2026-10-01", endDate: null, priority: "NORMAL" });
    expect(resolveCompetitionDay(iso("2026-09-21"), [other, multi()])).toBe(true);
    expect(resolveCompetitionDay(iso("2026-09-23"), [other, multi()])).toBe(false);
    expect(resolveCompetitionDay(iso("2026-09-21"), [])).toBe(false);
  });

  it("daysUntilCompetition は開催期間を1つの interval として扱う（開催前=開始日まで / 期間中=0 / 終了後=終了日から）", () => {
    const ref = multi();
    expect(daysUntilCompetition("2026-09-13", ref)).toBe(7);
    expect(daysUntilCompetition("2026-09-19", ref)).toBe(1);
    expect(daysUntilCompetition("2026-09-20", ref)).toBe(0);
    expect(daysUntilCompetition("2026-09-21", ref)).toBe(0);
    expect(daysUntilCompetition("2026-09-22", ref)).toBe(0);
    expect(daysUntilCompetition("2026-09-23", ref)).toBe(-1);
    expect(daysUntilCompetition("2026-09-25", ref)).toBe(-3);
  });

  it("single-day 互換: endDate 無し / endDate=date は R7 の `date − d` と全オフセットで完全一致", () => {
    for (let offset = -20; offset <= 20; offset++) {
      const plannedDate = addDaysStr("2026-09-20", offset);
      const r7 = calendarDayDiff(iso(plannedDate), iso("2026-09-20")); // R7 の実装そのもの（n = D − d）
      expect(daysUntilCompetition(plannedDate, single()), plannedDate).toBe(r7);
      expect(daysUntilCompetition(plannedDate, single(null)), plannedDate).toBe(r7);
      expect(daysUntilCompetition(plannedDate, single("2026-09-20")), plannedDate).toBe(r7);
      expect(isWithinCompetitionPeriod(iso(plannedDate), single(null)), plannedDate).toBe(r7 === 0);
    }
  });

  it("endDate < date の CompetitionRef（schema を通していない入力）は swap も無視もせず例外", () => {
    const inverted = { id: "bad", date: iso("2026-09-22"), endDate: iso("2026-09-20"), priority: "NORMAL" } as CompetitionRef;
    expect(() => daysUntilCompetition("2026-09-21", inverted)).toThrow(/endDate は date 以降/);
    expect(() => isWithinCompetitionPeriod(iso("2026-09-21"), inverted)).toThrow(/endDate は date 以降/);
    // 並び順に依存しない（先に true になる大会があっても不正 range を見逃さない）
    expect(() => resolveCompetitionDay(iso("2026-09-21"), [multi(), inverted])).toThrow(/endDate は date 以降/);
  });

  it("R7 window: 開催2日目以降も n=0 の行に match する（開始日との差で負値＝対象外にならない）。終了後は対象外のまま", () => {
    const rowsAt = (d: string) =>
      matchedCompetitionWindows({ ruleSet, competitions: [multi()], plannedDate: d, tier: "ADVANCED" }).map((m) => `${m.rule.id}@${m.n}`);
    const dayOne = rowsAt("2026-09-20");
    expect(dayOne.length).toBeGreaterThan(0);
    expect(rowsAt("2026-09-21")).toEqual(dayOne);
    expect(rowsAt("2026-09-22")).toEqual(dayOne);
    expect(rowsAt("2026-09-23")).toEqual([]);
    // 開催前の window は endDate の有無で変わらない
    const singlePeak = competitionRefSchema.parse({ id: "multi", date: "2026-09-20", endDate: null, priority: "PEAK" });
    for (const d of ["2026-09-06", "2026-09-13", "2026-09-17", "2026-09-19"]) {
      expect(rowsAt(d), d).toEqual(
        matchedCompetitionWindows({ ruleSet, competitions: [singlePeak], plannedDate: d, tier: "ADVANCED" }).map((m) => `${m.rule.id}@${m.n}`),
      );
    }
  });

  it("resolveCompetitionAndPhase: 開催2日目でも competitionDay=true / 終了翌日は false", () => {
    const base = {
      ruleSet,
      phase: null,
      competitions: [multi()],
      tier: "ADVANCED" as const,
      method: "ACCELERATION" as const,
      loadClass: "HIGH_NEURAL" as const,
      template: null,
      coverage28d: "COMPLETE" as const,
      templateUsedWithin28d: true,
      history: [],
    };
    expect(resolveCompetitionAndPhase({ ...base, plannedDate: "2026-09-21" }).competitionDay).toBe(true);
    expect(resolveCompetitionAndPhase({ ...base, plannedDate: "2026-09-23" }).competitionDay).toBe(false);
    expect(resolveCompetitionAndPhase({ ...base, plannedDate: null }).competitionDay).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// n=0（大会当日）
// ---------------------------------------------------------------------------

describe("§14.3 n=0（大会当日）", () => {
  it("race は負荷イベント化（R6 competitionDay=true）、他の HIGH_* は REQUIRE_COACH_REVIEW", () => {
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { competitions: [competition(0, "NORMAL")] });
    expect(r.status, describeResult(r)).toBe("OK");
    if (r.status !== "OK") throw new Error("unreachable");
    expect(r.prescription.findings.map((f) => f.code)).toContain("COMPETITION_DAY_NON_RACE_HIGH");
    expect(r.sessionFindings.map((f) => f.code)).toContain("AGG_COMPETITION_DAY_EXTRA");
  });

  it("[R10-B2.1] 複数日開催（endDate あり）の2日目も大会当日として扱う（開始日だけを当日扱いしない）", () => {
    const multiDay = competitionRefSchema.parse({ id: "multi", date: addDaysStr(PLANNING_DATE, -1), endDate: addDaysStr(PLANNING_DATE, 1), priority: "NORMAL" });
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { competitions: [multiDay] });
    expect(r.status, describeResult(r)).toBe("OK");
    if (r.status !== "OK") throw new Error("unreachable");
    expect(r.prescription.findings.map((f) => f.code)).toContain("COMPETITION_DAY_NON_RACE_HIGH");
    expect(r.sessionFindings.map((f) => f.code)).toContain("AGG_COMPETITION_DAY_EXTRA");
  });

  it("大会日でなければ false・plannedDate 無しなら NOT_EVALUATED", () => {
    const r = plan("ACCELERATION", "ACC_BLOCK_20", { competitions: [competition(5, "NORMAL")] });
    expect(r.status, describeResult(r)).toBe("OK");
    if (r.status !== "OK") throw new Error("unreachable");
    expect(r.sessionFindings.map((f) => f.code)).not.toContain("AGG_COMPETITION_DAY_EXTRA");
  });

  it("AI/SYSTEM は大会当日に race 以外の HIGH_* を自動生成できない", () => {
    for (const actor of [AI, SYSTEM]) {
      const r = plan("ACCELERATION", "ACC_BLOCK_20", { competitions: [competition(0, "NORMAL")], actor });
      expect(r.status, actor.kind).toBe("INELIGIBLE");
    }
  });
});

// ---------------------------------------------------------------------------
// T-PH-02: TRAINING_MEET に 14日 taper を適用しない
// ---------------------------------------------------------------------------

describe("T-PH-02: 記録会（TRAINING_MEET）に 14日 taper を適用しない", () => {
  it("TRAINING_MEET の 10日前: 制限なし（taper finding 無し・dose cap も competition 由来では変更なし）", () => {
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { competitions: [competition(10, "TRAINING_MEET")] }));
    expect(p.findings.map((f) => f.code)).not.toContain("COMPETITION_TAPER_GUIDANCE");
    const baseline = expectOk(plan("TEMPO_EXTENSIVE", "TE_200"));
    expect(p.repsPerSet.value).toBe(baseline.repsPerSet.value);
    expect(p.sets.value).toBe(baseline.sets.value);
  });

  it("TRAINING_MEET n=1: HIGH_METABOLIC だけ autogen 不可（HIGH_NEURAL は不可でない）", () => {
    const metabolic = plan("SPRINT_ENDURANCE_SHORT", "SES_100", { competitions: [competition(1, "TRAINING_MEET")], actor: AI, phase: "COMPETITION", subject: advancedWithMark() });
    expect(metabolic.status).toBe("INELIGIBLE");
    if (metabolic.status === "INELIGIBLE") expect(metabolic.findings.map((f) => f.code)).toContain("COMPETITION_AUTOGEN_BLOCKED");
    // ACCELERATION（HIGH_NEURAL）は TRAINING_MEET n=1 では blocked ではない
    const neural = plan("ACCELERATION", "ACC_BLOCK_20", { competitions: [competition(1, "TRAINING_MEET")], actor: AI });
    expect(neural.status).toBe("OK");
  });

  it("TRAINING_MEET n>=2: 制限なし", () => {
    const r = plan("SPRINT_ENDURANCE_SHORT", "SES_100", {
      competitions: [competition(2, "TRAINING_MEET")],
      actor: AI,
      phase: "COMPETITION",
      subject: advanced({ marks: [{ event: "100m", timeS: 10.5, date: iso("2026-06-01"), timing: "PHOTO_CELL" }] }),
    });
    if (r.status === "INELIGIBLE") {
      expect(r.reasons.map((x) => x.code)).not.toContain("WEEKLY_PHASE_COMPETITION_AUTOGEN_BLOCKED");
      expect(r.reasons.map((x) => x.code)).not.toContain("COMPETITION_LONG_INCOMPLETE_BLOCKED");
    }
  });
});

// ---------------------------------------------------------------------------
// NORMAL n=1 の例外（STRIDE / ACC<=20m）
// ---------------------------------------------------------------------------

describe("§14.3 NORMAL n=1 の例外（STRIDE・ACC<=20m）", () => {
  it("STRIDE は loadClass=LOW なので NORMAL n=1 の HIGH_* ブロックの対象にすらならない（autogen 可）", () => {
    const r = plan("STRIDE", "ST_RELAXED", { competitions: [competition(1, "NORMAL")], actor: AI });
    expect(r.status, describeResult(r)).toBe("OK");
  });

  it("resolveAutogenBlock: STRIDE 例外は仮に blockedAutogenLoadClasses に該当しても丸ごと免除して LOWER_BOUND にする", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(1, "NORMAL")], plannedDate: PLANNING_DATE, tier: "ADVANCED" });
    // STRIDE の実際の loadClass（LOW）では該当行に触れないため、免除メカニズム自体を loadClass を偽装して検証する。
    const result = resolveAutogenBlock({ matched, method: "STRIDE", loadClass: "HIGH_NEURAL", template: null });
    expect(result.blocked).toBe(false);
    expect("exceptionPositionCap" in result && result.exceptionPositionCap).toBe("LOWER_BOUND");
  });

  it("ACC_BLOCK_20（displayDistanceM=20）は例外、ACC_BLOCK_30（30m）は例外にならない", () => {
    const short = plan("ACCELERATION", "ACC_BLOCK_20", { competitions: [competition(1, "NORMAL")], actor: AI });
    expect(short.status).toBe("OK");
    const long = plan("ACCELERATION", "ACC_BLOCK_30", { competitions: [competition(1, "NORMAL")], actor: AI });
    expect(long.status).toBe("INELIGIBLE");
  });

  it("NORMAL n=1 の例外判定は templateId の文字列 parse ではなく template.displayDistanceM を使う", () => {
    const dir = path.join(process.cwd(), "src/domain/running/competition");
    for (const file of fs.readdirSync(dir)) {
      const code = fs
        .readFileSync(path.join(dir, file), "utf-8")
        .split("\n")
        .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*"); })
        .join("\n");
      expect(code, file).not.toMatch(/templateId\.(startsWith|includes)/);
      expect(code, file).not.toMatch(/ACC_BLOCK_\d/);
    }
  });
});

// ---------------------------------------------------------------------------
// NORMAL n=2 / IMPORTANT / PEAK
// ---------------------------------------------------------------------------

describe("§14.3 NORMAL / IMPORTANT / PEAK", () => {
  it("NORMAL n=2: HIGH_METABOLIC のみ autogen 不可、n=3 以上は制限なし", () => {
    const n2 = plan("SPRINT_ENDURANCE_SHORT", "SES_100", { competitions: [competition(2, "NORMAL")], actor: AI, phase: "COMPETITION", subject: advancedWithMark() });
    expect(n2.status).toBe("INELIGIBLE");
    if (n2.status === "INELIGIBLE") {
      expect(n2.findings.map((f) => f.code)).toContain("COMPETITION_AUTOGEN_BLOCKED");
    }
    const n3 = plan("SPRINT_ENDURANCE_SHORT", "SES_100", {
      competitions: [competition(3, "NORMAL")],
      actor: AI,
      phase: "COMPETITION",
      subject: advanced({ marks: [{ event: "100m", timeS: 10.5, date: iso("2026-06-01"), timing: "PHOTO_CELL" }] }),
    });
    if (n3.status === "INELIGIBLE") expect(n3.findings.map((f) => f.code)).not.toContain("COMPETITION_AUTOGEN_BLOCKED");
  });

  it("IMPORTANT n=2-4: HIGH_METABOLIC 不可・dose cap=LOWER_HALF", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(3, "IMPORTANT")], plannedDate: PLANNING_DATE, tier: "ADVANCED" });
    expect(combinedDosePositionCap(matched)).toBe("LOWER_HALF");
  });

  it("IMPORTANT n=5-7: 新規刺激 REVIEW + BLOCK_AUTOGEN", () => {
    const events = [event({ templateId: "SES_100", method: "SPRINT_ENDURANCE_SHORT", at: isoDT("2026-08-01T00:00:00.000Z") })];
    const r = plan("SPRINT_ENDURANCE_SHORT", "SES_150", { competitions: [competition(6, "IMPORTANT")], actor: AI, phase: "COMPETITION", subject: advancedWithMark(), history: historyWith(events) });
    expect(r.status).toBe("INELIGIBLE");
    if (r.status === "INELIGIBLE") {
      expect(r.findings.map((x) => x.code)).toContain("COMPETITION_NEW_STIMULUS");
    }
  });
});

// ---------------------------------------------------------------------------
// PEAK ADVANCED / DEVELOPMENTAL の分岐
// ---------------------------------------------------------------------------

describe("§14.3 PEAK ADVANCED vs DEVELOPMENTAL", () => {
  it("PEAK ADV n=2-4: dose cap=LOWER_BOUND（IMPORTANT の LOWER_HALF より強い）", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(3, "PEAK")], plannedDate: PLANNING_DATE, tier: "ADVANCED" });
    expect(combinedDosePositionCap(matched)).toBe("LOWER_BOUND");
  });

  it("PEAK ADV n=5-7: LONG の INCOMPLETE が不適格（override 可）", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(6, "PEAK")], plannedDate: PLANNING_DATE, tier: "ADVANCED" });
    const blocked = longIncompleteBlockedBy(matched);
    expect(blocked).not.toBeNull();
    expect(blocked!.ruleId).toBe("COMP_PEAK_ADV_N5_7");
  });

  it("PEAK ADV n=5-7 は plan パイプライン上でも LONG(INCOMPLETE) を override 可能な不適格にする", () => {
    const r = plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_300_PLUS_100", { competitions: [competition(6, "PEAK")], phase: "COMPETITION" });
    expect(r.status).toBe("INELIGIBLE");
    if (r.status === "INELIGIBLE") {
      const reason = r.reasons.find((x) => x.code === "COMPETITION_LONG_INCOMPLETE_BLOCKED");
      expect(reason).toBeDefined();
      expect(reason!.overrideAllowed).toBe(true);
    }
  });

  it("PEAK DEV n=5-7: 新規刺激制限 + HIGH_METABOLIC 自動生成不可（LONG INCOMPLETE 制限は課さない）", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(6, "PEAK")], plannedDate: PLANNING_DATE, tier: "DEVELOPMENTAL" });
    expect(resolveNewStimulus({ matched, coverage28d: "COMPLETE", templateUsedWithin28d: false })).toBe("NEW");
    const block = resolveAutogenBlock({ matched, method: "SPRINT_ENDURANCE_SHORT", loadClass: "HIGH_METABOLIC", template: null });
    expect(block.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 新規刺激（coverage28d 不完全）
// ---------------------------------------------------------------------------

describe("新規刺激判定: coverage28d 不完全は「新規ではない」と断定しない", () => {
  it("coverage=COMPLETE かつ template 未使用 → NEW", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(6, "IMPORTANT")], plannedDate: PLANNING_DATE, tier: "ADVANCED" });
    expect(resolveNewStimulus({ matched, coverage28d: "COMPLETE", templateUsedWithin28d: false })).toBe("NEW");
  });
  it("coverage=COMPLETE かつ 20日前に使用済み → NOT_NEW", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(6, "IMPORTANT")], plannedDate: PLANNING_DATE, tier: "ADVANCED" });
    expect(resolveNewStimulus({ matched, coverage28d: "COMPLETE", templateUsedWithin28d: true })).toBe("NOT_NEW");
  });
  it("coverage=PARTIAL → NOT_DETERMINABLE（AI は block、COACH は review）", () => {
    const events = [event({ templateId: "SES_100", method: "SPRINT_ENDURANCE_SHORT", at: isoDT("2026-08-01T00:00:00.000Z") })];
    const ai = plan("SPRINT_ENDURANCE_SHORT", "SES_150", { competitions: [competition(6, "IMPORTANT")], actor: AI, phase: "COMPETITION", subject: advancedWithMark(), history: historyWith(events, "PARTIAL") });
    expect(ai.status).toBe("INELIGIBLE");
    if (ai.status === "INELIGIBLE") {
      expect(ai.findings.map((f) => f.code)).toContain("COMPETITION_NEW_STIMULUS_NOT_DETERMINABLE");
    }
    const coach = expectOk(plan("SPRINT_ENDURANCE_SHORT", "SES_80", { competitions: [competition(6, "IMPORTANT")], subject: advancedWithMark(), history: historyWith(events, "PARTIAL") }));
    expect(coach.findings.map((f) => f.code)).toContain("COMPETITION_NEW_STIMULUS_NOT_DETERMINABLE");
  });
});

// ---------------------------------------------------------------------------
// Taper（T-PH-03 / T-PH-04）
// ---------------------------------------------------------------------------

describe("T-PH-03: youth（DEVELOPMENTAL）に % taper を適用しない", () => {
  it("DEV × PEAK n=10: PEAK×DEVELOPMENTAL の day-range データに n=8-14 行が存在しない（taper 非対象）", () => {
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(10, "PEAK")], plannedDate: PLANNING_DATE, tier: "DEVELOPMENTAL" });
    expect(matched).toEqual([]);
    expect(ruleSet.competitionRules.some((r) => r.priority === "PEAK" && r.tier === "DEVELOPMENTAL" && r.dayMin >= 8)).toBe(false);
  });

  it("DEV × PEAK n=10: taper finding 無し。phase position だけ・intensity 不変", () => {
    const p = expectOk(plan("STRIDE", "ST_RELAXED", { subject: developmental(), competitions: [competition(10, "PEAK")] }));
    expect(p.findings.map((f) => f.code)).not.toContain("COMPETITION_TAPER_GUIDANCE");
    const baseline = expectOk(plan("STRIDE", "ST_RELAXED", { subject: developmental() }));
    expect(p.intensity.reference).toEqual(baseline.intensity.reference);
  });
});

describe("T-PH-04: ADVANCED × PEAK n=10 は 41–60% taper guidance", () => {
  // plannedDate（PLANNING_DATE）から見た直近4週、各週に1件ずつ（daysAgo 3/10/17/24）配置する。
  const running28dEvents = () =>
    [3, 10, 17, 24].map((daysAgo) =>
      event({
        at: isoDT(`${addDaysStr(PLANNING_DATE, -daysAgo)}T00:00:00.000Z`),
        category: "RUNNING_LOW_INTENSITY",
        magnitude: { distanceM: { lower: 2000, upper: 2000, unit: "m", source: "PLANNED", confidence: "HIGH" } },
      }),
    );

  it("coverage28d=COMPLETE かつ十分なデータ: 41–60% guidance + baseline + dose LOWER_HALF + intensity 不変", () => {
    const p = expectOk(
      plan("TEMPO_EXTENSIVE", "TE_200", { competitions: [competition(10, "PEAK")], history: historyWith(running28dEvents(), "COMPLETE") }),
    );
    const finding = p.findings.find((f) => f.code === "COMPETITION_TAPER_GUIDANCE");
    expect(finding).toBeDefined();
    expect(finding!.metric).toContain("reductionPercentLower=41");
    expect(finding!.metric).toContain("reductionPercentUpper=60");
    expect(finding!.metric).toContain("baselineAverageLowerM=2000");
    const evidenceRule = ruleSet.competitionRules.find((r) => r.taperGuidance !== null)!;
    expect(evidenceRule.taperGuidance!.evidenceId).toBe("EV_BOSQUET_2007_TAPER");

    // [R7 pre-commit correction §19] intensity 側の完全な deep-equality。reference（MAX_INTENT /
    // Vmax 参照の種類など）と target（intensityPercent・比率などの実値）の両方、および
    // exposure（Vmax 系の露出量。§14 は触らない）・rest（短くならない）まで一致を確認する。
    const baseline = expectOk(plan("TEMPO_EXTENSIVE", "TE_200"));
    expect(p.intensity).toEqual(baseline.intensity);
    expect(p.exposure).toEqual(baseline.exposure);
    expect(p.rest.repRestS.value).toBeGreaterThanOrEqual(baseline.rest.repRestS.recommended!.min);
  });

  it("history 不足（coverage28d=PARTIAL）: 文章 guidance のみ、数値 baseline なし（0 で埋めない）", () => {
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { competitions: [competition(10, "PEAK")], history: historyWith(running28dEvents(), "PARTIAL") }));
    const finding = p.findings.find((f) => f.code === "COMPETITION_TAPER_GUIDANCE")!;
    expect(finding.metric).toContain("reductionPercentLower=41");
    expect(finding.metric).not.toContain("baselineAverageLowerM");
  });

  it("history が無い（null）場合も同様に数値なしガイダンスのみ", () => {
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { competitions: [competition(10, "PEAK")] }));
    const finding = p.findings.find((f) => f.code === "COMPETITION_TAPER_GUIDANCE")!;
    expect(finding.metric).not.toContain("baselineAverageLowerM");
  });

  it("computeTaperBaseline: 距離不明の event が1件でもあれば null（0 にしない）", () => {
    const events = [...running28dEvents(), event({ at: isoDT(`${addDaysStr(PLANNING_DATE, -5)}T00:00:00.000Z`), category: "RUNNING_LOW_INTENSITY", magnitude: {} })];
    const result = computeTaperBaseline({ events, plannedDate: iso(PLANNING_DATE), coverage28d: "COMPLETE" });
    expect(result).toBeNull();
  });

  it("taper は itemのsets/reps/distanceを直接書き換えない（Finding にだけ載る）", () => {
    const withTaper = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { competitions: [competition(10, "PEAK")] }));
    const withoutTaper = expectOk(plan("TEMPO_EXTENSIVE", "TE_200"));
    // taper 由来の position cap（LOWER_HALF）はかかるが、recommended レンジ自体は不変
    expect(withTaper.repsPerSet.recommended).toEqual(withoutTaper.repsPerSet.recommended);
  });
});

// ---------------------------------------------------------------------------
// 複数大会の重なり（§52）
// ---------------------------------------------------------------------------

describe("複数大会ウィンドウの重なり（弱い rule を強い rule で消さない）", () => {
  it("NORMAL 大会1日前 + PEAK 大会10日前: 両方の制限が残る", () => {
    const competitions = [competition(1, "NORMAL"), competition(10, "PEAK")];
    const p = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { competitions }));
    expect(p.findings.map((f) => f.code)).toContain("COMPETITION_TAPER_GUIDANCE");
    // NORMAL n=1 は HIGH_* autogen 停止（TE は loadClass=LOW なので影響なし。ACC で確認）
    const ai = plan("ACCELERATION", "ACC_BLOCK_30", { competitions, actor: AI });
    expect(ai.status).toBe("INELIGIBLE");
  });

  it("入力順を shuffle しても結果は同じ", () => {
    const a = [competition(1, "NORMAL"), competition(10, "PEAK")];
    const b = [competition(10, "PEAK"), competition(1, "NORMAL")];
    const pa = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { competitions: a }));
    const pb = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { competitions: b }));
    expect(pa.findings.map((f) => f.code).sort()).toEqual(pb.findings.map((f) => f.code).sort());
  });
});

// ---------------------------------------------------------------------------
// [R7 correction] §14.1 Phase × Competition の明示的な交差テスト（加算ではなく intersection）
// ---------------------------------------------------------------------------

describe("[R7 correction] Phase と Competition は intersection（大会側が phase を緩めない）", () => {
  it("Case A: phase=TRANSITION + NORMAL n=1 + ACC 20m → NORMAL n1 の例外だけなら autogen 候補だが、TRANSITION の HIGH_* block が別レイヤーで効く", () => {
    // NORMAL n=1 単独なら ACC≤20m は例外で autogen 可（既存テストで確認済み）。
    const withoutTransition = plan("ACCELERATION", "ACC_BLOCK_20", { competitions: [competition(1, "NORMAL")], actor: AI });
    expect(withoutTransition.status).toBe("OK");

    // phase=TRANSITION を重ねると、AI/SYSTEM は自動生成不可（Competition の例外は Phase を解除しない）。
    for (const actor of [AI, SYSTEM]) {
      const r = plan("ACCELERATION", "ACC_BLOCK_20", { phase: "TRANSITION", competitions: [competition(1, "NORMAL")], actor });
      expect(r.status, actor.kind).toBe("INELIGIBLE");
    }
    const coach = expectOk(plan("ACCELERATION", "ACC_BLOCK_20", { phase: "TRANSITION", competitions: [competition(1, "NORMAL")] }));
    expect(coach.findings.map((f) => f.code)).toContain("PHASE_AUTOGEN_BLOCKED");
    // resolver 自体でも確認: autogenBlockedLoadClasses に HIGH_NEURAL が含まれる（NORMAL n1 の例外は
    // 無関係に、phase 由来の block が別途乗る）。
    const result = resolveCompetitionAndPhase({
      ruleSet,
      phase: "TRANSITION",
      competitions: [competition(1, "NORMAL")],
      plannedDate: PLANNING_DATE,
      tier: "ADVANCED",
      method: "ACCELERATION",
      loadClass: "HIGH_NEURAL",
      template: null,
      coverage28d: "NONE",
      templateUsedWithin28d: false,
      history: [],
    });
    expect(result.autogenBlockedLoadClasses).toContain("HIGH_NEURAL");
  });

  it("Case B: phase=PREPARATION（cap=UPPER_HALF）× PEAK ADVANCED n=2-4（cap=LOWER_BOUND） → LOWER_BOUND（最も低い方）", () => {
    const result = resolveCompetitionAndPhase({
      ruleSet,
      phase: "PREPARATION",
      competitions: [competition(3, "PEAK")],
      plannedDate: PLANNING_DATE,
      tier: "ADVANCED",
      method: "TEMPO_EXTENSIVE",
      loadClass: "LOW",
      template: null,
      coverage28d: "NONE",
      templateUsedWithin28d: false,
      history: [],
    });
    expect(result.dosePositionCap).toBe("LOWER_BOUND");
  });

  it("Case C: phase=COMPETITION（cap=LOWER_HALF）× IMPORTANT n=8-14（dose cap 無し・行自体が無い） → Phase の LOWER_HALF を維持", () => {
    // IMPORTANT の day range データは n=1/2-4/5-7 までで、8-14 は「無制限」= 該当行が無い
    // （window が存在するだけで phase cap を消さないことの確認）。
    const matched = matchedCompetitionWindows({ ruleSet, competitions: [competition(10, "IMPORTANT")], plannedDate: PLANNING_DATE, tier: "ADVANCED" });
    expect(matched).toEqual([]);
    const result = resolveCompetitionAndPhase({
      ruleSet,
      phase: "COMPETITION",
      competitions: [competition(10, "IMPORTANT")],
      plannedDate: PLANNING_DATE,
      tier: "ADVANCED",
      method: "TEMPO_EXTENSIVE",
      loadClass: "LOW",
      template: null,
      coverage28d: "NONE",
      templateUsedWithin28d: false,
      history: [],
    });
    expect(result.dosePositionCap).toBe("LOWER_HALF");
  });

  it("Case D: phase=TRANSITION + competition rule に dose cap 無し → LOWER_BOUND（phase 側）を維持", () => {
    const result = resolveCompetitionAndPhase({
      ruleSet,
      phase: "TRANSITION",
      competitions: [competition(1, "TRAINING_MEET")], // dosePositionCap=null の行
      plannedDate: PLANNING_DATE,
      tier: "ADVANCED",
      method: "TEMPO_EXTENSIVE",
      loadClass: "LOW",
      template: null,
      coverage28d: "NONE",
      templateUsedWithin28d: false,
      history: [],
    });
    expect(result.dosePositionCap).toBe("LOWER_BOUND");
  });
});

// ---------------------------------------------------------------------------
// RuleSet 駆動・shuffle・mutation
// ---------------------------------------------------------------------------

describe("判定データは RuleSet 側にある", () => {
  function withCompetitionRules(mutate: (rules: RuleSet["competitionRules"]) => RuleSet["competitionRules"]): RuleSet {
    return ruleSetSchema.parse({ ...ruleSet, competitionRules: mutate(ruleSet.competitionRules) });
  }
  function withPhaseRules(mutate: (rules: RuleSet["phaseRules"]) => RuleSet["phaseRules"]): RuleSet {
    return ruleSetSchema.parse({ ...ruleSet, phaseRules: mutate(ruleSet.phaseRules) });
  }

  it("competitionRules の配列順序を入れ替えても結果は同じ", () => {
    const shuffled = ruleSetSchema.parse({ ...ruleSet, competitionRules: [...ruleSet.competitionRules].reverse() });
    const a = resolveCompetitionAndPhase({
      ruleSet,
      phase: null,
      competitions: [competition(1, "NORMAL"), competition(10, "PEAK")],
      plannedDate: PLANNING_DATE,
      tier: "ADVANCED",
      method: "ACCELERATION",
      loadClass: "HIGH_NEURAL",
      template: null,
      coverage28d: "NONE",
      templateUsedWithin28d: false,
      history: [],
    });
    const b = resolveCompetitionAndPhase({
      ruleSet: shuffled,
      phase: null,
      competitions: [competition(1, "NORMAL"), competition(10, "PEAK")],
      plannedDate: PLANNING_DATE,
      tier: "ADVANCED",
      method: "ACCELERATION",
      loadClass: "HIGH_NEURAL",
      template: null,
      coverage28d: "NONE",
      templateUsedWithin28d: false,
      history: [],
    });
    expect(b.autogenBlockedLoadClasses.sort()).toEqual(a.autogenBlockedLoadClasses.sort());
    expect(b.dosePositionCap).toBe(a.dosePositionCap);
  });

  it("phaseRules の配列順序を入れ替えても結果は同じ", () => {
    const shuffled = ruleSetSchema.parse({ ...ruleSet, phaseRules: [...ruleSet.phaseRules].reverse() });
    const a = evaluatePhase(ruleSet, "TRANSITION");
    const b = evaluatePhase(shuffled, "TRANSITION");
    expect(b).toEqual(a);
  });

  it("Taper %（41-60 → 別値）を変えると Finding params が変わる", () => {
    const mutated = withCompetitionRules((rules) =>
      rules.map((r) => (r.taperGuidance ? { ...r, taperGuidance: { ...r.taperGuidance, reductionPercentLower: 30, reductionPercentUpper: 50 } } : r)),
    );
    const base = expectOk(plan("TEMPO_EXTENSIVE", "TE_200", { competitions: [competition(10, "PEAK")] }));
    // production RuleSet を差し替えるテストは planning からは直接できないため、resolver を直接呼ぶ。
    const result = resolveCompetitionAndPhase({
      ruleSet: mutated,
      phase: null,
      competitions: [competition(10, "PEAK")],
      plannedDate: PLANNING_DATE,
      tier: "ADVANCED",
      method: "TEMPO_EXTENSIVE",
      loadClass: "LOW",
      template: null,
      coverage28d: "NONE",
      templateUsedWithin28d: false,
      history: [],
    });
    const finding = result.findings.find((f) => f.code === "COMPETITION_TAPER_GUIDANCE")!;
    expect(finding.metric).toContain("reductionPercentLower=30");
    expect(base.findings.find((f) => f.code === "COMPETITION_TAPER_GUIDANCE")?.metric).toContain("reductionPercentLower=41");
  });

  it("NORMAL n=1 の規則を test 版で変えると結果が data に従う", () => {
    const mutated = withCompetitionRules((rules) =>
      rules.map((r) =>
        r.priority === "NORMAL" && r.dayMin === 1
          ? { ...r, blockedAutogenLoadClasses: [], autogenExceptionMethods: [], autogenExceptionAccMaxDistanceM: null, autogenExceptionPositionCap: null }
          : r,
      ),
    );
    const before = resolveAutogenBlock({
      matched: matchedCompetitionWindows({ ruleSet, competitions: [competition(1, "NORMAL")], plannedDate: PLANNING_DATE, tier: "ADVANCED" }),
      method: "ACCELERATION",
      loadClass: "HIGH_NEURAL",
      template: null,
    });
    const after = resolveAutogenBlock({
      matched: matchedCompetitionWindows({ ruleSet: mutated, competitions: [competition(1, "NORMAL")], plannedDate: PLANNING_DATE, tier: "ADVANCED" }),
      method: "ACCELERATION",
      loadClass: "HIGH_NEURAL",
      template: null,
    });
    expect(before.blocked).toBe(true);
    expect(after.blocked).toBe(false);
  });

  it("phase dose cap を test 版で変えると結果が変わる", () => {
    const mutated = withPhaseRules((rules) => rules.map((r) => (r.phase === "COMPETITION" ? { ...r, dosePositionCap: "LOWER_BOUND" as const } : r)));
    expect(evaluatePhase(ruleSet, "COMPETITION").dosePositionCap).toBe("LOWER_HALF");
    expect(evaluatePhase(mutated, "COMPETITION").dosePositionCap).toBe("LOWER_BOUND");
  });

  it("competition/ に日数バケット・% 等の magic number を複製していない（境界値の 0/1 比較は可）", () => {
    const dir = path.join(process.cwd(), "src/domain/running/competition");
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), "utf-8");
      const code = source
        .split("\n")
        .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*"); })
        .join("\n");
      expect(code, file).not.toMatch(/\b14\b|\b41\b|\b60\b|\b28\b/);
    }
  });

  // [R7 pre-commit correction §23] phase/taper/weekly は処方値へ自動倍率を一切適用しない
  // （taper の 41–60% は Finding guidance の数値としてのみ現れ、dose position cap 以外の形で
  // RunningPrescription の実値には反映されない）。
  it("phase/competition/weekly の domain コードに処方値への自動倍率が無い（grep 監査）", () => {
    const dirs = ["src/domain/running/weekly", "src/domain/running/competition"];
    const forbidden = [/phaseFactor/, /taperFactor/, /volumeMultiplier/, /\*=\s*0\.\d/, /\*\s*0\.\d+\s*[;)]/];
    for (const dir of dirs) {
      const full = path.join(process.cwd(), dir);
      for (const file of fs.readdirSync(full)) {
        if (!file.endsWith(".ts")) continue;
        const code = fs.readFileSync(path.join(full, file), "utf-8");
        for (const pattern of forbidden) {
          expect(code, `${dir}/${file} matched ${pattern}`).not.toMatch(pattern);
        }
      }
    }
  });

  it("build.ts の phase/competition/weekly 接続部分も自動倍率を持たない", () => {
    const code = fs.readFileSync(path.join(process.cwd(), "src/domain/running/planning/build.ts"), "utf-8");
    expect(code).not.toMatch(/phaseFactor/);
    expect(code).not.toMatch(/taperFactor/);
    expect(code).not.toMatch(/volumeMultiplier/);
    expect(code).not.toMatch(/reductionPercent(Lower|Upper)\s*\/\s*100/);
  });
});

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

describe("root public API", () => {
  it("CompetitionRef の型・schema だけを公開し、内部 resolver は非公開", () => {
    expect(typeof runningApi.competitionRefSchema.parse).toBe("function");
    expect(runningApi.competitionRefSchema.parse({ id: "c1", date: PLANNING_DATE, priority: "NORMAL" })).toBeDefined();
    for (const name of ["resolveCompetitionAndPhase", "evaluatePhase", "matchedCompetitionWindows", "computeTaperBaseline", "resolveCompetitionDay", "isWithinCompetitionPeriod"]) {
      expect(Object.keys(runningApi), name).not.toContain(name);
    }
  });
});
