"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Field, INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import {
  EXERCISE_CATEGORY_LABEL,
  type ExerciseCategory,
  type MetricType,
} from "@/domain/exercise/constants";
import type { TrainingPhase } from "@/domain/menu/constants";
import {
  suggestPrescription,
  type PrescriptionSuggestion,
} from "@/domain/prescription/calculate";
import {
  ATHLETE_LEVEL_LABEL,
  BASELINE_LEVEL,
} from "@/domain/prescription/constants";
import {
  LEGACY_RUNNING_SUGGESTION_NOTICE_JA,
  isRunningExerciseForV2,
} from "@/presentation/running/legacy-routing";
import type { ExercisePickerItem } from "@/infra/repositories/exercise-repository";
import type { ActionResult } from "@/domain/shared/result";

export type MenuItemFormValues = {
  exerciseId: string;
  displayName: string;
  sets: string;
  reps: string;
  distanceMeters: string;
  durationSeconds: string;
  restSeconds: string;
  intensityPercent: string;
  loadKg: string;
  note: string;
};

export const EMPTY_MENU_ITEM_FORM: MenuItemFormValues = {
  exerciseId: "",
  displayName: "",
  sets: "",
  reps: "",
  distanceMeters: "",
  durationSeconds: "",
  restSeconds: "",
  intensityPercent: "",
  loadKg: "",
  note: "",
};

type Action = (
  prev: ActionResult<null> | null,
  formData: FormData,
) => Promise<ActionResult<null>>;

/**
 * メニュー内の 1 項目（＝処方）の入力フォーム。
 *
 * 種目を選ぶと、その種目の「推奨負荷」を初期値として流し込む。
 * ただし入った後は自由に上書きできる ——
 * これが Exercise（種目の知識）と MenuItem（このメニューでの処方）を
 * 分けている意味が、画面上で一番はっきり出る場所。
 */
