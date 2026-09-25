/**
 * [OPEN20 F4] review フォーム下書き → リクエストの検証テスト。
 * - reason は trim 後 10〜1000 文字（§13）。
 * - 2段階の確認は両方必須（§11）。
 * - 複数 issue は全件完成のみ（§14/§15）。issueDigest の重複は拒否。
 * これは UX 用の先取り検証であり、最終 authority は server（F3 の Action test が担保）。
 */
import { describe, expect, it } from "vitest";
import type { PlausibilityReviewDraft } from "@/presentation/running/dto";
import { buildPlausibilityReviewRequests, reviewDraftIssue } from "@/presentation/running/review-requests";

function draft(overrides: Partial<PlausibilityReviewDraft> = {}): PlausibilityReviewDraft {
  return {
    issueDigest: "a".repeat(64),
    reason: "コーチが現在値と基準を二回確認して承認しました",
    firstConfirmed: true,
    secondConfirmed: true,
    ...overrides,
  };
}

describe("buildPlausibilityReviewRequests", () => {
  it("reason は trim して 10〜1000 文字で受け付ける", () => {
    const ten = buildPlausibilityReviewRequests([draft({ reason: "  一二三四五六七八九十  " })]);
    expect(ten.ok).toBe(true);
    if (ten.ok) expect(ten.requests[0]!.reason).toBe("一二三四五六七八九十");
    expect(buildPlausibilityReviewRequests([draft({ reason: "あ".repeat(1000) })]).ok).toBe(true);
  });

  it("reason 9文字以下・空白のみ・1001文字以上は拒否", () => {
    expect(buildPlausibilityReviewRequests([draft({ reason: "短すぎる理由" })]).ok).toBe(false);
    expect(buildPlausibilityReviewRequests([draft({ reason: "         " })]).ok).toBe(false);
    expect(buildPlausibilityReviewRequests([draft({ reason: "あ".repeat(1001) })]).ok).toBe(false);
  });

  it("2段階の確認が揃わないと送れない（片方だけは不可 §11）", () => {
    expect(buildPlausibilityReviewRequests([draft({ firstConfirmed: false })]).ok).toBe(false);
    expect(buildPlausibilityReviewRequests([draft({ secondConfirmed: false })]).ok).toBe(false);
    expect(buildPlausibilityReviewRequests([draft({ firstConfirmed: false, secondConfirmed: false })]).ok).toBe(false);
    expect(buildPlausibilityReviewRequests([draft()]).ok).toBe(true);
  });

  it("複数 issue は全件完成しないと送れない（部分承認は不可 §14/§15）", () => {
    const a = draft({ issueDigest: "a".repeat(64) });
    const bIncomplete = draft({ issueDigest: "b".repeat(64), secondConfirmed: false });
    expect(buildPlausibilityReviewRequests([a, bIncomplete]).ok).toBe(false);
    const b = draft({ issueDigest: "b".repeat(64) });
    const ok = buildPlausibilityReviewRequests([a, b]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.requests.map((r) => r.issueDigest)).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("issueDigest の重複は拒否", () => {
    expect(buildPlausibilityReviewRequests([draft(), draft()]).ok).toBe(false);
  });

  it("空の下書きリストは拒否", () => {
    expect(buildPlausibilityReviewRequests([]).ok).toBe(false);
  });

  it("リクエストは firstConfirmed / secondConfirmed を true で送る（reason は trim 済み）", () => {
    const result = buildPlausibilityReviewRequests([draft({ reason: "  十分な長さの理由をここに入力します  " })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requests[0]).toEqual({
        issueDigest: "a".repeat(64),
        reason: "十分な長さの理由をここに入力します",
        firstConfirmed: true,
        secondConfirmed: true,
      });
    }
  });
});

describe("reviewDraftIssue", () => {
  it("完成した下書きはエラーなし、未完は理由・確認の案内を返す", () => {
    expect(reviewDraftIssue(draft())).toBeNull();
    expect(reviewDraftIssue(draft({ reason: "短い" }))).toContain("10文字");
    expect(reviewDraftIssue(draft({ firstConfirmed: false }))).toContain("2つの確認");
  });
});
