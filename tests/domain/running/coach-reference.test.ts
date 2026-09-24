/**
 * R10-B4A.2 — Coach manual reference（TARGET_SPLIT）の domain contract。
 */
import { describe, expect, it } from "vitest";
import { coachManualReferenceInputSchema, toCoachReferenceInput, COACH_ENTERED_REFERENCE_CONFIDENCE } from "@/domain/running/planning/coachReference";
import { planRunningPrescription } from "@/domain/running/planning";
import { coachReferenceInputSchema } from "@/domain/running/planning/schema";
import { getRuleSet } from "@/domain/running/rules/loader";
import type { IsoDate } from "@/domain/running/types/primitives";
import type { Subject } from "@/domain/running/types/subject";
import { createCoachActor } from "@/domain/running/types/actor";

const COACH = createCoachActor("coach-1");
const AI = { kind: "AI_PLANNER", provider: "p", model: "m", requestId: "r1" } as const;
const SYSTEM = { kind: "SYSTEM" } as const;
const iso = (v: string) => v as IsoDate;

function groupSubject(overrides: Record<string, unknown> = {}): Subject {
  return {
    kind: "GROUP",
    profile: {
      label: "400mグループ",
      members: [
        {
          birthDate: null,
          ageBandOverride: "U18",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
          primaryEvent: "400m",
          ...overrides,
        },
      ],
      availableMinutes: null,
      allowAdvancedMethods: true,
    },
  } as unknown as Subject;
}

function athleteSubject(): Subject {
  return {
    kind: "ATHLETE",
    profile: {
      birthDate: iso("1998-01-01"),
      primaryEvent: "400m",
      maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") },
      trainingAge: { structuredSprintYears: 6, coachAssignedTier: "ADVANCED" },
      marks: [],
      vmax: null,
      allowAdvancedMethods: true,
    },
  } as unknown as Subject;
}

const SPLIT = toCoachReferenceInput({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }] });

function request(o: { method?: string; templateId?: string; subject?: Subject; actor?: unknown; coachReference?: unknown; coachEdits?: unknown[] } = {}) {
  return {
    planningDate: iso("2026-09-20"),
    selection: { method: o.method ?? "LONG_SPRINT_RACE_SPECIFIC", templateId: o.templateId ?? "LSR_SPECIAL_ENDURANCE_I" },
    subject: o.subject ?? groupSubject(),
    menuContext: { phase: null, plannedDate: iso("2026-09-20"), plannedAt: null, competitions: [], otherItems: [], availableMinutes: 90 },
    history: null,
    readiness: null,
    positionPreference: null,
    coachEdits: o.coachEdits ?? [],
    overrides: [],
    coachReference: "coachReference" in o ? o.coachReference : SPLIT,
    actor: o.actor ?? COACH,
  };
}

