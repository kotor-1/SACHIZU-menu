"use client";

import { useActionState, useState } from "react";
import { Card, CardBody, CardHeader, Field, INPUT_CLASS, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { createSessionFromMenuAction } from "@/actions/session-actions";
import { SessionConfirmationPanel, sessionConfirmationFailureOf } from "./session-confirmation-panel";
import { todayInputValue } from "@/lib/format";

/**
 * メニューから 1 回分の練習を起こすフォーム。
 * ここで作られたセッションは、この時点のメニュー内容のコピーを持つ。
 */
export function StartSessionForm({
  menuId,
  menuName,
  runningV2Enabled = false,
}: {
  menuId: string;
  menuName: string;
  /** [R11-B1] 走トレーニングの確認パネルを出すか（flag OFF なら安全側のエラー表示だけ）。 */
  runningV2Enabled?: boolean;
}) {
  const [state, formAction] = useActionState(createSessionFromMenuAction, null);
  const errors = state && !state.ok && state.kind === "INVALID_INPUT" ? (state.fieldErrors ?? {}) : {};
  const input = cn(INPUT_CLASS, "h-9 py-0");
  const confirmation = runningV2Enabled ? sessionConfirmationFailureOf(state) : null;
  const [confirmationReady, setConfirmationReady] = useState(false);

  return (
    <Card className="border-indigo-200">
      <CardHeader className="border-indigo-100 bg-indigo-50/60">
        <h2 className="text-sm font-semibold text-indigo-900">この練習を実施する</h2>
        <p className="mt-0.5 text-xs text-indigo-700/70">
          現在の内容をコピーして練習記録を作ります。
        </p>
      </CardHeader>
      <CardBody>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="menuTemplateId" value={menuId} />

          {state && !state.ok && (
            <p className="rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
              {state.message}
            </p>
          )}

          <Field label="実施日" required errors={errors.date}>
            <input
              type="date"
              name="date"
              required
              defaultValue={todayInputValue()}
              className={input}
            />
          </Field>

          <Field label="練習名" hint="空ならメニュー名" errors={errors.title}>
            <input
              name="title"
              maxLength={120}
              placeholder={menuName}
              className={input}
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="対象" errors={errors.groupName}>
              <input
                name="groupName"
                maxLength={120}
                placeholder="短距離ブロック"
                className={input}
              />
            </Field>
            <Field label="場所" errors={errors.location}>
              <input
                name="location"
                maxLength={120}
                placeholder="第一競技場"
                className={input}
              />
            </Field>
          </div>

          <SessionConfirmationPanel
            failure={confirmation}
            idPrefix={`start-session-${menuId}`}
            onReadyChange={setConfirmationReady}
          />

          <SubmitButton className="w-full" pendingLabel="作成中…" disabled={confirmation !== null && !confirmationReady}>
            {confirmation === null ? "練習記録を作成" : "確認のうえ作成する"}
          </SubmitButton>
        </form>
      </CardBody>
    </Card>
  );
}
