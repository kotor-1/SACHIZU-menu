"use client";

import { calculateMenuDuration, DURATION_PHASES, type DurationPlan, type MenuDurationSummary } from "@/domain/menu-composition/duration";
import type { EditableComposition } from "@/domain/menu-composition/contracts";
import type { RunningDurationInput } from "@/domain/menu-composition/duration";
import { INPUT_CLASS } from "@/components/ui";

const PHASE_LABEL: Record<(typeof DURATION_PHASES)[number], string> = {
  WARM_UP: "ウォームアップ",
  DRILLS_STRENGTH: "ドリル・補強",
  RUNNING: "走",
  COOL_DOWN: "クールダウン",
  OTHER: "その他",
};

const STATUS_LABEL: Record<MenuDurationSummary["status"], string> = {
  OVER_BUDGET: "目安時間を超えています",
  UNDERALLOCATED: "配分時間が不足しています",
  UNVERIFIED: "未確認の時間があります",
  MATCHES_REQUEST: "配分が目安時間に一致しています",
  NO_TARGET: "目安時間は未指定です",
};

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "未算出";
  const sign = seconds < 0 ? "−" : "";
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  if (minutes === 0) return `${sign}${remainder}秒`;
  return remainder === 0 ? `${sign}${minutes}分` : `${sign}${minutes}分${remainder}秒`;
}

function toSeconds(minutes: string): number | null {
  if (minutes.trim() === "") return null;
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 60);
}

function fromSeconds(seconds: number | null): string {
  return seconds === null ? "" : String(seconds / 60);
}

function normalizePlan(composition: EditableComposition, plan: DurationPlan): DurationPlan {
  const prior = new Map(plan.blocks.map((block) => [block.blockId, block]));
  return {
    blocks: composition.blocks.map((block) => prior.get(block.id) ?? {
      blockId: block.id,
      phase: "OTHER" as const,
      allocatedSeconds: null,
    }),
    transitionSeconds: plan.transitionSeconds,
  };
}

/**
 * A duration plan is an editable planning window only. It never changes item doses,
 * running prescriptions, or promises an exact physical session duration.
 */
