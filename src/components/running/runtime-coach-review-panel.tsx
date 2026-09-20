"use client";

import { useEffect, useRef, useState } from "react";
import { acknowledgeRuntimeCoachReviewAction } from "@/actions/session-actions";
import { Button } from "@/components/ui";
import type { RunningSessionExecutionDto } from "@/presentation/running/session-execution";

type PendingReview = NonNullable<RunningSessionExecutionDto["pendingCoachReview"]>;

export function RuntimeCoachReviewPanel({
  sessionItemId,
  review,
  busy,
  beginMutation,
  finishMutation,
}: {
  sessionItemId: string;
  review: PendingReview;
  busy: boolean;
  beginMutation: () => boolean;
  finishMutation: (refresh: boolean) => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (message !== null) resultRef.current?.focus();
  }, [message]);

  async function acknowledge() {
    if (!beginMutation()) return;
    setMessage(null);
    try {
      const result = await acknowledgeRuntimeCoachReviewAction({
        sessionItemId,
        reviewIdentity: review.reviewIdentity,
      });
      if (result.ok) {
        setError(false);
        setMessage(result.kind === "ALREADY_ACKNOWLEDGED"
          ? "この判定はすでに確認済みです。最新の状態を読み込みます。"
          : "判定内容を確認しました。最新の状態を読み込みます。");
      } else {
        setError(true);
        setMessage(result.message);
      }
      finishMutation(true);
    } catch {
      setError(true);
      setMessage("送信を完了できませんでした。通信状態を確認して、もう一度お試しください。");
      finishMutation(false);
    }
  }

  return (
    <section className="min-w-0 rounded-xl border border-amber-300 bg-amber-50 p-3 break-words sm:p-4" aria-labelledby={`runtime-review-${sessionItemId}`}>
      <h4 id={`runtime-review-${sessionItemId}`} className="text-sm font-semibold text-amber-950">{review.title}</h4>
      <p className="mt-1 text-sm leading-relaxed text-amber-900">{review.message}</p>
      <p className="mt-1 text-xs text-amber-800">{review.occurredAtRep.setIndex}セット・{review.occurredAtRep.repIndex}本目の判定です。</p>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">
        この操作は判定内容を確認して次の入力を再開するためのものです。安全性や医学的な解決を意味しません。
      </p>
      <Button type="button" size="lg" className="mt-3 min-h-11 w-full sm:w-auto" disabled={busy} onClick={acknowledge}>
        {busy ? "確認を保存中…" : "内容を確認して次へ進む"}
      </Button>
      {message && (
        <p ref={resultRef} tabIndex={-1} aria-live="polite" className={`mt-3 rounded-lg px-3 py-2 text-sm outline-none ${error ? "bg-rose-100 text-rose-800" : "bg-emerald-50 text-emerald-800"}`}>
          {message}
        </p>
      )}
    </section>
  );
}
