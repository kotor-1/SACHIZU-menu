"use client";

import { useState, useTransition } from "react";
import { buttonClass, cn } from "@/components/ui";
import { editRunningItemAction, overrideRunningItemAction, recalculateWithActiveRuleSetAction, type RunningActionResult } from "@/actions/running-actions";
import type { PlausibilityIssue, PlausibilityReviewRequest } from "@/domain/running/types/plausibilityReview";
import { coachReferenceEditFormData, fieldEditFormData, overrideFormData, recalculateFormData } from "@/presentation/running/action-forms";
import type {
  EditableFieldKey,
  FindingPresentationDto,
  OverrideDraft,
  RunningFieldEditRequest,
  RunningItemPresentationDto,
  RunningOverrideRequest,
  RunningRecalculateRequest,
  TargetSplitSegmentDraft,
} from "@/presentation/running/dto";
import type { SavedRunningItemPresentation } from "@/presentation/running/server";
import { presentPlausibilityReviewIssues } from "@/presentation/running/review-issues";
import { buildCoachReferenceEditRequest, targetSplitDraftsFrom } from "@/presentation/running/target-split";
import { ConfidenceBadge } from "./confidence-badge";
import { FindingsList } from "./findings-list";
import { PlausibilityReviewForm } from "./plausibility-review-form";
import { RunningDoseSummary, RunningItemEditor } from "./running-item-editor";
import { TargetSplitEditor } from "./target-split-editor";

/**
 * メニュー内の 1 つの走トレーニング項目（R10-B4B）。
 *
 * B3 の表示・編集コンポーネントに、B4A / B4A.2 の Server Action をつなぐだけの層。
 *   - 数値の妥当性・二重確認の要否・確認が必要かどうかは、すべて domain / Action の結果に従う
 *     （ここで安全規則を判断しない）。
 *   - 保存に失敗しても入力は消さない。確認が必要になったら、その Finding だけをチェック対象にする。
 *   - 保存済みの版（RuleSet）は動かさない。「現行ルールで再計算」を押したときだけ Action 側が版を進める。
 */
/**
 * 処方調整の送り先。既定は保存済みメニューの Server Action（menuId に bind）。
 * [R12 unified composer] 保存前の下書きでは、同じ Action を rollback 付きの transaction で実行する
 * 送り先に差し替える（検証・確認・review の扱いはこのコンポーネントも Action も変わらない）。
 */
export type RunningItemOperations = {
  edit: (form: FormData) => Promise<RunningActionResult<unknown>>;
  override: (form: FormData) => Promise<RunningActionResult<unknown>>;
  recalculate: (form: FormData) => Promise<RunningActionResult<unknown>>;
};

function savedMenuOperations(menuId: string): RunningItemOperations {
  return {
    edit: (form) => editRunningItemAction(menuId, null, form),
    override: (form) => overrideRunningItemAction(menuId, null, form),
    recalculate: (form) => recalculateWithActiveRuleSetAction(menuId, null, form),
  };
}

export function RunningItemPanel({
  menuId,
  presentation,
  operations,
}: {
  menuId: string;
  presentation: SavedRunningItemPresentation;
  operations?: RunningItemOperations;
}) {
  if (presentation.status === "UNREADABLE") {
    return (
      <div className="min-w-0 rounded-lg border border-rose-200 bg-rose-50 p-3">
        <p className="text-sm font-semibold break-words text-rose-900">{presentation.title}</p>
        <p className="mt-1 text-xs text-rose-800">{presentation.message}</p>
      </div>
    );
  }
  if (presentation.status === "NOT_RUNNING_V2") return null;
  return <LoadedRunningItemPanel item={presentation.item} note={presentation.note ?? null} operations={operations ?? savedMenuOperations(menuId)} />;
}

