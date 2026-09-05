import Link from "next/link";
import { cn } from "./ui";

/**
 * ページ送り。検索条件を保ったまま page だけ差し替える。
 */
export function Pagination({
  page,
  totalPages,
  total,
  baseParams,
  basePath,
}: {
  page: number;
  totalPages: number;
  total: number;
  baseParams: URLSearchParams;
  basePath: string;
}) {
  if (totalPages <= 1) {
    return (
      <p className="mt-4 text-center text-xs text-slate-400">全 {total} 件</p>
    );
  }

  const href = (p: number) => {
    const params = new URLSearchParams(baseParams);
    params.set("page", String(p));
    return `${basePath}?${params.toString()}`;
  };

  // 現在ページの前後 2 件だけ出す（件数が増えても崩れないように）
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(
    (p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2,
  );

  const cellBase =
    "inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-sm";

  return (
    <nav className="mt-6 flex flex-wrap items-center justify-center gap-1.5 no-print">
      <Link
        href={href(Math.max(1, page - 1))}
        aria-disabled={page === 1}
        className={cn(
          cellBase,
          page === 1
            ? "pointer-events-none border-slate-200 text-slate-300"
            : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        前へ
      </Link>

      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-1.5">
          {i > 0 && pages[i - 1] !== p - 1 && (
            <span className="px-1 text-slate-400">…</span>
          )}
          <Link
            href={href(p)}
            className={cn(
              cellBase,
              p === page
                ? "border-indigo-600 bg-indigo-600 font-semibold text-white"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            {p}
          </Link>
        </span>
      ))}

      <Link
        href={href(Math.min(totalPages, page + 1))}
        aria-disabled={page === totalPages}
        className={cn(
          cellBase,
          page === totalPages
            ? "pointer-events-none border-slate-200 text-slate-300"
            : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        次へ
      </Link>

      <span className="ml-2 text-xs text-slate-400">全 {total} 件</span>
    </nav>
  );
}
