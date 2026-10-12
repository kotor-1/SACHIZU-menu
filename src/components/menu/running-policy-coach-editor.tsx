"use client";

import { useState, useTransition } from "react";
import { Button, INPUT_CLASS } from "@/components/ui";
import type { RunningCoachEditRequest } from "@/application/running-menu/coach-edit";
import type { RunningMenuFinalPrescription } from "@/application/running-menu/persistence";

export type CoachEditDraft = RunningCoachEditRequest;
export type CoachEditInitial = RunningMenuFinalPrescription;

const DISTANCES = [30, 50, 60, 100, 120, 150, 200, 250, 300] as const;
function minutesToSeconds(value: string): number | null {
  if (value.trim() === "") return null;
  const seconds = Number(value) * 60;
  return Number.isFinite(seconds) && Math.abs(seconds - Math.round(seconds)) < 1e-7
    ? Math.round(seconds) : Number.NaN;
}

export type CoachEditSubmitResult = { ok: true } | { ok: false; message: string };

/** Sends an explicit Coach edit request; only the server can accept numeric values. */
export function RunningPolicyCoachEditor({ initial, onSubmit, proposalSafety = false }: {
  initial: RunningMenuFinalPrescription;
  onSubmit: (edit: RunningCoachEditRequest) => Promise<CoachEditSubmitResult>;
  /** Structured proposals retain the signed distance, intensity and set structure. */
  proposalSafety?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [distance, setDistance] = useState(String(initial.distanceMeters));
  const [reps, setReps] = useState(String(initial.totalReps));
  const [restMinutes, setRepRestMinutes] = useState(initial.repRestSeconds === null ? "" : String(initial.repRestSeconds / 60));
  const [instruction, setInstruction] = useState(initial.executionInstructionText ?? "");
  const [target, setTarget] = useState(initial.coachTargetTimeSeconds === null ? "" : String(initial.coachTargetTimeSeconds));
  const [targetMin, setTargetMin] = useState(initial.coachTargetTimeRange === null ? "" : String(initial.coachTargetTimeRange.minSeconds));
  const [targetMax, setTargetMax] = useState(initial.coachTargetTimeRange === null ? "" : String(initial.coachTargetTimeRange.maxSeconds));
  const [setRepsText, setSetRepsText] = useState(initial.setReps?.join(",") ?? "");
  const [setRestMinutes, setSetRestMinutes] = useState(initial.setRestSeconds === null ? "" : String(initial.setRestSeconds / 60));
  const distanceChanged = Number(distance) !== initial.distanceMeters;
  const distances: readonly number[] = DISTANCES.some(value => value === initial.distanceMeters) ? DISTANCES : [initial.distanceMeters, ...DISTANCES];

  function changeDistance(value: string) {
    setDistance(value);
    setReps(String(initial.totalReps));
    setRepRestMinutes(initial.repRestSeconds === null ? "" : String(initial.repRestSeconds / 60));
    setTarget(""); setTargetMin(""); setTargetMax("");
    setSetRepsText(""); setSetRestMinutes("");
  }

  function submit() {
    const edit: RunningCoachEditRequest = {};
    const distanceNumber = Number(distance);
    const repsNumber = Number(reps);
    const restSeconds = minutesToSeconds(restMinutes);
    if (!distances.includes(distanceNumber)) return setError("この距離は標準処方の対象外です。");
    if (!Number.isInteger(repsNumber) || repsNumber < 1) return setError("本数を確認してください。");
    if (restSeconds !== null && (!Number.isInteger(restSeconds) || restSeconds < 1)) return setError("休憩時間を確認してください。");
    if (proposalSafety && (distanceNumber !== initial.distanceMeters || repsNumber > initial.totalReps
      || initial.setReps !== null && repsNumber !== initial.totalReps
      || initial.repRestSeconds !== null && (restSeconds === null || restSeconds < initial.repRestSeconds))) {
      return setError("この提案では本数の削減と休息の延長だけを調整できます。分割済みのセット構造は変更できません。");
    }
    if (distanceNumber !== initial.distanceMeters) edit.distanceMeters = distanceNumber;
    if (repsNumber !== initial.totalReps) edit.totalReps = repsNumber;
    if (restSeconds !== initial.repRestSeconds && restSeconds !== null) edit.repRestSeconds = restSeconds;
    if (!proposalSafety && instruction.trim() !== (initial.executionInstructionText ?? "")) edit.executionInstructionText = instruction.trim() || null;
    if (target.trim() && (targetMin.trim() || targetMax.trim())) return setError("目標タイムは単一値か範囲のどちらかを指定してください。");
    const targetNumber = target.trim() ? Number(target) : null;
    const range = targetMin.trim() || targetMax.trim()
      ? { minSeconds: Number(targetMin), maxSeconds: Number(targetMax) } : null;
    if (!proposalSafety && targetNumber !== initial.coachTargetTimeSeconds) edit.coachTargetTimeSeconds = targetNumber;
    if (!proposalSafety && JSON.stringify(range) !== JSON.stringify(initial.coachTargetTimeRange)) edit.coachTargetTimeRange = range;
    if (!proposalSafety && setRepsText.trim() !== (initial.setReps?.join(",") ?? "")) {
      edit.setReps = setRepsText.trim() === "" ? null : setRepsText.split(",").map((value) => Number(value.trim()));
    }
    const setRestSeconds = minutesToSeconds(setRestMinutes);
    if (proposalSafety && initial.setRestSeconds !== null && (setRestSeconds === null || !Number.isInteger(setRestSeconds) || setRestSeconds < initial.setRestSeconds)) {
      return setError("セット間休息は元の処方以上にしてください。");
    }
    if (setRestSeconds !== initial.setRestSeconds) edit.setRestSeconds = setRestSeconds;
    if (Object.keys(edit).length === 0) return setError("変更する項目を入力してください。");
    setError(null);
    startTransition(async () => {
      const result = await onSubmit(edit);
      if (!result.ok) setError(result.message);
      else setOpen(false);
    });
  }

  if (!open) return <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>コーチ調整</Button>;
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 no-print">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">距離
          <select className={INPUT_CLASS} value={distance} onChange={(e) => changeDistance(e.target.value)} disabled={pending || proposalSafety}>
            {distances.map((value) => <option key={value} value={value}>{value}m</option>)}
          </select>
        </label>
        <label className="text-xs">総本数<input type="number" min="1" max={proposalSafety ? initial.totalReps : undefined} className={INPUT_CLASS} value={reps} onChange={(e) => setReps(e.target.value)} disabled={pending || distanceChanged || proposalSafety && initial.setReps !== null} /></label>
        <label className="text-xs">1本ごとの休憩（分）<input type="number" min={proposalSafety && initial.repRestSeconds !== null ? initial.repRestSeconds / 60 : 0} step="0.1" className={INPUT_CLASS} value={restMinutes} onChange={(e) => setRepRestMinutes(e.target.value)} disabled={pending || distanceChanged || proposalSafety && initial.repRestSeconds === null} /></label>
        {!proposalSafety && <>
        <label className="text-xs">目標タイム（秒）<input type="number" min="0" step="0.01" className={INPUT_CLASS} value={target} onChange={(e) => setTarget(e.target.value)} disabled={pending} /></label>
        <label className="text-xs">目標範囲・最短（秒）<input type="number" min="0" step="0.01" className={INPUT_CLASS} value={targetMin} onChange={(e) => setTargetMin(e.target.value)} disabled={pending} /></label>
        <label className="text-xs">目標範囲・最長（秒）<input type="number" min="0" step="0.01" className={INPUT_CLASS} value={targetMax} onChange={(e) => setTargetMax(e.target.value)} disabled={pending} /></label>
        <label className="text-xs">セット分割（例：3,2）<input className={INPUT_CLASS} value={setRepsText} onChange={(e) => setSetRepsText(e.target.value)} disabled={pending} /></label>
        </>}
        {(!proposalSafety || initial.setRestSeconds !== null) && <label className="text-xs">セット間休憩（分）<input type="number" min={proposalSafety && initial.setRestSeconds !== null ? initial.setRestSeconds / 60 : 0} step="0.1" className={INPUT_CLASS} value={setRestMinutes} onChange={(e) => setSetRestMinutes(e.target.value)} disabled={pending} /></label>}
      </div>
      {proposalSafety && <p className="text-xs leading-relaxed text-slate-600">この提案では本数の削減と休息の延長を調整できます。距離・強度・セット構造を変える場合は、練習条件を見直してください。{initial.setReps !== null && "分割済みのセットでは本数も固定です。"}</p>}
      {distanceChanged && <p className="text-xs text-slate-600">距離変更後の本数・休憩は新距離の標準値で再計算します。必要な追加調整は再計算後に行えます。目標タイムとセット分割は引き継ぎません。</p>}
      <p className="text-xs text-slate-500">セット間休憩は、前セット最後の走から次セット最初の走までの総時間です。</p>
      {!proposalSafety && <label className="block text-xs">実行指示<textarea className={INPUT_CLASS} value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={300} disabled={pending} /></label>}
      {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
      <div className="flex gap-2"><Button type="button" size="sm" disabled={pending} onClick={submit}>調整を反映</Button><Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setOpen(false)}>閉じる</Button></div>
    </div>
  );
}
