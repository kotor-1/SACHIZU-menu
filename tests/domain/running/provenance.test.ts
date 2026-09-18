/**
 * R10-B1.1 — Provenance.inputsDigest の ageBand / trainingAgeTier「GROUP UNKNOWN」修正の検証。
 *
 * 確認すること:
 *   1. GROUP（members=[]）→ ageBand=UNKNOWN, trainingAgeTier=UNKNOWN（保守的な既定値へ偽装しない）
 *   2. GROUP（member あり）→ 実際に解決された値を保存する（UNKNOWN へ丸めない）
 *   3. 既存（R9 時点）の具体的な AgeBand/TrainingAgeTier を持つ provenance は今も validate できる
 *      （schemaVersion=1 のまま、後方互換）
 *   4. core の AgeBand / TrainingAgeTier 自体には "UNKNOWN" が混入していない
 */
import { describe, expect, it } from "vitest";
import { getActiveRuleSet } from "@/domain/running/rules/loader";
import { resolveSubjectProfile } from "@/domain/running/context/subject";
import { AGE_BANDS, ageBandSchema, TRAINING_AGE_TIERS, trainingAgeTierSchema, type Subject } from "@/domain/running/types/subject";
import { isoDateSchema } from "@/domain/running/types/primitives";
import { provenanceSchema, provenanceTrainingAgeTierSchema } from "@/domain/running/persistence/provenance";

const PLANNED_DATE = isoDateSchema.parse("2026-09-20");
const { ruleSet, contentHash } = getActiveRuleSet(PLANNED_DATE);

function baseProvenanceInputsDigest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tier: "DEVELOPMENTAL",
    ageBand: "UNKNOWN",
    maturityEffective: "UNKNOWN",
    trainingAgeTier: "UNKNOWN",
    phase: null,
    plannedDate: PLANNED_DATE,
    competitionWindows: [],
    referenceKinds: [],
    historyCoverage72h: "PARTIAL",
    readinessActions: [],
    ...overrides,
  };
}

function baseProvenance(inputsDigestOverrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    engineVersion: "0.0.0-test",
    ruleSet: { version: ruleSet.ruleSetVersion, contentHash, status: ruleSet.status },
    generatedBy: { proposer: { kind: "ENGINE" }, createdByCoach: false, acceptedByCoachAt: null },
    inputsDigest: baseProvenanceInputsDigest(inputsDigestOverrides),
    evidenceIds: [],
    confidence: { prescription: "LOW", directness: "DIRECT", inputData: "LOW" },
    coachEdits: [],
    overrides: [],
    aiReason: null,
  };
}

describe("R10-B1.1: GROUP の ageBand / trainingAgeTier — provenance は正直に記録する", () => {
  it("GROUP（members=[]）は resolveSubjectProfile 自体が UNKNOWN / BEGINNER(known=false) を返す", () => {
    const subject: Subject = { kind: "GROUP", profile: { label: "空グループ", members: [], allowAdvancedMethods: false } };
    const profile = resolveSubjectProfile({ subject, asOf: PLANNED_DATE, ruleSet });
    expect(profile.ageBand).toBe("UNKNOWN");
    expect(profile.trainingAgeKnown).toBe(false);

    // Provenance が記録すべき値（_running-plan-service.ts#inputsDigestFor と同じ変換）
    const provenanceAgeBand = profile.ageBand;
    const provenanceTrainingAgeTier = profile.trainingAgeKnown ? profile.trainingAgeTier : "UNKNOWN";
    expect(provenanceAgeBand).toBe("UNKNOWN");
    expect(provenanceTrainingAgeTier).toBe("UNKNOWN");

    const parsed = provenanceSchema.parse(
      baseProvenance({ ageBand: provenanceAgeBand, trainingAgeTier: provenanceTrainingAgeTier }),
    );
    expect(parsed.inputsDigest.ageBand).toBe("UNKNOWN");
    expect(parsed.inputsDigest.trainingAgeTier).toBe("UNKNOWN");
  });

  it("GROUP（member あり・年齢/トレーニング歴が分かっている）は UNKNOWN へ丸めず実際の値を記録する", () => {
    const subject: Subject = {
      kind: "GROUP",
      profile: {
        label: "テストグループ",
        allowAdvancedMethods: true,
        members: [
          {
            birthDate: null,
            ageBandOverride: "U15",
            maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: isoDateSchema.parse("2026-09-01") },
            trainingAge: { structuredSprintYears: 4, coachAssignedTier: "TRAINED" },
            primaryEvent: "400m",
          },
        ],
      },
    };
    const profile = resolveSubjectProfile({ subject, asOf: PLANNED_DATE, ruleSet });
    expect(profile.ageBand).toBe("U15");
    expect(profile.trainingAgeKnown).toBe(true);
    expect(profile.trainingAgeTier).toBe("TRAINED");

    const provenanceAgeBand = profile.ageBand;
    const provenanceTrainingAgeTier = profile.trainingAgeKnown ? profile.trainingAgeTier : "UNKNOWN";
    const parsed = provenanceSchema.parse(
      baseProvenance({ ageBand: provenanceAgeBand, trainingAgeTier: provenanceTrainingAgeTier }),
    );
    expect(parsed.inputsDigest.ageBand).toBe("U15");
    expect(parsed.inputsDigest.trainingAgeTier).toBe("TRAINED");
  });

  it("既存（R9 時点）の具体的な AgeBand/TrainingAgeTier を持つ provenance は今も validate できる（後方互換）", () => {
    const parsed = provenanceSchema.parse(baseProvenance({ ageBand: "ADULT", trainingAgeTier: "ADVANCED" }));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.inputsDigest.ageBand).toBe("ADULT");
    expect(parsed.inputsDigest.trainingAgeTier).toBe("ADVANCED");
  });

  it("core の AgeBand / TrainingAgeTier 自体には UNKNOWN を混入させない", () => {
    expect(AGE_BANDS).toEqual(["U12", "U15", "U18", "ADULT"]);
    expect(ageBandSchema.safeParse("UNKNOWN").success).toBe(false);
    expect(TRAINING_AGE_TIERS).toEqual(["BEGINNER", "DEVELOPING", "TRAINED", "ADVANCED"]);
    expect(trainingAgeTierSchema.safeParse("UNKNOWN").success).toBe(false);

    // Provenance 専用の型だけが UNKNOWN を許す
    expect(provenanceTrainingAgeTierSchema.safeParse("UNKNOWN").success).toBe(true);
    expect(provenanceTrainingAgeTierSchema.safeParse("ADVANCED").success).toBe(true);
  });
});