export function MenuItemForm({
  action,
  exercises,
  initial = EMPTY_MENU_ITEM_FORM,
  submitLabel,
  onCancel,
  onSuccess,
  resetOnSuccess = false,
  compact = false,
  phase = null,
  runningV2Enabled = false,
  runningPolicyContext = false,
}: {
  action: Action;
  exercises: ExercisePickerItem[];
  initial?: MenuItemFormValues;
  submitLabel: string;
  onCancel?: () => void;
  /** 保存が成功したとき（編集フォームを閉じる用途）。 */
  onSuccess?: () => void;
  /** 連続入力できるよう、追加成功後に入力欄を空へ戻す。 */
  resetOnSuccess?: boolean;
  compact?: boolean;
  /** このメニューの期分け。推奨処方の計算に使う。 */
  phase?: TrainingPhase | null;
  /**
   * [R10-B4B] Running v2 が有効か（既定は false ＝ B4B 前とまったく同じ表示・操作）。
   * true のとき、走系の種目では legacy の「推奨処方を入れる」を出さず、走トレーニングの導線を案内する。
   */
  runningV2Enabled?: boolean;
  /** New policy menus must not expose the generic legacy Running recommendation. */
  runningPolicyContext?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const [values, setValues] = useState<MenuItemFormValues>(initial);
  const [suggestion, setSuggestion] = useState<PrescriptionSuggestion | null>(
    null,
  );

  // 追加が通ったら入力欄を空へ戻し、連続で登録できるようにする。
  // state は成功のたびに新しいオブジェクトになるので、これを変化の合図に使う。
  // （効果ではなくレンダー中に自分の state を直すのが React 推奨のやり方）
  const [ackedState, setAckedState] = useState<unknown>(null);
  if (state?.ok && ackedState !== state) {
    setAckedState(state);
    if (resetOnSuccess) setValues(EMPTY_MENU_ITEM_FORM);
  }

  // 保存後にフォームを閉じるのは親の状態なので、こちらは効果で伝える。
  const notified = useRef<unknown>(null);
  useEffect(() => {
    if (!state?.ok || notified.current === state) return;
    notified.current = state;
    onSuccess?.();
  }, [state, onSuccess]);

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const selected = exercises.find((e) => e.id === values.exerciseId);
  const metric = (selected?.metricType ?? "REPS") as MetricType;

  // [R10-B4B] 走系かどうかは既存の分類（classify）で決める。種目名の一覧をここで持たない。
  const routedToRunningV2 =
    (runningV2Enabled || runningPolicyContext) &&
    selected !== undefined &&
    isRunningExerciseForV2({
      category: selected.category,
      energySystem: selected.energySystem,
      difficulty: selected.difficulty,
      targets: selected.targets.map((t) => t.target),
    });

  /** 種目を選び直したら、その種目の推奨値でフォームを埋め直す。 */
  function pickExercise(id: string) {
    setSuggestion(null);
    const ex = exercises.find((e) => e.id === id);
    if (!ex) {
      setValues((v) => ({ ...v, exerciseId: "" }));
      return;
    }
    if (runningPolicyContext) {
      setValues((v) => ({ ...v, exerciseId: id, displayName: "", sets: "", reps: "", distanceMeters: "", durationSeconds: "", restSeconds: "" }));
      return;
    }
    const str = (n: number | null) => (n == null ? "" : String(n));
    setValues((v) => ({
      ...v,
      exerciseId: id,
      displayName: "",
      sets: str(ex.defaultSets),
      reps: str(ex.defaultReps),
      distanceMeters: str(ex.defaultDistanceMeters),
      durationSeconds: str(ex.defaultDurationSeconds),
      restSeconds: str(ex.defaultRestSeconds),
    }));
  }

  /**
   * 処方エンジンの推奨値を入れる。
   *
   * 押したときだけ動かす（種目を選んだ瞬間に自動で入れない）のは、
   * コーチが手で入れた数字を勝手に書き換えないため。
   * note は触らない ―― あそこはコーチ自身の指示欄なので、根拠はこの下に表示するだけ。
   */
  function applySuggestion() {
    if (!selected) return;
    const s = suggestPrescription(
      {
        category: selected.category,
        energySystem: selected.energySystem,
        difficulty: selected.difficulty,
        metricType: selected.metricType,
        targets: selected.targets.map((t) => t.target),
        defaultSets: selected.defaultSets,
        defaultReps: selected.defaultReps,
        defaultDistanceMeters: selected.defaultDistanceMeters,
        defaultDurationSeconds: selected.defaultDurationSeconds,
        defaultRestSeconds: selected.defaultRestSeconds,
      },
      { phase, level: BASELINE_LEVEL },
    );
    const str = (n: number | null | undefined) => (n == null ? "" : String(n));
    setValues((v) => ({
      ...v,
      sets: str(s.prescription.sets),
      reps: str(s.prescription.reps),
      distanceMeters: str(s.prescription.distanceMeters),
      durationSeconds: str(s.prescription.durationSeconds),
      restSeconds: str(s.prescription.restSeconds),
      intensityPercent: str(s.prescription.intensityPercent),
    }));
    setSuggestion(s);
  }

  const set = (key: keyof MenuItemFormValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  // カテゴリごとにまとめると 25 件以上でも選びやすい
  const grouped = exercises.reduce<Record<string, ExercisePickerItem[]>>((acc, ex) => {
    (acc[ex.category] ??= []).push(ex);
    return acc;
  }, {});

  const numberInput = "h-9 " + INPUT_CLASS;

  return (
    <form
      action={formAction}
      className={cn(
        "space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3",
        compact && "text-sm",
      )}
    >
      {state && !state.ok && (
        <p className="rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
          {state.message}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="種目" errors={errors.exerciseId}>
          <select
            name="exerciseId"
            value={values.exerciseId}
            onChange={(e) => pickExercise(e.target.value)}
            className={cn(INPUT_CLASS, "h-9 py-0")}
          >
            <option value="">（カタログから選ぶ）</option>
            {Object.entries(grouped).map(([category, list]) => (
              <optgroup
                key={category}
                label={EXERCISE_CATEGORY_LABEL[category as ExerciseCategory] ?? category}
              >
                {list.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        <Field
          label="項目名"
          hint="カタログにないものはこちら"
          errors={errors.displayName}
        >
          <input
            name="displayName"
            value={values.displayName}
            onChange={set("displayName")}
            placeholder="例：3km ジョグ"
            maxLength={160}
            disabled={Boolean(values.exerciseId)}
            className={cn(INPUT_CLASS, "h-9 py-0 disabled:bg-slate-100 disabled:text-slate-400")}
          />
        </Field>
      </div>

      {selected && routedToRunningV2 && (
        <p className="rounded border border-indigo-200 bg-white px-2.5 py-2 text-xs leading-relaxed text-slate-600">
          {runningPolicyContext ? "走の距離・本数・休憩は走の確認済み処方とコーチ調整で設定してください。" : LEGACY_RUNNING_SUGGESTION_NOTICE_JA}
        </p>
      )}

      {selected && !routedToRunningV2 && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={applySuggestion}
            className={buttonClass("secondary", "sm")}
          >
            推奨処方を入れる
          </button>
          {suggestion && (
            <div className="rounded border border-slate-200 bg-white px-2.5 py-2 text-xs leading-relaxed text-slate-600">
              <p className="mb-1 font-medium text-slate-700">
                根拠（{ATHLETE_LEVEL_LABEL[BASELINE_LEVEL]}想定
                {suggestion.setRestSeconds != null && "・セット間は下記参照"}）
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                {suggestion.rationale.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              {suggestion.warnings.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-rose-700">
                  {suggestion.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="セット" errors={errors.sets}>
          <input
            type="number"
            name="sets"
            value={values.sets}
            onChange={set("sets")}
            min={1}
            className={numberInput}
          />
        </Field>

        {(metric === "REPS" || values.reps !== "") && (
          <Field label="回数" errors={errors.reps}>
            <input
              type="number"
              name="reps"
              value={values.reps}
              onChange={set("reps")}
              min={1}
              className={numberInput}
            />
          </Field>
        )}
        {(metric === "DISTANCE" || values.distanceMeters !== "") && (
          <Field label="距離(m)" errors={errors.distanceMeters}>
            <input
              type="number"
              name="distanceMeters"
              value={values.distanceMeters}
              onChange={set("distanceMeters")}
              min={1}
              step="any"
              className={numberInput}
            />
          </Field>
        )}
        {(metric === "TIME" || values.durationSeconds !== "") && (
          <Field label="時間(秒)" errors={errors.durationSeconds}>
            <input
              type="number"
              name="durationSeconds"
              value={values.durationSeconds}
              onChange={set("durationSeconds")}
              min={1}
              className={numberInput}
            />
          </Field>
        )}

        <Field label="レスト(秒)" errors={errors.restSeconds}>
          <input
            type="number"
            name="restSeconds"
            value={values.restSeconds}
            onChange={set("restSeconds")}
            min={0}
            className={numberInput}
          />
        </Field>

        <Field label="強度(%)" errors={errors.intensityPercent}>
          <input
            type="number"
            name="intensityPercent"
            value={values.intensityPercent}
            onChange={set("intensityPercent")}
            min={1}
            max={200}
            className={numberInput}
          />
        </Field>

        <Field label="重量(kg)" errors={errors.loadKg}>
          <input
            type="number"
            name="loadKg"
            value={values.loadKg}
            onChange={set("loadKg")}
            min={0}
            step="any"
            className={numberInput}
          />
        </Field>
      </div>

      {/* 表示していない単位も値を落とさず送る */}
      {metric !== "REPS" && values.reps === "" && (
        <input type="hidden" name="reps" value="" />
      )}
      {metric !== "DISTANCE" && values.distanceMeters === "" && (
        <input type="hidden" name="distanceMeters" value="" />
      )}
      {metric !== "TIME" && values.durationSeconds === "" && (
        <input type="hidden" name="durationSeconds" value="" />
      )}

      <Field label="この項目への指示" errors={errors.note}>
        <input
          name="note"
          value={values.note}
          onChange={set("note")}
          maxLength={1000}
          placeholder="設定 18.5 秒。落ちたら打ち切り。"
          className={cn(INPUT_CLASS, "h-9 py-0")}
        />
      </Field>

      <div className="flex items-center gap-2">
        <SubmitButton size="sm" pendingLabel="保存中…">
          {submitLabel}
        </SubmitButton>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className={buttonClass("secondary", "sm")}
          >
            キャンセル
          </button>
        )}
      </div>
    </form>
  );
}
