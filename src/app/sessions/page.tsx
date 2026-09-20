import Link from "next/link";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { SessionFilters } from "@/components/session/session-filters";
import { Pagination } from "@/components/pagination";
import { sessionSearchSchema } from "@/domain/session/schema";
import { parseSearchParams, toBaseParams } from "@/lib/search-params";
import {
  SESSION_STATUS_COLOR,
  SESSION_STATUS_LABEL,
  type SessionStatus,
} from "@/domain/session/constants";
import { searchSessions } from "@/infra/repositories/session-repository";
import { formatDate, relativeDays } from "@/lib/format";
import { presentCompetitionSession } from "@/presentation/running/competition";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata = { title: "練習記録｜SACHIZU" };

export default async function SessionsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const search = parseSearchParams(sessionSearchSchema, raw);
  const result = await searchSessions(search);

  const baseParams = toBaseParams(raw);

  return (
    <>
      <PageHeader
        title="練習記録"
        description="メニューから起こした 1 回分の練習です。作成後はメニューから独立します。"
        actions={<LinkButton href="/sessions/new">＋ 練習を作成</LinkButton>}
      />

      <SessionFilters search={search} resultCount={result.total} />

      {result.items.length === 0 ? (
        <EmptyState
          title="練習記録がありません"
          description="メニュー画面の「この練習を実施する」から作成できます。"
          action={<LinkButton href="/menus">メニュー一覧へ</LinkButton>}
        />
      ) : (
        <ul className="space-y-2.5">
          {result.items.map((session) => {
            const doneCount = session.items.filter((i) => i.done).length;
            const status = session.status as SessionStatus;
            const competitionRecord = session.sessionKind === "COMPETITION" ? presentCompetitionSession(session) : null;
            return (
              <li key={session.id}>
                <Card className="transition-shadow hover:shadow-md">
                  <Link
                    href={`/sessions/${session.id}`}
                    className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <Badge className={SESSION_STATUS_COLOR[status]}>
                          {SESSION_STATUS_LABEL[status] ?? session.status}
                        </Badge>
                        {competitionRecord && <Badge>大会実績</Badge>}
                        <span className="text-xs text-slate-500">
                          {formatDate(session.date)}
                        </span>
                        <span className="text-xs text-slate-400">
                          （{relativeDays(session.date)}）
                        </span>
                      </div>

                      <h3 className="truncate text-base font-semibold text-slate-900">
                        {session.title}
                      </h3>

                      <p className="mt-0.5 text-xs text-slate-500">
                        {competitionRecord
                          ? competitionRecord.categoriesLabel
                          : ([session.groupName, session.location].filter(Boolean).join(" ・ ") || "対象・場所は未設定")}
                        {session.sourceMenuTemplate
                          ? ` ／ 元メニュー：${session.sourceMenuTemplate.name}`
                          : session.sourceMenuNameSnapshot
                            ? ` ／ 元メニュー：${session.sourceMenuNameSnapshot}（削除済み）`
                            : ""}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      {competitionRecord ? (
                        <p className="text-sm font-medium text-slate-700">実績記録</p>
                      ) : (
                        <>
                          <p className="text-sm font-medium text-slate-700">{doneCount} / {session._count.items}</p>
                          <p className="text-xs text-slate-400">実施済み</p>
                        </>
                      )}
                    </div>
                  </Link>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        baseParams={baseParams}
        basePath="/sessions"
      />
    </>
  );
}
