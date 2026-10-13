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
import { currentAppViewer } from "@/infra/auth/current-app-user";

/** DB を直接読むため、ビルド時に固定せず毎回サーバーで描画する。 */
export const dynamic = "force-dynamic";


/** 得点板のように、数字を大きく並べた帯の 1 区画。 */
function Score({
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
    <Link href={href} className="group block bg-white px-4 py-3 transition-colors hover:bg-slate-50 sm:px-5 sm:py-4">
      <p className="text-xs font-semibold text-slate-600">{label}</p>
      <p className="mt-1 text-3xl font-extrabold tabular-nums tracking-tight text-slate-900 group-hover:text-indigo-700">
        {value}
        <span className="ml-1 text-xs font-medium text-slate-500">{suffix}</span>
      </p>
    </Link>
  );
}

export default async function Home() {
  // 件数とカテゴリ別の集計は管理者だけに見せる（メンバーには練習の予定と最近のメニューだけ）。
  // 手元の開発ではログインを使わないので、そのまま表示する。
  const { isAdmin } = await currentAppViewer();
  const [exerciseCount, menuCount, sessionCount, draftCount, byCategory, upcoming, recentMenus] =
    await Promise.all([
      isAdmin ? prisma.exercise.count({ where: { status: { not: "ARCHIVED" } } }) : 0,
      isAdmin ? prisma.menuTemplate.count({ where: { status: { not: "ARCHIVED" } } }) : 0,
      isAdmin ? prisma.trainingSession.count() : 0,
      isAdmin ? prisma.exerciseDraft.count({ where: { status: "PENDING_REVIEW" } }) : 0,
      isAdmin ? countExercisesByCategory() : ({} as Awaited<ReturnType<typeof countExercisesByCategory>>),
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
            {isAdmin && <LinkButton href="/exercises/new" variant="secondary">
              ＋ 種目を登録
            </LinkButton>}
          </>
        }
      />

      {/* 1px の隙間に罫線の色を見せて、区画の間に線を引く */}
      {isAdmin && <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 lg:grid-cols-4">
        <Score label="登録種目" value={exerciseCount} suffix="件" href="/exercises" />
        <Score label="メニュー" value={menuCount} suffix="件" href="/menus" />
        <Score label="練習記録" value={sessionCount} suffix="件" href="/sessions" />
        <Score label="AI下書き（確認待ち）" value={draftCount} suffix="件" href="/ai" />
      </div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900">予定・実施中の練習</h2>
            <Link href="/sessions" className="text-xs font-semibold text-indigo-700 underline-offset-4 hover:underline">
              すべて見る
            </Link>
          </CardHeader>
          <CardBody>
            {upcoming.length === 0 ? (
              <p className="py-4 text-sm text-slate-500">
                予定されている練習はありません。
                <Link href="/menus" className="ml-1 font-semibold text-indigo-700 underline underline-offset-4">
                  メニューから作成
                </Link>
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {upcoming.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/sessions/${s.id}`}
                      className="flex items-center justify-between gap-3 py-2.5 hover:text-indigo-700"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {s.title}
                        </p>
                        <p className="text-xs tabular-nums text-slate-500">
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
            <h2 className="text-sm font-bold text-slate-900">最近のメニュー</h2>
          </CardHeader>
          <CardBody>
            {recentMenus.length === 0 ? (
              <p className="text-sm text-slate-500">まだありません。</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recentMenus.map((m) => (
                  <li key={m.id}>
                    <Link
                      href={`/menus/${m.id}`}
                      className="block truncate py-2.5 text-sm font-medium text-slate-800 hover:text-indigo-700"
                    >
                      {m.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {isAdmin && <Card className="lg:col-span-3">
          <CardHeader>
            <h2 className="text-sm font-bold text-slate-900">カテゴリ別の種目数</h2>
          </CardHeader>
          <CardBody>
            {topCategories.length === 0 ? (
              <p className="text-sm text-slate-500">種目がまだ登録されていません。</p>
            ) : (
              <ul className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-4">
                {topCategories.map(({ category, count }) => (
                  <li key={category} className="border-b border-slate-100">
                    <Link
                      href={`/exercises?category=${category}`}
                      className="flex min-h-11 items-center justify-between gap-3 text-sm hover:text-indigo-700"
                    >
                      <CategoryBadge category={category} />
                      <span className="font-bold tabular-nums text-slate-900">{count}</span>
                      <span className="sr-only">
                        {EXERCISE_CATEGORY_LABEL[category]} の種目一覧へ
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>}
      </div>
    </>
  );
}
