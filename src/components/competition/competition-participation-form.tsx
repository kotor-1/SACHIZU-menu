"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import type { CompetitionParticipationActionResult } from "@/actions/competition-actions";
import { Field, INPUT_CLASS } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { COMPETITION_LOAD_CATEGORY_LABEL_JA } from "@/presentation/running/competition";

type ParticipationAction = (
  previous: CompetitionParticipationActionResult | null,
  formData: FormData,
) => Promise<CompetitionParticipationActionResult>;

export function CompetitionParticipationForm({
  action,
  competitionId,
  startDate,
  endDate,
  latestRecordableDate,
}: {
  action: ParticipationAction;
  competitionId: string;
  startDate: string;
  endDate: string;
  latestRecordableDate: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(action, null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const singleDay = startDate === endDate;
  const maximum = endDate < latestRecordableDate ? endDate : latestRecordableDate;
  const canRecordByDate = startDate <= latestRecordableDate;

  useEffect(() => {
    if (state === null) return;
    resultRef.current?.focus();
    if (state.ok) router.refresh();
  }, [router, state]);

  return (
    <form action={formAction} className="min-w-0 space-y-4">
      <input type="hidden" name="competitionId" value={competitionId} />
      {state && (
        <p
          ref={resultRef}
          tabIndex={-1}
          aria-live="polite"
          className={`rounded-lg border px-3 py-2 text-sm outline-none ${state.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}
        >
          {state.message}
          {state.ok && <Link className="ml-2 font-medium underline" href={`/sessions/${state.data.sessionId}`}>実績を見る</Link>}
        </p>
      )}

      <Field label="開催日" required errors={state && !state.ok ? state.fieldErrors?.date : undefined}>
        <input
          name="date"
          type="date"
          defaultValue={startDate}
          min={startDate}
          max={maximum}
          disabled={!canRecordByDate}
          readOnly={singleDay}
          required
          className={`${INPUT_CLASS} min-h-11`}
        />
      </Field>

      <fieldset className="min-w-0 space-y-2" aria-describedby={`${id}-category-help`}>
        <legend className="text-sm font-medium text-slate-700">参加種別 <span aria-hidden="true" className="text-rose-500">*</span></legend>
        <p id={`${id}-category-help`} className="text-xs leading-relaxed text-slate-500">この日に出場した種別を1つ以上選択してください。混合日は両方を選べます。</p>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {(["RACE", "RELAY"] as const).map((category) => (
            <label key={category} className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus-within:ring-2 focus-within:ring-indigo-500">
              <input type="checkbox" name="loadCategories" value={category} className="size-5 shrink-0" />
              <span>{COMPETITION_LOAD_CATEGORY_LABEL_JA[category]}</span>
            </label>
          ))}
        </div>
        {state && !state.ok && state.fieldErrors?.loadCategories?.map((error) => <p key={error} className="text-xs text-rose-600">{error}</p>)}
      </fieldset>

      {!canRecordByDate && <p className="text-sm text-slate-600">開催日以降に大会実績を記録できます。</p>}
      <SubmitButton size="lg" className="min-h-11 w-full sm:w-auto" pendingLabel="記録中…" disabled={!canRecordByDate}>大会実績を記録</SubmitButton>
      <p className="text-xs leading-relaxed text-slate-500">これは大会予定の追加ではなく、実際に出場した日の記録です。内容の訂正は既存記録を削除してから再登録します。</p>
    </form>
  );
}
