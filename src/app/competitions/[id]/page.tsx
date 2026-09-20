import { notFound } from "next/navigation";
import { recordCompetitionParticipationAction, updateCompetitionAction } from "@/actions/competition-actions";
import { CompetitionDeleteForm } from "@/components/competition/competition-delete-form";
import { CompetitionForm } from "@/components/competition/competition-form";
import { CompetitionParticipationForm } from "@/components/competition/competition-participation-form";
import { Badge, Card, CardBody, LinkButton, PageHeader } from "@/components/ui";
import { findCompetition } from "@/infra/repositories/competition-repository";
import { listCompetitionSessions } from "@/infra/repositories/competition-session-repository";
import { presentCompetition, presentCompetitionSession } from "@/presentation/running/competition";
import { todayInputValue } from "@/lib/format";
import { SESSION_STATUS_COLOR, SESSION_STATUS_LABEL, type SessionStatus } from "@/domain/session/constants";

export default async function CompetitionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await findCompetition(id);
  if (row === null) notFound();
  const competition = presentCompetition(row);
  const participationRecords = (await listCompetitionSessions(competition.id)).map(presentCompetitionSession);
  const action = updateCompetitionAction.bind(null, competition.id);

  return (
    <>
      <PageHeader
        title={competition.name}
        description={<span className="flex flex-wrap items-center gap-2"><Badge>{competition.priorityLabel}</Badge><span>{competition.dateLabel}</span></span>}
      />

      <section aria-labelledby="competition-participation-heading" className="mb-5">
        <Card>
          <CardBody className="min-w-0 space-y-4">
            <div>
              <h2 id="competition-participation-heading" className="text-base font-semibold text-slate-800">大会実績を記録</h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">出場後に、開催日と参加した種別を記録します。大会予定だけでは練習負荷には加算されません。</p>
            </div>
            <CompetitionParticipationForm
              action={recordCompetitionParticipationAction}
              competitionId={competition.id}
              startDate={competition.date}
              endDate={competition.endDate ?? competition.date}
              latestRecordableDate={todayInputValue()}
            />
          </CardBody>
        </Card>
      </section>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] [&>*]:min-w-0">
        <section aria-labelledby="competition-edit-heading">
          <h2 id="competition-edit-heading" className="mb-3 text-base font-semibold text-slate-800">大会情報を編集</h2>
          <CompetitionForm
            action={action}
            initial={{
              name: competition.name,
              date: competition.date,
              endDate: competition.endDate ?? "",
              priority: competition.priority,
              note: competition.note ?? "",
            }}
            submitLabel="変更を保存"
            cancelHref="/competitions"
          />
        </section>

        <aside className="space-y-4">
          <Card>
            <CardBody>
              <h2 className="text-sm font-semibold text-slate-700">記録済みの大会実績</h2>
              {participationRecords.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">大会実績はまだありません。</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {participationRecords.map((record) => {
                    const status = record.status as SessionStatus;
                    return (
                      <li key={record.id} className="min-w-0 rounded-lg border border-slate-200 p-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <Badge className={SESSION_STATUS_COLOR[status]}>{SESSION_STATUS_LABEL[status] ?? "状態を確認"}</Badge>
                          <span className="text-sm text-slate-700">{record.dateLabel}</span>
                        </div>
                        <p className="mt-1 break-words text-sm font-medium text-slate-800">{record.categoriesLabel}</p>
                        <LinkButton href={`/sessions/${record.id}`} variant="secondary" size="sm" className="mt-2 min-h-11 w-full">実績を見る</LinkButton>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <h2 className="text-sm font-semibold text-slate-700">登録内容</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <div><dt className="text-xs text-slate-500">日程</dt><dd className="mt-0.5 text-slate-800">{competition.dateLabel}</dd></div>
                <div><dt className="text-xs text-slate-500">優先度</dt><dd className="mt-0.5 text-slate-800">{competition.priorityLabel}</dd></div>
                <div><dt className="text-xs text-slate-500">メモ</dt><dd className="mt-0.5 break-words whitespace-pre-wrap text-slate-800">{competition.note ?? "メモなし"}</dd></div>
              </dl>
            </CardBody>
          </Card>
          <Card className="border-rose-200">
            <CardBody className="space-y-2">
              <h2 className="text-sm font-semibold text-rose-800">大会予定の削除</h2>
              <p className="text-xs leading-relaxed text-slate-600">削除しても、関連する過去の練習記録は消えません。</p>
              <CompetitionDeleteForm competitionId={competition.id} competitionName={competition.name} />
            </CardBody>
          </Card>
        </aside>
      </div>
    </>
  );
}
