/**
 * Running Prescription Engine v2 — [OPEN20 F4] review フォームの下書き → リクエスト。
 *
 * - 最終 authority は server（`plausibilityReviewRequestSchema`）。ここは UX 用の先取り検証で、
 *   server の検証を緩めない・置き換えない。
 * - reason は trim 後 10〜1000 文字（§13）。2段階の確認は**両方**明示的に必要（§11）。
 *   単一 checkbox を内部で first/second 両方へ複製しない。
 * - 複数 issue はすべて完成していないと送らない（§14/§15）。issueDigest の重複は拒否する。
 * - `import type` のみで domain schema を client bundle へ持ち込まない。
 */
import type { PlausibilityReviewRequest } from "@/domain/running/types/plausibilityReview";
import type { PlausibilityReviewDraft } from "./dto";

export const REVIEW_REASON_MIN_CHARS = 10;
export const REVIEW_REASON_MAX_CHARS = 1000;

export type PlausibilityReviewRequestBuildResult =
  | { ok: true; requests: PlausibilityReviewRequest[] }
  | { ok: false; message: string };

function reasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "理由を入力してください。";
  if (trimmed.length < REVIEW_REASON_MIN_CHARS) return `理由は${REVIEW_REASON_MIN_CHARS}文字以上で入力してください。`;
  if (trimmed.length > REVIEW_REASON_MAX_CHARS) return `理由は${REVIEW_REASON_MAX_CHARS}文字以内で入力してください。`;
  return null;
}

/**
 * 全 issue が完成していればリクエストを返す。1件でも未完・不正なら送らない。
 * `issueDigest` の集合は送信内容を決める authority であり、ここでは重複を弾くだけ（値の改変はしない）。
 */
export function buildPlausibilityReviewRequests(drafts: readonly PlausibilityReviewDraft[]): PlausibilityReviewRequestBuildResult {
  if (drafts.length === 0) return { ok: false, message: "確認対象がありません。" };

  const digests = drafts.map((draft) => draft.issueDigest);
  if (new Set(digests).size !== digests.length) return { ok: false, message: "確認対象が重複しています。" };

  for (const draft of drafts) {
    const reasonIssue = reasonError(draft.reason);
    if (reasonIssue !== null) return { ok: false, message: reasonIssue };
    if (!draft.firstConfirmed) return { ok: false, message: "1つ目の確認にチェックを入れてください。" };
    if (!draft.secondConfirmed) return { ok: false, message: "2つ目の確認にチェックを入れてください。" };
  }

  return {
    ok: true,
    requests: drafts.map((draft) => ({
      issueDigest: draft.issueDigest,
      reason: draft.reason.trim(),
      firstConfirmed: true,
      secondConfirmed: true,
    })),
  };
}

/** 1件の下書き単体が送信可能か（フォーム内の行ごとの案内用）。 */
export function reviewDraftIssue(draft: PlausibilityReviewDraft): string | null {
  const reasonIssue = reasonError(draft.reason);
  if (reasonIssue !== null) return reasonIssue;
  if (!draft.firstConfirmed || !draft.secondConfirmed) return "2つの確認にチェックを入れてください。";
  return null;
}
