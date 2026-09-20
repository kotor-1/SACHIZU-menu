import { Badge, cn } from "@/components/ui";
import type { RunningSessionExecutionDto } from "@/presentation/running/session-execution";

function stateTone(dto: RunningSessionExecutionDto): string {
  if (dto.execution.state === "UNREADABLE" || dto.execution.terminalKindInternal === "STOP_SAFETY") {
    return "border-rose-200 bg-rose-50";
  }
  if (dto.execution.state === "COACH_REVIEW_ACK_REQUIRED") return "border-amber-300 bg-amber-50";
  if (dto.execution.state === "TERMINAL" || dto.execution.state === "END_SET") return "border-slate-300 bg-slate-50";
  return "border-indigo-200 bg-indigo-50/50";
}

export function MonitorBanner({ execution }: { execution: RunningSessionExecutionDto }) {
  const latest = execution.latestMonitor;
  return (
    <section
      className={cn("min-w-0 space-y-3 rounded-xl border p-3 break-words sm:p-4", stateTone(execution))}
      aria-labelledby={`execution-state-${execution.sessionItemId}`}
      role={execution.execution.terminalKindInternal === "STOP_SAFETY" ? "alert" : undefined}
    >
      <div>
        <p className="text-xs font-medium text-slate-500">現在の実施状態</p>
        <h4 id={`execution-state-${execution.sessionItemId}`} className="mt-0.5 text-sm font-semibold text-slate-900">
          {execution.execution.message}
        </h4>
      </div>

      <div className="grid min-w-0 gap-2 text-sm sm:grid-cols-2 [&>*]:min-w-0">
        <div className="rounded-lg bg-white/80 p-2.5">
          <p className="text-xs text-slate-500">実施前の体調確認</p>
          <p className="mt-0.5 font-medium text-slate-800">{execution.readiness.message}</p>
          {execution.readiness.actions.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
              {execution.readiness.actions.map((action) => <li key={action.codeInternal}>{action.label}</li>)}
            </ul>
          )}
        </div>
        <div className="rounded-lg bg-white/80 p-2.5">
          <p className="text-xs text-slate-500">実施本数</p>
          <p className="mt-0.5 font-medium text-slate-800">{execution.progress.label}</p>
          <p className="mt-1 text-xs text-slate-500">本数の完遂と品質判定は別の記録です。</p>
        </div>
      </div>

      {latest && (
        <div className="min-w-0 rounded-lg border border-white/80 bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-slate-500">最新保存済みの実施中判定</p>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">{latest.actionLabel}</p>
            </div>
            <Badge>{latest.setIndex}セット・{latest.repIndex}本目</Badge>
          </div>
          <dl className="mt-2 grid min-w-0 gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-2 [&>*]:min-w-0">
            <div className="flex gap-2"><dt>品質</dt><dd className="font-medium text-slate-800">{latest.qualityLabel}</dd></div>
            <div className="flex gap-2"><dt>計時</dt><dd className="font-medium text-slate-800">{latest.timingLabel}</dd></div>
            {latest.timeLabel && <div className="flex gap-2"><dt>タイム</dt><dd className="font-medium text-slate-800">{latest.timeLabel}</dd></div>}
            {latest.restTakenLabel && <div className="flex gap-2"><dt>休息</dt><dd className="font-medium text-slate-800">{latest.restTakenLabel}</dd></div>}
          </dl>
          {latest.reasons.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-slate-600">判定理由</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
                {latest.reasons.map((reason, index) => <li key={`${reason.codeInternal}-${index}`} className="break-words">{reason.label}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{latest.nextRepRestMessage}</p>
        </div>
      )}

      <div className="grid min-w-0 gap-2 text-xs sm:grid-cols-2 [&>*]:min-w-0">
        <div className="rounded-lg bg-white/80 p-2.5">
          <p className="font-medium text-slate-600">高速走行量</p>
          {execution.exposure.state === "READY" ? (
            <p className="mt-1 text-slate-800">
              {execution.exposure.valueLabel ?? "値を確認できません"}・{execution.exposure.sourceLabel}・{execution.exposure.confidenceLabel}
            </p>
          ) : <p className="mt-1 text-slate-600">{execution.exposure.message}</p>}
        </div>
        <div className="rounded-lg bg-white/80 p-2.5">
          <p className="font-medium text-slate-600">安全対応の記録</p>
          {execution.safety.state === "READY" ? (
            <><p className="mt-1 font-medium text-slate-800">{execution.safety.label}</p><p className="mt-1 leading-relaxed text-slate-500">{execution.safety.lifecycleNote}</p></>
          ) : <p className="mt-1 text-slate-600">{execution.safety.message}</p>}
        </div>
      </div>
    </section>
  );
}
