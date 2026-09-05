"use client";

import { useActionState, useState } from "react";
import { Field, INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { addBlockAction } from "@/actions/menu-actions";

export function AddBlockForm({ menuId }: { menuId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(addBlockAction.bind(null, menuId), null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(buttonClass("secondary", "md"), "w-full border-dashed no-print")}
      >
        ＋ ブロックを追加
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 no-print"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ブロック名" required errors={errors.name}>
          <input
            name="name"
            required
            maxLength={80}
            placeholder="例：主運動"
            className={cn(INPUT_CLASS, "h-9 py-0")}
          />
        </Field>
        <Field label="備考" errors={errors.note}>
          <input
            name="note"
            maxLength={1000}
            className={cn(INPUT_CLASS, "h-9 py-0")}
          />
        </Field>
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
