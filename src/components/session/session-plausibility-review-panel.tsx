"use client";

import { useState } from "react";
import { INPUT_CLASS, cn } from "@/components/ui";
import { ConfirmationCheckbox } from "@/components/running/findings-list";
import type { PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import { PLAUSIBILITY_REVIEWS_FIELD } from "@/presentation/running/action-forms";
import type { PlausibilityReviewDraft } from "@/presentation/running/dto";
import { presentPlausibilityReviewIssues } from "@/presentation/running/review-issues";
import { buildPlausibilityReviewRequests, REVIEW_REASON_MAX_CHARS, REVIEW_REASON_MIN_CHARS } from "@/presentation/running/review-requests";

/**
 * [OPEN20 F4] Session 作成時の review パネル（legacy F12 と v2 の review）。
 *
 * - 作成フォームの**中**に置き、入力が揃ったら `plausibilityReviewsJson` を hidden field として同じ
 *   フォームで送る（SessionConfirmationPanel と同じ方式。§33）。
 * - これは「このセッションを作成する」ことへの確認であり、元メニューを Running v2 として承認するものでは
 *   ない（§31）。issue ごとに reason + 2段階の明示確認（§11）。全 issue が揃うまで送信ボタンを無効化。
 * - issue が変わった（stale）ら、古い入力を持ち越さない（§21/§32）。
 */
export function SessionPlausibilityReviewPanel({
  issues,
  idPrefix = "session-review",
  disabled,
  onReadyChange,
}: {
  issues: readonly PlausibilityIssue[] | null;
  idPrefix?: string;
  disabled?: boolean;
  onReadyChange?: (ready: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, PlausibilityReviewDraft>>({});
  const activeKey = (issues ?? []).map((issue) => issue.issueDigest).sort().join("|");
  const [trackedKey, setTrackedKey] = useState<string | null>(null);
  if (trackedKey !== activeKey) {
    setTrackedKey(activeKey);
    setDrafts({});
  }

  const presented = issues === null ? [] : presentPlausibilityReviewIssues(issues);
  const draftOf = (issueDigest: string): PlausibilityReviewDraft =>
    drafts[issueDigest] ?? { issueDigest, reason: "", firstConfirmed: false, secondConfirmed: false };
  const update = (issueDigest: string, patch: Partial<PlausibilityReviewDraft>) =>
    setDrafts((d) => ({ ...d, [issueDigest]: { ...draftOf(issueDigest), ...patch } }));

  const draftList = presented.map((issue) => draftOf(issue.issueDigest));
  const built = buildPlausibilityReviewRequests(draftList);

  const ready = presented.length > 0 && built.ok;
  const [notifiedReady, setNotifiedReady] = useState<boolean | null>(null);
  if (notifiedReady !== ready) {
    setNotifiedReady(ready);
    onReadyChange?.(ready);
  }

  if (presented.length === 0) return null;
  const headingId = `${idPrefix}-heading`;

  return (
    <section className="min-w-0 space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold break-words text-indigo-900">
        このセッションの作成には、コーチの確認が必要です
      </h3>
      <p className="text-xs text-indigo-900/80">
        各内容を確認し、理由と2段階の確認を入力してください。この確認は「このセッションを作成する」ことへの確認であり、元メニューの承認ではありません。
      </p>

      {presented.map((issue, index) => {
        const draft = draftOf(issue.issueDigest);
        const fieldsetId = `${idPrefix}-issue-${index}`;
        return (
          <fieldset key={issue.issueDigest} className="min-w-0 space-y-2 rounded-lg border border-indigo-200 bg-white p-3">
            <legend className="sr-only">確認内容 {index + 1}</legend>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold break-words text-slate-900">{issue.subjectLabel}</span>
                <span className="text-xs text-slate-500">{issue.scopeLabel}</span>
              </div>
              {issue.valueLabel !== null && <p className="text-sm break-words text-slate-800">現在: {issue.valueLabel}</p>}
              {issue.thresholdLabel !== null && <p className="text-sm break-words text-slate-800">基準: {issue.thresholdLabel}</p>}
              <p className={cn("text-sm font-medium break-words", issue.certaintyInternal === "POSSIBLE_EXCEED" ? "text-amber-800" : "text-rose-700")}>
                {issue.certaintyLabel}
              </p>
            </div>

            <div>
              <label htmlFor={`${fieldsetId}-reason`} className="mb-1 block text-xs font-medium text-slate-700">
                理由（{REVIEW_REASON_MIN_CHARS}〜{REVIEW_REASON_MAX_CHARS}文字）
              </label>
              <textarea
                id={`${fieldsetId}-reason`}
                rows={3}
                className={INPUT_CLASS}
                value={draft.reason}
                disabled={disabled}
                onChange={(event) => update(issue.issueDigest, { reason: event.currentTarget.value })}
              />
              <p className="mt-1 text-xs text-slate-500">理由は記録として残ります。内容は保存時にも確認されます。</p>
            </div>

            <div className="space-y-2">
              <ConfirmationCheckbox
                id={`${fieldsetId}-confirm-1`}
                label="基準を超える内容・現在値を確認しました"
                checked={draft.firstConfirmed}
                disabled={disabled}
                onChange={(checked) => update(issue.issueDigest, { firstConfirmed: checked })}
              />
              <ConfirmationCheckbox
                id={`${fieldsetId}-confirm-2`}
                label="それでもこのセッションを作成する判断をしました"
                checked={draft.secondConfirmed}
                disabled={disabled}
                onChange={(checked) => update(issue.issueDigest, { secondConfirmed: checked })}
              />
            </div>
          </fieldset>
        );
      })}

      {built.ok && <input type="hidden" name={PLAUSIBILITY_REVIEWS_FIELD} value={JSON.stringify(built.requests)} />}
    </section>
  );
}
