"use client";

import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import type {
  DosePresentationDto,
  EditableFieldDto,
  EditableFieldKey,
  EligibilityOverrideOptionDto,
  FindingPresentationDto,
  OverrideDraft,
  RunningFieldEditRequest,
  RunningItemPresentationDto,
  RunningOverrideRequest,
  RunningRecalculateRequest,
} from "@/presentation/running/dto";
import {
  buildFieldEditRequest,
  buildOverrideRequest,
  buildRecalculateRequest,
  confirmedCodesForRequest,
  overrideDraftRequiresDoubleConfirmation,
} from "@/presentation/running/editor-requests";
import { ConfidenceBadge } from "./confidence-badge";
import { ConfirmationCheckbox, FindingsList } from "./findings-list";
import { ProvenancePanel } from "./provenance-panel";

/**
 * RUNNING_V2 項目の表示・編集コンポーネント（R10-B3）。
 *
 * **完全な controlled component**: 入力中の値・確認チェック・override の下書きはすべて props で受け取り、
 * 変更は callback で親へ返す（hooks を持たない）。Server Action は import しない。
 * B4 で親（integration boundary）が callback を `editRunningItemAction` / `overrideRunningItemAction` /
 * `recalculateWithActiveRuleSetAction` と、確認済み Finding（`confirmedFindingCodes[]`）へ接続する。
 * 範囲・安全上限・reason の長さなどの最終検証は domain が行う（ここでは入力の完成度しか見ない）。
 *
 * [R10-B4A] 確認の流れ: 保存 → Action が CONFIRMATION_REQUIRED / STALE と確認対象の Finding を返す →
 * 親が `pendingConfirmationFindings` に渡す → コーチが「内容を確認しました」にチェック → 同じ操作をもう一度送る。
 * リクエストに載せる code は `pendingConfirmationFindings` にあるものだけ（保存済み Finding の確認記録は操作に流用しない）。
 */
export type RunningItemEditorProps = {
  value: RunningItemPresentationDto;
  /** field ごとの入力欄の文字列（未入力の field は省略可）。 */
  fieldDrafts: Readonly<Partial<Record<EditableFieldKey, string>>>;
  confirmationState: { confirmedKeys: readonly string[] };
  /** [R10-B4A] 直前の Action 結果で示された、保存前に明示確認が必要な Finding（無ければ省略）。 */
  pendingConfirmationFindings?: readonly FindingPresentationDto[];
  overrideState: OverrideDraft | null;
  disabled?: boolean;
  onChange: (field: EditableFieldKey, text: string) => void;
  onConfirmationChange: (confirmationKey: string, confirmed: boolean) => void;
  onOverrideChange: (next: OverrideDraft | null) => void;
  onEditRequest?: (request: RunningFieldEditRequest) => void;
  onOverrideRequest?: (request: RunningOverrideRequest) => void;
  onRecalculateRequest?: (request: RunningRecalculateRequest) => void;
};

function requestConfirmedCodes(props: RunningItemEditorProps): string[] {
  return confirmedCodesForRequest(props.pendingConfirmationFindings ?? [], props.confirmationState.confirmedKeys);
}

