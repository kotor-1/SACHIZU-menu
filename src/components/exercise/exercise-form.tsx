"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader, Field, INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import {
  DIFFICULTY_LABEL,
  DIFFICULTY_LEVELS,
  EXERCISE_CATEGORIES,
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_PURPOSES,
  EXERCISE_PURPOSE_LABEL,
  METRIC_TYPES,
  METRIC_TYPE_LABEL,
  TRACK_FIELD_EVENTS,
  TRACK_FIELD_EVENT_LABEL,
  TRAINING_TARGETS,
  TRAINING_TARGET_LABEL,
  type MetricType,
} from "@/domain/exercise/constants";
import { REVIEW_STATUSES, REVIEW_STATUS_LABEL } from "@/domain/shared/constants";
import type { ActionResult } from "@/domain/shared/result";

export type ExerciseFormValues = {
  id?: string;
  name: string;
  nameKana: string;
  description: string;
  coachingPoint: string;
  commonMistake: string;
  category: string;
  metricType: string;
  difficulty: number;
  defaultSets: string;
  defaultReps: string;
  defaultDistanceMeters: string;
  defaultDurationSeconds: string;
  defaultRestSeconds: string;
  videoUrl: string;
  source: string;
  status: string;
  targets: string[];
  purposes: string[];
  events: string[];
  generalTags: string;
  equipmentTags: string;
  bodyPartTags: string;
};

export const EMPTY_EXERCISE_FORM: ExerciseFormValues = {
  name: "",
  nameKana: "",
  description: "",
  coachingPoint: "",
  commonMistake: "",
  category: "DRILL",
  metricType: "REPS",
  difficulty: 3,
  defaultSets: "",
  defaultReps: "",
  defaultDistanceMeters: "",
  defaultDurationSeconds: "",
  defaultRestSeconds: "",
  videoUrl: "",
  source: "MANUAL",
  status: "REVIEWED",
  targets: [],
  purposes: [],
  events: [],
  generalTags: "",
  equipmentTags: "",
  bodyPartTags: "",
};

type Action = (
  prev: ActionResult<{ id: string }> | null,
  formData: FormData,
) => Promise<ActionResult<{ id: string }>>;

