"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, INPUT_CLASS } from "@/components/ui";
import { MenuDurationEditor } from "./menu-duration-editor";
import type { EditableComposition } from "@/domain/menu-composition/contracts";
import { calculateMenuDuration, type DurationPlan, type RunningDurationInput } from "@/domain/menu-composition/duration";
import { saveMenuDurationAction } from "@/actions/menu-duration-actions";

export function SavedMenuDurationEditor(props: {
  menuId: string; sourceFingerprint: string; composition: EditableComposition;
  running: RunningDurationInput; requestedSeconds: number | null; plan: DurationPlan;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [minutes, setMinutes] = useState(props.requestedSeconds === null ? "" : String(props.requestedSeconds / 60));
  const [plan, setPlan] = useState(props.plan);
  const [message, setMessage] = useState("");
  const requested = minutes === "" ? null : Math.round(Number(minutes) * 60);
  const summary = calculateMenuDuration(props.composition, props.running, requested, plan);
  const hasStaleEstimate = summary.planIssues.some((issue) => issue.code === "STALE_BASIS");
  const allocatedBlocks = summary.blocks.filter((block) => block.allocatedSeconds !== null).length;
  const allocatedBlockSeconds = summary.blocks.reduce((sum, block) => sum + (block.allocatedSeconds ?? 0), 0);
  function save() {
    setMessage("");
    start(async () => {
      const result = await saveMenuDurationAction({ menuId: props.menuId, sourceFingerprint: props.sourceFingerprint,
        requestedSeconds: requested, plan: { ...plan, blocks: plan.blocks.filter(row => props.composition.blocks.some(block => block.id === row.blockId)) } });
      if (result.ok) { setMessage("時間配分を保存しました。"); router.refresh(); }
      else setMessage(result.code === "DURATION_UNDERSIZED_SLOT" ? "必要な実施・休息時間より短い配分があります。" : "保存できませんでした。再読込して時間配分を確認してください。");
    });
  }
  return <section className="mb-4 rounded-xl border bg-white p-4">
    <details>
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
        <span><strong>時間配分を調整</strong><span className="ml-2 text-xs text-slate-500">計画用・実測時間ではありません</span></span>
        <span className="text-sm text-slate-700" data-testid="saved-duration-summary">
          {summary.plannedTotalSeconds === null ? allocatedBlocks > 0 ? `部分配分 ${Math.floor(allocatedBlockSeconds / 60)}分${allocatedBlockSeconds % 60 ? `${allocatedBlockSeconds % 60}秒` : ""}` : "配分合計は未算出" : `${hasStaleEstimate ? "旧配分" : "計画枠"} ${Math.floor(summary.plannedTotalSeconds / 60)}分${summary.plannedTotalSeconds % 60 ? `${summary.plannedTotalSeconds % 60}秒` : ""}`}
          {summary.plannedTotalSeconds === null && <span className="block text-xs text-amber-800">ブロック配分 {allocatedBlocks}/{summary.blocks.length}・移動準備 {plan.transitionSeconds === null ? "未設定" : "入力済み"}。時間未確定 {summary.unknownComponents.length}件</span>}
          <span className="block text-xs text-slate-700" data-testid="duration-planning-status" data-status={summary.planningStatus}>{hasStaleEstimate ? "内容変更前の見積もりは無効です。再見積もりが必要です。" : summary.planningStatus === "ACCOUNTED_FOR" ? "配分内訳の合計は一致（計画上の推定・要確認）" : "時間配分の内訳は要確認"}</span>
          {summary.plannedTotalSeconds !== null && summary.unknownComponents.length > 0 && <span className="block text-xs text-amber-800">時間未確定 {summary.unknownComponents.length}件</span>}
        </span>
      </summary>
      <div className="space-y-3 pt-3">
        <label className="block text-sm">希望時間（分）<input type="number" min={1} max={10080} step={1} className={INPUT_CLASS} disabled={pending} value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
        <MenuDurationEditor composition={props.composition} running={props.running} requestedSeconds={requested} plan={plan} onChange={setPlan} disabled={pending} />
        <Button type="button" disabled={pending} onClick={save}>時間配分を保存</Button>
        {message && <p role="status" className="text-sm">{message}</p>}
      </div>
    </details>
  </section>;
}
