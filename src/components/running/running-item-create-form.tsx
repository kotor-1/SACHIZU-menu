"use client";

import { useState, useTransition } from "react";
import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { planRunningItemAction } from "@/actions/running-actions";
import type { PlausibilityIssue, PlausibilityReviewRequest } from "@/domain/running/types/plausibilityReview";
import { eligibilityOverrideOptions, groupCreateMethodPolicy } from "@/presentation/running/eligibility";
import type { TemplatePickerProviderResult } from "@/actions/_running-template-options";
import { planRunningItemFormData } from "@/presentation/running/action-forms";
import type {
  EligibilityReasonPresentationDto,
  FindingPresentationDto,
  RunningTemplateSelection,
  TargetSplitSegmentDraft,
} from "@/presentation/running/dto";
import { POSITION_PREFERENCE_LABEL_JA } from "@/presentation/running/labels";
import { presentPlausibilityReviewIssues } from "@/presentation/running/review-issues";
import { buildTargetSplitInput } from "@/presentation/running/target-split";
import { FindingsList } from "./findings-list";
import { MethodTemplatePicker } from "./method-template-picker";
import { PlausibilityReviewForm } from "./plausibility-review-form";
import { TargetSplitEditor } from "./target-split-editor";

/**
 * 走トレーニング（Running v2）の項目を追加する（R10-B4B）。
 *
 * - 一覧は**候補**。選べるかどうかは `planRunningItemAction` の結果（PLAN_INELIGIBLE 等）だけが決める。
 * - 失敗しても選択・入力は消さない。値を自動で直さない（例：目標スプリットを勝手に入れない）。
 * - 確認が必要な Finding は Action の結果から受け取り、チェックしてもう一度送る（code は presentation が持つ）。
 */
