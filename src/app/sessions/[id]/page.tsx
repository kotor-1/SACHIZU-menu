import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  LinkButton,
  PageHeader,
} from "@/components/ui";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { SubmitButton } from "@/components/submit-button";
import { SessionItemRow } from "@/components/session/session-item-row";
import { AddSessionItemForm } from "@/components/session/add-session-item-form";
import { deleteSessionAction, setSessionStatusAction } from "@/actions/session-actions";
import { findSession } from "@/infra/repositories/session-repository";
import { listExercisesForPicker } from "@/infra/repositories/exercise-repository";
import {
  SESSION_STATUS_COLOR,
  SESSION_STATUS_LABEL,
  type SessionStatus,
} from "@/domain/session/constants";
import { formatDate, relativeDays } from "@/lib/format";

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [session, exercises] = await Promise.all([findSession(id), listExercisesForPicker()]);
  if (!session) notFound();

  const status = session.status as SessionStatus;
  const doneCount = session.items.filter((i) => i.done).length;
  const progress =
    session.items.length === 0 ? 0 : Math.round((doneCount / session.items.length) * 100);

  // 記録はブロック名のスナップショットでまとめて表示する（順序は sortOrder のまま）
  const groups: Array<{ name: string; items: typeof session.items }> = [];
  for (const item of session.items) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.blockNameSnapshot) last.items.push(item);
    else groups.push({ name: item.blockNameSnapshot, items: [item] });
  }

  const blockNames = [...new Set(session.items.map((i) => i.blockNameSnapshot))];

  const info = [
    { label: "対象", value: session.groupName },
    { label: "場所", value: session.location },
    { label: "天候", value: session.weather },
    { label: "コンディション", value: session.condition },
  ].filter((row) => Boolean(row.value));

  return (
    <>
      <PageHeader
        title={session.title}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge className={SESSION_STATUS_COLOR[status]}>
              {SESSION_STATUS_LABEL[status] ?? session.status}
            </Badge>
            <span className="text-sm text-slate-600">{formatDate(session.date)}</span>
            <span className="text-xs text-slate-400">（{relativeDays(session.date)}）</span>
            {session.sourceMenuTemplate ? (
              <Link
                href={`/menus/${session.sourceMenuTemplate.id}`}
                className="text-xs text-indigo-600 hover:underline"
              >
                元メニュー：{session.sourceMenuTemplate.name}
              </Link>
            ) : session.sourceMenuNameSnapshot ? (
              <span className="text-xs text-slate-400">
                元メニュー：{session.sourceMenuNameSnapshot}（削除済み）
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            {status !== "COMPLETED" && (
              <form action={setSessionStatusAction}>
                <input type="hidden" name="id" value={session.id} />
                <input type="hidden" name="status" value="COMPLETED" />
                <SubmitButton>練習を完了にする</SubmitButton>
              </form>
            )}
            {status === "COMPLETED" && (
              <form action={setSessionStatusAction}>
                <input type="hidden" name="id" value={session.id} />
                <input type="hidden" name="status" value="IN_PROGRESS" />
                <SubmitButton variant="secondary">完了を取り消す</SubmitButton>
              </form>
            )}
            <LinkButton href={`/sessions/${session.id}/edit`} variant="secondary">
              編集
            </LinkButton>
            <form action={deleteSessionAction}>
              <input type="hidden" name="id" value={session.id} />
              <ConfirmSubmitButton size="md" message="この練習記録を削除します。よろしいですか？">
                削除
              </ConfirmSubmitButton>
            </form>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <Card>
            <CardHeader className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-700">実施項目</h2>
              <span className="text-xs text-slate-500">
                {doneCount} / {session.items.length} 実施済み
              </span>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>

              {session.items.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">
                  項目がありません。下から追加できます。
                </p>
              ) : (
                groups.map((group, gi) => (
                  <div key={`${group.name}-${gi}`}>
                    <h3 className="mb-1.5 text-xs font-bold tracking-wide text-slate-500">
                      {group.name}
                    </h3>
                    <ul className="space-y-1.5">
                      {group.items.map((item) => (
                        <SessionItemRow
                          key={item.id}
                          sessionId={session.id}
                          item={item}
                          index={session.items.indexOf(item)}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              )}

              <AddSessionItemForm
                sessionId={session.id}
                exercises={exercises}
                blockNames={blockNames}
              />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          {info.length > 0 && (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-semibold text-slate-700">実施条件</h2>
              </CardHeader>
              <CardBody>
                <dl className="space-y-1.5 text-sm">
                  {info.map((row) => (
                    <div key={row.label} className="flex gap-2">
                      <dt className="w-28 shrink-0 text-xs text-slate-400">{row.label}</dt>
                      <dd className="text-slate-700">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>
          )}

          <Card className={session.coachNote ? "border-slate-200" : "border-dashed"}>
            <CardHeader>
              <h2 className="text-sm font-semibold text-slate-700">コーチ所感</h2>
            </CardHeader>
            <CardBody>
              {session.coachNote ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-700">
                  {session.coachNote}
                </p>
              ) : (
                <p className="text-sm text-slate-400">
                  <Link
                    href={`/sessions/${session.id}/edit`}
                    className="text-indigo-600 hover:underline"
                  >
                    編集画面
                  </Link>
                  から振り返りを残せます。
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
