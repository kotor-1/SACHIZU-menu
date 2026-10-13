"use client";

import { useEffect, useState } from "react";

/**
 * How long a proposal usually takes. Real Luna sends under the current contract took 10.7–18.5 seconds
 * (2026-10-12/13), and the App's own work adds well under a second. The countdown starts a little above
 * that range, so it usually ends early rather than late.
 */
export const PROPOSAL_WAIT_DEFAULT_SECONDS = 20;
/** The Luna request gives up after 45 seconds, and the App's own proposal is shown instead. */
export const PROPOSAL_WAIT_LIMIT_SECONDS = 50;

/** A wait of 3 seconds or more was spent on the AI. Quicker answers (nothing to choose from, AI unavailable) say nothing about the next one. */
export function proposalWaitSample(seconds: number): boolean {
  return seconds >= 3 && seconds <= PROPOSAL_WAIT_LIMIT_SECONDS;
}

/** The next countdown: the median of the waits seen on this screen plus 2 seconds, or the usual time before the first. */
export function proposalWaitEstimate(samples: readonly number[]): number {
  const usable = samples.filter(proposalWaitSample).sort((a, b) => a - b);
  if (!usable.length) return PROPOSAL_WAIT_DEFAULT_SECONDS;
  const half = Math.floor(usable.length / 2);
  const median = usable.length % 2 ? usable[half] : (usable[half - 1] + usable[half]) / 2;
  return Math.min(Math.max(Math.ceil(median + 2), 8), 45);
}

/** 残り秒数とバー。目安を過ぎてもバーは満タンにせず、遅れているときだけ短い説明を足す。 */
export function ProposalWaitView({ elapsedSeconds, estimateSeconds }: { elapsedSeconds: number; estimateSeconds: number }) {
  const remaining = Math.ceil(estimateSeconds - elapsedSeconds);
  const progress = elapsedSeconds < estimateSeconds ? 90 * elapsedSeconds / estimateSeconds
    : 90 + 9 * (1 - Math.exp(-(elapsedSeconds - estimateSeconds) / 15));
  const note = elapsedSeconds >= PROPOSAL_WAIT_LIMIT_SECONDS ? "通信に時間がかかっています。このままお待ちください。"
    : elapsedSeconds >= Math.max(estimateSeconds + 10, 30) ? `AIの返事が遅れています。長くても${PROPOSAL_WAIT_LIMIT_SECONDS}秒ほどで表示します。` : null;
  return <div className="border-t-2 border-slate-900 bg-white px-4 py-3">
    <p role="status" className="sr-only">{note ?? `提案を作成しています。${estimateSeconds}秒ほどかかります。`}</p>
    <div aria-hidden="true">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-800">提案を作成しています</p>
        <p className="text-sm font-semibold text-slate-800 tabular-nums">
          {remaining > 0 ? <>あと約<span className="mx-1 text-2xl font-extrabold text-slate-900">{remaining}</span>秒</> : "まもなく完成します"}
        </p>
      </div>
      <div className="mt-1 h-2 bg-slate-200">
        <div className="h-full bg-indigo-600 transition-[width] duration-300 ease-linear motion-reduce:transition-none" style={{ width: `${progress.toFixed(1)}%` }} />
      </div>
      {note && <p className="mt-2 text-xs leading-relaxed text-slate-600">{note}</p>}
    </div>
  </div>;
}

/** 押した時刻から数える。画面を離れて戻っても、実際の経過時間で表示する。 */
export function ProposalWaitStatus({ startedAt, estimateSeconds }: { startedAt: number; estimateSeconds: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return <ProposalWaitView elapsedSeconds={Math.max(0, (now - startedAt) / 1000)} estimateSeconds={estimateSeconds} />;
}
