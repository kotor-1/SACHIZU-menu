"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Card, CardBody, Field, INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import {
  SESSION_STATUSES,
  SESSION_STATUS_LABEL,
  WEATHER_PRESETS,
} from "@/domain/session/constants";
import type { ActionResult } from "@/domain/shared/result";

export type SessionFormValues = {
  title: string;
  date: string;
  groupName: string;
  location: string;
  weather: string;
  condition: string;
  status: string;
  coachNote: string;
};

export function SessionForm({
  action,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: (
    prev: ActionResult<{ id: string }> | null,
    formData: FormData,
  ) => Promise<ActionResult<{ id: string }>>;
  initial: SessionFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const input = cn(INPUT_CLASS, "h-10 py-0");

  return (
    <form action={formAction} className="space-y-4">
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
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="練習名" required errors={errors.title} className="sm:col-span-2">
              <input
                name="title"
                defaultValue={initial.title}
                required
                maxLength={120}
                className={input}
              />
            </Field>
            <Field label="実施日" required errors={errors.date}>
              <input
                type="date"
                name="date"
                defaultValue={initial.date}
                required
                className={input}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="対象グループ・選手" errors={errors.groupName}>
              <input
                name="groupName"
                defaultValue={initial.groupName}
                maxLength={120}
                placeholder="短距離ブロック"
                className={input}
              />
            </Field>
            <Field label="場所" errors={errors.location}>
              <input
                name="location"
                defaultValue={initial.location}
                maxLength={120}
                placeholder="第一競技場"
                className={input}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="天候" errors={errors.weather}>
              <input
                name="weather"
                defaultValue={initial.weather}
                maxLength={60}
                list="weather-presets"
                placeholder="晴れ"
                className={input}
              />
              <datalist id="weather-presets">
                {WEATHER_PRESETS.map((w) => (
                  <option key={w} value={w} />
                ))}
              </datalist>
            </Field>

            <Field label="コンディション" errors={errors.condition} className="sm:col-span-2">
              <input
                name="condition"
                defaultValue={initial.condition}
                maxLength={500}
                placeholder="気温 22℃ / 追い風 1.2m"
                className={input}
              />
            </Field>
          </div>

          <Field label="状態" errors={errors.status}>
            <select name="status" defaultValue={initial.status} className={input}>
              {SESSION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SESSION_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="コーチ所感" hint="振り返り・次回への申し送り" errors={errors.coachNote}>
            <textarea
              name="coachNote"
              defaultValue={initial.coachNote}
              rows={5}
              maxLength={4000}
              placeholder="加速走は3本目まで良好。4本目で上体が起きるのが早くなったため打ち切り。次回は本数を3本に。"
              className={INPUT_CLASS}
            />
          </Field>
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
