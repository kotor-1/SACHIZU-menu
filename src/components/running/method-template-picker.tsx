"use client";

import { useState } from "react";
import { Badge, INPUT_CLASS, cn } from "@/components/ui";
import type { RunningTemplatePickerDto, RunningTemplateSelection } from "@/presentation/running/dto";
import { filterTemplateGroups } from "@/presentation/running/template-search";

export type MethodTemplatePickerProps = {
  picker: RunningTemplatePickerDto;
  value: RunningTemplateSelection | null;
  onSelect: (selection: RunningTemplateSelection) => void;
  idPrefix: string;
  disabled?: boolean;
};

/**
 * 新規追加用の練習の型ピッカー（検索語の state だけを持つ）。
 * RuleSet loader は import しない。server が作った DTO を props で受けるだけ。
 */
export function MethodTemplatePicker(props: MethodTemplatePickerProps) {
  const [query, setQuery] = useState("");
  return <MethodTemplatePickerView {...props} query={query} onQueryChange={setQuery} />;
}

/**
 * hooks を持たない表示部分。画面の主名称は SessionTemplate の日本語名で、分類（Method）は一覧整理用に
 * 弱く表示する。内部の Method / template id は選択値としてだけ持ち、描画しない。
 */
export function MethodTemplatePickerView({
  picker,
  value,
  onSelect,
  idPrefix,
  disabled,
  query,
  onQueryChange,
}: MethodTemplatePickerProps & { query: string; onQueryChange: (query: string) => void }) {
  const searchId = `${idPrefix}-search`;
  const groups = filterTemplateGroups(picker.groups, query);
  return (
    <div className="min-w-0 space-y-3">
      {picker.ruleSetNoticeLabel !== null && (
        <p className="text-xs text-slate-600">
          <Badge className="border-slate-300 bg-white text-slate-700">{picker.ruleSetNoticeLabel}</Badge>
          <span className="ml-1.5">正式版として確定していないルールで作成されます。</span>
        </p>
      )}
      <p className="text-xs text-slate-600">{picker.candidateNote}</p>
      <div>
        <label htmlFor={searchId} className="mb-1 block text-sm font-medium text-slate-700">
          練習の型を検索
        </label>
        <input
          id={searchId}
          type="search"
          className={cn(INPUT_CLASS, "h-11")}
          placeholder="例: フライ、流し"
          value={query}
          disabled={disabled}
          onChange={(e) => onQueryChange(e.currentTarget.value)}
        />
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-slate-500">該当する練習の型がありません。</p>
      ) : (
        groups.map((group, groupIndex) => {
          // 内部の Method 名を DOM 属性にも出さない（id は並び順から作る）。
          const headingId = `${idPrefix}-group-${groupIndex}`;
          return (
            <section key={group.methodInternal} className="min-w-0 space-y-1.5" aria-labelledby={headingId}>
              <h4 id={headingId} className="text-xs font-normal text-slate-400">
                {group.groupLabel}
              </h4>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {group.options.map((option) => {
                  const selected = value !== null && value.method === option.methodInternal && value.templateId === option.templateIdInternal;
                  return (
                    <li key={option.key} className="min-w-0">
                      <button
                        type="button"
                        aria-pressed={selected}
                        disabled={disabled || !option.canAttemptSelection}
                        onClick={() => onSelect({ method: option.methodInternal, templateId: option.templateIdInternal })}
                        className={cn(
                          "flex min-h-11 w-full flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors",
                          selected ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50",
                          "disabled:cursor-not-allowed disabled:opacity-60",
                        )}
                      >
                        <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
                          <span className="min-w-0 text-sm font-semibold break-words text-slate-900">{option.label}</span>
                          {selected && <span className="text-xs font-medium text-indigo-700">選択中</span>}
                          {option.recoveryLabel !== null && <Badge>{option.recoveryLabel}</Badge>}
                          {option.advancedOnlyLabel !== null && <Badge>{option.advancedOnlyLabel}</Badge>}
                        </span>
                        {option.aliases.length > 0 && (
                          <span className="text-xs break-words text-slate-500">別名: {option.aliases.join("、")}</span>
                        )}
                        {option.restrictionMessage !== null && (
                          <span className="text-xs break-words text-rose-700">{option.restrictionMessage}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
