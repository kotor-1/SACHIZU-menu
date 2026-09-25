/**
 * [OPEN20 F4] review フォームの静的レンダリングテスト。
 * - issue の日本語表示が DOM に出る。internal（issueDigest / ruleId）は出ない。
 * - 入力が揃うまで送信ボタンは disabled（初期 render では未完）。
 * - issue ごとに reason textarea + 2つの独立した確認 checkbox がある（§11）。
 */
import { describe, expect, it } from "vitest";
import type { PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import { PlausibilityReviewForm } from "@/components/running/plausibility-review-form";
import { SessionPlausibilityReviewPanel } from "@/components/session/session-plausibility-review-panel";
import { presentPlausibilityReviewIssues } from "@/presentation/running/review-issues";
import { rawKeyLeaks, renderMarkup } from "./helpers";

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

describe("PlausibilityReviewForm の静的レンダリング", () => {
  it("日本語の確認内容を表示し、internal キー・hex digest を出さない", () => {
    const markup = renderMarkup(PlausibilityReviewForm, {
      issues: presentPlausibilityReviewIssues([issue()]),
      idPrefix: "t",
      onSubmit: () => {},
    });
    expect(markup).toContain("1セットの本数");
    expect(markup).toContain("現在: 31本");
    expect(markup).toContain("基準: 上限 30本");
    expect(markup).toContain("上限を超えています");
    expect(markup).not.toContain("PLA_REPS_PER_SET");
    expect(markup).not.toContain("c".repeat(64));
    expect(rawKeyLeaks(markup)).toEqual([]);
  });

  it("POSSIBLE_EXCEED は「可能性があります」と表示する（断定しない §8）", () => {
    const markup = renderMarkup(PlausibilityReviewForm, {
      issues: presentPlausibilityReviewIssues([issue({ certainty: "POSSIBLE_EXCEED" })]),
      idPrefix: "t",
      onSubmit: () => {},
    });
    expect(markup).toContain("上限を超えている可能性があります");
    expect(markup).not.toContain("上限を超えています");
  });

  it("入力が揃うまで送信ボタンは disabled（初期 render）", () => {
    const markup = renderMarkup(PlausibilityReviewForm, {
      issues: presentPlausibilityReviewIssues([issue()]),
      idPrefix: "t",
      onSubmit: () => {},
    });
    expect(markup).toContain("確認のうえ保存する");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>確認のうえ保存する<\/button>/);
  });

  it("issue ごとに reason と2つの確認 checkbox を用意する（§11）", () => {
    const markup = renderMarkup(PlausibilityReviewForm, {
      issues: presentPlausibilityReviewIssues([issue(), issue({ ruleId: "PLA_SETS", target: { kind: "PRESCRIPTION_FIELD", field: "sets" }, issueDigest: "d".repeat(64) })]),
      idPrefix: "t",
      onSubmit: () => {},
    });
    expect(markup.match(/type="checkbox"/g)).toHaveLength(4);
    expect(markup.match(/<textarea/g)).toHaveLength(2);
    expect(markup).toContain("基準を超える内容・現在値を確認しました");
    expect(markup).toContain("それでもこの内容で保存・実施する判断をしました");
  });

  it("issue が無ければ何も描画しない", () => {
    expect(renderMarkup(PlausibilityReviewForm, { issues: [], idPrefix: "t", onSubmit: () => {} })).toBe("");
  });
});

describe("SessionPlausibilityReviewPanel の静的レンダリング", () => {
  it("「このセッションを作成する」確認であることを明示し、元メニューの承認と混同させない（§31）", () => {
    const markup = renderMarkup(SessionPlausibilityReviewPanel, {
      issues: [issue({ scope: "SESSION", target: { kind: "ITEM_TOTAL_DISTANCE" }, observation: { kind: "SCALAR", value: 9000, unit: "m" }, boundary: { side: "MAX", threshold: 7000 }, ruleId: "PLA_ITEM_TOTAL_DISTANCE" })],
      idPrefix: "t",
    });
    expect(markup).toContain("このセッションの作成には、コーチの確認が必要です");
    expect(markup).toContain("元メニューの承認ではありません");
    expect(markup).not.toContain("c".repeat(64));
  });
});
