import { Badge, cn } from "@/components/ui";
import type { FindingPresentationDto, FindingTone } from "@/presentation/running/dto";

const TONE_CLASS: Record<FindingTone, { row: string; badge: string }> = {
  info: { row: "border-slate-200 bg-slate-50", badge: "border-slate-200 bg-white text-slate-700" },
  caution: { row: "border-amber-200 bg-amber-50", badge: "border-amber-300 bg-white text-amber-900" },
  review: { row: "border-indigo-200 bg-indigo-50", badge: "border-indigo-300 bg-white text-indigo-800" },
  restricted: { row: "border-orange-200 bg-orange-50", badge: "border-orange-300 bg-white text-orange-900" },
  blocked: { row: "border-rose-300 bg-rose-50", badge: "border-rose-300 bg-white text-rose-800" },
};

/**
 * 明示的な確認のチェックボックス（「OK」ボタン1回ではなく、文を読んだうえでの明示操作）。
 * チェックボックス自体より大きいラベル全体をタップ領域にする（最低 44px の高さ）。
 */
export function ConfirmationCheckbox({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <input
        id={id}
        type="checkbox"
        className="h-6 w-6 shrink-0 accent-indigo-600"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );
}

export type FindingsConfirmation = {
  confirmedKeys: readonly string[];
  onChange: (confirmationKey: string, confirmed: boolean) => void;
  disabled?: boolean;
};

/**
 * Finding の一覧（表示専用。hooks を持たないので Server Component からも使える）。[R10-B4A] 保存前の確認対象（Action 結果）にだけ `confirmation` を渡し、保存済み Finding には確認記録ラベルを表示する。
 * Finding code や severity の内部名は描画しない。`confirmation` を渡したときだけ、確認が必要な行に
 * 「内容を確認しました」のチェックボックスを出す（B3 では controlled。Action にはまだ接続しない）。
 */
export function FindingsList({
  findings,
  idPrefix,
  heading,
  emptyMessage = null,
  confirmation,
}: {
  findings: readonly FindingPresentationDto[];
  idPrefix: string;
  heading?: string;
  emptyMessage?: string | null;
  confirmation?: FindingsConfirmation;
}) {
  if (findings.length === 0 && emptyMessage === null) return null;
  const headingId = `${idPrefix}-heading`;
  return (
    <section className="min-w-0 space-y-2" aria-labelledby={heading ? headingId : undefined}>
      {heading && (
        <h4 id={headingId} className="text-sm font-semibold text-slate-800">
          {heading}
        </h4>
      )}
      {findings.length === 0 ? (
        <p className="text-sm text-slate-500">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2">
          {findings.map((finding, index) => {
            const tone = TONE_CLASS[finding.tone];
            return (
              <li key={finding.key} className={cn("min-w-0 space-y-1.5 rounded-lg border px-3 py-2.5 break-words", tone.row)}>
                <div className="flex flex-wrap items-center gap-1">
                  {finding.severityLabels.map((label) => (
                    <Badge key={label} className={tone.badge}>
                      {label}
                    </Badge>
                  ))}
                  <span className="text-xs text-slate-500">{finding.scopeLabel}</span>
                </div>
                <p className="text-sm text-slate-900">{finding.message}</p>
                {finding.confirmationRecordLabel !== null ? (
                  <p className="text-xs font-medium text-slate-700">{finding.confirmationRecordLabel}</p>
                ) : (
                  finding.severityNote !== null && <p className="text-xs font-medium text-slate-700">{finding.severityNote}</p>
                )}
                {finding.details.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-slate-600">
                    {finding.details.map((d, i) => (
                      <li key={i} className="break-words">
                        {[d.subjectLabel, d.valueLabel, d.limitLabel].filter((v): v is string => v !== null).join(" ／ ")}
                      </li>
                    ))}
                  </ul>
                )}
                {finding.requiresExplicitConfirmation && confirmation && (
                  <ConfirmationCheckbox
                    id={`${idPrefix}-confirm-${index}`}
                    label="内容を確認しました"
                    checked={confirmation.confirmedKeys.includes(finding.confirmationKey)}
                    disabled={confirmation.disabled}
                    onChange={(checked) => confirmation.onChange(finding.confirmationKey, checked)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
