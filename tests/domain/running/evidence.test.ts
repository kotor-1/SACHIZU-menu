import { describe, expect, it } from "vitest";

import {
  SOURCE_TYPES,
  sourceTypeSchema,
  evidenceLevelForSourceType,
  evidenceRecordSchema,
  type EvidenceRecord,
  type SourceType,
  type EvidenceLevel,
} from "@/domain/running/evidence/schema";
import {
  deriveDirectness,
  type EvidencePopulationContext,
  type DirectnessEvidenceInput,
} from "@/domain/running/evidence/directness";
import {
  derivePrescriptionConfidence,
  type UsedEvidenceSummary,
  type ConfidenceInputs,
} from "@/domain/running/evidence/confidence";

// ---------------------------------------------------------------------------
// evidenceLevelForSourceType — §5.2 の対応表を全 SOURCE_TYPES で確認
// ---------------------------------------------------------------------------

describe("evidenceLevelForSourceType (§5.2)", () => {
  const expected: Record<SourceType, number> = {
    META_ANALYSIS: 1,
    SYSTEMATIC_REVIEW: 1,
    CONSENSUS_STATEMENT: 1,
    RCT: 2,
    CROSSOVER_REPEATED_MEASURES: 3,
    QUASI_EXPERIMENTAL: 3,
    OBSERVATIONAL: 3,
    MECHANISTIC: 3,
    NARRATIVE_REVIEW: 3,
    GOVERNING_BODY_GUIDANCE: 3,
    COACHING_BEST_PRACTICE: 4,
    ELITE_COACH_PRACTICE: 4,
    EXPERT_OPINION: 5,
    ENGINE_POLICY: 5,
  };

  it("covers all 14 SOURCE_TYPES with the exact §5.2 mapping", () => {
    expect(SOURCE_TYPES.length).toBe(14);
    for (const sourceType of SOURCE_TYPES) {
      expect(evidenceLevelForSourceType(sourceType), sourceType).toBe(expected[sourceType]);
    }
  });

  it("Moran 問題の再発防止: evidenceLevel はエビデンスの「強さ」であり directness/confidence とは独立", () => {
    // META_ANALYSIS (level 1) が常に処方への適用可能性まで保証するわけではない
    // ことは directness の役割であり、evidenceLevelForSourceType はそれを混ぜない。
    expect(evidenceLevelForSourceType("META_ANALYSIS")).toBe(1);
    expect(evidenceLevelForSourceType("EXPERT_OPINION")).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// EvidenceRecord schema — synthetic fixtures only（Haugen 等の実データは禁止）
// ---------------------------------------------------------------------------

function makeSyntheticEvidence(overrides: Partial<EvidenceRecord> = {}) {
  const base = {
    id: "EV_SYNTHETIC_001",
    sourceType: "OBSERVATIONAL" as const,
    studyDesign: "synthetic fixture for R1 tests — not real literature",
    population: {
      ageBands: "ANY" as const,
      maturity: "ANY" as const,
      sexes: "ANY" as const,
      performanceLevels: "ANY" as const,
      sport: "TRACK_SPRINT" as const,
      n: null,
    },
    reference: {
      citation: "Synthetic Fixture (not a real paper)",
      year: null,
      doi: null,
      url: null,
    },
    evidenceLevel: evidenceLevelForSourceType("OBSERVATIONAL"),
    applicabilityNotes: "R1 synthetic fixture only.",
    usage: "PRESCRIPTION" as const,
    verification: "SECONDARY_REPORT_ONLY" as const,
    reportedBy: ["CLAUDE_DR"] as const,
    provisional: true,
  };
  return { ...base, ...overrides };
}

describe("EvidenceRecord schema (synthetic fixtures only)", () => {
  it("accepts a minimal ENGINE_POLICY record", () => {
    const record = makeSyntheticEvidence({
      sourceType: "ENGINE_POLICY",
      evidenceLevel: evidenceLevelForSourceType("ENGINE_POLICY"),
      verification: "PRIMARY_CHECKED",
    });
    expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
  });

  it("accepts a META_ANALYSIS record", () => {
    const record = makeSyntheticEvidence({
      sourceType: "META_ANALYSIS",
      evidenceLevel: evidenceLevelForSourceType("META_ANALYSIS"),
    });
    expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
  });

  it("accepts SECONDARY_REPORT_ONLY verification", () => {
    const record = makeSyntheticEvidence({ verification: "SECONDARY_REPORT_ONLY" });
    expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
  });

  it("accepts PRIMARY_CHECKED verification", () => {
    const record = makeSyntheticEvidence({ verification: "PRIMARY_CHECKED" });
    expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
  });

  it("accepts CONTEXT_ONLY usage", () => {
    const record = makeSyntheticEvidence({ usage: "CONTEXT_ONLY" });
    expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
  });

  it("accepts CHECK_ONLY usage", () => {
    const record = makeSyntheticEvidence({ usage: "CHECK_ONLY" });
    expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
  });

  it("rejects evidenceLevel that does not match sourceType's §5.2 mapping", () => {
    const record = makeSyntheticEvidence({
      sourceType: "META_ANALYSIS",
      evidenceLevel: 5, // META_ANALYSIS は 1 のはず
    });
    expect(evidenceRecordSchema.safeParse(record).success).toBe(false);
  });

  // 監査指摘: evidenceLevelForSourceType() を呼ぶ側の注意力だけに依存せず、
  // evidenceRecordSchema 自身が sourceType × evidenceLevel の矛盾を
  // (`.refine()` により) 確実に拒否することを、schema.safeParse() のレベルで
  // 明示的に確認する（R2 の RuleSet JSON が誤った evidenceLevel を手書きしても
  // 通らないことの保証）。
  describe("sourceType × evidenceLevel 整合性を schema 自身が強制する（R2向けガード）", () => {
    it("META_ANALYSIS + 1（正しい対応） → PASS", () => {
      const record = makeSyntheticEvidence({ sourceType: "META_ANALYSIS", evidenceLevel: 1 });
      expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
    });

    it("META_ANALYSIS + 5（矛盾） → FAIL", () => {
      const record = makeSyntheticEvidence({ sourceType: "META_ANALYSIS", evidenceLevel: 5 });
      expect(evidenceRecordSchema.safeParse(record).success).toBe(false);
    });

    it("ENGINE_POLICY + 5（正しい対応） → PASS", () => {
      const record = makeSyntheticEvidence({
        sourceType: "ENGINE_POLICY",
        evidenceLevel: 5,
        verification: "PRIMARY_CHECKED",
      });
      expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
    });

    it("ENGINE_POLICY + 1（矛盾） → FAIL", () => {
      const record = makeSyntheticEvidence({
        sourceType: "ENGINE_POLICY",
        evidenceLevel: 1,
        verification: "PRIMARY_CHECKED",
      });
      expect(evidenceRecordSchema.safeParse(record).success).toBe(false);
    });

    it("全 14 SOURCE_TYPES について、期待どおりの evidenceLevel の組み合わせは schema レベルで必ず受理される", () => {
      for (const sourceType of SOURCE_TYPES) {
        const record = makeSyntheticEvidence({
          sourceType,
          evidenceLevel: evidenceLevelForSourceType(sourceType),
        });
        const parsed = evidenceRecordSchema.safeParse(record);
        expect(parsed.success, `${sourceType} + level ${evidenceLevelForSourceType(sourceType)}`).toBe(
          true,
        );
      }
    });

    it("全 14 SOURCE_TYPES について、正しくない evidenceLevel との組み合わせは schema レベルで必ず拒否される", () => {
      for (const sourceType of SOURCE_TYPES) {
        const correctLevel = evidenceLevelForSourceType(sourceType);
        const wrongLevel = (((correctLevel % 5) + 1) as EvidenceLevel); // 1..5 のうち correctLevel とは異なる値
        const record = makeSyntheticEvidence({ sourceType, evidenceLevel: wrongLevel });
        const parsed = evidenceRecordSchema.safeParse(record);
        expect(parsed.success, `${sourceType} + wrong level ${wrongLevel}`).toBe(false);
      }
    });
  });

  it("rejects reportedBy as an empty array", () => {
    const record = makeSyntheticEvidence({ reportedBy: [] });
    expect(evidenceRecordSchema.safeParse(record).success).toBe(false);
  });

  it("Fable C-8: .strict() が directness キーを含む payload を拒否する", () => {
    const record = { ...makeSyntheticEvidence(), directness: "DIRECT" };
    const parsed = evidenceRecordSchema.safeParse(record);
    expect(parsed.success).toBe(false);
  });

  it("Fable C-8: .strict() が prescriptionConfidence キーを含む payload を拒否する", () => {
    const record = { ...makeSyntheticEvidence(), prescriptionConfidence: "HIGH" };
    const parsed = evidenceRecordSchema.safeParse(record);
    expect(parsed.success).toBe(false);
  });

  it("Fable C-8: directness と prescriptionConfidence を両方含む payload も拒否する", () => {
    const record = {
      ...makeSyntheticEvidence(),
      directness: "PARTIAL",
      prescriptionConfidence: "MODERATE",
    };
    expect(evidenceRecordSchema.safeParse(record).success).toBe(false);
  });

  it("sourceTypeSchema accepts all 14 SOURCE_TYPES and rejects an unknown value", () => {
    for (const s of SOURCE_TYPES) {
      expect(sourceTypeSchema.safeParse(s).success, s).toBe(true);
    }
    expect(sourceTypeSchema.safeParse("BLOG_POST").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveDirectness — §5.3 の判定表を全分岐カバー
// ---------------------------------------------------------------------------

describe("deriveDirectness (§5.3)", () => {
  const trackSprintAnyEvidence: DirectnessEvidenceInput = {
    sourceType: "OBSERVATIONAL",
    population: {
      ageBands: "ANY",
      maturity: "ANY",
      sexes: "ANY",
      performanceLevels: "ANY",
      sport: "TRACK_SPRINT",
      n: null,
    },
  };

  const adultAdvancedContext: EvidencePopulationContext = {
    ageBand: "ADULT",
    maturity: "POST",
    performanceLevel: "ELITE",
  };

  const u12PreContext: EvidencePopulationContext = {
    ageBand: "U12",
    maturity: "PRE",
    performanceLevel: "YOUTH_DEVELOPING",
  };

  it("ENGINE_POLICY sourceType → NOT_APPLICABLE（population に関わらず）", () => {
    const enginePolicyEvidence: DirectnessEvidenceInput = {
      sourceType: "ENGINE_POLICY",
      population: trackSprintAnyEvidence.population,
    };
    expect(deriveDirectness(enginePolicyEvidence, adultAdvancedContext)).toBe("NOT_APPLICABLE");
    expect(deriveDirectness(enginePolicyEvidence, u12PreContext)).toBe("NOT_APPLICABLE");
  });

  it("sport が TRACK_SPRINT/GENERAL 以外 → INDIRECT", () => {
    const evidence: DirectnessEvidenceInput = {
      sourceType: "OBSERVATIONAL",
      population: { ...trackSprintAnyEvidence.population, sport: "ENDURANCE" },
    };
    expect(deriveDirectness(evidence, adultAdvancedContext)).toBe("INDIRECT");
  });

  it("GENERAL sport は TRACK_SPRINT と同様に許容される（INDIRECT にならない）", () => {
    const evidence: DirectnessEvidenceInput = {
      sourceType: "OBSERVATIONAL",
      population: { ...trackSprintAnyEvidence.population, sport: "GENERAL" },
    };
    expect(deriveDirectness(evidence, adultAdvancedContext)).toBe("DIRECT");
  });

  it("maturity が不一致 → INDIRECT", () => {
    const evidence: DirectnessEvidenceInput = {
      sourceType: "OBSERVATIONAL",
      population: { ...trackSprintAnyEvidence.population, maturity: ["POST"] },
    };
    expect(deriveDirectness(evidence, u12PreContext)).toBe("INDIRECT");
  });

  it("ageBand が不一致 → INDIRECT", () => {
    const evidence: DirectnessEvidenceInput = {
      sourceType: "OBSERVATIONAL",
      population: { ...trackSprintAnyEvidence.population, ageBands: ["ADULT"] },
    };
    expect(deriveDirectness(evidence, u12PreContext)).toBe("INDIRECT");
  });

  it("sport・maturity・ageBand が複合的に不一致でも INDIRECT（複数不一致がまとまってINDIRECTになることを確認）", () => {
    const evidence: DirectnessEvidenceInput = {
      sourceType: "OBSERVATIONAL",
      population: {
        ...trackSprintAnyEvidence.population,
        sport: "ENDURANCE",
        maturity: ["POST"],
        ageBands: ["ADULT"],
      },
    };
    expect(deriveDirectness(evidence, u12PreContext)).toBe("INDIRECT");
  });

  it("performanceLevel のみ不一致（他はすべて一致） → PARTIAL", () => {
    const evidence: DirectnessEvidenceInput = {
      sourceType: "OBSERVATIONAL",
      population: {
        ...trackSprintAnyEvidence.population,
        ageBands: ["ADULT"],
        maturity: ["POST"],
        performanceLevels: ["ELITE"],
      },
    };
    const context: EvidencePopulationContext = {
      ageBand: "ADULT",
      maturity: "POST",
      performanceLevel: "TRAINED", // ELITE ではない
    };
    expect(deriveDirectness(evidence, context)).toBe("PARTIAL");
  });

  it("すべて一致 → DIRECT", () => {
    const evidence: DirectnessEvidenceInput = {
      sourceType: "OBSERVATIONAL",
      population: {
        ...trackSprintAnyEvidence.population,
        ageBands: ["ADULT"],
        maturity: ["POST"],
        performanceLevels: ["ELITE"],
      },
    };
    expect(deriveDirectness(evidence, adultAdvancedContext)).toBe("DIRECT");
  });

  it("population のすべてのフィールドが \"ANY\" なら常に一致扱い → DIRECT", () => {
    expect(deriveDirectness(trackSprintAnyEvidence, adultAdvancedContext)).toBe("DIRECT");
    expect(deriveDirectness(trackSprintAnyEvidence, u12PreContext)).toBe("DIRECT");
  });

  // T-EV-01（正式仕様 §20.2）:
  // 「同じ Haugen elite Evidence を ADULT ADVANCED と U12 PRE に適用
  //   → PARTIAL/DIRECT と INDIRECT」
  it("T-EV-01: 同じ (synthetic Haugen-elite-like) Evidence を ADULT+ADVANCED-equivalent と U12+PRE-equivalent の2つの subject context に適用すると directness が変わる", () => {
    // Haugen 2019 的な「エリート短距離選手の対象研究」を模した synthetic evidence。
    // 実際の文献データは投入しない（R1 では禁止）— population 条件だけを模す。
    const syntheticHaugenEliteLikeEvidence: DirectnessEvidenceInput = {
      sourceType: "OBSERVATIONAL",
      population: {
        ageBands: ["ADULT"],
        maturity: ["POST"],
        sexes: "ANY",
        performanceLevels: ["ELITE"],
        sport: "TRACK_SPRINT",
        n: null,
      },
    };

    const forAdultAdvanced = deriveDirectness(syntheticHaugenEliteLikeEvidence, adultAdvancedContext);
    const forU12Pre = deriveDirectness(syntheticHaugenEliteLikeEvidence, u12PreContext);

    // ADULT+ADVANCED 相当の context には population がそのまま一致するので PARTIAL/DIRECT。
    expect(["PARTIAL", "DIRECT"]).toContain(forAdultAdvanced);
    expect(forAdultAdvanced).toBe("DIRECT");
    // U12+PRE 相当の context は ageBand・maturity の両方が不一致なので INDIRECT。
    expect(forU12Pre).toBe("INDIRECT");
    // 同じ Evidence でも対象によって directness が変わることそのものが Fable C-8 の核心。
    expect(forAdultAdvanced).not.toBe(forU12Pre);
  });
});

// ---------------------------------------------------------------------------
// derivePrescriptionConfidence — §5.4 の判定表を全分岐カバー
// ---------------------------------------------------------------------------

describe("derivePrescriptionConfidence (§5.4)", () => {
  function ev(overrides: Partial<UsedEvidenceSummary> = {}): UsedEvidenceSummary {
    return {
      sourceType: "OBSERVATIONAL",
      verification: "PRIMARY_CHECKED",
      directness: "DIRECT",
      ...overrides,
    };
  }

  function inputs(overrides: Partial<ConfidenceInputs> = {}): ConfidenceInputs {
    return {
      usedEvidence: [ev()],
      inputDataConfidence: "HIGH",
      historyCoverage72h: "COMPLETE",
      ...overrides,
    };
  }

  it("すべて ENGINE_POLICY → POLICY_ONLY", () => {
    const result = derivePrescriptionConfidence(
      inputs({ usedEvidence: [ev({ sourceType: "ENGINE_POLICY" }), ev({ sourceType: "ENGINE_POLICY" })] }),
    );
    expect(result).toBe("POLICY_ONLY");
  });

  it("空の usedEvidence 配列は POLICY_ONLY を誤って返さない（vacuous truth 対策）", () => {
    const result = derivePrescriptionConfidence(inputs({ usedEvidence: [] }));
    expect(result).not.toBe("POLICY_ONLY");
  });

  it("いずれかの directness が INDIRECT → LOW", () => {
    const result = derivePrescriptionConfidence(
      inputs({ usedEvidence: [ev({ directness: "DIRECT" }), ev({ directness: "INDIRECT" })] }),
    );
    expect(result).toBe("LOW");
  });

  it("inputDataConfidence が LOW → LOW", () => {
    const result = derivePrescriptionConfidence(inputs({ inputDataConfidence: "LOW" }));
    expect(result).toBe("LOW");
  });

  it("inputDataConfidence が NONE → LOW", () => {
    const result = derivePrescriptionConfidence(inputs({ inputDataConfidence: "NONE" }));
    expect(result).toBe("LOW");
  });

  it("historyCoverage72h が NONE → LOW", () => {
    const result = derivePrescriptionConfidence(inputs({ historyCoverage72h: "NONE" }));
    expect(result).toBe("LOW");
  });

  it("いずれかの directness が PARTIAL（INDIRECT はなし） → MODERATE", () => {
    const result = derivePrescriptionConfidence(
      inputs({ usedEvidence: [ev({ directness: "DIRECT" }), ev({ directness: "PARTIAL" })] }),
    );
    expect(result).toBe("MODERATE");
  });

  it("inputDataConfidence が MEDIUM → MODERATE", () => {
    const result = derivePrescriptionConfidence(inputs({ inputDataConfidence: "MEDIUM" }));
    expect(result).toBe("MODERATE");
  });

  it("すべての evidence が SECONDARY_REPORT_ONLY → MODERATE", () => {
    const result = derivePrescriptionConfidence(
      inputs({
        usedEvidence: [
          ev({ verification: "SECONDARY_REPORT_ONLY" }),
          ev({ verification: "SECONDARY_REPORT_ONLY" }),
        ],
      }),
    );
    expect(result).toBe("MODERATE");
  });

  it("空の usedEvidence 配列は SECONDARY_REPORT_ONLY 全件一致とみなして MODERATE を誤って返さない（vacuous truth 対策）", () => {
    const result = derivePrescriptionConfidence(
      inputs({ usedEvidence: [], inputDataConfidence: "HIGH", historyCoverage72h: "COMPLETE" }),
    );
    expect(result).not.toBe("MODERATE");
    expect(result).not.toBe("POLICY_ONLY");
  });

  it("それ以外（全条件をクリア） → HIGH", () => {
    const result = derivePrescriptionConfidence(
      inputs({
        usedEvidence: [ev({ verification: "PRIMARY_CHECKED", directness: "DIRECT" })],
        inputDataConfidence: "HIGH",
        historyCoverage72h: "COMPLETE",
      }),
    );
    expect(result).toBe("HIGH");
  });

  it("優先順位: INDIRECT が1件でもあれば PARTIAL/MEDIUM条件より優先して LOW になる", () => {
    const result = derivePrescriptionConfidence(
      inputs({
        usedEvidence: [ev({ directness: "INDIRECT" }), ev({ directness: "PARTIAL" })],
        inputDataConfidence: "MEDIUM",
      }),
    );
    expect(result).toBe("LOW");
  });

  it("優先順位: 全件 ENGINE_POLICY が最優先で POLICY_ONLY になる（他の劣化条件があっても）", () => {
    const result = derivePrescriptionConfidence(
      inputs({
        usedEvidence: [ev({ sourceType: "ENGINE_POLICY", directness: "INDIRECT" })],
        inputDataConfidence: "NONE",
        historyCoverage72h: "NONE",
      }),
    );
    expect(result).toBe("POLICY_ONLY");
  });
});
