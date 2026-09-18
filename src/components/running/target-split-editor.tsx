"use client";

import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import type { TargetSplitSegmentDraft } from "@/presentation/running/dto";

/**
 * [R10-B4A.2] コーチが入力する目標スプリットの編集（完全な controlled component）。
 *
 * LONG（ロングスプリント）は強度の基準が無いと計画できないため、コーチが区間ごとの距離と目標タイムを入力する。
 * 自動入力はしない（練習の型の名前から距離を埋めない・記録や年齢から目標タイムを作らない）。
 * Server Action は import しない。値の検証（正の数値・区間が1つ以上）は `buildTargetSplitInput()`、
 * どの練習の型で使えるか・値の妥当性は domain が判定する。
 */
export type TargetSplitEditorProps = {
  idPrefix: string;
  segments: readonly TargetSplitSegmentDraft[];
  onChange: (next: TargetSplitSegmentDraft[]) => void;
  disabled?: boolean;
  /** 入力の不足（`buildTargetSplitInput()` の結果）を表示する。 */
  errorMessage?: string | null;
  heading?: string;
  description?: string;
};

export function TargetSplitEditor({
  idPrefix,
  segments,
  onChange,
  disabled,
  errorMessage = null,
  heading = "コーチ設定の目標スプリット",
  description = "区間ごとの距離と目標タイムを入力してください（自動では入力しません）。",
}: TargetSplitEditorProps) {
  const update = (index: number, patch: Partial<TargetSplitSegmentDraft>) =>
    onChange(segments.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-semibold text-slate-800">{heading}</legend>
      <p className="text-xs text-slate-600">{description}</p>
      {segments.length === 0 ? (
        <p className="text-sm text-slate-500">区間がまだありません。</p>
      ) : (
        <ol className="space-y-2">
          {segments.map((segment, index) => {
            const distanceId = `${idPrefix}-distance-${index}`;
            const timeId = `${idPrefix}-time-${index}`;
            return (
              <li key={index} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                <div className="min-w-0">
                  <label htmlFor={distanceId} className="mb-1 block text-xs font-medium text-slate-700">
                    区間{index + 1}の距離（m）
                  </label>
                  <input
                    id={distanceId}
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min="0"
                    className={cn(INPUT_CLASS, "h-11 w-full")}
                    value={segment.distanceText}
                    disabled={disabled}
                    onChange={(e) => update(index, { distanceText: e.currentTarget.value })}
                  />
                </div>
                <div className="min-w-0">
                  <label htmlFor={timeId} className="mb-1 block text-xs font-medium text-slate-700">
                    区間{index + 1}の目標タイム（秒）
                  </label>
                  <input
                    id={timeId}
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min="0"
                    className={cn(INPUT_CLASS, "h-11 w-full")}
                    value={segment.targetTimeText}
                    disabled={disabled}
                    onChange={(e) => update(index, { targetTimeText: e.currentTarget.value })}
                  />
                </div>
                <button
                  type="button"
                  aria-label={`区間${index + 1}を削除`}
                  className={buttonClass("secondary", "lg", "min-w-11")}
                  disabled={disabled}
                  onClick={() => onChange(segments.filter((_, i) => i !== index))}
                >
                  削除
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass("secondary", "lg")}
          disabled={disabled}
          onClick={() => onChange([...segments, { distanceText: "", targetTimeText: "" }])}
        >
          区間を追加
        </button>
      </div>
      {errorMessage !== null && (
        <p role="alert" className="text-xs break-words text-rose-700">
          {errorMessage}
        </p>
      )}
    </fieldset>
  );
}
