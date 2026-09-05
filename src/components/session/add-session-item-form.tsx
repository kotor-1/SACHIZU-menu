"use client";

import { useState } from "react";
import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { addSessionItemAction } from "@/actions/session-actions";
import {
  EXERCISE_CATEGORY_LABEL,
  type ExerciseCategory,
} from "@/domain/exercise/constants";
import type { ExercisePickerItem } from "@/infra/repositories/exercise-repository";

/** 当日その場で足した種目を記録へ追加する（テンプレートには影響しない）。 */
export function AddSessionItemForm({
  sessionId,
  exercises,
  blockNames,
}: {
  sessionId: string;
  exercises: ExercisePickerItem[];
  blockNames: string[];
}) {
  const [open, setOpen] = useState(false);

  const grouped = exercises.reduce<Record<string, ExercisePickerItem[]>>((acc, ex) => {
    (acc[ex.category] ??= []).push(ex);
    return acc;
  }, {});

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(buttonClass("secondary", "sm"), "w-full border-dashed no-print")}
      >
        ＋ その場で種目を追加
      </button>
    );
  }

  const input = cn(INPUT_CLASS, "h-9 py-0");

  return (
    <form
      action={addSessionItemAction}
      className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 no-print"
    >
      <input type="hidden" name="sessionId" value={sessionId} />

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-0.5 block text-xs text-slate-500">種目から選ぶ</span>
          <select name="exerciseId" defaultValue="" className={input}>
            <option value="">（選択しない）</option>
            {Object.entries(grouped).map(([category, list]) => (
              <optgroup
                key={category}
                label={EXERCISE_CATEGORY_LABEL[category as ExerciseCategory] ?? category}
              >
                {list.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-xs text-slate-500">または自由入力</span>
          <input name="name" maxLength={160} placeholder="補強サーキット" className={input} />
        </label>

        <label className="block">
          <span className="mb-0.5 block text-xs text-slate-500">ブロック</span>
          <input
            name="blockName"
            list="session-block-names"
            defaultValue={blockNames[blockNames.length - 1] ?? "追加"}
            maxLength={80}
            className={input}
          />
          <datalist id="session-block-names">
            {blockNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="flex gap-2">
        <SubmitButton size="sm">追加する</SubmitButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={buttonClass("secondary", "sm")}
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}
