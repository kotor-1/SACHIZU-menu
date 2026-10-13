import Link from "next/link";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { listCompetitions } from "@/infra/repositories/competition-repository";
import { presentCompetition } from "@/presentation/running/competition";

export const metadata = { title: "大会予定｜SACHIZU" };

/** DB を読むため、ビルド時に固定せず毎回サーバーで描画する（付け忘れると本番で一覧が更新されない）。 */
export const dynamic = "force-dynamic";

export default async function CompetitionsPage() {
  const competitions = (await listCompetitions()).map(presentCompetition);
  return (
    <>
      <PageHeader
        title="大会予定"
        description="練習計画で参照する大会日程と優先度を管理します。"
        actions={<LinkButton href="/competitions/new" size="lg">＋ 大会を登録</LinkButton>}
      />

      {competitions.length === 0 ? (
        <EmptyState
          title="大会予定はまだ登録されていません"
          description="今後の大会を登録すると、練習計画時の大会コンテキストに使用されます。"
          action={<LinkButton href="/competitions/new" size="lg">＋ 大会を登録</LinkButton>}
        />
      ) : (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          {competitions.map((competition) => (
            <Card key={competition.id} className="min-w-0 transition-shadow hover:shadow-md">
              <Link href={`/competitions/${competition.id}`} className="block min-w-0 p-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge>{competition.priorityLabel}</Badge>
                  <span className="text-sm text-slate-500">{competition.dateLabel}</span>
                </div>
                <h2 className="mt-2 break-words text-base font-semibold text-slate-900">{competition.name}</h2>
                {competition.note && <p className="mt-1 line-clamp-2 break-words text-sm whitespace-pre-wrap text-slate-500">{competition.note}</p>}
              </Link>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