export function MenuDurationEditor({
  composition,
  running,
  requestedSeconds,
  plan,
  onChange,
  disabled = false,
}: {
  composition: EditableComposition;
  running: RunningDurationInput;
  requestedSeconds: number | null;
  plan: DurationPlan;
  onChange: (plan: DurationPlan) => void;
  disabled?: boolean;
}) {
  const current = normalizePlan(composition, plan);
  const summary = calculateMenuDuration(composition, running, requestedSeconds, current);
  const allocationById = new Map(current.blocks.map((block) => [block.blockId, block]));
  const allocationsComplete = current.blocks.every((block) => block.allocatedSeconds !== null)
    && current.transitionSeconds !== null;
  const enteredAllocationSeconds = current.blocks.reduce((sum, block) => sum + (block.allocatedSeconds ?? 0), 0)
    + (current.transitionSeconds ?? 0);
  const allocationTotalLabel = allocationsComplete ? "配分合計" : "入力済み配分の小計";
  const phaseCoverage = DURATION_PHASES.map((phase) => {
    const rows = current.blocks.filter((block) => block.phase === phase);
    const allocatedCount = rows.filter((block) => block.allocatedSeconds !== null).length;
    const allocatedSeconds = rows.reduce((sum, block) => sum + (block.allocatedSeconds ?? 0), 0);
    return { phase, rows, allocatedCount, allocatedSeconds };
  });

  function changeBlock(blockId: string, patch: Partial<DurationPlan["blocks"][number]>) {
    onChange({
      ...current,
      blocks: current.blocks.map((block) => block.blockId === blockId ? { ...block, ...patch } : block),
    });
  }

  function changeTransition(value: string) {
    onChange({ ...current, transitionSeconds: toSeconds(value) });
  }

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="menu-duration-title">
      <div>
        <h2 id="menu-duration-title" className="text-sm font-semibold text-slate-900">時間配分（計画用）</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          ブロックごとの計画枠です。種目の処方・本数・休憩は変更せず、実際の所要時間を保証するものでもありません。
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-xs text-slate-500">希望時間</p>
          <p className="mt-1 text-sm font-semibold" data-testid="duration-requested">{formatSeconds(requestedSeconds)}</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-xs text-slate-500">計算できる運動・休息・移動準備の最低時間</p>
          <p className="mt-1 text-sm font-semibold" data-testid="duration-known-minimum">{formatSeconds(summary.knownMinimumSeconds)}</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-xs text-slate-500">{allocationTotalLabel}</p>
          <p className="mt-1 text-sm font-semibold" data-testid="duration-allocation-total">{formatSeconds(enteredAllocationSeconds)}</p>
        </div>
      </div>

      <p className="text-sm font-medium" data-testid="duration-status">{STATUS_LABEL[summary.status]}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-slate-700">
          ブロック間の移動・準備時間（分）
          <input
            type="number" min="0" max="1440" step="0.1" inputMode="decimal"
            aria-label="ブロック間の移動・準備時間（分）"
            className={INPUT_CLASS} value={fromSeconds(current.transitionSeconds)}
            disabled={disabled} onChange={(event) => changeTransition(event.target.value)}
          />
        </label>
        <div className="rounded-lg border border-slate-100 p-3 text-xs text-slate-600">
          {summary.plannedTotalSeconds === null ? (
            <p>配分合計は未確定です。作業量・休息・時間配分の未入力項目を確認してください。</p>
          ) : (
            <>
              <p>計画合計：<strong>{formatSeconds(summary.plannedTotalSeconds)}</strong></p>
              <p className="mt-1">
                {summary.budgetDifferenceSeconds === null ? (
                  <>希望との差：<strong>目安時間は未指定です</strong></>
                ) : (
                  <>希望との差：<strong>{summary.budgetDifferenceSeconds > 0 ? "+" : ""}{formatSeconds(summary.budgetDifferenceSeconds)}</strong>
                    {summary.budgetDifferenceSeconds > 0 ? "（超過）" : summary.budgetDifferenceSeconds < 0 ? "（残り）" : "（一致）"}</>
                )}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {composition.blocks.map((block, index) => {
          const allocation = allocationById.get(block.id)!;
          const measured = summary.blocks[index]!;
          return (
            <div key={block.id} className="grid gap-2 rounded-lg border border-slate-100 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <p className="self-center truncate text-sm font-medium text-slate-800">{block.name}</p>
              <label className="block text-xs text-slate-700">
                分類
                <select
                  aria-label={`${block.name}の時間分類`}
                  className={INPUT_CLASS} value={allocation.phase}
                  disabled={disabled}
                  onChange={(event) => changeBlock(block.id, { phase: event.target.value as DurationPlan["blocks"][number]["phase"] })}
                >
                  {DURATION_PHASES.map((phase) => <option key={phase} value={phase}>{PHASE_LABEL[phase]}</option>)}
                </select>
              </label>
              <label className="block text-xs text-slate-700">
                配分（分）
                <input
                  type="number" min="0" max="1440" step="0.1" inputMode="decimal"
                  aria-label={`${block.name}の配分（分）`}
                  className={INPUT_CLASS} value={fromSeconds(allocation.allocatedSeconds)}
                  disabled={disabled} onChange={(event) => changeBlock(block.id, { allocatedSeconds: toSeconds(event.target.value) })}
                />
              </label>
              <div className="text-xs text-slate-600 sm:col-span-3">
                <span>既知の最低時間：{formatSeconds(measured.knownMinimumSeconds)}</span>
                {measured.underallocated && <p className="mt-1 font-medium text-rose-700">配分が既知の最低時間を下回っています。</p>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-lg border border-slate-100 p-3 text-xs text-slate-600" aria-label="フェーズの配分状況">
        {phaseCoverage.map(({ phase, rows, allocatedCount, allocatedSeconds }) => (
          <p key={phase}>
            {PHASE_LABEL[phase]}：{rows.length === 0
              ? "未割当（必要性を確認。ブロックや配分を自動追加しません。）"
              : allocatedCount < rows.length
                ? `一部未割当（${allocatedCount}/${rows.length}ブロック、入力済み合計 ${formatSeconds(allocatedSeconds)}）`
                : `${formatSeconds(allocatedSeconds)} 配分済み`}
          </p>
        ))}
      </div>

      {summary.unknownComponents.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3" role="status">
          <p className="text-xs font-semibold text-amber-900">時間を確定できない項目</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-900">
            {summary.unknownComponents.map((unknown, index) => (
              <li key={`${unknown.blockId}:${unknown.itemId ?? ""}:${unknown.component}:${index}`}>
                {unknown.blockId ? `${composition.blocks.find((block) => block.id === unknown.blockId)?.name ?? "対象外ブロック"}：` : "準備："}{unknown.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
