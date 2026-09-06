import Link from "next/link";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import {
  DIFFICULTY_LABEL,
  DIFFICULTY_LEVELS,
  EXERCISE_CATEGORIES,
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_PURPOSES,
  EXERCISE_PURPOSE_LABEL,
  TAG_KIND_LABEL,
  TRACK_FIELD_EVENTS,
  TRACK_FIELD_EVENT_LABEL,
  TRAINING_TARGETS,
  TRAINING_TARGET_LABEL,
  type TagKind,
} from "@/domain/exercise/constants";
import { REVIEW_STATUSES, REVIEW_STATUS_LABEL } from "@/domain/shared/constants";
import { EXERCISE_SORT_LABEL, type ExerciseSearch } from "@/domain/exercise/schema";

type TagOption = { id: string; name: string; kind: string };

/**
 * 種目の検索フィルタ。
 * 条件はすべてクエリパラメータに載せる（サーバー側で完結し、状態管理を持たない）。
 */
export function ExerciseFilters({
  search,
  tags,
  resultCount,
}: {
  search: ExerciseSearch;
  tags: TagOption[];
  resultCount: number;
}) {
  const selectedTags = new Set(search.tag);
  const hasFilter =
    Boolean(search.q) ||
    Boolean(search.category) ||
    Boolean(search.target) ||
    Boolean(search.purpose) ||
    Boolean(search.event) ||
    Boolean(search.status) ||
    Boolean(search.favorite) ||
    search.difficulty !== "" ||
    search.tag.length > 0;

  const tagsByKind = tags.reduce<Record<string, TagOption[]>>((acc, t) => {
    (acc[t.kind] ??= []).push(t);
    return acc;
  }, {});

  const selectClass = cn(INPUT_CLASS, "h-9 py-0");

  return (
    <AutoSubmitForm action="/exercises" className="mb-5 space-y-3">
      <input type="hidden" name="page" value="1" />

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <input
            type="search"
            name="q"
            defaultValue={search.q}
            placeholder="種目名・説明・ポイントで検索"
            className={INPUT_CLASS}
            aria-label="キーワード検索"
          />
        </div>
        <button type="submit" className={buttonClass("primary", "md", "shrink-0")}>
          検索
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <select name="category" defaultValue={search.category} className={selectClass} aria-label="カテゴリ">
          <option value="">カテゴリ：すべて</option>
          {EXERCISE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {EXERCISE_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>

        <select name="target" defaultValue={search.target} className={selectClass} aria-label="対象能力">
          <option value="">対象能力：すべて</option>
          {TRAINING_TARGETS.map((t) => (
            <option key={t} value={t}>
              {TRAINING_TARGET_LABEL[t]}
            </option>
          ))}
        </select>

        <select name="purpose" defaultValue={search.purpose} className={selectClass} aria-label="練習目的">
          <option value="">練習目的：すべて</option>
          {EXERCISE_PURPOSES.map((p) => (
            <option key={p} value={p}>
              {EXERCISE_PURPOSE_LABEL[p]}
            </option>
          ))}
        </select>

        <select name="event" defaultValue={search.event} className={selectClass} aria-label="対象競技">
          <option value="">対象競技：すべて</option>
          {TRACK_FIELD_EVENTS.map((ev) => (
            <option key={ev} value={ev}>
              {TRACK_FIELD_EVENT_LABEL[ev]}
            </option>
          ))}
        </select>

        <select
          name="difficulty"
          defaultValue={String(search.difficulty)}
          className={selectClass}
          aria-label="難易度"
        >
          <option value="">難易度：すべて</option>
          {DIFFICULTY_LEVELS.map((d) => (
            <option key={d} value={d}>
              {"★".repeat(d)} {DIFFICULTY_LABEL[d]}
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
          {Object.entries(EXERCISE_SORT_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <label
        className={cn(
          "inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
          search.favorite === "1"
            ? "border-amber-400 bg-amber-50 text-amber-800"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        <input
          type="checkbox"
          name="favorite"
          value="1"
          defaultChecked={search.favorite === "1"}
          className="sr-only"
        />
        ★ お気に入りのみ
      </label>

      {Object.keys(tagsByKind).length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
          {(Object.keys(tagsByKind) as TagKind[]).map((kind) => (
            <div key={kind} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 shrink-0 text-xs font-medium text-slate-500">
                {TAG_KIND_LABEL[kind] ?? kind}
              </span>
              {tagsByKind[kind].map((tag) => {
                const checked = selectedTags.has(tag.id);
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
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{resultCount} 件が該当</span>
        {hasFilter && (
          <Link href="/exercises" className="text-indigo-600 hover:underline">
            条件をクリア
          </Link>
        )}
      </div>
    </AutoSubmitForm>
  );
}
