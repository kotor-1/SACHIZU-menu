"use client";

import { useState, useTransition } from "react";
import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { updateRunningMenuContextAction } from "@/actions/running-actions";
import { AGE_BANDS, MATURITY_CONFIDENCES, MATURITY_STATUSES, MATURITY_ASSESSMENT_METHODS, TRAINING_AGE_TIERS } from "@/domain/running/types/subject";
import {
  AGE_BAND_LABEL_JA,
  MATURITY_CONFIDENCE_LABEL_JA,
  MATURITY_METHOD_LABEL_JA,
  MATURITY_STATUS_LABEL_JA,
  PRIMARY_EVENT_LABEL_JA,
  TRAINING_AGE_TIER_LABEL_JA,
} from "@/presentation/running/labels";
import { runningContextFormData } from "@/presentation/running/action-forms";
import {
  buildRunningContextJson,
  emptyMemberDraft,
  type RunningContextDraft,
  type RunningContextMemberDraft,
} from "@/presentation/running/menu-context";

/**
 * メニューの「対象グループ・計画日」の設定（R10-B4B）。
 *
 * - 入力できるのは `runningMenuContextSchema` にある項目だけ。**痛み・体調・睡眠・性別・生年月日の欄は作らない**
 *   （健康情報・個人情報はこの設定に保存しない）。
 * - 計画日を今日で自動補完しない。開始予定時刻の日付がずれていても黙って直さず、メッセージで返す。
 * - 保存は `updateRunningMenuContextAction` の 1 本だけ（ここで Prisma も RuleSet も触らない）。
 */
