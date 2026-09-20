"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { deleteCompetitionAction } from "@/actions/competition-actions";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";

export function CompetitionDeleteForm({ competitionId, competitionName }: { competitionId: string; competitionName: string }) {
  const router = useRouter();
  const [state, formAction] = useActionState(deleteCompetitionAction, null);
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state === null) return;
    if (state.ok && state.kind === "DELETED") {
      router.push("/competitions");
      return;
    }
    resultRef.current?.focus();
  }, [router, state]);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="competitionId" value={competitionId} />
      <ConfirmSubmitButton
        size="lg"
        className="min-h-11 w-full sm:w-auto"
        message={`「${competitionName}」を削除します。過去の練習記録は残ります。よろしいですか？`}
      >
        大会を削除
      </ConfirmSubmitButton>
      {state && !state.ok && (
        <p ref={resultRef} tabIndex={-1} aria-live="polite" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 outline-none">
          {state.message}
        </p>
      )}
    </form>
  );
}
