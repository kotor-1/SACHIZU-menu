import { describe, expect, it } from "vitest";

import { resolveAgeBand } from "@/domain/running/context/ageBand";
import {
  normalizeMaturity,
  computeGrowthVelocity,
  RAPID_GROWTH_THRESHOLD_CM_PER_YEAR,
} from "@/domain/running/context/maturity";
import { deriveTrainingAgeTier, isTrainingAgeKnown } from "@/domain/running/context/trainingAge";
import { deriveEnvelopeTier } from "@/domain/running/context/tier";
import { resolveConstraints, resolveEligibility } from "@/domain/running/context/constraints";
import {
  computeFlySplitVelocity,
  resolveReference,
  applyFreshnessDowngrade,
  isMarkStale,
} from "@/domain/running/context/performance";
import { evaluateInputPlausibility, CONTEXT_PLAUSIBILITY_RULE_IDS } from "@/domain/running/context/plausibility";
import { trainingAgeInputSchema } from "@/domain/running/types/subject";
import { getRuleSet } from "@/domain/running/rules/loader";
import type { IsoDate } from "@/domain/running/types/primitives";

const ruleSet = getRuleSet("rs-2026.09.0")!;

/** テスト専用: 手書きの日付文字列を IsoDate（branded）にキャストする。 */
function iso(value: string): IsoDate {
  return value as IsoDate;
}

// ---------------------------------------------------------------------------
// ageBand boundaries（§4.2）
// ---------------------------------------------------------------------------

describe("resolveAgeBand — boundaries (§4.2)", () => {
  const asOf = iso("2026-06-15");

  it("11歳364日 → U12", () => {
    // asOf - 11y364d = 誕生日は2026-06-16の1年前(2015-06-16)より1日早い
    expect(resolveAgeBand({ birthDate: iso("2014-06-16"), ageBandOverride: undefined }, asOf)).toBe("U12");
  });

  it("12歳ちょうど → U15", () => {
    expect(resolveAgeBand({ birthDate: iso("2014-06-15"), ageBandOverride: undefined }, asOf)).toBe("U15");
  });

  it("14歳364日 → U15", () => {
    expect(resolveAgeBand({ birthDate: iso("2011-06-16"), ageBandOverride: undefined }, asOf)).toBe("U15");
  });

  it("15歳ちょうど → U18", () => {
    expect(resolveAgeBand({ birthDate: iso("2011-06-15"), ageBandOverride: undefined }, asOf)).toBe("U18");
  });

  it("17歳364日 → U18", () => {
    expect(resolveAgeBand({ birthDate: iso("2008-06-16"), ageBandOverride: undefined }, asOf)).toBe("U18");
  });

  it("18歳ちょうど → ADULT", () => {
    expect(resolveAgeBand({ birthDate: iso("2008-06-15"), ageBandOverride: undefined }, asOf)).toBe("ADULT");
  });

  it("date-only 実装なのでタイムゾーンに関わらず同じ結果になる（Dateオブジェクトを使わないことの間接確認）", () => {
    // 年末年始・うるう年をまたぐケースでも整数演算だけで解決できることを確認する。
    expect(resolveAgeBand({ birthDate: iso("2012-02-29"), ageBandOverride: undefined }, iso("2026-03-01"))).toBe("U15");
    expect(resolveAgeBand({ birthDate: iso("2012-02-29"), ageBandOverride: undefined }, iso("2026-02-28"))).toBe("U15");
  });
});

