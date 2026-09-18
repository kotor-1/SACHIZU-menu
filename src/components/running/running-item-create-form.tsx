"use client";

import { useState, useTransition } from "react";
import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { planRunningItemAction } from "@/actions/running-actions";
import type { TemplatePickerProviderResult } from "@/actions/_running-template-options";
import { planRunningItemFormData } from "@/presentation/running/action-forms";
import type {
  EligibilityReasonPresentationDto,
  FindingPresentationDto,
  RunningTemplateSelection,
  TargetSplitSegmentDraft,
} from "@/presentation/running/dto";
import { POSITION_PREFERENCE_LABEL_JA } from "@/presentation/running/labels";
import { buildTargetSplitInput } from "@/presentation/running/target-split";
import { FindingsList } from "./findings-list";
import { MethodTemplatePicker } from "./method-template-picker";
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
  const [pendingConfirmations, setPendingConfirmations] = useState<FindingPresentationDto[]>([]);
  const [confirmedKeys, setConfirmedKeys] = useState<string[]>([]);
  const [findings, setFindings] = useState<FindingPresentationDto[]>([]);
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
  const split = segments.length === 0 ? null : buildTargetSplitInput(segments);

  function submit() {
    if (selection === null) {
      setMessage("練習の型を選んでください。");
      return;
    }
    if (split !== null && !split.ok) {
      setMessage(split.message);
      return;
    }
    const codes = pendingConfirmations.filter((f) => f.requiresExplicitConfirmation && confirmedKeys.includes(f.confirmationKey)).map((f) => f.confirmationKey);
    const form = planRunningItemFormData({
      selection,
      positionPreference: positionPreference === "" ? null : positionPreference,
      confirmedFindingCodes: codes,
      coachReferenceJson: split !== null && split.ok ? split.json : null,
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
        onCreated?.();
        return;
      }
      if (result.kind === "CONFIRMATION_REQUIRED" || result.kind === "CONFIRMATION_STATE_STALE") {
        setPendingConfirmations(result.findings);
        // 前の結果の確認は引き継がない（STALE のときは特に、チェックし直してもらう）。
        setConfirmedKeys([]);
        setFindings([]);
        setReasons([]);
        return;
      }
      setPendingConfirmations([]);
      setFindings(result.kind === "PLAN_INELIGIBLE" || result.kind === "PLAN_BLOCKED" ? result.findings : []);
      setReasons(result.kind === "PLAN_INELIGIBLE" ? result.reasons : []);
    });
  }

  return (
    <div className="min-w-0 space-y-4 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
      <MethodTemplatePicker picker={picker.picker} value={selection} onSelect={setSelection} idPrefix={`running-add-${blockId}`} disabled={pending} />

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
        </section>
      )}

      <FindingsList findings={findings} idPrefix={`running-add-${blockId}-findings`} heading="確認事項" />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass("primary", "lg")} disabled={pending} onClick={submit}>
          この内容で追加
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
