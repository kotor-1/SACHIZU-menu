"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Badge, INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { SessionExecutionPanel } from "@/components/running/session-execution-panel";
import {
  deleteSessionItemAction,
  toggleSessionItemAction,
  updateSessionItemAction,
} from "@/actions/session-actions";
import { formatPrescription } from "@/domain/shared/prescription";
import type { RunningSessionExecutionDto } from "@/presentation/running/session-execution";
import type { SessionItemRowDto } from "@/presentation/running/session-item";

const str = (v: number | null) => (v == null ? "" : String(v));

/**
 * 練習記録の 1 項目。
 *
 * planned*（メニューから写した計画値）は読み取り専用で表示し、
 * actual*（実際にやった値）だけを入力する。
 * 計画と実績が同じ行に並ぶので、ズレがそのまま振り返り材料になる。
 */
export function SessionItemRow({
  sessionId,
  item,
  index,
  runningExecution = null,
  runningExecutionUiEnabled = false,
}: {
  sessionId: string;
  item: SessionItemRowDto;
  index: number;
  runningExecution?: RunningSessionExecutionDto | null;
  runningExecutionUiEnabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(
    updateSessionItemAction.bind(null, sessionId, item.id),
    null,
  );

  const planned = item.runningSnapshot ? null : formatPrescription({
    sets: item.plannedSets,
    reps: item.plannedReps,
    distanceMeters: item.plannedDistanceMeters,
    durationSeconds: item.plannedDurationSeconds,
    restSeconds: item.plannedRestSeconds,
    intensityPercent: item.plannedIntensityPercent,
    loadKg: item.plannedLoadKg,
  });

  const actual = formatPrescription({
    sets: item.actualSets,
    reps: item.actualReps,
    distanceMeters: item.actualDistanceMeters,
    durationSeconds: item.actualDurationSeconds,
    loadKg: item.actualLoadKg,
  });

  const input = cn(INPUT_CLASS, "h-9 py-0");
  const useRunningExecutionUi = runningExecutionUiEnabled && runningExecution !== null;

  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2.5 transition-colors",
        item.done ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-white",
      )}
    >
      <div className="flex items-start gap-2.5">
        {!useRunningExecutionUi && <form action={toggleSessionItemAction} className="no-print">
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="itemId" value={item.id} />
          <button
            type="submit"
            title={item.done ? "未実施に戻す" : "実施済みにする"}
            className={cn(
              // 練習中もっとも繰り返しタップされる操作のため、他の補助ボタンより
              // 一回り大きくしてある（元は h-5 w-5 = 20px で、指では狙いにくかった）。
              "grid h-7 w-7 place-items-center rounded border text-sm transition-colors",
              item.done
                ? "border-emerald-500 bg-emerald-500 text-white"
                : "border-slate-300 bg-white text-transparent hover:border-emerald-400",
            )}
          >
            ✓
          </button>
        </form>}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-400">{index + 1}.</span>
            {item.exercise ? (
              <Link
                href={`/exercises/${item.exercise.id}`}
                className={cn(
                  "text-sm font-medium hover:underline",
                  item.done ? "text-emerald-900" : "text-slate-900",
                )}
              >
                {item.exerciseNameSnapshot}
              </Link>
            ) : (
              <span className="text-sm font-medium text-slate-900">
                {item.exerciseNameSnapshot}
              </span>
            )}
            {/* 参照先の種目が消えても、記録は名前のスナップショットで残る */}
            {!item.exercise && !item.runningSnapshot && (
              <Badge className="border-slate-200 bg-slate-50 text-slate-400">
                カタログ参照なし
              </Badge>
            )}
          </div>

          {planned && (
            <p className="mt-0.5 font-mono text-xs text-slate-500">計画 {planned}</p>
          )}
          {!item.runningSnapshot && item.plannedReps == null && item.plannedDistanceMeters == null && item.plannedDurationSeconds == null && <p className="mt-0.5 text-xs text-slate-500">計画 量未設定</p>}
          {item.runningSnapshot?.status === "OK" && (
            <div className="mt-0.5 text-xs text-slate-600">
              {item.runningSnapshot.restText && <p>{item.runningSnapshot.restText}</p>}
              {item.runningSnapshot.instruction && <p>{item.runningSnapshot.instruction}</p>}
              {item.runningSnapshot.targetTimeText && <p>{item.runningSnapshot.targetTimeText}</p>}
              {item.runningSnapshot.setText && <p>{item.runningSnapshot.setText}</p>}
              {item.runningSnapshot.coachEdited && <p className="text-xs text-slate-500">コーチ調整済み</p>}
            </div>
          )}
          {item.runningSnapshot?.status === "UNREADABLE" && (
            <p className="mt-0.5 text-xs text-rose-700">保存済みの走処方を読み込めません</p>
          )}
          {actual && (
            <p className="mt-0.5 font-mono text-xs font-medium text-emerald-700">
              実績 {actual}
            </p>
          )}
          {item.plannedNote && (
            <p className="mt-0.5 text-xs text-slate-500">{item.plannedNote}</p>
          )}
          {item.actualNote && (
            <p className="mt-1 rounded bg-white/70 px-2 py-1 text-xs text-slate-700">
              {item.actualNote}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 no-print">
          {!useRunningExecutionUi && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className={cn(buttonClass("ghost", "sm"), "px-2")}
            >
              {open ? "閉じる" : "記録"}
            </button>
          )}
          <form action={deleteSessionItemAction}>
            <input type="hidden" name="sessionId" value={sessionId} />
            <input type="hidden" name="itemId" value={item.id} />
            <ConfirmSubmitButton
              variant="ghost"
              size="sm"
              message={`「${item.exerciseNameSnapshot}」をこの記録から削除します。よろしいですか？`}
            >
              ✕
            </ConfirmSubmitButton>
          </form>
        </div>
      </div>

      {useRunningExecutionUi && runningExecution && (
        <SessionExecutionPanel sessionId={sessionId} execution={runningExecution} />
      )}

      {!useRunningExecutionUi && open && (
        <form
          action={formAction}
          className="mt-2.5 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5"
        >
          {state && !state.ok && (
            <p className="text-xs text-rose-700">{state.message}</p>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <label className="block">
              <span className="mb-0.5 block text-xs text-slate-500">セット</span>
              <input
                type="number"
                name="actualSets"
                defaultValue={str(item.actualSets)}
                placeholder={str(item.plannedSets)}
                min={0}
                className={input}
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-slate-500">回数</span>
              <input
                type="number"
                name="actualReps"
                defaultValue={str(item.actualReps)}
                placeholder={str(item.plannedReps)}
                min={0}
                className={input}
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-slate-500">距離(m)</span>
              <input
                type="number"
                name="actualDistanceMeters"
                defaultValue={str(item.actualDistanceMeters)}
                placeholder={str(item.plannedDistanceMeters)}
                min={0}
                step="any"
                className={input}
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-slate-500">時間(秒)</span>
              <input
                type="number"
                name="actualDurationSeconds"
                defaultValue={str(item.actualDurationSeconds)}
                placeholder={str(item.plannedDurationSeconds)}
                min={0}
                className={input}
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-slate-500">重量(kg)</span>
              <input
                type="number"
                name="actualLoadKg"
                defaultValue={str(item.actualLoadKg)}
                placeholder={str(item.plannedLoadKg)}
                min={0}
                step="any"
                className={input}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-0.5 block text-xs text-slate-500">メモ</span>
            <input
              name="actualNote"
              defaultValue={item.actualNote ?? ""}
              maxLength={1000}
              placeholder="3本目まで良好。4本目で上体が起きた。"
              className={input}
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            {/* 未チェックでも値を送るため、前に false を置く */}
            <input type="hidden" name="done" value="" />
            <input
              type="checkbox"
              name="done"
              value="true"
              defaultChecked={item.done}
              className="h-4 w-4 rounded border-slate-300 text-emerald-600"
            />
            実施済みにする
          </label>

          <div className="flex gap-2">
            <SubmitButton size="sm">記録する</SubmitButton>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={buttonClass("secondary", "sm")}
            >
              閉じる
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