export function RunningDoseSummary({ dose }: { dose: DosePresentationDto }) {
  const structure = dose.repStructure;
  const lines: string[] = [dose.countsLabel];
  if (structure.kind === "FLY") {
    lines.push(structure.buildUpLabel, structure.flyZoneLabel);
    if (structure.decelerationLabel !== null) lines.push(structure.decelerationLabel);
    if (structure.totalRunningLabel !== null) lines.push(structure.totalRunningLabel);
  } else if (structure.kind === "DURATION") {
    lines.push(structure.durationLabel);
    if (structure.approxDistanceLabel !== null) lines.push(structure.approxDistanceLabel);
  } else if (structure.kind === "ATTEMPTS") {
    lines.push(structure.approachLabel, structure.approachDistanceLabel);
  } else if (dose.distanceLabel !== null) {
    lines.push(dose.distanceLabel);
  }
  lines.push(dose.restLabel);
  if (dose.setRestLabel !== null) lines.push(dose.setRestLabel);
  if (dose.intraRepRestLabel !== null) lines.push(dose.intraRepRestLabel);
  lines.push(`強度の基準: ${dose.intensityLabel}`);
  if (dose.intensityTargetLabel !== null) lines.push(dose.intensityTargetLabel);

  return (
    <div className="min-w-0 space-y-1">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-800">
        {lines.map((line, i) => (
          <li key={i} className="min-w-0 break-words">
            {line}
          </li>
        ))}
      </ul>
      {/* [R10-B4A.2] コーチが入力した目標スプリット（保存された入力値。エンジンが作った個別目標ではない）。 */}
      {dose.coachTargetSplit !== null && (
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-700">{dose.coachTargetSplit.heading}</p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-800">
            {dose.coachTargetSplit.segments.map((s, i) => (
              <li key={i} className="min-w-0 break-words">
                {s.distanceLabel}：{s.targetTimeLabel}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dose.restFeasibilityLabel !== null && <p className="text-xs text-amber-800">{dose.restFeasibilityLabel}</p>}
    </div>
  );
}

function emptyFieldOverride(field: EditableFieldDto, layer: EditableFieldDto["overrideLayers"][number]): OverrideDraft {
  return {
    kind: "FIELD",
    fieldInternal: field.keyInternal,
    layerInternal: layer.layerInternal,
    valueText: "",
    reason: "",
    firstConfirmation: false,
    secondConfirmation: false,
  };
}

function OverrideForm({
  props,
  draft,
  heading,
  idBase,
}: {
  props: RunningItemEditorProps;
  draft: OverrideDraft;
  heading: string;
  idBase: string;
}) {
  const { value, disabled, onOverrideChange, onOverrideRequest } = props;
  const doubleConfirmation = overrideDraftRequiresDoubleConfirmation(draft, value.editor);
  const built = buildOverrideRequest(value.id, draft, value.editor, requestConfirmedCodes(props));
  const field = draft.kind === "FIELD" ? value.editor.fields.find((f) => f.keyInternal === draft.fieldInternal) : undefined;
  const headingId = `${idBase}-heading`;
  const canSubmit = !disabled && value.canEdit && onOverrideRequest !== undefined && built.ok;

  return (
    <div role="group" aria-labelledby={headingId} className="mt-3 min-w-0 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <p id={headingId} className="text-sm font-semibold break-words text-amber-900">
        {heading}
      </p>
      {draft.kind === "FIELD" && (
        <div>
          <label htmlFor={`${idBase}-value`} className="mb-1 block text-sm font-medium text-slate-700">
            設定する値{field ? `（${field.unitLabel}）` : ""}
          </label>
          <input
            id={`${idBase}-value`}
            type="number"
            inputMode="decimal"
            className={cn(INPUT_CLASS, "h-11 sm:w-40")}
            value={draft.valueText}
            disabled={disabled}
            onChange={(e) => onOverrideChange({ ...draft, valueText: e.currentTarget.value })}
          />
        </div>
      )}
      <div>
        <label htmlFor={`${idBase}-reason`} className="mb-1 block text-sm font-medium text-slate-700">
          理由（必須）
        </label>
        <textarea
          id={`${idBase}-reason`}
          rows={3}
          className={INPUT_CLASS}
          value={draft.reason}
          disabled={disabled}
          onChange={(e) => onOverrideChange({ ...draft, reason: e.currentTarget.value })}
        />
        <p className="mt-1 text-xs text-slate-600">理由は記録として残ります。内容は保存時にも確認されます。</p>
      </div>
      <ConfirmationCheckbox
        id={`${idBase}-confirm-1`}
        label="通常の範囲の外にする理由と内容を確認しました"
        checked={draft.firstConfirmation}
        disabled={disabled}
        onChange={(checked) => onOverrideChange({ ...draft, firstConfirmation: checked })}
      />
      {doubleConfirmation && (
        <ConfirmationCheckbox
          id={`${idBase}-confirm-2`}
          label="選手の安全への影響をもう一度確認し、この内容で実施します"
          checked={draft.secondConfirmation}
          disabled={disabled}
          onChange={(checked) => onOverrideChange({ ...draft, secondConfirmation: checked })}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass("primary", "lg")}
          disabled={!canSubmit}
          onClick={() => {
            if (built.ok && onOverrideRequest) onOverrideRequest(built.request);
          }}
        >
          例外として保存
        </button>
        <button type="button" className={buttonClass("secondary", "lg")} disabled={disabled} onClick={() => onOverrideChange(null)}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

function FieldRow({ props, field, idBase }: { props: RunningItemEditorProps; field: EditableFieldDto; idBase: string }) {
  const { value, fieldDrafts, overrideState, disabled, onChange, onOverrideChange, onEditRequest } = props;
  const draft = fieldDrafts[field.keyInternal] ?? "";
  const built = buildFieldEditRequest(value.id, field, draft, requestConfirmedCodes(props));
  const canSubmit = !disabled && value.canEdit && onEditRequest !== undefined && built.ok;
  const inputId = `${idBase}-input`;
  const openOverride = overrideState?.kind === "FIELD" && overrideState.fieldInternal === field.keyInternal ? overrideState : null;
  const openLayer = openOverride ? field.overrideLayers.find((l) => l.layerInternal === openOverride.layerInternal) : undefined;

  return (
    <li className="min-w-0 rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium break-words text-slate-800">{field.label}</span>
        <span className="text-sm break-words text-slate-700">現在: {field.currentValueLabel}</span>
      </div>
      {field.readOnly && <p className="text-xs text-slate-500">表示のみ</p>}
      {field.originLabel !== null && <p className="text-xs text-slate-500">値の由来: {field.originLabel}</p>}
      {(field.recommended !== null || field.coachEditable !== null || field.hardSafety !== null) && (
        <dl className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-3">
          {field.recommended !== null && (
            <div>
              <dt className="font-medium text-slate-700">推奨範囲</dt>
              <dd>{field.recommended.label}</dd>
            </div>
          )}
          {field.coachEditable !== null && (
            <div>
              <dt className="font-medium text-slate-700">コーチ調整可能範囲</dt>
              <dd>{field.coachEditable.label}</dd>
            </div>
          )}
          {field.hardSafety !== null && (
            <div>
              <dt className="font-medium text-slate-700">安全上の範囲</dt>
              <dd>{field.hardSafety.label}</dd>
            </div>
          )}
        </dl>
      )}
      {field.editable ? (
        <div className="mt-2">
          <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-slate-700">
            新しい値（{field.unitLabel}）
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={inputId}
              type="number"
              inputMode="decimal"
              className={cn(INPUT_CLASS, "h-11 w-full sm:w-40")}
              value={draft}
              disabled={disabled || !value.canEdit}
              onChange={(e) => onChange(field.keyInternal, e.currentTarget.value)}
            />
            <button
              type="button"
              className={buttonClass("secondary", "lg")}
              disabled={!canSubmit}
              onClick={() => {
                if (built.ok && onEditRequest) onEditRequest(built.request);
              }}
            >
              この値で保存
            </button>
          </div>
          {draft.trim() !== "" && !built.ok && <p className="mt-1 text-xs text-rose-700">{built.message}</p>}
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-500">{field.notEditableReason}</p>
      )}
      {value.canEdit && !field.readOnly && field.overrideLayers.length > 0 && openOverride === null && (
        <div className="mt-2 flex flex-wrap gap-2">
          {field.overrideLayers.map((layer) => (
            <button
              key={layer.layerInternal}
              type="button"
              className={buttonClass("ghost", "lg", "border border-dashed border-slate-300")}
              disabled={disabled}
              onClick={() => onOverrideChange(emptyFieldOverride(field, layer))}
            >
              {layer.label}
            </button>
          ))}
        </div>
      )}
      {openOverride !== null && openLayer !== undefined && (
        <OverrideForm props={props} draft={openOverride} heading={`${field.label}：${openLayer.label}`} idBase={`${idBase}-override`} />
      )}
    </li>
  );
}

function EligibilityOverrideRow({ props, option, idBase }: { props: RunningItemEditorProps; option: EligibilityOverrideOptionDto; idBase: string }) {
  const { value, overrideState, disabled, onOverrideChange } = props;
  const open = overrideState?.kind === "ELIGIBILITY" && overrideState.ruleIdInternal === option.ruleIdInternal ? overrideState : null;
  return (
    <li className="min-w-0 rounded-lg border border-slate-200 p-3">
      <p className="text-sm break-words text-slate-800">{option.message}</p>
      {open === null ? (
        value.canEdit && (
          <button
            type="button"
            className={cn(buttonClass("ghost", "lg", "border border-dashed border-slate-300"), "mt-2")}
            disabled={disabled}
            onClick={() =>
              onOverrideChange({ kind: "ELIGIBILITY", ruleIdInternal: option.ruleIdInternal, reason: "", firstConfirmation: false, secondConfirmation: false })
            }
          >
            選択条件の例外として設定する
          </button>
        )
      ) : (
        <OverrideForm props={props} draft={open} heading="選択条件の例外として設定" idBase={`${idBase}-override`} />
      )}
    </li>
  );
}

export function RunningItemEditor(props: RunningItemEditorProps) {
  const { value, confirmationState, pendingConfirmationFindings = [], disabled, onConfirmationChange, onRecalculateRequest } = props;
  const idBase = `running-item-${value.id}`;
  const confirmation = { confirmedKeys: confirmationState.confirmedKeys, onChange: onConfirmationChange, disabled };

  return (
    <article className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-4 break-words" aria-labelledby={`${idBase}-title`}>
      <header className="min-w-0 space-y-1.5">
        <h3 id={`${idBase}-title`} className="text-base font-semibold break-words text-slate-900">
          {value.title}
        </h3>
        {value.subtitle !== null && <p className="text-xs text-slate-500">分類: {value.subtitle}</p>}
        <ConfidenceBadge confidence={value.confidence} />
        {value.needsCoachReview && <p className="text-xs font-medium text-indigo-800">コーチの確認が必要な内容があります。</p>}
      </header>

      <RunningDoseSummary dose={value.dose} />

      <FindingsList
        findings={pendingConfirmationFindings}
        idPrefix={`${idBase}-pending-confirmations`}
        heading="保存する前の確認"
        confirmation={confirmation}
      />
      <FindingsList findings={value.findings} idPrefix={`${idBase}-findings`} heading="この項目の確認事項" />
      <FindingsList findings={value.sessionFindings} idPrefix={`${idBase}-session-findings`} heading="練習全体の確認事項" />

      <section className="min-w-0 space-y-1">
        <h4 className="text-sm font-semibold text-slate-800">処方の根拠</h4>
        <p className="text-sm whitespace-pre-line break-words text-slate-700">{value.rationaleText}</p>
      </section>

      <section className="min-w-0 space-y-2">
        <h4 className="text-sm font-semibold text-slate-800">数値の調整</h4>
        {value.editUnavailableMessage !== null && <p className="text-xs text-slate-600">{value.editUnavailableMessage}</p>}
        <ul className="space-y-2">
          {value.editor.fields.map((field, index) => (
            <FieldRow key={field.keyInternal} props={props} field={field} idBase={`${idBase}-field-${index}`} />
          ))}
        </ul>
      </section>

      {value.editor.eligibilityOverrides.length > 0 && (
        <section className="min-w-0 space-y-2">
          <h4 className="text-sm font-semibold text-slate-800">選択条件</h4>
          <ul className="space-y-2">
            {value.editor.eligibilityOverrides.map((option, index) => (
              <EligibilityOverrideRow key={option.ruleIdInternal} props={props} option={option} idBase={`${idBase}-eligibility-${index}`} />
            ))}
          </ul>
        </section>
      )}

      <section className="min-w-0 space-y-1.5">
        <button
          type="button"
          className={buttonClass("secondary", "lg")}
          disabled={disabled || !value.canRecalculate || onRecalculateRequest === undefined}
          onClick={() => onRecalculateRequest?.(buildRecalculateRequest(value.id, requestConfirmedCodes(props)))}
        >
          現行ルールで再計算
        </button>
        <p className="text-xs text-slate-600">現行のルールで数値を計算し直します。以前の例外設定は引き継がれません。</p>
      </section>

      <details className="min-w-0 rounded-lg border border-slate-200">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-semibold text-slate-800">作成経緯と根拠</summary>
        <div className="border-t border-slate-100 px-3 py-3">
          <ProvenancePanel provenance={value.provenance} />
        </div>
      </details>
    </article>
  );
}