function LoadedRunningItemPanel({ item, note, operations }: { item: RunningItemPresentationDto; note: string | null; operations: RunningItemOperations }) {
  const [open, setOpen] = useState(false);
  const [fieldDrafts, setFieldDrafts] = useState<Partial<Record<EditableFieldKey, string>>>({});
  const [overrideState, setOverrideState] = useState<OverrideDraft | null>(null);
  const [confirmedKeys, setConfirmedKeys] = useState<string[]>([]);
  const [pendingConfirmations, setPendingConfirmations] = useState<FindingPresentationDto[]>([]);
  const [segments, setSegments] = useState<TargetSplitSegmentDraft[]>(targetSplitDraftsFrom(item.editor.targetSplit.current));
  const [reviewIssues, setReviewIssues] = useState<PlausibilityIssue[] | null>(null);
  const [reviewResubmit, setReviewResubmit] = useState<((requests: PlausibilityReviewRequest[]) => void) | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(call: () => Promise<RunningActionResult<unknown>>, resubmit?: (reviews: PlausibilityReviewRequest[]) => void) {
    startTransition(async () => {
      const result = await call();
      setSucceeded(result.ok);
      setMessage(result.ok ? (result.message ?? "保存しました") : result.message);
      if (result.ok) {
        setPendingConfirmations([]);
        setConfirmedKeys([]);
        setFieldDrafts({});
        setOverrideState(null);
        setReviewIssues(null);
        setReviewResubmit(null);
        return;
      }
      if (result.kind === "CONFIRMATION_REQUIRED" || result.kind === "CONFIRMATION_STATE_STALE") {
        setPendingConfirmations(result.findings);
        // 以前の結果に対する確認は引き継がない。
        setConfirmedKeys([]);
        setReviewIssues(null);
        setReviewResubmit(null);
        return;
      }
      setPendingConfirmations([]);
      const hasReview = result.kind === "PLAN_BLOCKED" && result.reviewError === "REVIEW_REQUIRED" && (result.reviewIssues?.length ?? 0) > 0;
      setReviewIssues(hasReview ? result.reviewIssues! : null);
      setReviewResubmit(hasReview ? (resubmit ?? null) : null);
    });
  }

  /** 同じ操作を review 付きで再実行する re-entrant なハンドラ。 */
  function resubmittable(call: (reviews?: PlausibilityReviewRequest[]) => Promise<RunningActionResult<unknown>>) {
    const invoke = (reviews?: PlausibilityReviewRequest[]) =>
      run(
        () => call(reviews),
        (next) => invoke(next),
      );
    return invoke;
  }

  const onEditRequest = (request: RunningFieldEditRequest) =>
    resubmittable((reviews) => operations.edit(fieldEditFormData({ ...request, ...(reviews ? { plausibilityReviewRequests: reviews } : {}) })))();
  const onOverrideRequest = (request: RunningOverrideRequest) =>
    resubmittable((reviews) => operations.override(overrideFormData({ ...request, ...(reviews ? { plausibilityReviewRequests: reviews } : {}) })))();
  const onRecalculateRequest = (request: RunningRecalculateRequest) =>
    resubmittable((reviews) => operations.recalculate(recalculateFormData({ ...request, ...(reviews ? { plausibilityReviewRequests: reviews } : {}) })))();

  const confirmedCodesForSplit = pendingConfirmations
    .filter((f) => f.requiresExplicitConfirmation && confirmedKeys.includes(f.confirmationKey))
    .map((f) => f.confirmationKey);
  const splitRequest = buildCoachReferenceEditRequest(item.id, segments, confirmedCodesForSplit);

  return (
    <div className="min-w-0 space-y-2">
      <div className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold break-words text-slate-900">{item.title}</p>
            {item.subtitle !== null && <p className="mt-0.5 text-xs text-slate-500">分類: {item.subtitle}</p>}
          </div>
          <button type="button" className={buttonClass("secondary", "lg", "no-print")} disabled={pending} onClick={() => setOpen((v) => !v)}>
            {open ? "閉じる" : "内容を見る・調整する"}
          </button>
        </div>
        <div className="mt-1.5">
          <ConfidenceBadge confidence={item.confidence} />
        </div>
        <div className="mt-1.5">
          <RunningDoseSummary dose={item.dose} />
        </div>
        {note !== null && <p className="mt-1.5 text-xs break-words text-slate-600">メモ：{note}</p>}
        {!open && item.findings.length > 0 && <FindingsList findings={item.findings} idPrefix={`running-item-${item.id}-summary-findings`} heading="確認事項" />}
        {message !== null && (
          <p role="status" className={cn("mt-1.5 text-xs", succeeded ? "text-emerald-700" : "text-rose-700")}>
            {message}
          </p>
        )}
      </div>

      {open && (
        <div className="min-w-0 space-y-2">
          <RunningItemEditor
            value={item}
            fieldDrafts={fieldDrafts}
            confirmationState={{ confirmedKeys }}
            pendingConfirmationFindings={pendingConfirmations}
            overrideState={overrideState}
            disabled={pending}
            onChange={(field, text) => setFieldDrafts((d) => ({ ...d, [field]: text }))}
            onConfirmationChange={(key, confirmed) =>
              setConfirmedKeys((keys) => (confirmed ? [...new Set([...keys, key])] : keys.filter((k) => k !== key)))
            }
            onOverrideChange={setOverrideState}
            onEditRequest={onEditRequest}
            onOverrideRequest={onOverrideRequest}
            onRecalculateRequest={onRecalculateRequest}
          />

          {item.editor.targetSplit.acceptsInput === true && (
            <section className="min-w-0 space-y-2 rounded-xl border border-slate-200 bg-white p-4">
              <h4 className="text-sm font-semibold text-slate-800">コーチ設定の目標スプリット</h4>
              <TargetSplitEditor
                idPrefix={`running-item-${item.id}-split`}
                segments={segments}
                onChange={setSegments}
                disabled={pending || !item.canEdit}
                errorMessage={segments.length > 0 && !splitRequest.ok ? splitRequest.message : null}
              />
              <button
                type="button"
                className={buttonClass("secondary", "lg")}
                disabled={pending || !item.canEdit || !splitRequest.ok}
                onClick={() => {
                  if (splitRequest.ok) {
                    resubmittable((reviews) =>
                      operations.edit(coachReferenceEditFormData({ ...splitRequest.request, ...(reviews ? { plausibilityReviewRequests: reviews } : {}) })),
                    )();
                  }
                }}
              >
                この目標スプリットで計算し直す
              </button>
            </section>
          )}

          {reviewIssues !== null && reviewResubmit !== null && (
            <PlausibilityReviewForm
              issues={presentPlausibilityReviewIssues(reviewIssues)}
              idPrefix={`running-item-${item.id}-review`}
              disabled={pending}
              onSubmit={reviewResubmit}
            />
          )}
        </div>
      )}
    </div>
  );
}