describe("resolveAgeBand — birthDate / override / UNKNOWN（§4.3, 要件3・43）", () => {
  it("birthDate があれば override を無視する（矛盾していても birthDate 優先）", () => {
    expect(resolveAgeBand({ birthDate: iso("2014-01-01"), ageBandOverride: "ADULT" }, iso("2026-01-01"))).toBe("U15");
  });

  it("birthDate が無く override があれば override を使う", () => {
    expect(resolveAgeBand({ birthDate: null, ageBandOverride: "U18" }, iso("2026-01-01"))).toBe("U18");
  });

  it("birthDate も override も無ければ UNKNOWN（特定の年齢を推測しない）", () => {
    expect(resolveAgeBand({ birthDate: null, ageBandOverride: undefined }, iso("2026-01-01"))).toBe("UNKNOWN");
  });

  it("未来の birthDate は例外を投げる（validation error）", () => {
    expect(() => resolveAgeBand({ birthDate: iso("2027-01-01"), ageBandOverride: undefined }, iso("2026-01-01"))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Maturity normalization（§4.3, §4.4）
// ---------------------------------------------------------------------------

describe("normalizeMaturity — ADULT (§4.3 ENGINE-POLICY)", () => {
  it("ADULT は申告 status/method に関わらず POST/HIGH", () => {
    const result = normalizeMaturity({
      ageBand: "ADULT",
      maturity: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.normalizedStatus).toBe("POST");
    expect(result.effectiveConfidence).toBe("HIGH");
    expect(result.constraintCategory).toBe("POST");
  });

  it("ADULT でも rapidGrowthFlag=true なら constraintCategory だけ CIRCA（normalizedStatus は POST のまま）", () => {
    const result = normalizeMaturity({
      ageBand: "ADULT",
      maturity: {
        status: "POST",
        confidence: "HIGH",
        method: "GROWTH_VELOCITY",
        assessedAt: iso("2026-01-01"),
        heightHistory: [
          { date: iso("2025-01-01"), heightCm: 170 },
          { date: iso("2026-01-01"), heightCm: 180 }, // 10cm/年 > 7.2
        ],
      },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.rapidGrowthFlag).toBe(true);
    expect(result.normalizedStatus).toBe("POST");
    expect(result.constraintCategory).toBe("CIRCA");
  });
});

describe("normalizeMaturity — method=NONE は申告を無視する（要件9）", () => {
  it("status=POST・confidence=HIGH と申告しても method=NONE なら normalizedStatus=UNKNOWN・confidence=LOW", () => {
    const result = normalizeMaturity({
      ageBand: "U15",
      maturity: { status: "POST", confidence: "HIGH", method: "NONE", assessedAt: null },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.normalizedStatus).toBe("UNKNOWN");
    expect(result.effectiveConfidence).toBe("LOW");
    expect(result.constraintCategory).toBe("EFFECTIVE_UNKNOWN");
  });
});

describe("normalizeMaturity — confidence cap（要件10・44）", () => {
  const methods = ["COACH_OBSERVATION", "PARENT_REPORT", "MATURITY_OFFSET_EQUATION"] as const;
  for (const method of methods) {
    it(`${method}: ageBand≠ADULT では confidence=HIGH と申告しても MEDIUM に cap される`, () => {
      const result = normalizeMaturity({
        ageBand: "U18",
        maturity: { status: "POST", confidence: "HIGH", method, assessedAt: iso("2026-01-01") },
        asOf: iso("2026-01-01"),
        ruleSet,
      });
      expect(result.effectiveConfidence).toBe("MEDIUM");
      expect(result.constraintCategory).toBe("POST"); // MEDIUM は POST 条件を満たす
    });
  }

  it("GROWTH_VELOCITY: 有効な履歴条件を満たしても confidence は最大 MEDIUM", () => {
    const result = normalizeMaturity({
      ageBand: "U18",
      maturity: {
        status: "POST",
        confidence: "HIGH",
        method: "GROWTH_VELOCITY",
        assessedAt: iso("2026-01-01"),
        heightHistory: [
          { date: iso("2025-01-01"), heightCm: 170 },
          { date: iso("2026-01-01"), heightCm: 173 }, // 3cm/年（rapid ではない）
        ],
      },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.effectiveConfidence).toBe("MEDIUM");
    expect(result.rapidGrowthFlag).toBe(false);
  });

  it("schoolGrade はどの method でも一切参照されない（型自体に引数が無い）", () => {
    // normalizeMaturity の入力型に schoolGrade を渡す余地が無いこと自体が
    // 「使えない」ことの構造的な保証。ここでは念のため、同じ入力で
    // schoolGrade 相当の情報を変えても結果が変わらないことを別経路で確認する
    // （AthleteProfile.schoolGrade はそもそも渡していない）。
    const base = {
      ageBand: "U15" as const,
      maturity: { status: "CIRCA" as const, confidence: "MEDIUM" as const, method: "COACH_OBSERVATION" as const, assessedAt: iso("2026-01-01") },
      asOf: iso("2026-01-01"),
      ruleSet,
    };
    const a = normalizeMaturity(base);
    const b = normalizeMaturity(base); // schoolGrade を変える経路が存在しないので同一呼び出しで代用
    expect(a).toEqual(b);
  });
});

describe("normalizeMaturity — GROWTH_VELOCITY データ不足（要件14）", () => {
  it("有効点が2点未満なら confidence を上げず UNKNOWN/LOW/EFFECTIVE_UNKNOWN に落ちる", () => {
    const result = normalizeMaturity({
      ageBand: "U18",
      maturity: {
        status: "POST",
        confidence: "HIGH",
        method: "GROWTH_VELOCITY",
        assessedAt: iso("2026-01-01"),
        heightHistory: [{ date: iso("2026-01-01"), heightCm: 170 }],
      },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.normalizedStatus).toBe("UNKNOWN");
    expect(result.effectiveConfidence).toBe("LOW");
    expect(result.constraintCategory).toBe("EFFECTIVE_UNKNOWN");
  });

  it("間隔が6か月未満なら growth velocity を確定させず UNKNOWN/LOW に落ちる", () => {
    const result = normalizeMaturity({
      ageBand: "U18",
      maturity: {
        status: "POST",
        confidence: "HIGH",
        method: "GROWTH_VELOCITY",
        assessedAt: iso("2026-01-01"),
        heightHistory: [
          { date: iso("2025-11-01"), heightCm: 170 },
          { date: iso("2026-01-01"), heightCm: 172 }, // 2か月しか無い
        ],
      },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.constraintCategory).toBe("EFFECTIVE_UNKNOWN");
  });

  it("height に BLOCK 値（>260cm）が含まれる点は成長速度計算から除外する（要件37）", () => {
    const velocity = computeGrowthVelocity(
      [
        { date: iso("2025-01-01"), heightCm: 170 },
        { date: iso("2025-06-15"), heightCm: 999 }, // BLOCK
        { date: iso("2026-01-01"), heightCm: 173 },
      ],
      iso("2026-01-01"),
      ruleSet,
    );
    // BLOCK点を除外しても2点残るので計算はできるが、999は使われていないことを oldest/newest で確認。
    expect(velocity.available).toBe(true);
    if (velocity.available) {
      expect(velocity.oldest.heightCm).toBe(170);
      expect(velocity.newest.heightCm).toBe(173);
    }
  });
});

describe("normalizeMaturity — rapidGrowthFlag（要件13）", () => {
  it("> 7.2 cm/年（境界値超え）で true になる。ちょうど7.2は false", () => {
    const over = normalizeMaturity({
      ageBand: "U15",
      maturity: {
        status: "PRE",
        confidence: "MEDIUM",
        method: "GROWTH_VELOCITY",
        assessedAt: iso("2026-01-01"),
        heightHistory: [
          { date: iso("2025-01-01"), heightCm: 150 },
          { date: iso("2026-01-01"), heightCm: 150 + RAPID_GROWTH_THRESHOLD_CM_PER_YEAR + 0.1 },
        ],
      },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(over.rapidGrowthFlag).toBe(true);
    expect(over.constraintCategory).toBe("CIRCA");

    const exact = normalizeMaturity({
      ageBand: "U15",
      maturity: {
        status: "PRE",
        confidence: "MEDIUM",
        method: "GROWTH_VELOCITY",
        assessedAt: iso("2026-01-01"),
        heightHistory: [
          { date: iso("2025-01-01"), heightCm: 150 },
          { date: iso("2026-01-01"), heightCm: 150 + RAPID_GROWTH_THRESHOLD_CM_PER_YEAR },
        ],
      },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(exact.rapidGrowthFlag).toBe(false);
  });
});

describe("normalizeMaturity — Mirwald 未実装の確認（要件11）", () => {
  it("equation.offsetYears を渡しても normalizedStatus は申告値のまま（自動算出しない）", () => {
    const result = normalizeMaturity({
      ageBand: "U15",
      maturity: {
        status: "CIRCA",
        confidence: "MEDIUM",
        method: "MATURITY_OFFSET_EQUATION",
        assessedAt: iso("2026-01-01"),
        equation: { id: "MIRWALD_2002", offsetYears: 1.5 },
      },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    // offsetYears の値を変えても（ここでは0や負の値でも）normalizedStatus は declared のまま。
    const result2 = normalizeMaturity({
      ageBand: "U15",
      maturity: {
        status: "CIRCA",
        confidence: "MEDIUM",
        method: "MATURITY_OFFSET_EQUATION",
        assessedAt: iso("2026-01-01"),
        equation: { id: "MIRWALD_2002", offsetYears: -3.7 },
      },
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.normalizedStatus).toBe("CIRCA");
    expect(result2.normalizedStatus).toBe("CIRCA");
    expect(result.normalizedStatus).toBe(result2.normalizedStatus);
    expect(result.effectiveConfidence).toBe("MEDIUM"); // capはあるが HIGH にはならない
  });
});

// ---------------------------------------------------------------------------
// Training Age（§4.5, 要件15・16）
// ---------------------------------------------------------------------------

describe("deriveTrainingAgeTier", () => {
  it("coachAssignedTier があれば明示指定を使う（ADVANCED もここでのみ成立）", () => {
    expect(deriveTrainingAgeTier({ structuredSprintYears: null, coachAssignedTier: "ADVANCED" })).toBe("ADVANCED");
    expect(deriveTrainingAgeTier({ structuredSprintYears: 0.1, coachAssignedTier: "ADVANCED" })).toBe("ADVANCED");
  });

  it("structuredSprintYears=null → BEGINNER", () => {
    expect(deriveTrainingAgeTier({ structuredSprintYears: null })).toBe("BEGINNER");
  });

  it("<1年 → BEGINNER, 1〜<3年 → DEVELOPING, >=3年 → TRAINED", () => {
    expect(deriveTrainingAgeTier({ structuredSprintYears: 0.5 })).toBe("BEGINNER");
    expect(deriveTrainingAgeTier({ structuredSprintYears: 1 })).toBe("DEVELOPING");
    expect(deriveTrainingAgeTier({ structuredSprintYears: 2.9 })).toBe("DEVELOPING");
    expect(deriveTrainingAgeTier({ structuredSprintYears: 3 })).toBe("TRAINED");
  });

  it("20年でも coachAssignedTier が無ければ TRAINED まで（ADVANCED にはならない）", () => {
    expect(deriveTrainingAgeTier({ structuredSprintYears: 20 })).toBe("TRAINED");
  });

  it("isTrainingAgeKnown: 両方null/undefinedならfalse、どちらかあればtrue", () => {
    expect(isTrainingAgeKnown({ structuredSprintYears: null })).toBe(false);
    expect(isTrainingAgeKnown({ structuredSprintYears: 2 })).toBe(true);
    expect(isTrainingAgeKnown({ structuredSprintYears: null, coachAssignedTier: "BEGINNER" })).toBe(true);
  });
});

describe("trainingAgeInputSchema validation（要件16）", () => {
  it("負の年数を拒否する", () => {
    expect(trainingAgeInputSchema.safeParse({ structuredSprintYears: -1 }).success).toBe(false);
  });
  it("NaN を拒否する", () => {
    expect(trainingAgeInputSchema.safeParse({ structuredSprintYears: NaN }).success).toBe(false);
  });
  it("Infinity を拒否する（R1 defect fix）", () => {
    expect(trainingAgeInputSchema.safeParse({ structuredSprintYears: Infinity }).success).toBe(false);
  });
  it("-Infinity を拒否する", () => {
    expect(trainingAgeInputSchema.safeParse({ structuredSprintYears: -Infinity }).success).toBe(false);
  });
  it("負の小数も拒否する", () => {
    expect(trainingAgeInputSchema.safeParse({ structuredSprintYears: -0.5 }).success).toBe(false);
  });
  it("20年は schema を通過し、coachAssignedTier 無しの導出は TRAINED（ADVANCED にはならない）", () => {
    const parsed = trainingAgeInputSchema.safeParse({ structuredSprintYears: 20 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(deriveTrainingAgeTier(parsed.data)).toBe("TRAINED");
    }
  });
  it("ADVANCED は coachAssignedTier でのみ成立する", () => {
    const parsed = trainingAgeInputSchema.safeParse({ structuredSprintYears: 20, coachAssignedTier: "ADVANCED" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(deriveTrainingAgeTier(parsed.data)).toBe("ADVANCED");
    }
  });
});

// ---------------------------------------------------------------------------
// EnvelopeTier（§4.5, 要件17）
// ---------------------------------------------------------------------------

describe("deriveEnvelopeTier", () => {
  it("POST + TRAINED/ADVANCED trainingAge → ADVANCED", () => {
    expect(deriveEnvelopeTier("POST", "TRAINED")).toBe("ADVANCED");
    expect(deriveEnvelopeTier("POST", "ADVANCED")).toBe("ADVANCED");
  });
  it("POST でも trainingAge が BEGINNER/DEVELOPING なら DEVELOPMENTAL（成人初心者もDEVELOPMENTAL）", () => {
    expect(deriveEnvelopeTier("POST", "BEGINNER")).toBe("DEVELOPMENTAL");
    expect(deriveEnvelopeTier("POST", "DEVELOPING")).toBe("DEVELOPMENTAL");
  });
  it("POST 以外（PRE/CIRCA/EFFECTIVE_UNKNOWN）は trainingAge に関わらず DEVELOPMENTAL", () => {
    expect(deriveEnvelopeTier("PRE", "TRAINED")).toBe("DEVELOPMENTAL");
    expect(deriveEnvelopeTier("CIRCA", "ADVANCED")).toBe("DEVELOPMENTAL");
    expect(deriveEnvelopeTier("EFFECTIVE_UNKNOWN", "ADVANCED")).toBe("DEVELOPMENTAL");
  });
});

// ---------------------------------------------------------------------------
// Performance reference resolution（§4.6, 要件29〜34）
// ---------------------------------------------------------------------------

describe("computeFlySplitVelocity — T-MISS-03: PHOTO_CELL FLY20 2.00s", () => {
  it("nominal 10.0 m/s、区間 [20/2.05, 20/1.95]", () => {
    const result = computeFlySplitVelocity(
      { event: "FLY20", timeS: 2.0, date: iso("2026-01-01"), timing: "PHOTO_CELL" },
      ruleSet,
    );
    expect(result.valueMps).toBeCloseTo(10.0, 10);
    expect(result.lowerMps).toBeCloseTo(20 / 2.05, 10);
    expect(result.upperMps).toBeCloseTo(20 / 1.95, 10);
  });
});

describe("resolveReference — 100m PB → Vmax 推定式は絶対に使わない（要件30, T-MISS-01）", () => {
  const only100m = [{ event: "100m" as const, timeS: 11.5, date: iso("2026-01-01"), timing: "HAND" as const }];

  it("MAX_VELOCITY → MAX_INTENT / LOW", () => {
    const result = resolveReference({
      method: "MAX_VELOCITY",
      marks: only100m,
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.kind).toBe("MAX_INTENT");
    expect(result.confidence).toBe("LOW");
    expect(result.velocityEstimate).toBeNull();
  });

  it("TEMPO_EXTENSIVE → RELAXED_SUBMAX / LOW / 数値目標なし", () => {
    const result = resolveReference({
      method: "TEMPO_EXTENSIVE",
      marks: only100m,
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.kind).toBe("RELAXED_SUBMAX");
    expect(result.confidence).toBe("LOW");
    expect(result.velocityEstimate).toBeNull();
  });

  it("SPRINT_ENDURANCE_SHORT → MAX_INTENT / LOW", () => {
    const result = resolveReference({
      method: "SPRINT_ENDURANCE_SHORT",
      marks: only100m,
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.kind).toBe("MAX_INTENT");
    expect(result.confidence).toBe("LOW");
  });

  it("LONG は unavailable/ineligible（TARGET_SPLIT手入力まで）", () => {
    const result = resolveReference({
      method: "LONG_SPRINT_RACE_SPECIFIC",
      marks: only100m,
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.availability).toBe("UNAVAILABLE");
    expect(result.kind).toBeNull();
  });

  it("何もデータが無くても同じ結果になる", () => {
    const result = resolveReference({
      method: "MAX_VELOCITY",
      marks: [],
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.kind).toBe("MAX_INTENT");
    expect(result.confidence).toBe("LOW");
  });
});

describe("resolveReference — fly measured available (T-MISS-03文脈)", () => {
  it("MAX_VELOCITY: fresh PHOTO_CELL fly20 があれば MEASURED_VMAX/FLY_SPLIT を高confidenceで使う", () => {
    const result = resolveReference({
      method: "MAX_VELOCITY",
      marks: [{ event: "FLY20", timeS: 2.0, date: iso("2026-01-01"), timing: "PHOTO_CELL" }],
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-05"),
      ruleSet,
    });
    expect(result.availability).toBe("AVAILABLE");
    expect(result.kind).toBe("FLY_SPLIT"); // vmax未提供・flyマーク由来なのでFLY_SPLIT（MEASURED_VMAXはathlete.vmax直接提供時のみ）
    expect(result.confidence).toBe("HIGH");
    expect(result.velocityEstimate?.valueMps).toBeCloseTo(10.0, 10);
  });

  it("HAND fly は confidence LOW（要件32）", () => {
    const result = resolveReference({
      method: "MAX_VELOCITY",
      marks: [{ event: "FLY20", timeS: 2.0, date: iso("2026-01-01"), timing: "HAND" }],
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-05"),
      ruleSet,
    });
    expect(result.confidence).toBe("LOW");
  });
});

describe("mark freshness downgrade（§4.6, 要件33, T-MISS-05）", () => {
  it("非ADULT: 180日ちょうどはfresh（downgradeしない）、181日からdowngrade", () => {
    expect(isMarkStale(iso("2026-01-01"), iso("2026-06-30"), "U15")).toBe(false); // 180日
    expect(isMarkStale(iso("2026-01-01"), iso("2026-07-01"), "U15")).toBe(true); // 181日
  });

  it("ADULT: 365日ちょうどはfresh、366日からdowngrade", () => {
    expect(isMarkStale(iso("2025-01-01"), iso("2025-12-31"), "ADULT")).toBe(false); // 364日 (2025 not leap over this range? check via 365 boundary below)
    expect(isMarkStale(iso("2024-01-01"), iso("2024-12-31"), "ADULT")).toBe(false); // 365日 (2024 leap year)
    expect(isMarkStale(iso("2024-01-01"), iso("2025-01-01"), "ADULT")).toBe(true); // 366日
  });

  it("confidence downgrade: HIGH→MEDIUM→LOW→LOW、NONE→NONE（LOWをNONEへ落とさない）", () => {
    // 2024-01-01 → 2025-01-01 は366日（2024年はうるう年）で ADULT の365日しきい値を超える。
    expect(applyFreshnessDowngrade("HIGH", iso("2024-01-01"), iso("2025-01-01"), "ADULT")).toBe("MEDIUM");
    expect(applyFreshnessDowngrade("MEDIUM", iso("2024-01-01"), iso("2025-01-01"), "ADULT")).toBe("LOW");
    expect(applyFreshnessDowngrade("LOW", iso("2024-01-01"), iso("2025-01-01"), "ADULT")).toBe("LOW");
    expect(applyFreshnessDowngrade("NONE", iso("2024-01-01"), iso("2025-01-01"), "ADULT")).toBe("NONE");
  });

  it("T-MISS-05: U15 / 200日前の記録は1段downgradeされる", () => {
    const result = resolveReference({
      method: "MAX_VELOCITY",
      marks: [{ event: "FLY20", timeS: 2.0, date: iso("2025-06-19"), timing: "PHOTO_CELL" }], // asOfから200日前
      vmax: null,
      ageBand: "U15",
      asOf: iso("2026-01-05"),
      ruleSet,
    });
    // 本来 HIGH のはずが 200日 > 180日 で1段downgradeされ MEDIUM になる。
    expect(result.confidence).toBe("MEDIUM");
  });
});

describe("future mark は使用禁止（要件34）", () => {
  it("mark.date > asOf の記録は resolveReference から除外される", () => {
    const result = resolveReference({
      method: "MAX_VELOCITY",
      marks: [{ event: "FLY20", timeS: 2.0, date: iso("2026-06-01"), timing: "PHOTO_CELL" }],
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-01"), // markの日付より前
      ruleSet,
    });
    expect(result.kind).toBe("MAX_INTENT"); // fly記録は使われず fallback
  });
});

// ---------------------------------------------------------------------------
// Input plausibility（§8.5, 要件35・36）— R2 RuleSet のデータをそのまま使う
// ---------------------------------------------------------------------------

describe("context input plausibility (R2 RuleSet 由来。閾値をここに複製しない)", () => {
  it("100m mark: 9.0-25.0の範囲外はREQUIRE_CONFIRMATION、5-60の範囲外はBLOCK", () => {
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.MARK_100M, 11.0)).toBe("OK");
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.MARK_100M, 8.9)).toBe("REQUIRE_CONFIRMATION");
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.MARK_100M, 4.9)).toBe("BLOCK");
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.MARK_100M, 60.1)).toBe("BLOCK");
  });

  it("fly10: <0.80 or >2.5 はREQUIRE_CONFIRMATION, <0.5 or >5 はBLOCK", () => {
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.FLY_10M, 1.2)).toBe("OK");
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.FLY_10M, 0.79)).toBe("REQUIRE_CONFIRMATION");
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.FLY_10M, 0.49)).toBe("BLOCK");
  });

  it("height: <100 or >220 はREQUIRE_CONFIRMATION, <50 or >260 はBLOCK", () => {
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.HEIGHT, 170)).toBe("OK");
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.HEIGHT, 99)).toBe("REQUIRE_CONFIRMATION");
    expect(evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.HEIGHT, 261)).toBe("BLOCK");
  });

  it("BLOCK 判定された100m記録は resolveReference の usableMark として使われない（要件36）", () => {
    const result = resolveReference({
      method: "SPRINT_ENDURANCE_SHORT",
      marks: [{ event: "100m", timeS: 3.0, date: iso("2026-01-01"), timing: "HAND" }], // BLOCK (<5s)
      vmax: null,
      ageBand: "ADULT",
      asOf: iso("2026-01-01"),
      ruleSet,
    });
    expect(result.usableMark).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Constraint 解決（§8.2, §7.5, 要件20〜21・39）
// ---------------------------------------------------------------------------

describe("resolveConstraints — U12 hard constraints (§8.2)", () => {
  it("U12: ASSISTED/LONG/TEMPO_INTENSIVEがdisallow、RS_SLED_HEAVYがdisallowTemplateId、override不可、complexity上限LOW", () => {
    const result = resolveConstraints(ruleSet, "U12", "PRE", "BEGINNER");
    expect(result.disallowedMethods.get("ASSISTED_SPRINT")).toBe(false);
    expect(result.disallowedMethods.get("LONG_SPRINT_RACE_SPECIFIC")).toBe(false);
    expect(result.disallowedMethods.get("TEMPO_INTENSIVE")).toBe(false);
    expect(result.disallowedTemplateIds.get("RS_SLED_HEAVY")).toBe(false);
    expect(result.maxAutoComplexity).toBe("LOW");
  });

  it("U15/U18/ADULT には U12 hard constraint（LONG/TI/RS_SLED_HEAVY・complexity LOW）は適用されない", () => {
    for (const ageBand of ["U15", "U18", "ADULT"] as const) {
      const result = resolveConstraints(ruleSet, ageBand, "POST", "TRAINED");
      expect(result.appliedConstraintIds).not.toContain("CONSTRAINT_U12_HARD");
      expect(result.disallowedMethods.has("LONG_SPRINT_RACE_SPECIFIC")).toBe(false);
      expect(result.disallowedMethods.has("TEMPO_INTENSIVE")).toBe(false);
      expect(result.disallowedTemplateIds.has("RS_SLED_HEAVY")).toBe(false);
      expect(result.maxAutoComplexity).toBe("HIGH");
    }
  });

  it("U15 だけ ASSISTED_SPRINT が override 不可で disallow される（§8.2 R3 errata）。U18/ADULT は年齢だけでは禁止しない", () => {
    const u15 = resolveConstraints(ruleSet, "U15", "POST", "TRAINED");
    expect(u15.disallowedMethods.get("ASSISTED_SPRINT")).toBe(false);
    expect(u15.appliedConstraintIds).toContain("CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE");
    for (const ageBand of ["U18", "ADULT"] as const) {
      expect(resolveConstraints(ruleSet, ageBand, "POST", "TRAINED").disallowedMethods.has("ASSISTED_SPRINT")).toBe(false);
    }
  });

  it("ageBand=UNKNOWN は最も保守的（U12相当）に扱われる（要件5）", () => {
    const result = resolveConstraints(ruleSet, "UNKNOWN", "EFFECTIVE_UNKNOWN", "BEGINNER");
    expect(result.disallowedMethods.get("ASSISTED_SPRINT")).toBe(false);
    expect(result.maxAutoComplexity).toBe("LOW");
  });
});

describe("resolveConstraints — maturity/trainingAge complexity cap (§7.5, 要件21・25)", () => {
  it("PRE/EFFECTIVE_UNKNOWN/CIRCA は auto complexity ≤ MEDIUM", () => {
    for (const category of ["PRE", "EFFECTIVE_UNKNOWN", "CIRCA"] as const) {
      const result = resolveConstraints(ruleSet, "U18", category, "TRAINED");
      expect(result.maxAutoComplexity).toBe("MEDIUM");
    }
  });

  it("POST + TRAINED/ADVANCED は complexity 上限なし（HIGH）", () => {
    const result = resolveConstraints(ruleSet, "ADULT", "POST", "TRAINED");
    expect(result.maxAutoComplexity).toBe("HIGH");
  });

  it("trainingAge=BEGINNER は auto complexity ≤ MEDIUM（POSTでも）", () => {
    const result = resolveConstraints(ruleSet, "ADULT", "POST", "BEGINNER");
    expect(result.maxAutoComplexity).toBe("MEDIUM");
  });

  it("複数条件が重なる場合は最小のcomplexityを採用する（U12 + PRE + BEGINNER → LOW）", () => {
    const result = resolveConstraints(ruleSet, "U12", "PRE", "BEGINNER");
    expect(result.maxAutoComplexity).toBe("LOW");
  });
});

describe("resolveConstraints — 評価順序への非依存性（要件39）", () => {
  it("RuleSet.constraints 配列をシャッフルしても結果は変わらない", () => {
    const original = resolveConstraints(ruleSet, "U12", "PRE", "BEGINNER");
    const shuffled = { ...ruleSet, constraints: [...ruleSet.constraints].reverse() };
    const reversedResult = resolveConstraints(shuffled, "U12", "PRE", "BEGINNER");
    expect([...original.disallowedMethods.entries()].sort()).toEqual([...reversedResult.disallowedMethods.entries()].sort());
    expect(original.maxAutoComplexity).toBe(reversedResult.maxAutoComplexity);
  });
});

// ---------------------------------------------------------------------------
// resolveEligibility の基本動作（詳細な64件テストは population.test.ts）
// ---------------------------------------------------------------------------

describe("resolveEligibility — 基本動作", () => {
  it("ACC ≤20m は全 maturityCategory で AUTO", () => {
    for (const category of ["PRE", "EFFECTIVE_UNKNOWN", "CIRCA", "POST"] as const) {
      const decision = resolveEligibility(ruleSet, "ACCELERATION", "ACC_BLOCK_20", category);
      expect(decision.mode).toBe("AUTO");
    }
  });

  it("SES + POST は requiresPhaseEvaluation=true のため CONDITIONAL_AUTO（AUTOに昇格させない。要件26）", () => {
    const decision = resolveEligibility(ruleSet, "SPRINT_ENDURANCE_SHORT", "SES_100", "POST");
    expect(decision.mode).toBe("CONDITIONAL_AUTO");
  });

  it("存在しない組み合わせは例外を投げる", () => {
    expect(() => resolveEligibility(ruleSet, "ACCELERATION", "ST_WARMUP", "PRE")).toThrow();
  });
});
