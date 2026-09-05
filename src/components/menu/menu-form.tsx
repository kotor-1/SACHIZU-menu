"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Card, CardBody, Field, INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { TRAINING_PHASES, TRAINING_PHASE_LABEL } from "@/domain/menu/constants";
import { REVIEW_STATUSES, REVIEW_STATUS_LABEL } from "@/domain/shared/constants";
import type { ActionResult } from "@/domain/shared/result";

export type MenuFormValues = {
  name: string;
  description: string;
  purpose: string;
  phase: string;
  estimatedMinutes: string;
  status: string;
  tags: string;
};

export const EMPTY_MENU_FORM: MenuFormValues = {
  name: "",
  description: "",
  purpose: "",
  phase: "",
  estimatedMinutes: "",
  status: "DRAFT",
  tags: "",
};

export function MenuForm({
  action,
  initial,
  submitLabel,
  cancelHref,
  showDefaultBlocksOption = false,
}: {
  action: (
    prev: ActionResult<{ id: string }> | null,
    formData: FormData,
  ) => Promise<ActionResult<{ id: string }>>;
  initial: MenuFormValues;
  submitLabel: string;
  cancelHref: string;
  showDefaultBlocksOption?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const selectClass = cn(INPUT_CLASS, "h-10 py-0");

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
          <Field label="メニュー名" required errors={errors.name}>
            <input
              name="name"
              defaultValue={initial.name}
              required
              maxLength={120}
              placeholder="例：短距離｜スピード日（火曜）"
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="このメニューの狙い" errors={errors.purpose}>
            <textarea
              name="purpose"
              defaultValue={initial.purpose}
              rows={2}
              maxLength={2000}
              placeholder="最高速度の向上。疲労を溜めずに神経系へ刺激を入れる。"
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="補足・備考" errors={errors.description}>
            <textarea
              name="description"
              defaultValue={initial.description}
              rows={3}
              maxLength={4000}
              className={INPUT_CLASS}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="期分け" errors={errors.phase}>
              <select name="phase" defaultValue={initial.phase} className={selectClass}>
                <option value="">指定なし</option>
                {TRAINING_PHASES.map((p) => (
                  <option key={p} value={p}>
                    {TRAINING_PHASE_LABEL[p]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="想定所要時間（分）" errors={errors.estimatedMinutes}>
              <input
                type="number"
                name="estimatedMinutes"
                defaultValue={initial.estimatedMinutes}
                min={1}
                max={600}
                placeholder="90"
                className={INPUT_CLASS}
              />
            </Field>

            <Field label="状態" errors={errors.status}>
              <select name="status" defaultValue={initial.status} className={selectClass}>
                {REVIEW_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {REVIEW_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="タグ" hint="カンマ区切り" errors={errors.tags}>
            <input
              name="tags"
              defaultValue={initial.tags}
              placeholder="短距離, スピード"
              className={INPUT_CLASS}
            />
          </Field>

          {showDefaultBlocksOption && (
            <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              {/* 未チェックでも値が届くよう、チェックボックスの前に false を置く */}
              <input type="hidden" name="withDefaultBlocks" value="false" />
              <input
                type="checkbox"
                name="withDefaultBlocks"
                value="true"
                defaultChecked
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              <span>
                標準のブロック構成を用意する
                <span className="mt-0.5 block text-xs text-slate-400">
                  ウォームアップ / ドリル / 主運動 / 補強 / クールダウン
                </span>
              </span>
            </label>
          )}
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
