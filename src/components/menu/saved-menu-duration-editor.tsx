"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, INPUT_CLASS } from "@/components/ui";
import { MenuDurationEditor } from "./menu-duration-editor";
import type { EditableComposition } from "@/domain/menu-composition/contracts";
import type { DurationPlan, RunningDurationInput } from "@/domain/menu-composition/duration";
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
  function save() {
    setMessage("");
    start(async () => {
      const result = await saveMenuDurationAction({ menuId: props.menuId, sourceFingerprint: props.sourceFingerprint,
        requestedSeconds: requested, plan: { ...plan, blocks: plan.blocks.filter(row => props.composition.blocks.some(block => block.id === row.blockId)) } });
      if (result.ok) { setMessage("時間配分を保存しました。"); router.refresh(); }
      else setMessage(result.code === "DURATION_UNDERSIZED_SLOT" ? "必要な実施・休息時間より短い配分があります。" : "保存できませんでした。再読込して時間配分を確認してください。");
    });
  }
  return <section className="mb-4 space-y-3 rounded-xl border bg-white p-4">
    <label className="block text-sm">希望時間（分）<input type="number" min={1} max={10080} step={1} className={INPUT_CLASS} disabled={pending} value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
    <MenuDurationEditor composition={props.composition} running={props.running} requestedSeconds={requested} plan={plan} onChange={setPlan} disabled={pending} />
    <Button type="button" disabled={pending} onClick={save}>時間配分を保存</Button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
