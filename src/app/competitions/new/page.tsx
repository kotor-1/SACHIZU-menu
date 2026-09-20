import { createCompetitionAction } from "@/actions/competition-actions";
import { CompetitionForm, EMPTY_COMPETITION_FORM } from "@/components/competition/competition-form";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "大会を登録｜SACHIZU" };

export default function NewCompetitionPage() {
  return (
    <>
      <PageHeader title="大会を登録" description="開始日は必須です。複数日開催の場合だけ終了日を入力してください。" />
      <CompetitionForm
        action={createCompetitionAction}
        initial={EMPTY_COMPETITION_FORM}
        submitLabel="大会を登録"
        cancelHref="/competitions"
      />
    </>
  );
}