export function ExerciseForm({
  action,
  initial,
  submitLabel,
  cancelHref,
  draftId,
}: {
  action: Action;
  initial: ExerciseFormValues;
  submitLabel: string;
  cancelHref: string;
  /** AI 下書きから開いた場合の下書き ID。登録に成功したら APPLIED にする。 */
  draftId?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  // 負荷入力欄を metricType で出し分けるため、ここだけクライアント状態を持つ
  const [metric, setMetric] = useState<MetricType>(initial.metricType as MetricType);

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const selectClass = cn(INPUT_CLASS, "h-10 py-0");

  return (
    <form action={formAction} className="space-y-4">
      {draftId && <input type="hidden" name="draftId" value={draftId} />}
      {state && !state.ok && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {state.message}
        </p>
      )}
      {state?.ok && state.message && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {state.message}
        </p>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-700">基本情報</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="種目名" required errors={errors.name}>
              <input
                name="name"
                defaultValue={initial.name}
                required
                maxLength={120}
                placeholder="例：Aスキップ"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="よみがな" hint="並び替え・検索用" errors={errors.nameKana}>
              <input
                name="nameKana"
                defaultValue={initial.nameKana}
                maxLength={120}
                placeholder="えーすきっぷ"
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="カテゴリ" required errors={errors.category}>
              <select name="category" defaultValue={initial.category} className={selectClass}>
                {EXERCISE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {EXERCISE_CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="負荷の測り方" errors={errors.metricType}>
              <select
                name="metricType"
                value={metric}
                onChange={(e) => setMetric(e.target.value as MetricType)}
                className={selectClass}
              >
                {METRIC_TYPES.map((m) => (
                  <option key={m} value={m}>
                    {METRIC_TYPE_LABEL[m]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="難易度" errors={errors.difficulty}>
              <select
                name="difficulty"
                defaultValue={String(initial.difficulty)}
                className={selectClass}
              >
                {DIFFICULTY_LEVELS.map((d) => (
                  <option key={d} value={d}>
                    {"★".repeat(d)} {DIFFICULTY_LABEL[d]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="説明・実施手順" errors={errors.description}>
            <textarea
              name="description"
              defaultValue={initial.description}
              rows={4}
              maxLength={4000}
              placeholder="どのように行う種目かを書きます。"
              className={INPUT_CLASS}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="コーチングポイント" hint="選手に伝える意識点" errors={errors.coachingPoint}>
              <textarea
                name="coachingPoint"
                defaultValue={initial.coachingPoint}
                rows={3}
                maxLength={2000}
                placeholder="接地は体の真下。腰の位置を高く保つ。"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="ありがちな失敗" errors={errors.commonMistake}>
              <textarea
                name="commonMistake"
                defaultValue={initial.commonMistake}
                rows={3}
                maxLength={2000}
                placeholder="腿上げだけになり、接地が体の前になる。"
                className={INPUT_CLASS}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-700">分類</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            ここで付けた情報が、そのまま一覧の絞り込み条件になります。
          </p>
        </CardHeader>
        <CardBody className="space-y-4">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">対象能力</legend>
            <div className="flex flex-wrap gap-1.5">
              {TRAINING_TARGETS.map((t) => (
                <label
                  key={t}
                  className="cursor-pointer rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition-colors has-checked:border-indigo-600 has-checked:bg-indigo-600 has-checked:text-white hover:bg-slate-100"
                >
                  <input
                    type="checkbox"
                    name="targets"
                    value={t}
                    defaultChecked={initial.targets.includes(t)}
                    className="sr-only"
                  />
                  {TRAINING_TARGET_LABEL[t]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">
              練習目的
              <span className="ml-1 text-xs font-normal text-slate-400">
                この種目で意識させたい点
              </span>
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {EXERCISE_PURPOSES.map((p) => (
                <label
                  key={p}
                  className="cursor-pointer rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition-colors has-checked:border-indigo-600 has-checked:bg-indigo-600 has-checked:text-white hover:bg-slate-100"
                >
                  <input
                    type="checkbox"
                    name="purposes"
                    value={p}
                    defaultChecked={initial.purposes.includes(p)}
                    className="sr-only"
                  />
                  {EXERCISE_PURPOSE_LABEL[p]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">対象競技</legend>
            <div className="flex flex-wrap gap-1.5">
              {TRACK_FIELD_EVENTS.map((ev) => (
                <label
                  key={ev}
                  className="cursor-pointer rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition-colors has-checked:border-indigo-600 has-checked:bg-indigo-600 has-checked:text-white hover:bg-slate-100"
                >
                  <input
                    type="checkbox"
                    name="events"
                    value={ev}
                    defaultChecked={initial.events.includes(ev)}
                    className="sr-only"
                  />
                  {TRACK_FIELD_EVENT_LABEL[ev]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="タグ" hint="カンマ区切り" errors={errors.generalTags}>
              <input
                name="generalTags"
                defaultValue={initial.generalTags}
                placeholder="短距離, 定番"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="使用器具" hint="カンマ区切り" errors={errors.equipmentTags}>
              <input
                name="equipmentTags"
                defaultValue={initial.equipmentTags}
                placeholder="ハードル, ミニハードル"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="部位" hint="カンマ区切り" errors={errors.bodyPartTags}>
              <input
                name="bodyPartTags"
                defaultValue={initial.bodyPartTags}
                placeholder="ハムストリング, 体幹"
                className={INPUT_CLASS}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-700">推奨負荷</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            メニューへ追加するときの初期値になります。メニューごとに上書きできます。
          </p>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="セット数" errors={errors.defaultSets}>
              <input
                type="number"
                name="defaultSets"
                defaultValue={initial.defaultSets}
                min={1}
                max={99}
                className={INPUT_CLASS}
              />
            </Field>

            {metric === "REPS" && (
              <Field label="回数" errors={errors.defaultReps}>
                <input
                  type="number"
                  name="defaultReps"
                  defaultValue={initial.defaultReps}
                  min={1}
                  max={999}
                  className={INPUT_CLASS}
                />
              </Field>
            )}
            {metric === "DISTANCE" && (
              <Field label="距離（m）" errors={errors.defaultDistanceMeters}>
                <input
                  type="number"
                  name="defaultDistanceMeters"
                  defaultValue={initial.defaultDistanceMeters}
                  min={1}
                  step="any"
                  className={INPUT_CLASS}
                />
              </Field>
            )}
            {metric === "TIME" && (
              <Field label="時間（秒）" errors={errors.defaultDurationSeconds}>
                <input
                  type="number"
                  name="defaultDurationSeconds"
                  defaultValue={initial.defaultDurationSeconds}
                  min={1}
                  className={INPUT_CLASS}
                />
              </Field>
            )}

            <Field label="レスト（秒）" errors={errors.defaultRestSeconds}>
              <input
                type="number"
                name="defaultRestSeconds"
                defaultValue={initial.defaultRestSeconds}
                min={0}
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          {/* 表示していない単位の値も保持する（測り方を切り替えても消えないように） */}
          {metric !== "REPS" && (
            <input type="hidden" name="defaultReps" value={initial.defaultReps} />
          )}
          {metric !== "DISTANCE" && (
            <input
              type="hidden"
              name="defaultDistanceMeters"
              value={initial.defaultDistanceMeters}
            />
          )}
          {metric !== "TIME" && (
            <input
              type="hidden"
              name="defaultDurationSeconds"
              value={initial.defaultDurationSeconds}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-700">参考資料・状態</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field
            label="動画URL"
            hint="YouTube 等。将来の動画解析はアップロード動画を使います"
            errors={errors.videoUrl}
          >
            <input
              type="url"
              name="videoUrl"
              defaultValue={initial.videoUrl}
              placeholder="https://..."
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="状態" hint="AI下書き由来は「下書き」で登録されます" errors={errors.status}>
            <select name="status" defaultValue={initial.status} className={selectClass}>
              {REVIEW_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {REVIEW_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>

          <input type="hidden" name="source" value={initial.source} />
        </CardBody>
      </Card>

      <div className="flex items-center gap-2">
        <SubmitButton size="lg" pendingLabel="保存中…">
          {submitLabel}
        </SubmitButton>
        <Link href={cancelHref} className={buttonClass("secondary", "lg")}>
          キャンセル
        </Link>
      </div>
    </form>
  );
}
