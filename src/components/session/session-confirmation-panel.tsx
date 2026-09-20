"use client";

import { useState } from "react";
import { cn } from "@/components/ui";
import { FindingsList } from "@/components/running/findings-list";
import { CONFIRMED_FINDING_CODES_KEY } from "@/domain/session/schema";
import {
  allConfirmed,
  checkedKeysForChallenge,
  confirmedCodesToSubmit,
  presentSessionConfirmation,
  type SessionConfirmationFailureLike,
} from "@/presentation/running/session-confirmation";

/**
 * セッション作成前の明示確認パネル（R11-B1）。
 *
 * 作成フォームの**中**に置き、チェックした内容を hidden field として同じフォームで送る
 * （フォームの入力値は消えない。§36）。2つの入口（メニュー画面・練習記録の新規作成）で共有する。
 *
 * - チェックは既定 false。全部チェックするまで送信ボタンを無効にする（§33）
 * - `CONFIRMATION_STATE_STALE`（challenge が変わった）ときはチェックを全て外し、最新の Finding で出し直す（§35）
 * - challenge は hidden field としてだけ持ち、ユーザー向けテキストとして描画しない（§34）
 * - Finding code を画面に出さない（日本語化は B3 の presentation。§28）
 */
export function SessionConfirmationPanel({
  failure,
  idPrefix = "session-confirmation",
  disabled,
  onReadyChange,
}: {
  failure: SessionConfirmationFailureLike | null;
  idPrefix?: string;
  disabled?: boolean;
  /** 全項目の確認が揃ったか（親の送信ボタンの活性に使う）。 */
  onReadyChange?: (ready: boolean) => void;
}) {
  const panel = failure === null ? null : presentSessionConfirmation(failure);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [ackedChallenge, setAckedChallenge] = useState<string | null>(null);

  // 評価が変わった（challenge が違う）ら、以前のチェックは無効。レンダー中に自分の state を戻す。
  const challenge = panel?.challenge ?? null;
  if (challenge !== ackedChallenge) {
    setAckedChallenge(challenge);
    const next = checkedKeysForChallenge({ challenge: ackedChallenge, checkedKeys }, challenge);
    if (next.length !== checkedKeys.length) setCheckedKeys(next);
  }

  const ready = panel === null ? false : allConfirmed(panel, checkedKeys);
  const [notifiedReady, setNotifiedReady] = useState<boolean | null>(null);
  if (notifiedReady !== ready) {
    setNotifiedReady(ready);
    onReadyChange?.(ready);
  }

  if (panel === null) return null;

  return (
    <section
      className="min-w-0 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3"
      aria-labelledby={`${idPrefix}-heading`}
    >
      <h3 id={`${idPrefix}-heading`} className="text-sm font-semibold text-amber-900">
        {panel.heading}
      </h3>
      <p className={cn("text-xs", failure?.kind === "CONFIRMATION_STATE_STALE" ? "text-rose-800" : "text-amber-900")}>{panel.message}</p>

      {/* Finding の表示と「内容を確認しました」は B3 の FindingsList を再利用する（id も code を含めない） */}
      <FindingsList
        findings={panel.findings}
        idPrefix={`${idPrefix}-findings`}
        confirmation={{
          confirmedKeys: checkedKeys,
          disabled,
          onChange: (confirmationKey, checked) =>
            setCheckedKeys((keys) => (checked ? [...new Set([...keys, confirmationKey])] : keys.filter((k) => k !== confirmationKey))),
        }}
      />

      <p className="text-xs text-amber-900">{panel.note}</p>

      {/* 2回目のリクエストで送る値（画面には出さない） */}
      <input type="hidden" name="confirmationChallenge" value={panel.challenge} />
      {confirmedCodesToSubmit(panel, checkedKeys).map((code) => (
        <input key={code} type="hidden" name={CONFIRMED_FINDING_CODES_KEY} value={code} />
      ))}
    </section>
  );
}

/** Action の結果から確認パネル用の失敗だけを取り出す（それ以外は null）。 */
export function sessionConfirmationFailureOf(state: { ok: boolean; kind?: string } | null): SessionConfirmationFailureLike | null {
  if (state === null || state.ok) return null;
  if (state.kind !== "CONFIRMATION_REQUIRED" && state.kind !== "CONFIRMATION_STATE_STALE") return null;
  return state as unknown as SessionConfirmationFailureLike;
}