describe("R10-B4A.2: コーチ入力の正規化", () => {
  it("入力された目標タイムをそのまま区間化する（lower = upper。中央値・推定値を作らない）", () => {
    const ref = toCoachReferenceInput({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }, { distanceM: 100, targetTimeS: 13.5 }] });
    expect(ref).toEqual({
      kind: "TARGET_SPLIT",
      segments: [
        { distanceM: 300, targetS: { lower: 38, upper: 38, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } },
        { distanceM: 100, targetS: { lower: 13.5, upper: 13.5, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } },
      ],
    });
    // 既存 domain の慣習（コーチ入力参照の inputData / 手入力距離）と同じ値を使う
    expect(COACH_ENTERED_REFERENCE_CONFIDENCE).toBe("MEDIUM");
    // 正式な CoachReferenceInput として受理される
    expect(coachReferenceInputSchema.safeParse(ref).success).toBe(true);
  });

  it("記録（TimedMark / PB / Vmax）へ変換しない：予定値のまま保持する", () => {
    expect(JSON.stringify(SPLIT)).not.toMatch(/mark|timing|event|vmax|SAME_DISTANCE_BEST/i);
  });

  it("入力 schema は正の有限値だけを受け付け、余分なキー・別 kind を拒否する（科学的な閾値は作らない）", () => {
    const ok = coachManualReferenceInputSchema.safeParse({ kind: "TARGET_SPLIT", segments: [{ distanceM: 0.5, targetTimeS: 0.5 }] });
    expect(ok.success).toBe(true);
    for (const bad of [
      { kind: "TARGET_SPLIT", segments: [] },
      { kind: "TARGET_SPLIT", segments: [{ distanceM: 0, targetTimeS: 38 }] },
      { kind: "TARGET_SPLIT", segments: [{ distanceM: -300, targetTimeS: 38 }] },
      { kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 0 }] },
      { kind: "TARGET_SPLIT", segments: [{ distanceM: Number.POSITIVE_INFINITY, targetTimeS: 38 }] },
      { kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38, source: "MEASURED" }] },
      { kind: "RACE_PACE", event: "400m", targetTimeS: 50 },
      { kind: "SAME_DISTANCE_BEST", distanceM: 300 },
    ]) {
      expect(coachManualReferenceInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("R10-B4A.2: actor 境界", () => {
  it("COACH だけが coachReference を渡せる（AI_PLANNER / SYSTEM は PlanRequest の検証で拒否）", () => {
    for (const actor of [AI, SYSTEM]) {
      const r = planRunningPrescription(request({ actor }) as never);
      expect(r.status, actor.kind).toBe("BLOCKED");
      if (r.status !== "BLOCKED") throw new Error("unreachable");
      expect(r.findings.map((f) => f.code)).toContain("PLAN_REQUEST_INVALID");
    }
  });
});

describe("R10-B4A.2: reference resolution", () => {
  it("LONG は基準が無ければ INELIGIBLE、コーチ入力の目標スプリットがあれば OK（FULL・SP_LSR_FULL）", () => {
    const without = planRunningPrescription(request({ coachReference: null }) as never);
    expect(without.status).toBe("INELIGIBLE");
    if (without.status !== "INELIGIBLE") throw new Error("unreachable");
    expect(without.reasons.map((r) => r.code)).toEqual(["REFERENCE_UNAVAILABLE"]);

    const withSplit = planRunningPrescription(request() as never);
    expect(withSplit.status, JSON.stringify(withSplit)).toBe("OK");
    if (withSplit.status !== "OK") throw new Error("unreachable");
    expect(withSplit.prescription.recoveryStructure).toBe("FULL");
    expect(withSplit.prescription.stopPolicyId).toBe("SP_LSR_FULL");
    expect(withSplit.prescription.intensity.reference).toEqual(SPLIT);
  });

  it("RuleSet が許可しない Method では拒否する（Method 名の TS 分岐ではなく MethodMeta が source of truth）", () => {
    const r = planRunningPrescription(request({ method: "ACCELERATION", templateId: "ACC_BLOCK_30" }) as never);
    expect(r.status).toBe("BLOCKED");
    if (r.status !== "BLOCKED") throw new Error("unreachable");
    expect(r.findings.map((f) => f.code)).toContain("COACH_REFERENCE_INVALID");

    // RuleSet 側で許可すれば通る（TS の Method 分岐に依存していない）
    const ruleSet = structuredClone(getRuleSet("rs-2026.09.0")!);
    expect(ruleSet.methods.find((m) => m.method === "LONG_SPRINT_RACE_SPECIFIC")!.allowedIntensityReferences).toContain("TARGET_SPLIT");
    expect(ruleSet.methods.find((m) => m.method === "EVENT_APPROACH_SPEED")!.allowedIntensityReferences).toContain("TARGET_SPLIT");
    expect(ruleSet.methods.find((m) => m.method === "ACCELERATION")!.allowedIntensityReferences).not.toContain("TARGET_SPLIT");
  });

  it("優先順位は RuleSet の許可リストの順序（rs-2026.09.0 では、コーチ入力の目標スプリットが実測参照に負けない）", () => {
    const measured = ["MEASURED_VMAX", "FLY_SPLIT", "SAME_DISTANCE_BEST"];
    for (const m of getRuleSet("rs-2026.09.0")!.methods) {
      const kinds = [...m.allowedIntensityReferences];
      const splitIndex = kinds.indexOf("TARGET_SPLIT");
      if (splitIndex === -1) continue;
      const measuredBefore = kinds.slice(0, splitIndex).filter((k) => measured.includes(k));
      expect(measuredBefore, `${m.method} は実測参照を TARGET_SPLIT より先に解決する`).toEqual([]);
    }
  });
});

describe("R10-B4A.2: GROUP semantics と confidence", () => {
  it("GROUP では自動の目標タイムを作らない。ATHLETE では従来どおりコーチ入力値を区間として出す", () => {
    const group = planRunningPrescription(request() as never);
    if (group.status !== "OK") throw new Error(JSON.stringify(group));
    expect(group.prescription.intensity.target).toBeNull();
    expect(group.prescription.intensity.reference).toEqual(SPLIT);

    const athlete = planRunningPrescription(request({ subject: athleteSubject() }) as never);
    if (athlete.status !== "OK") throw new Error(JSON.stringify(athlete));
    expect(athlete.prescription.intensity.target).toEqual({ lower: 38, upper: 38, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" });
  });

  it("コーチ入力の基準は performance evidence の confidence を引き上げない（GROUP の上限・tier・処方の確信度）", () => {
    const r = planRunningPrescription(request() as never);
    if (r.status !== "OK") throw new Error(JSON.stringify(r));
    // GROUP の inputData 上限（LOW）を超えない
    expect(r.prescription.confidence.inputData).toBe("LOW");
    expect(r.prescription.confidence.prescription).not.toBe("HIGH");
    expect(r.prescription.confidence.directness).toBe("NOT_APPLICABLE");

    // EnvelopeTier は トレーニング歴から決まり、基準の入力では上がらない
    const developing = planRunningPrescription(
      request({
        method: "EVENT_APPROACH_SPEED",
        templateId: "EA_JUMP_SHORT_APPROACH",
        subject: groupSubject({ trainingAge: { structuredSprintYears: 1, coachAssignedTier: "DEVELOPING" } }),
        coachEdits: [{ field: "approachDistanceM", value: 30, unit: "m" }],
      }) as never,
    );
    if (developing.status !== "OK") throw new Error(JSON.stringify(developing));
    expect(developing.prescription.tier).toBe("DEVELOPMENTAL");
    expect(developing.prescription.intensity.reference.kind).toBe("TARGET_SPLIT");
  });
});
