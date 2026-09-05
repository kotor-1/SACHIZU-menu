import Link from "next/link";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import { SESSION_STATUSES, SESSION_STATUS_LABEL } from "@/domain/session/constants";
import type { SessionSearch } from "@/domain/session/schema";

export function SessionFilters({
  search,
  resultCount,
}: {
  search: SessionSearch;
  resultCount: number;
}) {
  const hasFilter =
    Boolean(search.q) || Boolean(search.status) || Boolean(search.from) || Boolean(search.to);
  const input = cn(INPUT_CLASS, "h-9 py-0");

  return (
    <AutoSubmitForm action="/sessions" className="mb-5 space-y-3">
      <input type="hidden" name="page" value="1" />

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          name="q"
          defaultValue={search.q}
          placeholder="練習名・対象・場所・所感で検索"
          className={cn(INPUT_CLASS, "flex-1")}
          aria-label="キーワード検索"
        />
        <button type="submit" className={buttonClass("primary", "md", "shrink-0")}>
          検索
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select name="status" defaultValue={search.status} className={input} aria-label="状態">
          <option value="">状態：すべて</option>
          {SESSION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SESSION_STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="shrink-0">開始</span>
          <input type="date" name="from" defaultValue={search.from} className={input} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="shrink-0">終了</span>
          <input type="date" name="to" defaultValue={search.to} className={input} />
        </label>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{resultCount} 件が該当</span>
        {hasFilter && (
          <Link href="/sessions" className="text-indigo-600 hover:underline">
            条件をクリア
          </Link>
        )}
      </div>
    </AutoSubmitForm>
  );
}
