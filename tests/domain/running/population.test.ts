import { describe, expect, it } from "vitest";

import { getRuleSet } from "@/domain/running/rules/loader";
import { resolveSubjectProfile } from "@/domain/running/context/subject";
import {
  resolveEligibility,
  resolveConstraints,
  applyConstraintsToEligibility,
  type EligibilityDecision,
  type EligibilityMode,
} from "@/domain/running/context/constraints";
import { resolveReference } from "@/domain/running/context/performance";
import { isAssistedManualCandidate, resolveSubjectEligibility } from "@/domain/running/context/subject";
import type { AthleteProfile, GroupProfile, Subject } from "@/domain/running/types/subject";
import type { IsoDate } from "@/domain/running/types/primitives";

const ruleSet = getRuleSet("rs-2026.09.0")!;

function iso(value: string): IsoDate {
  return value as IsoDate;
}

function athlete(overrides: Partial<AthleteProfile> = {}): Subject {
  return {
    kind: "ATHLETE",
    profile: {
      birthDate: null,
      primaryEvent: "400m",
      maturity: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
      trainingAge: { structuredSprintYears: null },
      marks: [],
      allowAdvancedMethods: false,
      ...overrides,
    },
  };
}

function group(overrides: Partial<GroupProfile> = {}): Subject {
  return {
    kind: "GROUP",
    profile: {
      label: "test group",
      members: [],
      allowAdvancedMethods: false,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// §4.4 全64セル 表駆動テスト（要件22・23）
// ---------------------------------------------------------------------------

describe("§4.4 eligibility — full 64-row table-driven test", () => {
  it("RuleSet.eligibility は64件（16行×4 maturityCategory）", () => {
    expect(ruleSet.eligibility.length).toBe(64);
  });

  for (const rule of ruleSet.eligibility) {
    for (const templateId of rule.templateIds) {
      it(`${rule.ruleId} / ${templateId}: resolveEligibility が RuleSet の値と一致する`, () => {
        const decision = resolveEligibility(ruleSet, rule.method, templateId, rule.maturityCategory);
        const expectedMode: EligibilityMode =
          rule.outcome === "AUTO" && rule.requiresPhaseEvaluation ? "CONDITIONAL_AUTO" : rule.outcome;
        expect(decision.mode).toBe(expectedMode);
        expect(decision.requiresReview).toBe(rule.requiresReview);
        expect(decision.overrideAllowed).toBe(rule.overrideAllowed);
        expect(decision.conditionNote).toBe(rule.conditionNote);
        expect(decision.sourceRuleId).toBe(rule.ruleId);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// T-POP-01: maturity UNKNOWN と PRE の違い（要件24, 最重要回帰）
// ---------------------------------------------------------------------------

describe("T-POP-01: U15 + maturity UNKNOWN(method=NONE) + trainingAge 3年", () => {
  const subject = athlete({
    birthDate: null,
    ageBandOverride: "U15",
    maturity: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
    trainingAge: { structuredSprintYears: 3 },
  }) as { kind: "ATHLETE"; profile: AthleteProfile };
  const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });

  it("effective=EFFECTIVE_UNKNOWN, tier=DEVELOPMENTAL", () => {
    expect(profile.maturity?.constraintCategory).toBe("EFFECTIVE_UNKNOWN");
    expect(profile.envelopeTier).toBe("DEVELOPMENTAL");
  });

  it("LONG(FULL/INCOMPLETE) / ASSISTED / RS_HEAVY は ineligible", () => {
    const category = profile.maturity!.constraintCategory;
    const longFull = applyConstraintsToEligibility(
      resolveEligibility(ruleSet, "LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", category),
      profile.resolvedConstraints,
      "LSR_SPECIAL_ENDURANCE_I",
    );
    const assisted = applyConstraintsToEligibility(
      resolveEligibility(ruleSet, "ASSISTED_SPRINT", "AS_TOWING", category),
      profile.resolvedConstraints,
      "AS_TOWING",
    );
    const rsHeavy = applyConstraintsToEligibility(
      resolveEligibility(ruleSet, "RESISTED_SPRINT", "RS_SLED_HEAVY", category),
      profile.resolvedConstraints,
      "RS_SLED_HEAVY",
    );
    expect(longFull.mode).toBe("INELIGIBLE");
    expect(assisted.mode).toBe("INELIGIBLE");
    expect(rsHeavy.mode).toBe("INELIGIBLE");
  });

  it("ACC≤20m は AUTO", () => {
    const decision = resolveEligibility(ruleSet, "ACCELERATION", "ACC_BLOCK_20", profile.maturity!.constraintCategory);
    expect(decision.mode).toBe("AUTO");
  });

  it("STRIDE は AUTO", () => {
    const decision = resolveEligibility(ruleSet, "STRIDE", "ST_WARMUP", profile.maturity!.constraintCategory);
    expect(decision.mode).toBe("AUTO");
  });

  it("MV_FLY10 は AUTO で reps≤3 の条件が付く", () => {
    const decision = resolveEligibility(ruleSet, "MAX_VELOCITY", "MV_FLY10", profile.maturity!.constraintCategory);
    expect(decision.mode).toBe("AUTO");
    expect(decision.conditionNote).toContain("reps≤3");
  });

  it("SES は MANUAL + REVIEW（PREなら INELIGIBLE になるはずの差分を明示）", () => {
    const decisionEffectiveUnknown = resolveEligibility(
      ruleSet,
      "SPRINT_ENDURANCE_SHORT",
      "SES_100",
      profile.maturity!.constraintCategory,
    );
    expect(decisionEffectiveUnknown.mode).toBe("MANUAL");
    expect(decisionEffectiveUnknown.requiresReview).toBe(true);

    // PRE との対比（UNKNOWNをPREへnormalizeしていないことの直接証拠）。
    const decisionPre = resolveEligibility(ruleSet, "SPRINT_ENDURANCE_SHORT", "SES_100", "PRE");
    expect(decisionPre.mode).toBe("INELIGIBLE");
    expect(decisionPre.overrideAllowed).toBe(true);
    expect(decisionEffectiveUnknown.mode).not.toBe(decisionPre.mode);
  });
});

// ---------------------------------------------------------------------------
// T-POP-02: U12 PRE
// ---------------------------------------------------------------------------

describe("T-POP-02: U12 + PRE", () => {
  const subject = athlete({
    ageBandOverride: "U12",
    maturity: { status: "PRE", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
    trainingAge: { structuredSprintYears: null },
  }) as { kind: "ATHLETE"; profile: AthleteProfile };
  const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });

  it("LONG/ASSISTED/TI/RS_HEAVY は non-overridable（U12 hard constraint。§8.2）", () => {
    const category = profile.maturity!.constraintCategory;
    expect(category).toBe("PRE");

    const long = applyConstraintsToEligibility(
      resolveEligibility(ruleSet, "LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", category),
      profile.resolvedConstraints,
      "LSR_SPECIAL_ENDURANCE_I",
    );
    const assisted = applyConstraintsToEligibility(
      resolveEligibility(ruleSet, "ASSISTED_SPRINT", "AS_TOWING", category),
      profile.resolvedConstraints,
      "AS_TOWING",
    );
    const ti = applyConstraintsToEligibility(
      resolveEligibility(ruleSet, "TEMPO_INTENSIVE", "TI_COACH_DEFINED", category),
      profile.resolvedConstraints,
      "TI_COACH_DEFINED",
    );
    const rsHeavy = applyConstraintsToEligibility(
      resolveEligibility(ruleSet, "RESISTED_SPRINT", "RS_SLED_HEAVY", category),
      profile.resolvedConstraints,
      "RS_SLED_HEAVY",
    );

    for (const d of [long, assisted, ti, rsHeavy]) {
      expect(d.mode).toBe("INELIGIBLE");
      expect(d.overrideAllowed).toBe(false);
    }
  });

  it("自動生成は complexity=LOW のみ許可される", () => {
    expect(profile.resolvedConstraints.maxAutoComplexity).toBe("LOW");
  });
});

// ---------------------------------------------------------------------------
// T-POP-03: U15 declared POST + rapid growth
// ---------------------------------------------------------------------------

describe("T-POP-03: U15 declared POST, growth > 7.2cm/year", () => {
  const subject = athlete({
    ageBandOverride: "U15",
    maturity: {
      status: "POST",
      confidence: "MEDIUM",
      method: "GROWTH_VELOCITY",
      assessedAt: iso("2026-01-01"),
      heightHistory: [
        { date: iso("2025-01-01"), heightCm: 150 },
        { date: iso("2026-01-01"), heightCm: 160 }, // 10cm/年
      ],
    },
    trainingAge: { structuredSprintYears: 3 },
  }) as { kind: "ATHLETE"; profile: AthleteProfile };
  const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });

  it("rapidGrowth=true は CHECK_ONLY で、申告 category/tier を変更しない", () => {
    expect(profile.rapidGrowthFlag).toBe(true);
    expect(profile.maturity?.constraintCategory).toBe("POST");
    expect(profile.envelopeTier).toBe("ADVANCED");
  });
});

// ---------------------------------------------------------------------------
// T-POP-04: U18 POST/MEDIUM, 0.5年
// ---------------------------------------------------------------------------

describe("T-POP-04: U18 POST/MEDIUM, trainingAge 0.5年", () => {
  const subject = athlete({
    ageBandOverride: "U18",
    maturity: { status: "POST", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
    trainingAge: { structuredSprintYears: 0.5 },
  }) as { kind: "ATHLETE"; profile: AthleteProfile };
  const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });

  it("trainingAgeTier=BEGINNER, envelopeTier=DEVELOPMENTAL", () => {
    expect(profile.trainingAgeTier).toBe("BEGINNER");
    expect(profile.envelopeTier).toBe("DEVELOPMENTAL");
  });
});

// ---------------------------------------------------------------------------
// T-POP-05: ADULT, training years=null
// ---------------------------------------------------------------------------

describe("T-POP-05: ADULT, structuredSprintYears=null", () => {
  const subject = athlete({
    ageBandOverride: "ADULT",
    maturity: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
    trainingAge: { structuredSprintYears: null },
  }) as { kind: "ATHLETE"; profile: AthleteProfile };
  const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });

  it("POST/HIGH → BEGINNER → DEVELOPMENTAL（成人でも初心者はDEVELOPMENTAL）", () => {
    expect(profile.maturity?.normalizedStatus).toBe("POST");
    expect(profile.maturity?.effectiveConfidence).toBe("HIGH");
    expect(profile.trainingAgeTier).toBe("BEGINNER");
    expect(profile.envelopeTier).toBe("DEVELOPMENTAL");
  });
});

// ---------------------------------------------------------------------------
// T-POP-06: ADULT + coachAssignedTier=ADVANCED + PHOTO_CELL fly
// ---------------------------------------------------------------------------

describe("T-POP-06: ADULT, coachAssignedTier=ADVANCED, PHOTO_CELL fly", () => {
  const subject = athlete({
    ageBandOverride: "ADULT",
    maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
    trainingAge: { structuredSprintYears: null, coachAssignedTier: "ADVANCED" },
    marks: [{ event: "FLY20", timeS: 2.0, date: iso("2026-01-01"), timing: "PHOTO_CELL" }],
  }) as { kind: "ATHLETE"; profile: AthleteProfile };
  const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-05"), ruleSet });

  it("EnvelopeTier=ADVANCED", () => {
    expect(profile.envelopeTier).toBe("ADVANCED");
  });

  it("reference は high input confidence context を返す", () => {
    const ref = resolveReference({
      method: "MAX_VELOCITY",
      marks: subject.profile.marks,
      vmax: subject.profile.vmax ?? null,
      ageBand: profile.ageBand,
      asOf: iso("2026-01-05"),
      ruleSet,
    });
    expect(ref.confidence).toBe("HIGH");
  });

  it("secondary report の処方根拠と primary-checked の限定的な根拠を混同しない", () => {
    // Phase 3B は一次照合済みの限定的な資料を保持するが、Haugen の
    // best-practice synthesis は引き続き SECONDARY_REPORT_ONLY である。
    expect(ruleSet.evidence.find((e) => e.id === "EV_HAUGEN_2019_REVIEW")?.verification).toBe("SECONDARY_REPORT_ONLY");
    expect(ruleSet.evidence.filter((e) => e.verification === "PRIMARY_CHECKED")).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// T-POP-07: ASSISTED eligibility
// ---------------------------------------------------------------------------

describe("T-POP-07: ASSISTED_SPRINT eligibility", () => {
  it("youth（U15, PRE）は non-overridable ineligible", () => {
    const subject = athlete({
      ageBandOverride: "U15",
      maturity: { status: "PRE", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
    }) as { kind: "ATHLETE"; profile: AthleteProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
    const decision = applyConstraintsToEligibility(
      resolveEligibility(ruleSet, "ASSISTED_SPRINT", "AS_TOWING", profile.maturity!.constraintCategory),
      profile.resolvedConstraints,
      "AS_TOWING",
    );
    expect(decision.mode).toBe("INELIGIBLE");
    expect(decision.overrideAllowed).toBe(false);
  });

  it("non-ADVANCED な成人（DEVELOPMENTAL）は MANUAL だが manual candidate 条件も満たさない", () => {
    const subject = athlete({
      ageBandOverride: "ADULT",
      maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
      trainingAge: { structuredSprintYears: null }, // BEGINNER → DEVELOPMENTAL
    }) as { kind: "ATHLETE"; profile: AthleteProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
    expect(profile.envelopeTier).toBe("DEVELOPMENTAL");
    expect(isAssistedManualCandidate(profile, "HIGH", ruleSet)).toBe(false);
  });

  it("全条件を満たした成人/POST/ADVANCEDでも AUTO にはならない（MANUALのまま）", () => {
    const subject = athlete({
      ageBandOverride: "ADULT",
      maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
      trainingAge: { structuredSprintYears: null, coachAssignedTier: "ADVANCED" },
      allowAdvancedMethods: true,
    }) as { kind: "ATHLETE"; profile: AthleteProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
    expect(profile.envelopeTier).toBe("ADVANCED");

    const decision = resolveEligibility(ruleSet, "ASSISTED_SPRINT", "AS_TOWING", profile.maturity!.constraintCategory);
    expect(decision.mode).toBe("MANUAL"); // AUTOではない
    expect(isAssistedManualCandidate(profile, "MEDIUM", ruleSet)).toBe(true); // 手動候補にはなりうる
    expect(isAssistedManualCandidate(profile, "LOW", ruleSet)).toBe(false); // vmax confidence不足なら候補にならない
    expect(isAssistedManualCandidate(profile, null, ruleSet)).toBe(false); // vmaxデータが無ければ候補にならない
  });
});

// ---------------------------------------------------------------------------
// Group resolution（要件18・19・42）
// ---------------------------------------------------------------------------

describe("Group resolution", () => {
  it("1) U12 + ADULT mixed group → 制約はU12相当、EnvelopeTier=DEVELOPMENTAL", () => {
    const subject = group({
      members: [
        {
          birthDate: null,
          ageBandOverride: "U12",
          maturity: { status: "PRE", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: null },
          primaryEvent: "100m",
        },
        {
          birthDate: null,
          ageBandOverride: "ADULT",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
          primaryEvent: "400m",
        },
      ],
    }) as { kind: "GROUP"; profile: GroupProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });

    expect(profile.envelopeTier).toBe("DEVELOPMENTAL");
    expect(profile.resolvedConstraints.disallowedMethods.get("ASSISTED_SPRINT")).toBe(false); // U12由来のnon-overridable制約が効く
    expect(profile.resolvedConstraints.maxAutoComplexity).toBe("LOW");
  });

  it("2) POST/ADVANCED member + CIRCA/BEGINNER member → group全体はDEVELOPMENTAL、eligibilityはintersection", () => {
    const subject = group({
      members: [
        {
          birthDate: null,
          ageBandOverride: "ADULT",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
          primaryEvent: "400m",
        },
        {
          birthDate: null,
          ageBandOverride: "U18",
          maturity: { status: "CIRCA", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: 0.2 },
          primaryEvent: "200m",
        },
      ],
    }) as { kind: "GROUP"; profile: GroupProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });

    expect(profile.envelopeTier).toBe("DEVELOPMENTAL"); // 1人でもDEVELOPMENTALならgroup全体もDEVELOPMENTAL
    expect([...profile.effectiveMaturityCategories].sort()).toEqual(["CIRCA", "POST"].sort());
    expect(profile.trainingAgeTier).toBe("BEGINNER"); // 最も低いtier
  });

  it("3) 全member POST/TRAINED以上 → 条件が揃えばADVANCED可能", () => {
    const subject = group({
      members: [
        {
          birthDate: null,
          ageBandOverride: "ADULT",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: 4 },
          primaryEvent: "400m",
        },
        {
          birthDate: null,
          ageBandOverride: "ADULT",
          maturity: { status: "POST", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: null, coachAssignedTier: "TRAINED" },
          primaryEvent: "200m",
        },
      ],
    }) as { kind: "GROUP"; profile: GroupProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
    expect(profile.envelopeTier).toBe("ADVANCED");
  });

  it("4) members=[] → UNKNOWN / EFFECTIVE_UNKNOWN / BEGINNER / DEVELOPMENTAL（要件19）", () => {
    const subject = group({ members: [] }) as { kind: "GROUP"; profile: GroupProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });

    expect(profile.ageBand).toBe("UNKNOWN");
    expect(profile.effectiveMaturityCategories).toEqual(["EFFECTIVE_UNKNOWN"]);
    expect(profile.trainingAgeKnown).toBe(false);
    expect(profile.trainingAgeTier).toBe("BEGINNER");
    expect(profile.envelopeTier).toBe("DEVELOPMENTAL");
    // 空groupでもU12相当の保守的制約が適用される（要件19: 全可能member条件の積集合）。
    expect(profile.resolvedConstraints.maxAutoComplexity).toBe("LOW");
  });

  it("5) GROUP では個人の marks/vmax を使わない（performanceAvailable=false, inputDataConfidenceCap=LOW）", () => {
    const subject = group({
      members: [
        {
          birthDate: null,
          ageBandOverride: "ADULT",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: 5 },
          primaryEvent: "400m",
        },
      ],
    }) as { kind: "GROUP"; profile: GroupProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
    expect(profile.performanceAvailable).toBe(false);
    expect(profile.inputDataConfidenceCap).toBe("LOW");
  });

  it("GROUP は複数memberのmaturityを1つへ平均化しない（memberMaturitiesが個別に残る）", () => {
    const subject = group({
      members: [
        {
          birthDate: null,
          ageBandOverride: "U15",
          maturity: { status: "PRE", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: null },
          primaryEvent: "100m",
        },
        {
          birthDate: null,
          ageBandOverride: "ADULT",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
          trainingAge: { structuredSprintYears: 5 },
          primaryEvent: "400m",
        },
      ],
    }) as { kind: "GROUP"; profile: GroupProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
    expect(profile.memberMaturities.length).toBe(2);
    expect(profile.maturity).toBeNull(); // GROUPは単一のmaturityを持たない
    expect(new Set(profile.memberMaturities.map((m) => m.constraintCategory))).toEqual(new Set(["PRE", "POST"]));
  });
});

// ---------------------------------------------------------------------------
// LONG primaryEvent の context 判定（要件27）
// ---------------------------------------------------------------------------

describe("LONG primaryEvent qualification (§4.5, 要件27)", () => {
  it("200m/400m/400mH は LONG FULL/INCOMPLETE の候補event", async () => {
    const { qualifiesForLongSprintEvent, qualifiesForLongIncomplete } = await import("@/domain/running/context/subject");
    expect(qualifiesForLongSprintEvent("200m")).toBe(true);
    expect(qualifiesForLongSprintEvent("400m")).toBe(true);
    expect(qualifiesForLongSprintEvent("400mH")).toBe(true);
    expect(qualifiesForLongSprintEvent("100m")).toBe(false);
    expect(qualifiesForLongSprintEvent("HURDLES")).toBe(false);
    expect(qualifiesForLongSprintEvent(null)).toBe(false);

    const subject = athlete({
      ageBandOverride: "ADULT",
      maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
      trainingAge: { structuredSprintYears: 5 },
      primaryEvent: "400m",
    }) as { kind: "ATHLETE"; profile: AthleteProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
    expect(profile.envelopeTier).toBe("ADVANCED");
    expect(qualifiesForLongIncomplete(profile, "400m")).toBe(true);
    expect(qualifiesForLongIncomplete(profile, "100m")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveConstraints の maturity/training-age complexity capは
// 表を再定義せずRuleSetから読んでいることの確認（要件25）
// ---------------------------------------------------------------------------

describe("complexity cap intersection", () => {
  it("U12 + PRE + BEGINNER の全条件が重なっても complexity は LOW（最小値。最大でLOWにはならない）", () => {
    const result = resolveConstraints(ruleSet, "U12", "PRE", "BEGINNER");
    expect(result.maxAutoComplexity).toBe("LOW");
  });
});

// ---------------------------------------------------------------------------
// T-POP-07（R3 eligibility 部分）: 年齢帯 × maturity × ASSISTED_SPRINT
// §8.2 [R3 errata] で U15 に ASSISTED 不適格（override 不可）を追加した。
// ---------------------------------------------------------------------------

describe("T-POP-07 (R3 eligibility): ASSISTED_SPRINT by ageBand × maturity", () => {
  function assistedProfile(
    ageBandOverride: "U12" | "U15" | "U18" | "ADULT",
    status: "PRE" | "CIRCA" | "POST" | "UNKNOWN",
    method: "COACH_OBSERVATION" | "NONE" = "COACH_OBSERVATION",
  ) {
    const subject = athlete({
      ageBandOverride,
      maturity: { status, confidence: "MEDIUM", method, assessedAt: iso("2026-01-01") },
      trainingAge: { structuredSprintYears: null, coachAssignedTier: "ADVANCED" },
      allowAdvancedMethods: true,
    }) as { kind: "ATHLETE"; profile: AthleteProfile };
    return resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
  }

  for (const templateId of ["AS_TOWING", "AS_DOWNHILL"]) {
    it(`U12 POST ADVANCED → ${templateId} は non-overridable INELIGIBLE、manual candidate にならない`, () => {
      const profile = assistedProfile("U12", "POST");
      expect(profile.envelopeTier).toBe("ADVANCED");
      const d = resolveSubjectEligibility(profile, "ASSISTED_SPRINT", templateId, ruleSet);
      expect(d.mode).toBe("INELIGIBLE");
      expect(d.overrideAllowed).toBe(false);
      expect(isAssistedManualCandidate(profile, "HIGH", ruleSet)).toBe(false);
    });

    it(`U15 POST ADVANCED → ${templateId} は non-overridable INELIGIBLE、manual candidate にならない（CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE）`, () => {
      const profile = assistedProfile("U15", "POST");
      expect(profile.maturity?.constraintCategory).toBe("POST");
      expect(profile.envelopeTier).toBe("ADVANCED");
      expect(profile.resolvedConstraints.appliedConstraintIds).toContain("CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE");
      const d = resolveSubjectEligibility(profile, "ASSISTED_SPRINT", templateId, ruleSet);
      expect(d.mode).toBe("INELIGIBLE");
      expect(d.overrideAllowed).toBe(false);
      expect(isAssistedManualCandidate(profile, "HIGH", ruleSet)).toBe(false);
    });
  }

  for (const [status, method, expectedCategory] of [
    ["PRE", "COACH_OBSERVATION", "PRE"],
    ["CIRCA", "COACH_OBSERVATION", "CIRCA"],
    ["UNKNOWN", "NONE", "EFFECTIVE_UNKNOWN"],
  ] as const) {
    it(`U18 ${expectedCategory} → ASSISTED は non-overridable INELIGIBLE`, () => {
      const profile = assistedProfile("U18", status, method);
      expect(profile.maturity?.constraintCategory).toBe(expectedCategory);
      const d = resolveSubjectEligibility(profile, "ASSISTED_SPRINT", "AS_TOWING", ruleSet);
      expect(d.mode).toBe("INELIGIBLE");
      expect(d.overrideAllowed).toBe(false);
      expect(isAssistedManualCandidate(profile, "HIGH", ruleSet)).toBe(false);
    });
  }

  it("U18 POST ADVANCED + allowAdvancedMethods + vmax≥MEDIUM → manual candidate（年齢だけでU18を禁止しない）", () => {
    const profile = assistedProfile("U18", "POST");
    expect(profile.envelopeTier).toBe("ADVANCED");
    expect(profile.resolvedConstraints.disallowedMethods.has("ASSISTED_SPRINT")).toBe(false);
    expect(isAssistedManualCandidate(profile, "MEDIUM", ruleSet)).toBe(true);
    expect(isAssistedManualCandidate(profile, "HIGH", ruleSet)).toBe(true);
    expect(isAssistedManualCandidate(profile, "LOW", ruleSet)).toBe(false);
  });

  it("U18 POST ADVANCED の manual candidate でも mode は MANUAL（AUTO にはならない）", () => {
    const profile = assistedProfile("U18", "POST");
    for (const templateId of ["AS_TOWING", "AS_DOWNHILL"]) {
      const d = resolveSubjectEligibility(profile, "ASSISTED_SPRINT", templateId, ruleSet);
      expect(d.mode).toBe("MANUAL");
      expect(d.mode).not.toBe("AUTO");
    }
  });

  it("allowAdvancedMethods=false なら U18 POST ADVANCED でも manual candidate にならない", () => {
    const subject = athlete({
      ageBandOverride: "U18",
      maturity: { status: "POST", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-01-01") },
      trainingAge: { structuredSprintYears: null, coachAssignedTier: "ADVANCED" },
      allowAdvancedMethods: false,
    }) as { kind: "ATHLETE"; profile: AthleteProfile };
    const profile = resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
    expect(isAssistedManualCandidate(profile, "HIGH", ruleSet)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4.4 [R3 errata]: confidence を下げても eligibility は緩まない（monotonic safety）
// ---------------------------------------------------------------------------

describe("§4.4 [R3 errata] confidence downgrade never loosens eligibility", () => {
  const MODE_RANK: Record<EligibilityMode, number> = { AUTO: 0, CONDITIONAL_AUTO: 1, MANUAL: 2, INELIGIBLE: 3 };
  const COMPLEXITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

  /** a が b と同等以上に制約的なら true。 */
  function atLeastAsRestrictive(a: EligibilityDecision, b: EligibilityDecision): boolean {
    if (MODE_RANK[a.mode] !== MODE_RANK[b.mode]) return MODE_RANK[a.mode] > MODE_RANK[b.mode];
    if (a.mode === "INELIGIBLE" && b.overrideAllowed === false && a.overrideAllowed !== false) return false;
    if (b.requiresReview && !a.requiresReview) return false;
    return true;
  }

  function profileFor(
    ageBandOverride: "U12" | "U15" | "U18",
    status: "PRE" | "CIRCA" | "POST" | "UNKNOWN",
    confidence: "LOW" | "MEDIUM" | "HIGH",
    method: "COACH_OBSERVATION" | "PARENT_REPORT" | "MATURITY_OFFSET_EQUATION",
  ) {
    const subject = athlete({
      ageBandOverride,
      maturity: { status, confidence, method, assessedAt: iso("2026-01-01") },
      trainingAge: { structuredSprintYears: 4 }, // TRAINED（EnvelopeTier の昇格も検査できるようにする）
      allowAdvancedMethods: true,
    }) as { kind: "ATHLETE"; profile: AthleteProfile };
    return resolveSubjectProfile({ subject, asOf: iso("2026-01-01"), ruleSet });
  }

  it("指定ケース: PRE MEDIUM→LOW は PRE のまま、CIRCA MEDIUM→LOW は CIRCA のまま、POST MEDIUM→LOW は EFFECTIVE_UNKNOWN", () => {
    expect(profileFor("U15", "PRE", "MEDIUM", "COACH_OBSERVATION").maturity?.constraintCategory).toBe("PRE");
    expect(profileFor("U15", "PRE", "LOW", "COACH_OBSERVATION").maturity?.constraintCategory).toBe("PRE");
    expect(profileFor("U15", "CIRCA", "MEDIUM", "COACH_OBSERVATION").maturity?.constraintCategory).toBe("CIRCA");
    expect(profileFor("U15", "CIRCA", "LOW", "COACH_OBSERVATION").maturity?.constraintCategory).toBe("CIRCA");
    expect(profileFor("U18", "POST", "MEDIUM", "COACH_OBSERVATION").maturity?.constraintCategory).toBe("POST");
    expect(profileFor("U18", "POST", "LOW", "COACH_OBSERVATION").maturity?.constraintCategory).toBe("EFFECTIVE_UNKNOWN");
  });

  const DOWNGRADES = [
    ["HIGH", "MEDIUM"],
    ["HIGH", "LOW"],
    ["MEDIUM", "LOW"],
  ] as const;

  for (const ageBand of ["U12", "U15", "U18"] as const) {
    for (const status of ["PRE", "CIRCA", "POST", "UNKNOWN"] as const) {
      for (const method of ["COACH_OBSERVATION", "PARENT_REPORT", "MATURITY_OFFSET_EQUATION"] as const) {
        for (const [higher, lower] of DOWNGRADES) {
          it(`${ageBand} ${status} ${method}: ${higher}→${lower} で全64行×全templateの判定・EnvelopeTier・complexity上限が緩まない`, () => {
            const hi = profileFor(ageBand, status, higher, method);
            const lo = profileFor(ageBand, status, lower, method);
            for (const rule of ruleSet.eligibility) {
              for (const templateId of rule.templateIds) {
                const dHi = resolveSubjectEligibility(hi, rule.method, templateId, ruleSet);
                const dLo = resolveSubjectEligibility(lo, rule.method, templateId, ruleSet);
                expect(
                  atLeastAsRestrictive(dLo, dHi),
                  `${rule.method}/${templateId}: ${higher}=${dHi.mode}(review=${dHi.requiresReview},override=${dHi.overrideAllowed}) → ${lower}=${dLo.mode}(review=${dLo.requiresReview},override=${dLo.overrideAllowed})`,
                ).toBe(true);
              }
            }
            expect(!(hi.envelopeTier === "DEVELOPMENTAL" && lo.envelopeTier === "ADVANCED")).toBe(true);
            expect(COMPLEXITY_RANK[lo.resolvedConstraints.maxAutoComplexity]).toBeLessThanOrEqual(
              COMPLEXITY_RANK[hi.resolvedConstraints.maxAutoComplexity],
            );
          });
        }
      }
    }
  }

  it("errata 前の読み（PRE+LOW→EFFECTIVE_UNKNOWN）だと SES が緩む — errata が必要な理由の回帰証拠", () => {
    const pre = resolveEligibility(ruleSet, "SPRINT_ENDURANCE_SHORT", "SES_100", "PRE");
    const effectiveUnknown = resolveEligibility(ruleSet, "SPRINT_ENDURANCE_SHORT", "SES_100", "EFFECTIVE_UNKNOWN");
    expect(atLeastAsRestrictive(effectiveUnknown, pre)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// root public API（§1.5）: R3 の root export は resolveSubjectProfile だけ
// ---------------------------------------------------------------------------

describe("root public API (R3)", () => {
  it("root index は resolveSubjectProfile を export し、R4 内部用 helper は export しない", async () => {
    const api = await import("@/domain/running");
    expect(typeof api.resolveSubjectProfile).toBe("function");
    for (const internal of [
      "qualifiesForLongSprintEvent",
      "qualifiesForLongIncomplete",
      "isAssistedManualCandidate",
      "resolveSubjectEligibility",
      "resolveAgeBand",
      "normalizeMaturity",
      "computeGrowthVelocity",
      "deriveTrainingAgeTier",
      "deriveEnvelopeTier",
      "resolveEligibility",
      "resolveConstraints",
      "intersectResolvedConstraints",
      "intersectEligibilityDecisions",
      "applyConstraintsToEligibility",
      "resolveReference",
      "computeFlySplitVelocity",
      "evaluateInputPlausibility",
    ]) {
      expect(internal in api, internal).toBe(false);
    }
  });
});
