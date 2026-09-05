import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { CategoryBadge } from "@/components/exercise/exercise-badges";
import { prisma } from "@/infra/db/prisma";
import { listUpcomingSessions } from "@/infra/repositories/session-repository";
import { countExercisesByCategory } from "@/infra/repositories/exercise-repository";
import {
  EXERCISE_CATEGORIES,
  EXERCISE_CATEGORY_LABEL,
} from "@/domain/exercise/constants";
import {
  SESSION_STATUS_COLOR,
  SESSION_STATUS_LABEL,
  type SessionStatus,
} from "@/domain/session/constants";
import { formatDate, relativeDays } from "@/lib/format";

/** DB を直接読むため、ビルド時に固定せず毎回サーバーで描画する。 */
export const dynamic = "force-dynamic";


function StatCard({
  label,
  value,
  href,
  suffix,
}: {
  label: string;
  value: number;
  href: string;
  suffix: string;
}) {
  return (
    <Link href={href}>
      <Card className="h-full transition-shadow hover:shadow-md">
        <CardBody>
          <p className="text-xs text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">
            {value}
            <span className="ml-1 text-xs font-normal text-slate-400">{suffix}</span>
          </p>
        </CardBody>
      </Card>
    </Link>
  );
}

export default async function Home() {
  const [exerciseCount, menuCount, sessionCount, draftCount, byCategory, upcoming, recentMenus] =
    await Promise.all([
      prisma.exercise.count({ where: { status: { not: "ARCHIVED" } } }),
      prisma.menuTemplate.count({ where: { status: { not: "ARCHIVED" } } }),
      prisma.trainingSession.count(),
      prisma.exerciseDraft.count({ where: { status: "PENDING_REVIEW" } }),
      countExercisesByCategory(),
      listUpcomingSessions(5),
      prisma.menuTemplate.findMany({
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, name: true, updatedAt: true },
      }),
    ]);

  const topCategories = EXERCISE_CATEGORIES.map((c) => ({
    category: c,
    count: byCategory[c] ?? 0,
  }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <>
      <PageHeader
        title="ホーム"
        description="種目を登録し、組み合わせてメニューを作り、1回分の練習として実施します。"
        actions={
          <>
            <LinkButton href="/menus/new">＋ メニューを作成</LinkButton>
            <LinkButton href="/exercises/new" variant="secondary">
              ＋ 種目を登録
            </LinkButton>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="登録種目" value={exerciseCount} suffix="件" href="/exercises" />
        <StatCard label="メニュー" value={menuCount} suffix="件" href="/menus" />
        <StatCard label="練習記録" value={sessionCount} suffix="件" href="/sessions" />
        <StatCard label="AI下書き（確認待ち）" value={draftCount} suffix="件" href="/ai" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">予定・実施中の練習</h2>
            <Link href="/sessions" className="text-xs text-indigo-600 hover:underline">
              すべて見る
            </Link>
          </CardHeader>
          <CardBody>
            {upcoming.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">
                予定されている練習はありません。
                <Link href="/menus" className="ml-1 text-indigo-600 hover:underline">
                  メニューから作成
                </Link>
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {upcoming.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/sessions/${s.id}`}
                      className="flex items-center justify-between gap-3 py-2.5 hover:text-indigo-600"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {s.title}
                        </p>
                        <p className="text-xs text-slate-400">
                          {formatDate(s.date)}（{relativeDays(s.date)}）・{s._count.items} 項目
                        </p>
                      </div>
                      <Badge className={SESSION_STATUS_COLOR[s.status as SessionStatus]}>
                        {SESSION_STATUS_LABEL[s.status as SessionStatus] ?? s.status}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-700">最近のメニュー</h2>
          </CardHeader>
          <CardBody>
            {recentMenus.length === 0 ? (
              <p className="text-sm text-slate-400">まだありません。</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recentMenus.map((m) => (
                  <li key={m.id}>
                    <Link
                      href={`/menus/${m.id}`}
                      className="block truncate py-2 text-sm text-slate-700 hover:text-indigo-600"
                    >
                      {m.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-700">カテゴリ別の種目数</h2>
          </CardHeader>
          <CardBody>
            {topCategories.length === 0 ? (
              <p className="text-sm text-slate-400">種目がまだ登録されていません。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {topCategories.map(({ category, count }) => (
                  <Link
                    key={category}
                    href={`/exercises?category=${category}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50"
                  >
                    <CategoryBadge category={category} />
                    <span className="text-slate-600">{count}</span>
                    <span className="sr-only">
                      {EXERCISE_CATEGORY_LABEL[category]} の種目一覧へ
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