export function RunningContextEditor({
  menuId,
  initial,
  statusMessage,
}: {
  menuId: string;
  initial: RunningContextDraft;
  /** 保存済みの設定を読めなかったときの案内（自動では直さない）。 */
  statusMessage?: string | null;
}) {
  const [draft, setDraft] = useState<RunningContextDraft>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const update = (patch: Partial<RunningContextDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const updateMember = (index: number, patch: Partial<RunningContextMemberDraft>) =>
    setDraft((d) => ({ ...d, members: d.members.map((m, i) => (i === index ? { ...m, ...patch } : m)) }));

  function save() {
    const built = buildRunningContextJson(draft);
    setSaved(false);
    if (!built.ok) {
      setMessage(built.message);
      return;
    }
    startTransition(async () => {
      const result = await updateRunningMenuContextAction(menuId, null, runningContextFormData(built.json));
      setMessage(result.ok ? (result.message ?? "保存しました") : result.message);
      setSaved(result.ok);
    });
  }

  const inputClass = cn(INPUT_CLASS, "h-11 w-full");
  const labelClass = "mb-1 block text-xs font-medium text-slate-700";

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="running-context-heading">
      <h3 id="running-context-heading" className="text-sm font-semibold text-slate-900">
        対象グループ・計画日
      </h3>
      {statusMessage != null && <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{statusMessage}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="running-context-label" className={labelClass}>
            対象グループの名前
          </label>
          <input
            id="running-context-label"
            className={inputClass}
            value={draft.label}
            maxLength={120}
            disabled={pending}
            placeholder="例：短距離ブロック"
            onChange={(e) => update({ label: e.currentTarget.value })}
          />
        </div>
        <div>
          <label htmlFor="running-context-planned-date" className={labelClass}>
            計画日
          </label>
          <input
            id="running-context-planned-date"
            type="date"
            className={inputClass}
            value={draft.plannedDate}
            disabled={pending}
            onChange={(e) => update({ plannedDate: e.currentTarget.value })}
          />
        </div>
        <div>
          <label htmlFor="running-context-planned-at" className={labelClass}>
            開始予定時刻（任意）
          </label>
          <input
            id="running-context-planned-at"
            type="datetime-local"
            className={inputClass}
            value={draft.plannedAtLocal}
            disabled={pending}
            onChange={(e) => {
              const local = e.currentTarget.value;
              const parsed = local === "" ? Number.NaN : new Date(local).getTimezoneOffset();
              update({ plannedAtLocal: local, plannedAtOffsetMinutes: Number.isNaN(parsed) ? null : parsed });
            }}
          />
          <p className="mt-1 text-xs text-slate-500">直近の練習との間隔を見るときに使います。未入力でも保存できます。</p>
        </div>
        <div>
          <label htmlFor="running-context-minutes" className={labelClass}>
            練習に使える時間（分・任意）
          </label>
          <input
            id="running-context-minutes"
            type="number"
            inputMode="numeric"
            min={1}
            className={inputClass}
            value={draft.availableMinutes}
            disabled={pending}
            onChange={(e) => update({ availableMinutes: e.currentTarget.value })}
          />
        </div>
        <div>
          <label htmlFor="running-context-count" className={labelClass}>
            人数の目安（任意）
          </label>
          <input
            id="running-context-count"
            type="number"
            inputMode="numeric"
            min={1}
            className={inputClass}
            value={draft.memberCountHint}
            disabled={pending}
            onChange={(e) => update({ memberCountHint: e.currentTarget.value })}
          />
        </div>
      </div>

      <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={draft.allowAdvancedMethods}
          disabled={pending}
          onChange={(e) => update({ allowAdvancedMethods: e.currentTarget.checked })}
        />
        熟練者向けの方式（抵抗走・アシステッドなど）も候補に出す
      </label>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-800">グループの構成</h4>
          <button
            type="button"
            className={buttonClass("secondary", "lg")}
            disabled={pending}
            onClick={() => setDraft((d) => ({ ...d, members: [...d.members, emptyMemberDraft()] }))}
          >
            対象を追加
          </button>
        </div>
        {draft.members.length === 0 && (
          <p className="text-xs text-slate-500">
            まだ登録がありません。年代・成長段階・練習歴を入れると、負荷の上限や使える方式の判断に使われます。
          </p>
        )}
        <ul className="space-y-3">
          {draft.members.map((member, index) => {
            const id = (name: string) => `running-context-member-${index}-${name}`;
            return (
              <li key={index} className="min-w-0 space-y-3 rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-700">{index + 1}人目</p>
                  <button
                    type="button"
                    aria-label={`${index + 1}人目を削除`}
                    className={buttonClass("ghost", "lg")}
                    disabled={pending}
                    onClick={() => setDraft((d) => ({ ...d, members: d.members.filter((_, i) => i !== index) }))}
                  >
                    削除
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={id("age")} className={labelClass}>
                      年代
                    </label>
                    <select
                      id={id("age")}
                      className={inputClass}
                      value={member.ageBandOverride}
                      disabled={pending}
                      onChange={(e) => updateMember(index, { ageBandOverride: e.currentTarget.value })}
                    >
                      <option value="">指定しない</option>
                      {AGE_BANDS.map((band) => (
                        <option key={band} value={band}>
                          {AGE_BAND_LABEL_JA[band]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={id("event")} className={labelClass}>
                      主な種目
                    </label>
                    <select
                      id={id("event")}
                      className={inputClass}
                      value={member.primaryEvent}
                      disabled={pending}
                      onChange={(e) => updateMember(index, { primaryEvent: e.currentTarget.value })}
                    >
                      {Object.entries(PRIMARY_EVENT_LABEL_JA).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={id("maturity-status")} className={labelClass}>
                      成長段階
                    </label>
                    <select
                      id={id("maturity-status")}
                      className={inputClass}
                      value={member.maturityStatus}
                      disabled={pending}
                      onChange={(e) => updateMember(index, { maturityStatus: e.currentTarget.value })}
                    >
                      {MATURITY_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {MATURITY_STATUS_LABEL_JA[status]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={id("maturity-method")} className={labelClass}>
                      成長段階の見立て方
                    </label>
                    <select
                      id={id("maturity-method")}
                      className={inputClass}
                      value={member.maturityMethod}
                      disabled={pending}
                      onChange={(e) => updateMember(index, { maturityMethod: e.currentTarget.value })}
                    >
                      {MATURITY_ASSESSMENT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {MATURITY_METHOD_LABEL_JA[method]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={id("maturity-confidence")} className={labelClass}>
                      見立ての確からしさ
                    </label>
                    <select
                      id={id("maturity-confidence")}
                      className={inputClass}
                      value={member.maturityConfidence}
                      disabled={pending}
                      onChange={(e) => updateMember(index, { maturityConfidence: e.currentTarget.value })}
                    >
                      {MATURITY_CONFIDENCES.map((confidence) => (
                        <option key={confidence} value={confidence}>
                          {MATURITY_CONFIDENCE_LABEL_JA[confidence]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={id("assessed-at")} className={labelClass}>
                      見立てた日（任意）
                    </label>
                    <input
                      id={id("assessed-at")}
                      type="date"
                      className={inputClass}
                      value={member.maturityAssessedAt}
                      disabled={pending}
                      onChange={(e) => updateMember(index, { maturityAssessedAt: e.currentTarget.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor={id("years")} className={labelClass}>
                      専門的なスプリント練習の年数（任意）
                    </label>
                    <input
                      id={id("years")}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      className={inputClass}
                      value={member.structuredSprintYears}
                      disabled={pending}
                      onChange={(e) => updateMember(index, { structuredSprintYears: e.currentTarget.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor={id("tier")} className={labelClass}>
                      コーチから見た習熟（任意）
                    </label>
                    <select
                      id={id("tier")}
                      className={inputClass}
                      value={member.coachAssignedTier}
                      disabled={pending}
                      onChange={(e) => updateMember(index, { coachAssignedTier: e.currentTarget.value })}
                    >
                      <option value="">指定しない</option>
                      {TRAINING_AGE_TIERS.map((tier) => (
                        <option key={tier} value={tier}>
                          {TRAINING_AGE_TIER_LABEL_JA[tier]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass("primary", "lg")} disabled={pending} onClick={save}>
          設定を保存
        </button>
        {message !== null && (
          <p role="status" className={cn("text-xs", saved ? "text-emerald-700" : "text-rose-700")}>
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
