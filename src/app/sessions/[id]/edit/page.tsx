import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { SessionForm, type SessionFormValues } from "@/components/session/session-form";
import { updateSessionAction } from "@/actions/session-actions";
import { findSession } from "@/infra/repositories/session-repository";
import { toDateInputValue } from "@/lib/format";

export default async function EditSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await findSession(id);
  if (!session) notFound();

  const initial: SessionFormValues = {
    title: session.title,
    date: toDateInputValue(session.date),
    groupName: session.groupName ?? "",
    location: session.location ?? "",
    weather: session.weather ?? "",
    condition: session.condition ?? "",
    status: session.status,
    coachNote: session.coachNote ?? "",
  };

  return (
    <>
      <PageHeader title="練習記録を編集" description={session.title} />
      <SessionForm
        action={updateSessionAction.bind(null, session.id)}
        initial={initial}
        submitLabel="保存する"
        cancelHref={`/sessions/${session.id}`}
      />
    </>
  );
}
