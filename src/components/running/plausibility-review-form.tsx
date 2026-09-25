"use client";

import { useState } from "react";
import { buttonClass, cn, INPUT_CLASS } from "@/components/ui";
import type { PlausibilityReviewRequest } from "@/domain/running/types/plausibilityReview";
import type { PlausibilityReviewDraft, PlausibilityReviewIssuePresentationDto } from "@/presentation/running/dto";
import { buildPlausibilityReviewRequests, REVIEW_REASON_MAX_CHARS, REVIEW_REASON_MIN_CHARS } from "@/presentation/running/review-requests";
import { ConfirmationCheckbox } from "./findings-list";

/**
 * [OPEN20 F4] 妥当性レビューの入力フォーム。
 *
 * - 各 issue を独立表示し、issue ごとに reason + **2段階の明示確認**（§11。単一 checkbox の複製ではない）。
 * - 全 issue が完成するまで送信ボタンを無効にする（§14/§15 の先取り。最終 authority は server）。
 * - issue が変わった（stale）ら、古い reason・確認を新しい issue へ持ち込まない（§21）。
 * - issueDigest / ruleId は内部値。DOM には出さない（表示は mapper の日本語だけ）。
 */
export function PlausibilityReviewForm({
  issues,
  idPrefix,
  disabled,
  onSubmit,
}: {
  issues: readonly PlausibilityReviewIssuePresentationDto[];
  idPrefix: string;
  disabled?: boolean;
  onSubmit: (requests: PlausibilityReviewRequest[]) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, PlausibilityReviewDraft>>({});
  // issue 集合が変わったら（stale）入力は全部無効。render 中に state を戻す。
  const activeKey = issues.map((issue) => issue.issueDigest).sort().join("|");
  const [trackedKey, setTrackedKey] = useState<string | null>(null);
  if (trackedKey !== activeKey) {
    setTrackedKey(activeKey);
    setDrafts({});
  }

  const draftOf = (issue: PlausibilityReviewIssuePresentationDto): PlausibilityReviewDraft =>
    drafts[issue.issueDigest] ?? { issueDigest: issue.issueDigest, reason: "", firstConfirmed: false, secondConfirmed: false };
  const update = (issue: PlausibilityReviewIssuePresentationDto, patch: Partial<PlausibilityReviewDraft>) =>
    setDrafts((d) => ({ ...d, [issue.issueDigest]: { ...draftOf(issue), ...patch } }));

  const draftList = issues.map(draftOf);
  const built = buildPlausibilityReviewRequests(draftList);

  if (issues.length === 0) return null;
  const headingId = `${idPrefix}-heading`;

  return (
    <section className="min-w-0 space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3" aria-labelledby={headingId}>
      <div className="min-w-0">
        <h4 id={headingId} className="text-sm font-semibold break-words text-indigo-900">
          コーチの確認が必要な内容があります
        </h4>
        <p className="mt-1 text-xs text-indigo-900/80">
          各内容を確認し、理由と2段階の確認を入力してください。すべて入力すると保存できます。
        </p>
      </div>

      {issues.map((issue, index) => {
        const draft = draftOf(issue);
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
                onChange={(event) => update(issue, { reason: event.currentTarget.value })}
              />
              <p className="mt-1 text-xs text-slate-500">理由は記録として残ります。内容は保存時にも確認されます。</p>
            </div>

            <div className="space-y-2">
              <ConfirmationCheckbox
                id={`${fieldsetId}-confirm-1`}
                label="基準を超える内容・現在値を確認しました"
                checked={draft.firstConfirmed}
                disabled={disabled}
                onChange={(checked) => update(issue, { firstConfirmed: checked })}
              />
              <ConfirmationCheckbox
                id={`${fieldsetId}-confirm-2`}
                label="それでもこの内容で保存・実施する判断をしました"
                checked={draft.secondConfirmed}
                disabled={disabled}
                onChange={(checked) => update(issue, { secondConfirmed: checked })}
              />
            </div>
          </fieldset>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass("primary", "lg")} disabled={disabled || !built.ok} onClick={() => built.ok && onSubmit(built.requests)}>
          確認のうえ保存する
        </button>
        {!built.ok && <p role="status" className="text-xs text-rose-700">{built.message}</p>}
      </div>
    </section>
  );
}
