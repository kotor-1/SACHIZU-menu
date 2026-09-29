"use client";

import { useActionState, useState } from "react";
import { Card, CardBody, CardHeader, Field, INPUT_CLASS, cn } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { createSessionFromMenuAction } from "@/actions/session-actions";
import { SessionConfirmationPanel, sessionConfirmationFailureOf } from "./session-confirmation-panel";
import { SessionPlausibilityReviewPanel } from "./session-plausibility-review-panel";
import { TRAINING_PHASE_LABEL, type TrainingPhase } from "@/domain/menu/constants";
import { todayInputValue } from "@/lib/format";

type MenuOption = {
  id: string;
  name: string;
  phase: string | null;
  estimatedMinutes: number | null;
  runningSourceFingerprint: string | null;
};

export function selectedRunningSourceFingerprint(menus: readonly MenuOption[], menuId: string): string | null {
  return menus.find((menu) => menu.id === menuId)?.runningSourceFingerprint ?? null;
}

export function NewSessionFromMenu({
  menus,
  runningV2Enabled = false,
}: {
  menus: MenuOption[];
  /** [R11-B1] 走トレーニングの確認パネルを出すか（flag OFF なら安全側のエラー表示だけ）。 */
  runningV2Enabled?: boolean;
}) {
  const [state, formAction] = useActionState(createSessionFromMenuAction, null);
  const errors = state && !state.ok && state.kind === "INVALID_INPUT" ? (state.fieldErrors ?? {}) : {};
  const input = cn(INPUT_CLASS, "h-10 py-0");
  const confirmation = runningV2Enabled ? sessionConfirmationFailureOf(state) : null;
  const [confirmationReady, setConfirmationReady] = useState(false);
  const reviewIssues = runningV2Enabled && state && !state.ok && state.kind === "REJECTED" && state.reviewIssues?.length ? state.reviewIssues : null;
  const [reviewReady, setReviewReady] = useState(false);
  const blockedOnReview = reviewIssues !== null && !reviewReady;
  const [selectedMenuId, setSelectedMenuId] = useState("");
  const runningSourceFingerprint = selectedRunningSourceFingerprint(menus, selectedMenuId);

  return (
    <Card className="border-indigo-200">
      <CardHeader className="border-indigo-100 bg-indigo-50/60">
        <h2 className="text-sm font-semibold text-indigo-900">メニューから作る</h2>
        <p className="mt-0.5 text-xs text-indigo-700/70">
          推奨。メニューの中身をコピーして、そのまま実施記録にできます。
        </p>
      </CardHeader>
      <CardBody>
        {menus.length === 0 ? (
          <p className="text-sm text-slate-400">
            使えるメニューがありません。先にメニューを作成してください。
          </p>
        ) : (
          <form action={formAction} className="space-y-3">
            {state && !state.ok && (
              <p className="rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
                {state.message}
              </p>
            )}

            <Field label="メニュー" required errors={errors.menuTemplateId}>
              <select name="menuTemplateId" required value={selectedMenuId} onChange={(event) => setSelectedMenuId(event.target.value)} className={input}>
                <option value="" disabled>
                  選択してください
                </option>
                {menus.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.phase ? `（${TRAINING_PHASE_LABEL[m.phase as TrainingPhase] ?? m.phase}）` : ""}
                  </option>
                ))}
              </select>
            </Field>
            {runningSourceFingerprint && <input type="hidden" name="runningSourceFingerprint" value={runningSourceFingerprint} />}

            <div className="grid gap-3 sm:grid-cols-2">
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
                <input name="title" maxLength={120} className={input} />
              </Field>
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

            <SessionConfirmationPanel failure={confirmation} idPrefix="new-session" onReadyChange={setConfirmationReady} />

            <SessionPlausibilityReviewPanel issues={reviewIssues} idPrefix="new-session" onReadyChange={setReviewReady} />

            <SubmitButton pendingLabel="作成中…" disabled={blockedOnReview || (confirmation !== null && !confirmationReady)}>
              {confirmation === null ? "練習記録を作成" : "確認のうえ作成する"}
            </SubmitButton>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
