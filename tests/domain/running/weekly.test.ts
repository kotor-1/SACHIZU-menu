/**
 * Running Prescription Engine v2 — Phase R7（§12 Weekly context）。
 *
 * 検証の柱:
 *   - exact 48h / 72h window（Method 別の回復時間を持たない）
 *   - readiness を偽造しない weekly fallback（USE_LOWER_BOUND 相当）
 *   - WeeklyHistoryInput の coverage 意味論（COMPLETE/PARTIAL/NONE の取り違え防止）
 *   - しきい値はすべて RuleSet 駆動（TS ハードコード禁止）
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as runningApi from "@/domain/running";
import { evaluateWeeklyContext } from "@/domain/running/weekly";
import { calendarDateOf, calendarDayDiff, hoursBetween, validateCoverage7d } from "@/domain/running/weekly/windows";
import { countHighSessions } from "@/domain/running/weekly/events";
import { planRunningPrescription } from "@/domain/running/planning";
import type { PlanRequest, PlanResult } from "@/domain/running/planning/schema";
import { getRuleSet } from "@/domain/running/rules/loader";
import { createCoachActor } from "@/domain/running/types/actor";
import { ruleSetSchema, type RuleSet } from "@/domain/running/rules/schema";
import { loadEventSchema, weeklyHistoryInputSchema, type LoadEvent, type WeeklyHistoryInput } from "@/domain/running/types/load";
import type { IsoDate, IsoDateTime } from "@/domain/running/types/primitives";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";

const ruleSet = getRuleSet("rs-2026.09.0")!;
const PLANNING_DATE = "2026-09-15";
const EVALUATED_AT = "2026-09-15T08:00:00.000Z" as IsoDateTime;
const COACH = createCoachActor("coach-1");

function iso(value: string): IsoDate {
  return value as IsoDate;
}

function hoursBefore(hours: number): IsoDateTime {
  return new Date(Date.parse(EVALUATED_AT) - hours * 60 * 60 * 1000).toISOString() as IsoDateTime;
}

function event(o: Partial<LoadEvent> = {}): LoadEvent {
  return loadEventSchema.parse({
    at: hoursBefore(24),
    category: "RUNNING_HIGH_INTENSITY",
    method: null,
    templateId: null,
    sessionKey: "s1",
    intensityTag: "HIGH",
    magnitude: {},
    source: "SESSION_RECORD",
    completion: "DONE",
    ...o,
  });
}

function history(o: Partial<WeeklyHistoryInput> = {}): WeeklyHistoryInput {
  return weeklyHistoryInputSchema.parse({
    events: [],
    coverage72h: "COMPLETE",
    coverage7d: "NONE",
    coverage28d: "NONE",
    dailyActivity7d: [],
    ...o,
  });
}

function ctx(o: Partial<Parameters<typeof evaluateWeeklyContext>[1]> = {}) {
  return {
    ruleSet,
    evaluatedAt: EVALUATED_AT,
    method: "MAX_VELOCITY" as const,
    loadClass: "HIGH_NEURAL" as const,
    ageBand: "ADULT" as const,
    hasExistingReadinessDecision: false,
    ...o,
  };
}

const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code);

// ---------------------------------------------------------------------------
// 日付・時間計算
// ---------------------------------------------------------------------------

describe("date math（current-time を読まない）", () => {
  it("calendarDateOf は文字列の先頭10文字（timezone 変換しない）", () => {
    expect(calendarDateOf("2026-09-15T23:30:00+09:00" as IsoDateTime)).toBe("2026-09-15");
    expect(calendarDateOf("2026-09-15T00:30:00Z" as IsoDateTime)).toBe("2026-09-15");
  });

  it("hoursBetween は offset を考慮した絶対時間差", () => {
    expect(hoursBetween("2026-09-15T00:00:00Z" as IsoDateTime, "2026-09-15T02:00:00Z" as IsoDateTime)).toBeCloseTo(2, 5);
    expect(hoursBetween("2026-09-15T00:00:00+09:00" as IsoDateTime, "2026-09-15T00:00:00Z" as IsoDateTime)).toBeCloseTo(9, 5);
  });

  it("calendarDayDiff は暦日差（うるう年をまたいでも正しい）", () => {
    expect(calendarDayDiff(iso("2026-09-15"), iso("2026-09-16"))).toBe(1);
    expect(calendarDayDiff(iso("2026-09-15"), iso("2026-09-15"))).toBe(0);
    expect(calendarDayDiff(iso("2028-02-28"), iso("2028-03-01"))).toBe(2); // 2028 はうるう年
  });
});

// ---------------------------------------------------------------------------
// plannedAt 無し = 未評価
// ---------------------------------------------------------------------------

describe("plannedAt が無い場合", () => {
  it("evaluatedAt=null なら history の中身を見ず NOT_EVALUATED", () => {
    const withHistory = evaluateWeeklyContext(history({ events: [event({ at: hoursBefore(1) })] }), ctx({ evaluatedAt: null }));
    const withoutHistory = evaluateWeeklyContext(null, ctx({ evaluatedAt: null }));
    expect(withHistory).toEqual(withoutHistory);
    expect(withHistory.coverage72h).toBe("NOT_EVALUATED");
    expect(codes(withHistory.findings)).toEqual(["WEEKLY_CONTEXT_NOT_EVALUATED"]);
    expect(withHistory.readinessRequired).toBe(false);
    expect(withHistory.weeklyPositionCap).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-WK-01〜05
// ---------------------------------------------------------------------------

describe("T-WK-01: race yesterday（24h 前に RACE）", () => {
  it("current MV → WEEKLY_HIGH_WITHIN_48H で BLOCK_AUTOGEN + REVIEW", () => {
    const h = history({ events: [event({ at: hoursBefore(24), category: "RACE", intensityTag: "HIGH" })] });
    const result = evaluateWeeklyContext(h, ctx({ method: "MAX_VELOCITY", loadClass: "HIGH_NEURAL" }));
    expect(codes(result.findings)).toContain("WEEKLY_HIGH_WITHIN_48H");
    const severities = result.findings.filter((f) => f.code === "WEEKLY_HIGH_WITHIN_48H").map((f) => f.severity);
    expect(severities.sort()).toEqual(["BLOCK_AUTOGEN", "REQUIRE_COACH_REVIEW"]);
    expect(result.autogenBlockedMethods).toContain("MAX_VELOCITY");
  });

  it("STRIDE には 48h lock が無い（loadClass=LOW は対象外）", () => {
    const h = history({ events: [event({ at: hoursBefore(24), category: "RACE", intensityTag: "HIGH" })] });
    const result = evaluateWeeklyContext(h, ctx({ method: "STRIDE", loadClass: "LOW" }));
    expect(codes(result.findings)).not.toContain("WEEKLY_HIGH_WITHIN_48H");
    expect(result.autogenBlockedMethods).not.toContain("STRIDE");
  });
});

describe("T-WK-02: heavy plyometrics yesterday（24h 前に PLYOMETRIC HIGH）", () => {
  it("current ACC → WEEKLY_NONRUN_HIGH_WITHIN_48H で BLOCK_AUTOGEN", () => {
    const h = history({ events: [event({ at: hoursBefore(24), category: "PLYOMETRIC", intensityTag: "HIGH" })] });
    const result = evaluateWeeklyContext(h, ctx({ method: "ACCELERATION", loadClass: "HIGH_NEURAL" }));
    expect(codes(result.findings)).toContain("WEEKLY_NONRUN_HIGH_WITHIN_48H");
    expect(result.autogenBlockedMethods).toContain("ACCELERATION");
  });
});

describe("T-WK-03: legacy の UNKNOWN 強度（30h 前）", () => {
  const h = () => history({ events: [event({ at: hoursBefore(30), category: "JUMPS", intensityTag: "UNKNOWN" })] });

  it("readiness=null: readinessRequired=true・LOWER_BOUND fallback、health data は偽造しない", () => {
    const result = evaluateWeeklyContext(h(), ctx({ hasExistingReadinessDecision: false }));
    expect(codes(result.findings)).toContain("WEEKLY_UNKNOWN_WITHIN_48H");
    expect(result.readinessRequired).toBe(true);
    expect(result.weeklyPositionCap).toBe("LOWER_BOUND");
    // health data（部位・尺度値等）は一切含まない
    expect(JSON.stringify(result)).not.toMatch(/pain|region|redFlag|soreness|fatigue|sleep/i);
  });

  it("readiness あり: weekly 側の LOWER_BOUND を重ねて偽装しない（readinessRequired は立つが cap は付けない）", () => {
    const result = evaluateWeeklyContext(h(), ctx({ hasExistingReadinessDecision: true }));
    expect(result.readinessRequired).toBe(true);
    expect(result.weeklyPositionCap).toBeNull();
  });
});

describe("T-WK-04: 48–72h（60h 前に MV HIGH）", () => {
  it("READINESS_CHECK_REQUIRED。readiness=null なら LOWER_BOUND", () => {
    const h = history({ events: [event({ at: hoursBefore(60), category: "RUNNING_HIGH_INTENSITY", intensityTag: "HIGH" })] });
    const result = evaluateWeeklyContext(h, ctx());
    expect(codes(result.findings)).toContain("READINESS_CHECK_REQUIRED");
    expect(result.readinessRequired).toBe(true);
    expect(result.weeklyPositionCap).toBe("LOWER_BOUND");
    // 48h 側の finding は出ない（60h は 48–72h window）
    expect(codes(result.findings)).not.toContain("WEEKLY_HIGH_WITHIN_48H");
  });
});

describe("T-WK-05: Method 別の回復時間を持たない（前回 SES 50h後 / 前回 ACC 50h後 は同一判定）", () => {
  it("SES と ACC の 50h 前 event で結果が同一（どちらも 48h 超過扱い）", () => {
    const ses = evaluateWeeklyContext(
      history({ events: [event({ at: hoursBefore(50), category: "RUNNING_HIGH_INTENSITY", intensityTag: "HIGH" })] }),
      ctx({ method: "SPRINT_ENDURANCE_SHORT", loadClass: "HIGH_METABOLIC" }),
    );
    const acc = evaluateWeeklyContext(
      history({ events: [event({ at: hoursBefore(50), category: "RUNNING_HIGH_INTENSITY", intensityTag: "HIGH" })] }),
      ctx({ method: "ACCELERATION", loadClass: "HIGH_NEURAL" }),
    );
    expect(codes(ses.findings).sort()).toEqual(codes(acc.findings).sort());
    expect(ses.readinessRequired).toBe(acc.readinessRequired);
    expect(ses.weeklyPositionCap).toBe(acc.weeklyPositionCap);
  });

  it("grep 監査: weekly/ に Method 別の 48h/72h/60h 等の定数が無い", () => {
    const dir = path.join(process.cwd(), "src/domain/running/weekly");
    for (const file of fs.readdirSync(dir)) {
      const code = fs
        .readFileSync(path.join(dir, file), "utf-8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
        .join("\n");
      expect(code, file).not.toMatch(/ACC\w*\s*[:=]\s*48/);
      expect(code, file).not.toMatch(/SES\w*\s*[:=]\s*72/);
      expect(code, file).not.toMatch(/MV\w*\s*[:=]\s*60/);
      expect(code, file).not.toMatch(/LONG\w*\s*[:=]\s*96/);
    }
  });
});

// ---------------------------------------------------------------------------
// 48h / 72h 境界（exact boundary）
// ---------------------------------------------------------------------------

describe("48h / 72h の厳密な境界", () => {
  const boundaryHours = [47.999722, 48, 48.000278, 71.999722, 72, 72.000278]; // 47:59:59, 48:00:00, 48:00:01, ...
  const labels = ["47:59:59", "48:00:00", "48:00:01", "71:59:59", "72:00:00", "72:00:01"];

  it.each(boundaryHours.map((h, i) => [labels[i], h] as const))("%s の event", (label, hours) => {
    const h = history({ events: [event({ at: hoursBefore(hours), category: "RUNNING_HIGH_INTENSITY", intensityTag: "HIGH" })] });
    const result = evaluateWeeklyContext(h, ctx());
    if (hours <= 48) {
      expect(codes(result.findings), label).toContain("WEEKLY_HIGH_WITHIN_48H");
      expect(codes(result.findings), label).not.toContain("READINESS_CHECK_REQUIRED");
    } else if (hours <= 72) {
      expect(codes(result.findings), label).not.toContain("WEEKLY_HIGH_WITHIN_48H");
      expect(codes(result.findings), label).toContain("READINESS_CHECK_REQUIRED");
    } else {
      expect(codes(result.findings), label).not.toContain("WEEKLY_HIGH_WITHIN_48H");
      expect(codes(result.findings), label).not.toContain("READINESS_CHECK_REQUIRED");
    }
  });

  it("未来 event は window 集計に入れない", () => {
    const future = event({ at: hoursBefore(-1), category: "RUNNING_HIGH_INTENSITY", intensityTag: "HIGH" });
    const result = evaluateWeeklyContext(history({ events: [future] }), ctx());
    expect(codes(result.findings)).not.toContain("WEEKLY_HIGH_WITHIN_48H");
    expect(result.events48h).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// coverage / HISTORY_UNKNOWN
// ---------------------------------------------------------------------------

describe("HISTORY_UNKNOWN と confidence の接続", () => {
  it("history=null / coverage72h=NONE → HISTORY_UNKNOWN。HIGH_METABOLIC は追加で REQUIRE_COACH_REVIEW", () => {
    const result = evaluateWeeklyContext(null, ctx({ method: "SPRINT_ENDURANCE_SHORT", loadClass: "HIGH_METABOLIC" }));
    expect(result.coverage72h).toBe("NONE");
    expect(codes(result.findings)).toContain("HISTORY_UNKNOWN");
    expect(codes(result.findings)).toContain("HISTORY_UNKNOWN_HIGH_METABOLIC");
    const nonMetabolic = evaluateWeeklyContext(null, ctx({ method: "ACCELERATION", loadClass: "HIGH_NEURAL" }));
    expect(codes(nonMetabolic.findings)).toContain("HISTORY_UNKNOWN");
    expect(codes(nonMetabolic.findings)).not.toContain("HISTORY_UNKNOWN_HIGH_METABOLIC");
  });

  it("coverage72h=PARTIAL は HISTORY_UNKNOWN を出さない（NONE だけが対象）", () => {
    const result = evaluateWeeklyContext(history({ coverage72h: "PARTIAL" }), ctx());
    expect(codes(result.findings)).not.toContain("HISTORY_UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// 7日 guard
// ---------------------------------------------------------------------------

describe("§12.4 highSessions7d（session 数。item 数ではない）", () => {
  it("同じ sessionKey 内の複数 HIGH event は1 session として数える", () => {
    const events = [
      event({ at: hoursBefore(10), sessionKey: "sessA", intensityTag: "HIGH" }),
      event({ at: hoursBefore(10), sessionKey: "sessA", intensityTag: "HIGH", category: "RACE" }),
      event({ at: hoursBefore(30), sessionKey: "sessB", intensityTag: "HIGH" }),
    ];
    expect(countHighSessions(events)).toBe(2);
  });

  it("3 session 以上で WEEKLY_HIGH_SESSIONS（WARN）", () => {
    const events = [1, 2, 3].map((n) => event({ at: hoursBefore(n * 20), sessionKey: `s${n}`, intensityTag: "HIGH" }));
    const result = evaluateWeeklyContext(history({ events }), ctx());
    expect(result.highSessions7d).toBe(3);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "WEEKLY_HIGH_SESSIONS", severity: "WARN" }));
  });

  it("2 session では WARN を出さない", () => {
    const events = [1, 2].map((n) => event({ at: hoursBefore(n * 20), sessionKey: `s${n}`, intensityTag: "HIGH" }));
    const result = evaluateWeeklyContext(history({ events }), ctx());
    expect(codes(result.findings)).not.toContain("WEEKLY_HIGH_SESSIONS");
  });
});

describe("E21 institutional weekly guidance is not a universal U15 runtime rule", () => {
  it("production RuleSet has no universal youth rest-day or weekly-minute rule", () => {
    expect(ruleSet.weeklyRules.some((r) => r.kind === "YOUTH_REST_DAYS")).toBe(false);
    expect(ruleSet.weeklyRules.some((r) => r.kind === "YOUTH_MAX_MINUTES_7D")).toBe(false);
  });

  it("ageBand=U15 alone does not evaluate the institutional 11h / 2-rest-day guidance", () => {
    const dailyActivity7d = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-09-${String(9 + i).padStart(2, "0")}` as IsoDate,
      hadActivity: true,
      trainingMinutes: 180,
    }));
    const result = evaluateWeeklyContext(history({ coverage7d: "COMPLETE", dailyActivity7d }), ctx({ ageBand: "U15" }));
    expect(codes(result.findings)).not.toContain("WEEKLY_JHS_REST_DAYS");
    expect(codes(result.findings)).not.toContain("WEEKLY_JHS_HOURS");
    expect(codes(result.findings)).not.toContain("WEEKLY_REST_DAYS_NOT_DETERMINABLE");
    expect(codes(result.findings)).not.toContain("WEEKLY_HOURS_NOT_DETERMINABLE");
  });

  it("RuleSet-driven weekly evaluation remains available for non-youth rules", () => {
    const result = evaluateWeeklyContext(history({ events: [event({ at: hoursBefore(24) })] }), ctx({ ageBand: "U15" }));
    expect(codes(result.findings)).toContain("WEEKLY_HIGH_WITHIN_48H");
  });
});

describe("coverage7d の整合検証（不足日があるのに COMPLETE は reject 相当）", () => {
  it("7日ぶん揃っていれば COMPLETE を維持", () => {
    const dailyActivity7d = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-09-${String(9 + i).padStart(2, "0")}` as IsoDate,
      hadActivity: true,
      trainingMinutes: 30,
    }));
    const v = validateCoverage7d(dailyActivity7d, "COMPLETE", EVALUATED_AT);
    expect(v).toEqual({ effectiveCoverage7d: "COMPLETE", inconsistent: false });
  });

  it("日数が足りないのに COMPLETE を主張 → PARTIAL へ downgrade", () => {
    const dailyActivity7d = [{ date: "2026-09-15" as IsoDate, hadActivity: true, trainingMinutes: 30 }];
    const v = validateCoverage7d(dailyActivity7d, "COMPLETE", EVALUATED_AT);
    expect(v).toEqual({ effectiveCoverage7d: "PARTIAL", inconsistent: true });
  });

  it("evaluateWeeklyContext 経由でも downgrade され、WEEKLY_COVERAGE7D_INCONSISTENT が出る", () => {
    const h = history({ coverage7d: "COMPLETE", dailyActivity7d: [{ date: "2026-09-15" as IsoDate, hadActivity: true, trainingMinutes: 30 }] });
    const result = evaluateWeeklyContext(h, ctx({ ageBand: "U15" }));
    expect(codes(result.findings)).toContain("WEEKLY_COVERAGE7D_INCONSISTENT");
    // E21: universal U15 weekly rule は runtime から除去されているため、追加の youth 判定不能 finding は出さない。
    expect(codes(result.findings)).not.toContain("WEEKLY_REST_DAYS_NOT_DETERMINABLE");
  });

  // [R7 pre-commit correction §16] 「対象7 calendar dates」の契約を明示する:
  // plannedDate（evaluatedAt の暦日）を含み、そこから遡って6日（plannedDate-6..plannedDate）の
  // 計7日。plannedDate 自体を含まない8日前〜2日前のような窓では COMPLETE を認めない。
  // タイムゾーン変換はしない（DailyActivitySummary.date を文字列としてそのまま暦日境界に使う）。
  it("対象7日は [plannedDate-6 .. plannedDate] の計7日（plannedDate 自身を含む）", () => {
    // plannedDate（09-15）自体が抜けている（09-08..09-14 の7日）→ COMPLETE を認めない。
    const missingPlannedDate = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-09-${String(8 + i).padStart(2, "0")}` as IsoDate,
      hadActivity: true,
      trainingMinutes: 30,
    }));
    expect(validateCoverage7d(missingPlannedDate, "COMPLETE", EVALUATED_AT)).toEqual({ effectiveCoverage7d: "PARTIAL", inconsistent: true });

    // 正しい窓（09-09..09-15、plannedDate を含む）は COMPLETE を維持する。
    const correctWindow = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-09-${String(9 + i).padStart(2, "0")}` as IsoDate,
      hadActivity: true,
      trainingMinutes: 30,
    }));
    expect(validateCoverage7d(correctWindow, "COMPLETE", EVALUATED_AT)).toEqual({ effectiveCoverage7d: "COMPLETE", inconsistent: false });
  });

  it("日付は文字列としてそのまま暦日境界に使う（timezone 変換をしない）", () => {
    // EVALUATED_AT は UTC 08:00 だが、DailyActivitySummary.date の暦日判定に時刻・タイムゾーンを
    // 一切持ち込まない（calendarDateOf と同じ「先頭10文字」規約）。
    const correctWindow = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-09-${String(9 + i).padStart(2, "0")}` as IsoDate,
      hadActivity: true,
      trainingMinutes: 30,
    }));
    const lateEvaluatedAt = "2026-09-15T23:59:59.000Z" as IsoDateTime;
    const earlyEvaluatedAt = "2026-09-15T00:00:00.000Z" as IsoDateTime;
    expect(validateCoverage7d(correctWindow, "COMPLETE", lateEvaluatedAt).effectiveCoverage7d).toBe("COMPLETE");
    expect(validateCoverage7d(correctWindow, "COMPLETE", earlyEvaluatedAt).effectiveCoverage7d).toBe("COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// RuleSet 駆動であること
// ---------------------------------------------------------------------------

describe("判定データは RuleSet 側にある", () => {
  function withWeeklyRules(mutate: (rules: RuleSet["weeklyRules"]) => RuleSet["weeklyRules"]): RuleSet {
    return ruleSetSchema.parse({ ...ruleSet, weeklyRules: mutate(ruleSet.weeklyRules) });
  }

  it("48h → 36h に変えると 40h 前 event の判定が変わる", () => {
    const h = history({ events: [event({ at: hoursBefore(40), category: "RUNNING_HIGH_INTENSITY", intensityTag: "HIGH" })] });
    const base = evaluateWeeklyContext(h, ctx());
    expect(codes(base.findings)).toContain("WEEKLY_HIGH_WITHIN_48H");

    const mutated = withWeeklyRules((rules) => rules.map((r) => (r.kind === "WINDOW_HOURS" ? { ...r, highWindowHours: 36 } : r)));
    const changed = evaluateWeeklyContext(h, ctx({ ruleSet: mutated }));
    expect(codes(changed.findings)).not.toContain("WEEKLY_HIGH_WITHIN_48H");
    expect(codes(changed.findings)).toContain("READINESS_CHECK_REQUIRED"); // 36–72h の範囲に入る
  });

  it("universal youth rules are intentionally absent while weekly completeness remains valid", () => {
    expect(ruleSet.weeklyRules.map((r) => r.kind)).toEqual(["WINDOW_HOURS", "RELEVANT_CATEGORIES", "HIGH_SESSIONS_7D", "HISTORY_UNKNOWN_POLICY"]);
  });

  it("weeklyRules の配列順序を入れ替えても結果は同じ", () => {
    const shuffled = ruleSetSchema.parse({ ...ruleSet, weeklyRules: [...ruleSet.weeklyRules].reverse() });
    const h = history({ events: [event({ at: hoursBefore(24), category: "RACE", intensityTag: "HIGH" })] });
    const a = evaluateWeeklyContext(h, ctx());
    const b = evaluateWeeklyContext(h, ctx({ ruleSet: shuffled }));
    expect(b).toEqual(a);
  });

  it("weekly/ に閾値の数値を複製していない（48/72/168/28d の policy 値。時間単位変換の 24 等は可）", () => {
    const dir = path.join(process.cwd(), "src/domain/running/weekly");
    for (const file of fs.readdirSync(dir)) {
      if (file === "windows.ts") continue; // 時間単位変換（h*24 等）だけを持つ
      const source = fs.readFileSync(path.join(dir, file), "utf-8");
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
        .join("\n");
      expect(code, file).not.toMatch(/\b48\b|\b72\b|\b960\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// Planning への接続（end-to-end）
// ---------------------------------------------------------------------------

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

function makeRequest(method: string, templateId: string, o: { plannedAt?: string | null; history?: unknown; actor?: PlanRequest["actor"] } = {}): PlanRequest {
  return {
    planningDate: iso(PLANNING_DATE),
    selection: { method, templateId },
    subject: athlete(),
    menuContext: {
      phase: null,
      plannedDate: iso(PLANNING_DATE),
      plannedAt: o.plannedAt ?? null,
      competitions: [],
      otherItems: [],
      availableMinutes: null,
    },
    history: o.history ?? null,
    readiness: null,
    positionPreference: null,
    coachEdits: [],
    overrides: [],
    coachReference: null,
    actor: o.actor ?? COACH,
  } as unknown as PlanRequest;
}

function describeResult(r: PlanResult): string {
  if (r.status === "OK") return "OK";
  if (r.status === "INELIGIBLE") return `INELIGIBLE ${JSON.stringify(r.reasons)}`;
  return `BLOCKED ${JSON.stringify(r.findings.filter((f) => f.severity !== "INFO"))}`;
}

describe("Planning への接続（end-to-end）", () => {
  it("24h 前に RACE がある状態で MAX_VELOCITY を AI が自動生成しようとすると INELIGIBLE", () => {
    const h = history({ events: [event({ at: "2026-09-14T08:00:00.000Z" as IsoDateTime, category: "RACE", intensityTag: "HIGH" })] });
    const r = planRunningPrescription(
      makeRequest("MAX_VELOCITY", "MV_FLY20", {
        plannedAt: "2026-09-15T08:00:00.000Z",
        history: h,
        actor: { kind: "AI_PLANNER", provider: "p", model: "m", requestId: "r1" },
      }),
    );
    expect(r.status, describeResult(r)).toBe("INELIGIBLE");
  });

  it("同じ状況で COACH は手動継続でき、weekly の Finding が処方に残る", () => {
    const h = history({ events: [event({ at: "2026-09-14T08:00:00.000Z" as IsoDateTime, category: "RACE", intensityTag: "HIGH" })] });
    const r = planRunningPrescription(makeRequest("MAX_VELOCITY", "MV_FLY20", { plannedAt: "2026-09-15T08:00:00.000Z", history: h }));
    expect(r.status, describeResult(r)).toBe("OK");
    if (r.status !== "OK") throw new Error("unreachable");
    expect(r.prescription.findings.map((f) => f.code)).toContain("WEEKLY_HIGH_WITHIN_48H");
  });

  it("weekly の履歴 sessionKey 等は処方に露出しない（表示は一般的な文言だけ）", () => {
    const h = history({
      events: [event({ at: "2026-09-14T08:00:00.000Z" as IsoDateTime, category: "RACE", intensityTag: "HIGH", sessionKey: "secret-session-key-123" })],
    });
    const r = planRunningPrescription(makeRequest("MAX_VELOCITY", "MV_FLY20", { plannedAt: "2026-09-15T08:00:00.000Z", history: h }));
    if (r.status !== "OK") throw new Error(describeResult(r));
    expect(JSON.stringify(r.prescription)).not.toContain("secret-session-key-123");
  });

  // [R7 pre-commit correction §13/§14] plannedAt 無し（週次評価そのものが不能）と、
  // plannedAt 有り + history=null（週次は評価できるが履歴が無い）を混同しない。
  describe("[R7 correction] plannedAt=null と history=null を区別する", () => {
    it("plannedAt=null: 週次は評価不能（NOT_EVALUATED）。history=null だからという理由だけで confidence を LOW へ落とさない", () => {
      const r = planRunningPrescription(makeRequest("STRIDE", "ST_RELAXED", { plannedAt: null, history: null }));
      expect(r.status, describeResult(r)).toBe("OK");
      if (r.status !== "OK") throw new Error("unreachable");
      expect(r.prescription.findings.map((f) => f.code)).toContain("WEEKLY_CONTEXT_NOT_EVALUATED");
      expect(r.prescription.findings.map((f) => f.code)).not.toContain("HISTORY_UNKNOWN");
      expect(r.prescription.findings.map((f) => f.code)).not.toContain("WEEKLY_NOT_EVALUATED");
      // history 自体を渡していても（plannedAt が無ければ）中身は読まない・LOW へは落とさない。
      const withHistoryButNoPlannedAt = planRunningPrescription(
        makeRequest("STRIDE", "ST_RELAXED", { plannedAt: null, history: history({ events: [] }) }),
      );
      expect(withHistoryButNoPlannedAt.status, describeResult(withHistoryButNoPlannedAt)).toBe("OK");
      if (withHistoryButNoPlannedAt.status !== "OK") throw new Error("unreachable");
      expect(withHistoryButNoPlannedAt.prescription.confidence).toEqual(r.prescription.confidence);
    });

    it("plannedAt あり + history=null: coverage72h=NONE・HISTORY_UNKNOWN・confidence 最大 LOW", () => {
      const r = planRunningPrescription(makeRequest("STRIDE", "ST_RELAXED", { plannedAt: "2026-09-15T08:00:00.000Z", history: null }));
      expect(r.status, describeResult(r)).toBe("OK");
      if (r.status !== "OK") throw new Error("unreachable");
      expect(r.prescription.findings.map((f) => f.code)).toContain("HISTORY_UNKNOWN");
      expect(r.prescription.confidence.prescription).toBe("POLICY_ONLY");
    });

    it("HIGH_METABOLIC × history=null（plannedAt あり）: HISTORY_UNKNOWN_HIGH_METABOLIC も追加で REQUIRE_COACH_REVIEW", () => {
      const r = planRunningPrescription(makeRequest("SPRINT_ENDURANCE_SHORT", "SES_100", { plannedAt: "2026-09-15T08:00:00.000Z", history: null }));
      expect(r.status, describeResult(r)).toBe("OK");
      if (r.status !== "OK") throw new Error("unreachable");
      const finding = r.prescription.findings.find((f) => f.code === "HISTORY_UNKNOWN_HIGH_METABOLIC");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("REQUIRE_COACH_REVIEW");
    });

    it("この2ケースの confidence は明確に異なる（NOT_EVALUATED は中立、NONE は LOW 強制）", () => {
      const noPlannedAt = planRunningPrescription(makeRequest("STRIDE", "ST_RELAXED", { plannedAt: null, history: null }));
      const plannedAtNoHistory = planRunningPrescription(makeRequest("STRIDE", "ST_RELAXED", { plannedAt: "2026-09-15T08:00:00.000Z", history: null }));
      if (noPlannedAt.status !== "OK" || plannedAtNoHistory.status !== "OK") throw new Error("unreachable");
      expect(noPlannedAt.prescription.confidence.prescription).not.toBe("LOW");
      expect(plannedAtNoHistory.prescription.confidence.prescription).toBe("POLICY_ONLY");
    });
  });

  // [R7 pre-commit correction §14] coverage72h=PARTIAL は「history-unknown」でも「confidence 強制
  // LOW」でもない。既知の event は48/72h guard に使い、未記録の活動が無いとは断定しない。
  describe("[R7 correction] coverage72h=PARTIAL は HISTORY_UNKNOWN でも LOW 強制でもない", () => {
    it("coverage72h=PARTIAL: confidence は LOW に強制されない。HISTORY_UNKNOWN も出ない", () => {
      const h = { events: [], coverage72h: "PARTIAL" as const, coverage7d: "NONE" as const, coverage28d: "NONE" as const, dailyActivity7d: [] };
      const r = planRunningPrescription(makeRequest("STRIDE", "ST_RELAXED", { plannedAt: "2026-09-15T08:00:00.000Z", history: h }));
      expect(r.status, describeResult(r)).toBe("OK");
      if (r.status !== "OK") throw new Error("unreachable");
      expect(r.prescription.confidence.prescription).not.toBe("LOW");
      expect(r.prescription.findings.map((f) => f.code)).not.toContain("HISTORY_UNKNOWN");
    });

    it("coverage72h=PARTIAL でも既知の event は 48h/72h guard にそのまま使う（未記録を「無かった」とは断定しないだけ）", () => {
      const h = {
        events: [event({ at: "2026-09-14T08:00:00.000Z" as IsoDateTime, category: "RACE", intensityTag: "HIGH" })],
        coverage72h: "PARTIAL" as const,
        coverage7d: "NONE" as const,
        coverage28d: "NONE" as const,
        dailyActivity7d: [],
      };
      const r = planRunningPrescription(makeRequest("MAX_VELOCITY", "MV_FLY20", { plannedAt: "2026-09-15T08:00:00.000Z", history: h }));
      expect(r.status, describeResult(r)).toBe("OK");
      if (r.status !== "OK") throw new Error("unreachable");
      expect(r.prescription.findings.map((f) => f.code)).toContain("WEEKLY_HIGH_WITHIN_48H");
    });
  });

  it("root public API は evaluateWeeklyContext と型だけを公開する", () => {
    expect(typeof runningApi.evaluateWeeklyContext).toBe("function");
    for (const name of ["countHighSessions", "hasUsedTemplateWithinDays", "windowHoursRule", "evaluateHighIntensityGuards"]) {
      expect(Object.keys(runningApi), name).not.toContain(name);
    }
  });
});
