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
import { createHash } from "node:crypto";
import { getActiveRuleSet } from "@/domain/running/rules/loader";
import { resolveSubjectProfile } from "@/domain/running/context/subject";
import { AGE_BANDS, ageBandSchema, TRAINING_AGE_TIERS, trainingAgeTierSchema, type Subject } from "@/domain/running/types/subject";
import { isoDateSchema } from "@/domain/running/types/primitives";
import { provenanceSchema, provenanceTrainingAgeTierSchema } from "@/domain/running/persistence/provenance";
import { PROVENANCE_JSON_MAX_BYTES, jsonByteLimitIssue } from "@/domain/running/persistence/limits";
import { buildPlausibilityIssueDigest } from "@/application/running-plausibility-review";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";

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

function plausibilityReview(overrides: Record<string, unknown> = {}) {
  const review = {
    ruleId: "PLA_REPS_PER_SET",
    findingCode: "PLAUSIBILITY_BLOCK",
    scope: "ITEM",
    target: { kind: "PRESCRIPTION_FIELD", field: "repsPerSet" },
    observation: { kind: "SCALAR", value: 31, unit: "reps" },
    boundary: { side: "MAX", threshold: 30 },
    certainty: "CONFIRMED_EXCEED",
    ruleSet: { version: ruleSet.ruleSetVersion, contentHash },
    contextDigest: "a".repeat(64),
    issueDigest: "b".repeat(64),
    reason: "コーチが現在値を再確認しました",
    confirmedTwice: true,
    actor: { kind: "COACH", ownerId: "coach-1" },
    at: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
  const identity = Object.fromEntries(Object.entries(review).filter(([key]) =>
    !["issueDigest", "reason", "confirmedTwice", "actor", "at"].includes(key),
  ));
  return { ...review, issueDigest: buildPlausibilityIssueDigest(identity as Parameters<typeof buildPlausibilityIssueDigest>[0]) };
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

  it("初回 coachEdits と coachEdits field の無い旧 provenance を読み込める", () => {
    const initialEdit = provenanceSchema.parse({
      ...baseProvenance(),
      coachEdits: [{ at: "2026-09-20T10:00:00+09:00", field: "totalReps", to: 2 }],
    });
    expect(initialEdit.coachEdits).toEqual([{ at: "2026-09-20T10:00:00+09:00", field: "totalReps", to: 2 }]);

    const legacy: Record<string, unknown> = { ...baseProvenance() };
    delete legacy.coachEdits;
    expect(provenanceSchema.parse(legacy).coachEdits).toEqual([]);
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

describe("OPEN20 F2: plausibility review provenance is optional and bounded", () => {
  it("uses standard SHA-256 over UTF-8 bytes", () => {
    expect(sha256Utf8Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Utf8Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it.each(["日本語", "🏃‍♀️", "\ud800", ...[55, 56, 63, 64, 65, 1000].map((length) => "x".repeat(length))])("matches Node SHA-256 for UTF-8 and padding case %#", (text) => {
    for (const input of [text, canonicalStringify({ text, observation: { upper: null, lower: 31, unit: "m" } })]) {
      expect(sha256Utf8Hex(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    }
  });

  it("accepts legacy provenance with the field absent, an empty list, and one valid review", () => {
    expect(provenanceSchema.parse(baseProvenance()).plausibilityReviews).toBeUndefined();
    expect(provenanceSchema.parse({ ...baseProvenance(), plausibilityReviews: [] }).plausibilityReviews).toEqual([]);
    expect(provenanceSchema.parse({ ...baseProvenance(), plausibilityReviews: [plausibilityReview()] }).plausibilityReviews).toHaveLength(1);
  });

  it("rejects malformed reviews, duplicate issue digests, and reviews from another RuleSet", () => {
    expect(provenanceSchema.safeParse({ ...baseProvenance(), plausibilityReviews: [{ issueDigest: "bad" }] }).success).toBe(false);
    expect(provenanceSchema.safeParse({
      ...baseProvenance(),
      plausibilityReviews: [plausibilityReview(), plausibilityReview()],
    }).success).toBe(false);
    expect(provenanceSchema.safeParse({
      ...baseProvenance(),
      plausibilityReviews: [plausibilityReview({ ruleSet: { version: ruleSet.ruleSetVersion, contentHash: "c".repeat(64) } })],
    }).success).toBe(false);
  });

  it("recomputes the stored issue digest from review identity, excluding reason and audit metadata", () => {
    const valid = plausibilityReview();
    expect(provenanceSchema.safeParse({ ...baseProvenance(), plausibilityReviews: [valid] }).success).toBe(true);
    expect(provenanceSchema.safeParse({
      ...baseProvenance(),
      plausibilityReviews: [{ ...valid, observation: { kind: "SCALAR", value: 32, unit: "reps" } }],
    }).success).toBe(false);
    expect(provenanceSchema.safeParse({
      ...baseProvenance(),
      plausibilityReviews: [{ ...valid, boundary: { side: "MIN", threshold: 30 } }],
    }).success).toBe(false);
    expect(provenanceSchema.safeParse({ ...baseProvenance(), plausibilityReviews: [{ ...valid, boundary: { side: "MAX", threshold: 29 } }] }).success).toBe(false);
    expect(provenanceSchema.safeParse({ ...baseProvenance(), plausibilityReviews: [{ ...valid, ruleId: "PLA_SETS" }] }).success).toBe(false);
    expect(provenanceSchema.safeParse({
      ...baseProvenance(),
      plausibilityReviews: [{ ...valid, contextDigest: "c".repeat(64) }],
    }).success).toBe(false);

    const withRecord = plausibilityReview({ target: { kind: "TIMED_MARK", recordDigest: "d".repeat(64) } });
    expect(provenanceSchema.safeParse({ ...baseProvenance(), plausibilityReviews: [withRecord] }).success).toBe(true);
    expect(provenanceSchema.safeParse({
      ...baseProvenance(),
      plausibilityReviews: [{ ...withRecord, target: { kind: "TIMED_MARK", recordDigest: "e".repeat(64) } }],
    }).success).toBe(false);

    expect(provenanceSchema.safeParse({
      ...baseProvenance(),
      plausibilityReviews: [{ ...valid, reason: "別のコーチ理由で再確認しました" }],
    }).success).toBe(true);
  });

  it("keeps the 16KB UTF-8 provenance limit effective with review records", () => {
    const reviews = Array.from({ length: 20 }, (_, index) => plausibilityReview({
      contextDigest: index.toString(16).padStart(64, "0"),
      reason: "x".repeat(1000),
    }));
    const parsed = provenanceSchema.parse({ ...baseProvenance(), plausibilityReviews: reviews });
    const raw = JSON.stringify(parsed);
    expect(jsonByteLimitIssue("provenanceJson", raw, PROVENANCE_JSON_MAX_BYTES)).not.toBeNull();
  });
});
