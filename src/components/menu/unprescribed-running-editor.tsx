"use client";

import type { UnprescribedRunningItem } from "@/domain/menu-composition/unprescribed-running";
import { INPUT_CLASS } from "@/components/ui";

const NUMERIC_FIELDS = [
  ["plannedSets", "セット数", 1, 99, 1],
  ["plannedReps", "回数", 1, 999, 1],
  ["plannedDistanceMeters", "距離（m）", 1, 100000, "any"],
  ["plannedDurationSeconds", "1本の時間（秒）", 1, 86400, 1],
  ["plannedRestSeconds", "休息（秒）", 0, 86400, 1],
  ["plannedIntensityPercent", "強度（%）", 1, 100, 1],
] as const;

export function UnprescribedRunningEditor({
  item,
  onChange,
  disabled = false,
}: {
  item: UnprescribedRunningItem;
  onChange: (patch: Partial<UnprescribedRunningItem>) => void;
  disabled?: boolean;
}) {
  const hasManualNumber = NUMERIC_FIELDS.some(([name]) => item[name] !== null);
  return (
    <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/60 p-3" aria-label="未処方の走項目">
      <div>
        <h4 className="font-semibold text-slate-900">走・未処方</h4>
        <p className="mt-1 text-sm text-slate-700">{item.reasonMessage}</p>
        <p className="mt-1 text-xs text-amber-900">Engineの処方・推奨値はありません。必要な数値は手入力で確認してください。</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {NUMERIC_FIELDS.map(([name, label, min, max, step]) => (
          <label className="text-xs" key={name}>
            {label}
            <input
              aria-label={label}
              type="number"
              className={INPUT_CLASS}
              value={item[name] ?? ""}
              min={min}
              max={max}
              step={step}
              disabled={disabled}
              onChange={(event) => onChange({ [name]: event.target.value === "" ? null : Number(event.target.value) } as Partial<UnprescribedRunningItem>)}
            />
          </label>
        ))}
      </div>
      <label className="block text-xs">メモ
        <textarea
          aria-label="走項目のメモ"
          className={INPUT_CLASS}
          value={item.plannedNote}
          maxLength={1000}
          disabled={disabled}
          onChange={(event) => onChange({ plannedNote: event.target.value })}
        />
      </label>
      {hasManualNumber && <p className="rounded border border-amber-300 bg-white px-2 py-1.5 text-xs font-medium text-amber-900">手入力（Engine未処方）</p>}
    </section>
  );
}
