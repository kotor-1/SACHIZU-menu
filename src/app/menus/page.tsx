import Link from "next/link";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { MenuFilters } from "@/components/menu/menu-filters";
import { Pagination } from "@/components/pagination";
import { menuSearchSchema } from "@/domain/menu/schema";
import { parseSearchParams, toBaseParams } from "@/lib/search-params";
import { TRAINING_PHASE_LABEL, type TrainingPhase } from "@/domain/menu/constants";
import { REVIEW_STATUS_LABEL, type ReviewStatus } from "@/domain/shared/constants";
import { searchMenus } from "@/infra/repositories/menu-repository";
import { listTagsInUse } from "@/infra/repositories/tag-repository";
import { formatMinutes } from "@/lib/format";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata = { title: "メニュー一覧｜SACHIZU" };

export default async function MenusPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const search = parseSearchParams(menuSearchSchema, raw, ["tag"]);

  const [result, tags] = await Promise.all([searchMenus(search), listTagsInUse()]);

  const baseParams = toBaseParams(raw);

  return (
    <>
      <PageHeader
        title="練習メニュー"
        description="種目を組み合わせた練習の雛形です。ここから 1 回分の練習を起こします。"
        actions={<LinkButton href="/menus/new">＋ メニューを作成</LinkButton>}
      />

      <MenuFilters
        search={search}
        tags={tags.filter((t) => t._count.menus > 0)}
        resultCount={result.total}
      />

      {result.items.length === 0 ? (
        <EmptyState
          title="該当するメニューがありません"
          description="条件を変えるか、新しくメニューを作成してください。"
          action={<LinkButton href="/menus/new">＋ メニューを作成</LinkButton>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {result.items.map((menu) => {
            const itemCount = menu.blocks.reduce((n, b) => n + b._count.items, 0);
            return (
              <Card key={menu.id} className="transition-shadow hover:shadow-md">
                <Link href={`/menus/${menu.id}`} className="block p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {menu.phase && (
                      <Badge className="border-sky-200 bg-sky-50 text-sky-700">
                        {TRAINING_PHASE_LABEL[menu.phase as TrainingPhase] ?? menu.phase}
                      </Badge>
                    )}
                    {menu.status !== "REVIEWED" && (
                      <Badge className="border-amber-200 bg-amber-50 text-amber-700">
                        {REVIEW_STATUS_LABEL[menu.status as ReviewStatus] ?? menu.status}
                      </Badge>
                    )}
                  </div>

                  <h3 className="text-base font-semibold text-slate-900">{menu.name}</h3>

                  {menu.purpose && (
                    <p className="mt-1 line-clamp-2 text-sm text-slate-500">{menu.purpose}</p>
                  )}

                  <p className="mt-2.5 text-xs text-slate-500">
                    {menu.blocks.length} ブロック / {itemCount} 種目
                    {menu.estimatedMinutes ? ` ・ 約 ${formatMinutes(menu.estimatedMinutes)}` : ""}
                    {menu._count.sessions > 0 ? ` ・ 実施 ${menu._count.sessions} 回` : ""}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-1 text-xs text-slate-400">
                    {menu.blocks.map((b) => (
                      <span key={b.id} className="rounded bg-slate-100 px-1.5 py-0.5">
                        {b.name}
                      </span>
                    ))}
                  </div>
                </Link>
              </Card>
            );
          })}
        </div>
      )}

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        baseParams={baseParams}
        basePath="/menus"
      />
    </>
  );
}