export function RunningItemCreateForm({
  menuId,
  blockId,
  picker,
  onCancel,
  onCreated,
}: {
  menuId: string;
  blockId: string;
  picker: TemplatePickerProviderResult;
  onCancel?: () => void;
  onCreated?: () => void;
}) {
  const [selection, setSelection] = useState<RunningTemplateSelection | null>(null);
  const [positionPreference, setPositionPreference] = useState<"" | "LOWER" | "MIDDLE">("");
  const [segments, setSegments] = useState<TargetSplitSegmentDraft[]>([]);
  const [eligibilityOverrideRuleIds, setEligibilityOverrideRuleIds] = useState<string[]>([]);
  const [eligibilityOverrideReason, setEligibilityOverrideReason] = useState("");
  const [eligibilityOverrideFirstConfirmation, setEligibilityOverrideFirstConfirmation] = useState(false);
  const [eligibilityOverrideSecondConfirmation, setEligibilityOverrideSecondConfirmation] = useState(false);
  const [coachEditValues, setCoachEditValues] = useState<Record<string, string>>({});
  const [pendingConfirmations, setPendingConfirmations] = useState<FindingPresentationDto[]>([]);
  const [confirmedKeys, setConfirmedKeys] = useState<string[]>([]);
  const [findings, setFindings] = useState<FindingPresentationDto[]>([]);
  const [reviewIssues, setReviewIssues] = useState<PlausibilityIssue[] | null>(null);
  const [reasons, setReasons] = useState<EligibilityReasonPresentationDto[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [pending, startTransition] = useTransition();

  if (picker.status !== "OK") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="text-sm text-slate-700">{picker.message}</p>
      </div>
    );
  }

  const options = picker.picker.groups.flatMap((g) => g.options);
  const selected = selection === null ? null : options.find((o) => o.templateIdInternal === selection.templateId && o.methodInternal === selection.method) ?? null;
  const acceptsTargetSplit = selected?.acceptsCoachTargetSplit === true;
  const methodPolicy = groupCreateMethodPolicy(selection?.method ?? null);
  const isSes = selection?.method === "SPRINT_ENDURANCE_SHORT";
  const isLongSpecialEnduranceI = selection?.method === "LONG_SPRINT_RACE_SPECIFIC" && selection.templateId === "LSR_SPECIAL_ENDURANCE_I";
  const isEventApproach = selection?.method === "EVENT_APPROACH_SPEED";
  const overrideableReasons = eligibilityOverrideOptions(reasons, selection?.method ?? null);
  const split = segments.length === 0 ? null : buildTargetSplitInput(segments);

  const sesCoachFields = [{ field: "totalReps", label: "合計本数", unit: "reps" }] as const;
  const longCoachFields = [{ field: "totalReps", label: "合計本数", unit: "reps" }] as const;
  const eventApproachCoachFields = [{ field: "approachDistanceM", label: "助走距離", unit: "m" }] as const;
  const coachInputFields = isSes ? sesCoachFields : isLongSpecialEnduranceI ? longCoachFields : isEventApproach ? eventApproachCoachFields : [];

  function submit(reviews?: PlausibilityReviewRequest[]) {
    if (selection === null) {
      setMessage("練習の型を選んでください。");
      return;
    }
    if (split !== null && !split.ok) {
      setMessage(split.message);
      return;
    }
    const codes = pendingConfirmations.filter((f) => f.requiresExplicitConfirmation && confirmedKeys.includes(f.confirmationKey)).map((f) => f.confirmationKey);
    const coachEdits = coachInputFields.flatMap(({ field, unit }) => {
          const valueText = coachEditValues[field] ?? "";
          if (valueText.trim() === "") return [];
          return [{ field, value: Number(valueText), unit }];
        });
    const form = planRunningItemFormData({
      selection,
      positionPreference: positionPreference === "" ? null : positionPreference,
      confirmedFindingCodes: codes,
      coachReferenceJson: split !== null && split.ok ? split.json : null,
      eligibilityOverrideRuleIds,
      eligibilityOverrideReason,
      eligibilityOverrideFirstConfirmation,
      eligibilityOverrideSecondConfirmation,
      coachEdits,
      plausibilityReviewRequests: reviews,
    });

    startTransition(async () => {
      const result = await planRunningItemAction(menuId, blockId, null, form);
      setSucceeded(result.ok);
      setMessage(result.ok ? (result.message ?? "追加しました") : result.message);
      if (result.ok) {
        setPendingConfirmations([]);
        setConfirmedKeys([]);
        setFindings(result.data.sessionFindingViews);
        setReasons([]);
        setReviewIssues(null);
        setEligibilityOverrideRuleIds([]);
        setEligibilityOverrideReason("");
        setEligibilityOverrideFirstConfirmation(false);
        setEligibilityOverrideSecondConfirmation(false);
        setCoachEditValues({});
        onCreated?.();
        return;
      }
      if (result.kind === "CONFIRMATION_REQUIRED" || result.kind === "CONFIRMATION_STATE_STALE") {
        setPendingConfirmations(result.findings);
        // 前の結果の確認は引き継がない（STALE のときは特に、チェックし直してもらう）。
        setConfirmedKeys([]);
        setFindings([]);
        setReasons([]);
        setReviewIssues(null);
        return;
      }
      setPendingConfirmations([]);
      setFindings(result.kind === "PLAN_INELIGIBLE" || result.kind === "PLAN_BLOCKED" ? result.findings : []);
      // [OPEN20 F4] review 可能な blocker だけを review フォームへ。hard / data-quality はここに入らない。
      setReviewIssues(result.kind === "PLAN_BLOCKED" && result.reviewError === "REVIEW_REQUIRED" && (result.reviewIssues?.length ?? 0) > 0 ? result.reviewIssues! : null);
      if (result.kind === "PLAN_INELIGIBLE") setReasons(result.reasons);
      else if (result.kind !== "INVALID_INPUT") setReasons([]);
    });
  }

  return (
    <div className="min-w-0 space-y-4 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
      <MethodTemplatePicker
        picker={picker.picker}
        value={selection}
        onSelect={(next) => {
          setSelection(next);
          setReasons([]);
          setFindings([]);
          setReviewIssues(null);
          setEligibilityOverrideRuleIds([]);
          setEligibilityOverrideReason("");
          setEligibilityOverrideFirstConfirmation(false);
          setEligibilityOverrideSecondConfirmation(false);
        }}
        idPrefix={`running-add-${blockId}`}
        disabled={pending}
      />

      {methodPolicy.message !== null && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          {methodPolicy.message}
        </p>
      )}

      {coachInputFields.length > 0 && (
        <section className="min-w-0 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
          <h4 className="text-sm font-semibold text-slate-800">コーチが入力する処方値</h4>
          <p className="text-xs text-slate-600">入力した数値はコーチの判断として扱います。未入力の数値をAIやシステムが補うことはありません。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {coachInputFields.map((field, index) => (
              <div key={field.field}>
                <label htmlFor={`running-add-${blockId}-ti-${index}`} className="mb-1 block text-xs font-medium text-slate-700">
                  {field.label}
                </label>
                <input
                  id={`running-add-${blockId}-ti-${index}`}
                  type="number"
                  step="any"
                  className={INPUT_CLASS}
                  value={coachEditValues[field.field] ?? ""}
                  disabled={pending}
                  onChange={(event) => setCoachEditValues((values) => ({ ...values, [field.field]: event.currentTarget.value }))}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="sm:max-w-xs">
        <label htmlFor={`running-add-${blockId}-position`} className="mb-1 block text-xs font-medium text-slate-700">
          推奨範囲のどこを使うか
        </label>
        <select
          id={`running-add-${blockId}-position`}
          className={cn(INPUT_CLASS, "h-11 w-full")}
          value={positionPreference}
          disabled={pending}
          onChange={(e) => setPositionPreference(e.currentTarget.value as "" | "LOWER" | "MIDDLE")}
        >
          <option value="">{POSITION_PREFERENCE_LABEL_JA.NONE}</option>
          <option value="LOWER">{POSITION_PREFERENCE_LABEL_JA.LOWER}</option>
          <option value="MIDDLE">{POSITION_PREFERENCE_LABEL_JA.MIDDLE}</option>
        </select>
      </div>

      {acceptsTargetSplit && (
        <section className="min-w-0 space-y-2">
          <h4 className="text-sm font-semibold text-slate-800">コーチ設定の目標スプリット</h4>
          <p className="text-xs text-slate-600">
            この型は、区間ごとの目標タイムを基準にできます。記録が無いグループでも、コーチが決めた目標で計画できます。
          </p>
          <TargetSplitEditor
            idPrefix={`running-add-${blockId}-split`}
            segments={segments}
            onChange={setSegments}
            disabled={pending}
            errorMessage={split !== null && !split.ok ? split.message : null}
          />
        </section>
      )}

      <FindingsList
        findings={pendingConfirmations}
        idPrefix={`running-add-${blockId}-pending`}
        heading="追加する前の確認"
        confirmation={{
          confirmedKeys,
          disabled: pending,
          onChange: (key, confirmed) => setConfirmedKeys((keys) => (confirmed ? [...new Set([...keys, key])] : keys.filter((k) => k !== key))),
        }}
      />

      {reasons.length > 0 && (
        <section className="min-w-0 space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <h4 className="text-sm font-semibold text-amber-900">この条件では選べません</h4>
          <ul className="list-disc space-y-1 pl-4 text-sm text-amber-900">
            {reasons.map((reason) => (
              <li key={reason.key}>{reason.message}</li>
            ))}
          </ul>
          {acceptsTargetSplit && segments.length === 0 && (
            <p className="text-xs text-amber-900">この型は、コーチ設定の目標スプリットを入力すると計画できる場合があります。</p>
          )}
          {overrideableReasons.length > 0 && (
            <fieldset className="space-y-2 border-t border-amber-200 pt-2">
              <legend className="text-sm font-semibold text-amber-900">コーチによる例外設定</legend>
              <p className="text-xs text-amber-900">現在の計画で解除可能と判定された条件だけが選べます。他の制約は引き続き評価されます。</p>
              <div className="space-y-2">
                {overrideableReasons.map((reason, index) => {
                  const ruleId = reason.ruleIdInternal!;
                  const checked = eligibilityOverrideRuleIds.includes(ruleId);
                  return (
                    <label key={reason.key} className="flex min-w-0 items-start gap-2 text-sm text-amber-950">
                      <input
                        type="checkbox"
                        className="mt-1 h-5 w-5 shrink-0"
                        checked={checked}
                        disabled={pending}
                        onChange={(event) => {
                          const isChecked = event.currentTarget.checked;
                          setEligibilityOverrideRuleIds((ids) => (isChecked ? [...new Set([...ids, ruleId])] : ids.filter((id) => id !== ruleId)));
                        }}
                        aria-label={`解除可能な条件 ${index + 1} の例外を申請`}
                      />
                      <span>{reason.message}（コーチ確認が必要）</span>
                    </label>
                  );
                })}
              </div>
              {eligibilityOverrideRuleIds.length > 0 && (
                <div className="space-y-2 rounded-md bg-white p-3">
                  <label htmlFor={`running-add-${blockId}-override-reason`} className="block text-xs font-medium text-slate-700">
                    例外設定の理由（10文字以上）
                  </label>
                  <textarea
                    id={`running-add-${blockId}-override-reason`}
                    className={cn(INPUT_CLASS, "min-h-20")}
                    value={eligibilityOverrideReason}
                    disabled={pending}
                    onChange={(event) => setEligibilityOverrideReason(event.currentTarget.value)}
                  />
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-5 w-5 shrink-0"
                      checked={eligibilityOverrideFirstConfirmation}
                      disabled={pending}
                      onChange={(event) => setEligibilityOverrideFirstConfirmation(event.currentTarget.checked)}
                    />
                    <span>この条件を例外として扱う判断を確認しました。</span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-5 w-5 shrink-0"
                      checked={eligibilityOverrideSecondConfirmation}
                      disabled={pending}
                      onChange={(event) => setEligibilityOverrideSecondConfirmation(event.currentTarget.checked)}
                    />
                    <span>例外設定を保存することをもう一度確認しました。</span>
                  </label>
                </div>
              )}
            </fieldset>
          )}
        </section>
      )}

      <FindingsList findings={findings} idPrefix={`running-add-${blockId}-findings`} heading="確認事項" />

      {reviewIssues !== null && (
        <PlausibilityReviewForm
          issues={presentPlausibilityReviewIssues(reviewIssues)}
          idPrefix={`running-add-${blockId}-review`}
          disabled={pending}
          onSubmit={(requests) => submit(requests)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass("primary", "lg")} disabled={pending || !methodPolicy.available} onClick={() => submit()}>
          {methodPolicy.available ? "この内容で追加" : "この画面では追加できません"}
        </button>
        {onCancel && (
          <button type="button" className={buttonClass("ghost", "lg")} disabled={pending} onClick={onCancel}>
            やめる
          </button>
        )}
        {message !== null && (
          <p role="status" className={cn("text-xs", succeeded ? "text-emerald-700" : "text-rose-700")}>
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
