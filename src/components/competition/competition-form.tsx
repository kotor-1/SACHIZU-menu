"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { CompetitionActionResult } from "@/actions/competition-actions";
import { Card, CardBody, Field, INPUT_CLASS, buttonClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { COMPETITION_PRIORITY_OPTIONS } from "@/presentation/running/competition";

export type CompetitionFormValues = {
  name: string;
  date: string;
  endDate: string;
  priority: string;
  note: string;
};

export const EMPTY_COMPETITION_FORM: CompetitionFormValues = {
  name: "",
  date: "",
  endDate: "",
  priority: "NORMAL",
  note: "",
};

type CompetitionFormAction = (
  previous: CompetitionActionResult | null,
  formData: FormData,
) => Promise<CompetitionActionResult>;

export function CompetitionForm({
  action,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: CompetitionFormAction;
  initial: CompetitionFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(action, null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  useEffect(() => {
    if (state === null) return;
    resultRef.current?.focus();
    if (state.ok && state.kind === "CREATED") router.push(`/competitions/${state.data.id}`);
    if (state.ok && state.kind === "UPDATED") router.refresh();
  }, [router, state]);

  return (
    <form action={formAction} className="min-w-0 space-y-4">
      {state && (
        <p
          ref={resultRef}
          tabIndex={-1}
          aria-live="polite"
          className={`rounded-lg border px-3 py-2 text-sm outline-none ${state.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}
        >
          {state.message}
        </p>
      )}

      <Card>
        <CardBody className="min-w-0 space-y-4">
          <Field label="大会名" required errors={errors.name}>
            <input
              name="name"
              defaultValue={initial.name}
              required
              maxLength={120}
              autoComplete="off"
              className={`${INPUT_CLASS} min-h-11`}
              placeholder="例：県選手権"
            />
          </Field>

          <div className="grid min-w-0 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <Field label="開始日" required errors={errors.date}>
              <input name="date" type="date" defaultValue={initial.date} required className={`${INPUT_CLASS} min-h-11`} />
            </Field>
            <Field label="終了日" hint="単日大会は空欄" errors={errors.endDate}>
              <input name="endDate" type="date" defaultValue={initial.endDate} className={`${INPUT_CLASS} min-h-11`} />
            </Field>
          </div>

          <Field label="大会の優先度" required errors={errors.priority}>
            <select name="priority" defaultValue={initial.priority} className={`${INPUT_CLASS} min-h-11`}>
              {COMPETITION_PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>

          <Field label="メモ" hint="1000文字まで" errors={errors.note}>
            <textarea
              name="note"
              defaultValue={initial.note}
              rows={4}
              maxLength={1000}
              className={INPUT_CLASS}
              placeholder="集合時間や申込状況など"
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SubmitButton size="lg" className="min-h-11 w-full sm:w-auto" pendingLabel="保存中…">
          {submitLabel}
        </SubmitButton>
        <Link href={cancelHref} className={buttonClass("secondary", "lg", "min-h-11 w-full sm:w-auto")}>
          キャンセル
        </Link>
      </div>
    </form>
  );
}
