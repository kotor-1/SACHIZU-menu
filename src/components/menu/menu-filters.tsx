import Link from "next/link";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { TRAINING_PHASES, TRAINING_PHASE_LABEL } from "@/domain/menu/constants";
import { REVIEW_STATUSES, REVIEW_STATUS_LABEL } from "@/domain/shared/constants";
import type { MenuSearch } from "@/domain/menu/schema";

export function MenuFilters({
  search,
  tags,
  resultCount,
}: {
  search: MenuSearch;
  tags: Array<{ id: string; name: string }>;
  resultCount: number;
}) {
  const selected = new Set(search.tag);
  const hasFilter =
    Boolean(search.q) || Boolean(search.phase) || Boolean(search.status) || search.tag.length > 0;
  const selectClass = cn(INPUT_CLASS, "h-9 py-0");

  return (
    <AutoSubmitForm action="/menus" className="mb-5 space-y-3">
      <input type="hidden" name="page" value="1" />

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          name="q"
          defaultValue={search.q}
          placeholder="メニュー名・狙い・含まれる種目名で検索"
          className={cn(INPUT_CLASS, "flex-1")}
          aria-label="キーワード検索"
        />
        <button type="submit" className={buttonClass("primary", "md", "shrink-0")}>
          検索
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <select name="phase" defaultValue={search.phase} className={selectClass} aria-label="期分け">
          <option value="">期分け：すべて</option>
          {TRAINING_PHASES.map((p) => (
            <option key={p} value={p}>
              {TRAINING_PHASE_LABEL[p]}
            </option>
          ))}
        </select>

        <select name="status" defaultValue={search.status} className={selectClass} aria-label="状態">
          <option value="">状態：すべて</option>
          {REVIEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {REVIEW_STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        <select name="sort" defaultValue={search.sort} className={selectClass} aria-label="並び順">
          <option value="updatedDesc">更新が新しい順</option>
          <option value="createdDesc">作成が新しい順</option>
          <option value="nameAsc">名前順</option>
        </select>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
          <span className="text-xs font-medium text-slate-500">タグ</span>
          {tags.map((tag) => {
            const checked = selected.has(tag.id);
            return (
              <label
                key={tag.id}
                className={cn(
                  "cursor-pointer rounded-md border px-2 py-0.5 text-xs transition-colors",
                  checked
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100",
                )}
              >
                <input
                  type="checkbox"
                  name="tag"
                  value={tag.id}
                  defaultChecked={checked}
                  className="sr-only"
                />
                {tag.name}
              </label>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{resultCount} 件が該当</span>
        {hasFilter && (
          <Link href="/menus" className="text-indigo-600 hover:underline">
            条件をクリア
          </Link>
        )}
      </div>
    </AutoSubmitForm>
  );
}
