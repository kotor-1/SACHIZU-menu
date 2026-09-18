/**
 * Running Prescription Engine v2 — R10-B3 editor の controlled state → B4 で Action へ渡すリクエスト（純粋関数）。
 *
 * client component から使うため、domain の schema を import しない（型だけ）。
 * ここで行うのは「入力欄の文字列を数値として読めるか」「必須の入力・確認がそろっているか」という
 * 入力の完成度チェックだけ。範囲・安全上限・reason の最小文字数などの最終検証は domain（Action 経由）が行う。
 */
import type {
  EditableFieldDto,
  FindingPresentationDto,
  OverrideDraft,
  RunningFieldEditRequest,
  RunningItemEditorDto,
  RunningOverrideRequest,
  RunningRecalculateRequest,
} from "./dto";

export type RequestBuildResult<T> = { ok: true; request: T } | { ok: false; message: string };

export function parseNumberInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * [R10-B4A] リクエストに載せる確認済み code。**直前の Action 結果（CONFIRMATION_REQUIRED / STALE）で示された、
 * いま画面にある確認対象の Finding だけ**から取る（以前の結果の確認や任意の文字列を送らない）。
 * 最終的な照合（現在の plan 結果との一致・stale 検出）は server が行う。
 */
export function confirmedCodesForRequest(pendingFindings: readonly FindingPresentationDto[], confirmedKeys: readonly string[]): string[] {
  const pending = new Set(pendingFindings.filter((f) => f.requiresExplicitConfirmation).map((f) => f.confirmationKey));
  return [...new Set(confirmedKeys)].filter((key) => pending.has(key));
}

export function buildFieldEditRequest(
  itemId: string,
  field: EditableFieldDto,
  text: string,
  confirmedFindingCodes: readonly string[] = [],
): RequestBuildResult<RunningFieldEditRequest> {
  if (field.readOnly || !field.editable) return { ok: false, message: field.notEditableReason ?? "この項目は変更できません。" };
  const value = parseNumberInput(text);
  if (value === null) return { ok: false, message: "数値を入力してください。" };
  return {
    ok: true,
    request: { itemId, field: field.keyInternal, value, displayedFromValue: field.currentValue, confirmedFindingCodes: [...confirmedFindingCodes] },
  };
}

export function buildRecalculateRequest(itemId: string, confirmedFindingCodes: readonly string[] = []): RunningRecalculateRequest {
  return { itemId, confirmedFindingCodes: [...confirmedFindingCodes] };
}

/** 下書きの対象に二重確認が必要か（DTO に載っている domain 由来の値だけを見る）。 */
export function overrideDraftRequiresDoubleConfirmation(draft: OverrideDraft, editor: RunningItemEditorDto): boolean {
  if (draft.kind === "FIELD") {
    const field = editor.fields.find((f) => f.keyInternal === draft.fieldInternal);
    return field?.overrideLayers.find((l) => l.layerInternal === draft.layerInternal)?.requiresDoubleConfirmation ?? true;
  }
  return editor.eligibilityOverrides.find((o) => o.ruleIdInternal === draft.ruleIdInternal)?.requiresDoubleConfirmation ?? true;
}

export function buildOverrideRequest(
  itemId: string,
  draft: OverrideDraft,
  editor: RunningItemEditorDto,
  confirmedFindingCodes: readonly string[] = [],
): RequestBuildResult<RunningOverrideRequest> {
  const doubleConfirmation = overrideDraftRequiresDoubleConfirmation(draft, editor);
  if (draft.reason.trim() === "") return { ok: false, message: "理由を入力してください。" };
  if (!draft.firstConfirmation || (doubleConfirmation && !draft.secondConfirmation)) {
    return { ok: false, message: "確認の項目にチェックしてください。" };
  }
  const confirmedTwice = doubleConfirmation && draft.firstConfirmation && draft.secondConfirmation;

  if (draft.kind === "ELIGIBILITY") {
    const option = editor.eligibilityOverrides.find((o) => o.ruleIdInternal === draft.ruleIdInternal);
    if (!option) return { ok: false, message: "この条件は例外設定の対象ではありません。" };
    return {
      ok: true,
      request: { itemId, kind: "ELIGIBILITY", ruleId: draft.ruleIdInternal, reason: draft.reason.trim(), confirmedTwice, confirmedFindingCodes: [...confirmedFindingCodes] },
    };
  }

  const field = editor.fields.find((f) => f.keyInternal === draft.fieldInternal);
  if (!field || field.readOnly || !field.overrideLayers.some((l) => l.layerInternal === draft.layerInternal)) {
    return { ok: false, message: "この項目は例外設定の対象ではありません。" };
  }
  const newValue = parseNumberInput(draft.valueText);
  if (newValue === null) return { ok: false, message: "数値を入力してください。" };
  return {
    ok: true,
    request: {
      itemId,
      kind: "FIELD",
      field: draft.fieldInternal,
      layer: draft.layerInternal,
      newValue,
      reason: draft.reason.trim(),
      confirmedTwice,
      confirmedFindingCodes: [...confirmedFindingCodes],
    },
  };
}
