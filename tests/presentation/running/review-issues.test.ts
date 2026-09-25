/**
 * [OPEN20 F4] PlausibilityIssue → 表示 DTO の mapper テスト。
 * - certainty（CONFIRMED / POSSIBLE）で文言を変える（POSSIBLE を断定しない §8）。
 * - boundary side（MIN / MAX）で「超えています／下回っています」を区別する。
 * - internal（issueDigest / ruleId / hex digest）を user-facing 文字列に出さない。
 */
import { describe, expect, it } from "vitest";
import type { PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import { presentPlausibilityReviewIssues } from "@/presentation/running/review-issues";

function issue(overrides: Partial<PlausibilityIssue> = {}): PlausibilityIssue {
  return {
    ruleId: "PLA_REPS_PER_SET",
    findingCode: "PLAUSIBILITY_BLOCK",
    scope: "ITEM",
    target: { kind: "PRESCRIPTION_FIELD", field: "repsPerSet" },
    observation: { kind: "SCALAR", value: 31, unit: "reps" },
    boundary: { side: "MAX", threshold: 30 },
    certainty: "CONFIRMED_EXCEED",
    ruleSet: { version: "rs-2026.09.0", contentHash: "a".repeat(64) },
    contextDigest: "b".repeat(64),
    issueDigest: "c".repeat(64),
    ...overrides,
  };
}

describe("presentPlausibilityReviewIssues", () => {
  it("PRESCRIPTION_FIELD target は日本語ラベル・現在値・基準・判定に変換する", () => {
    const [dto] = presentPlausibilityReviewIssues([issue()]);
    expect(dto.subjectLabel).toBe("1セットの本数");
    expect(dto.valueLabel).toBe("31本");
    expect(dto.thresholdLabel).toBe("上限 30本");
    expect(dto.certaintyLabel).toBe("上限を超えています");
    expect(dto.certaintyInternal).toBe("CONFIRMED_EXCEED");
    expect(dto.scopeLabel).toBe("この項目");
  });

  it("POSSIBLE_EXCEED は断定しない（CONFIRMED と同じ文にならない §8）", () => {
    const [dto] = presentPlausibilityReviewIssues([issue({ certainty: "POSSIBLE_EXCEED" })]);
    expect(dto.certaintyLabel).toBe("上限を超えている可能性があります");
    expect(dto.certaintyLabel).not.toBe("上限を超えています");
  });

  it("MIN 境界は「下回っています」で表す（F16 下端など）", () => {
    const [dto] = presentPlausibilityReviewIssues([
      issue({
        scope: "INPUT",
        target: { kind: "HEIGHT_POINT", recordDigest: "d".repeat(64) },
        observation: { kind: "SCALAR", value: 49.9, unit: "cm" },
        boundary: { side: "MIN", threshold: 50 },
      }),
    ]);
    expect(dto.subjectLabel).toBe("身長の計測点");
    expect(dto.valueLabel).toBe("49.9cm");
    expect(dto.thresholdLabel).toBe("下限 50cm");
    expect(dto.certaintyLabel).toBe("下限を下回っています");
    expect(dto.scopeLabel).toBe("入力・記録");
  });

  it("target kind ごとの対象ラベルを出す", () => {
    const labelOf = (target: PlausibilityIssue["target"]) => presentPlausibilityReviewIssues([issue({ target })])[0]!.subjectLabel;
    expect(labelOf({ kind: "ITEM_TOTAL_DISTANCE" })).toBe("項目の合計距離");
    expect(labelOf({ kind: "REP_DISTANCE" })).toBe("1本の距離");
    expect(labelOf({ kind: "TIMED_MARK", recordDigest: "d".repeat(64) })).toBe("計測したタイム");
  });

  it("INTERVAL observation は範囲として表示する", () => {
    const [dto] = presentPlausibilityReviewIssues([
      issue({ observation: { kind: "INTERVAL", lower: 31, upper: 34, unit: "reps", source: "PLANNED", confidence: "HIGH" } }),
    ]);
    expect(dto.valueLabel).toBe("31〜34本");
  });

  it("internal（ruleId / hex digest）を user-facing 文字列に出さない", () => {
    const [dto] = presentPlausibilityReviewIssues([issue()]);
    const text = [dto.subjectLabel, dto.valueLabel, dto.thresholdLabel, dto.certaintyLabel, dto.scopeLabel, dto.message].join(" ");
    expect(text).not.toContain("PLA_REPS_PER_SET");
    expect(text).not.toContain("c".repeat(64));
    expect(text).not.toContain("a".repeat(64));
  });
});
