"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RunningSessionExecutionDto } from "@/presentation/running/session-execution";
import { MonitorBanner } from "./monitor-banner";
import { ReadinessForm } from "./readiness-form";
import { RepLogger } from "./rep-logger";
import { RuntimeCoachReviewPanel } from "./runtime-coach-review-panel";

type MutationKind = "READINESS" | "REP" | "ACK" | "REFRESH";

export function SessionExecutionPanel({
  sessionId,
  execution,
}: {
  sessionId: string;
  execution: RunningSessionExecutionDto;
}) {
  const router = useRouter();
  const lockRef = useRef(false);
  const refreshObservedRef = useRef(false);
  const [pending, setPending] = useState<MutationKind | null>(null);
  const [isRefreshing, startRefresh] = useTransition();

  useEffect(() => {
    if (pending !== "REFRESH") return;
    if (isRefreshing) {
      refreshObservedRef.current = true;
      return;
    }
    if (refreshObservedRef.current) {
      refreshObservedRef.current = false;
      lockRef.current = false;
      setPending(null);
    }
  }, [isRefreshing, pending]);

  function beginMutation(kind: MutationKind): boolean {
    if (lockRef.current) return false;
    lockRef.current = true;
    setPending(kind);
    return true;
  }

  function finishMutation(refresh: boolean) {
    if (refresh) {
      setPending("REFRESH");
      startRefresh(() => router.refresh());
      return;
    }
    lockRef.current = false;
    setPending(null);
  }

  const busy = pending !== null;
  const versionKey = [
    execution.execution.state,
    execution.readiness.state,
    execution.progress.completedRepCount,
    execution.pendingCoachReview?.reviewIdentity.stopPolicyId ?? "none",
    execution.pendingCoachReview?.reviewIdentity.setIndex ?? "none",
    execution.pendingCoachReview?.reviewIdentity.repIndex ?? "none",
  ].join(":");

  return (
    <div className="mt-3 min-w-0 space-y-3 border-t border-slate-200 pt-3" data-running-execution-ui="true">
      <MonitorBanner execution={execution} />

      {execution.capabilities.canAcknowledgeCoachReview && execution.pendingCoachReview && (
        <RuntimeCoachReviewPanel
          key={`ack-${versionKey}`}
          sessionItemId={execution.sessionItemId}
          review={execution.pendingCoachReview}
          busy={busy}
          beginMutation={() => beginMutation("ACK")}
          finishMutation={finishMutation}
        />
      )}

      {execution.capabilities.canSubmitReadiness && (
        <section className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
          <ReadinessForm
            key={`readiness-${versionKey}`}
            sessionId={sessionId}
            busy={busy}
            beginMutation={() => beginMutation("READINESS")}
            finishMutation={finishMutation}
          />
        </section>
      )}

      {execution.capabilities.canRecordRep && (
        <section className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
          <RepLogger
            key={`rep-${versionKey}`}
            sessionItemId={execution.sessionItemId}
            busy={busy}
            beginMutation={() => beginMutation("REP")}
            finishMutation={finishMutation}
          />
        </section>
      )}

      {!execution.capabilities.canRecordRep
        && !execution.capabilities.canSubmitReadiness
        && !execution.capabilities.canAcknowledgeCoachReview && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            現在の保存済み状態では、この項目に対する入力操作はできません。
          </p>
        )}
    </div>
  );
}
