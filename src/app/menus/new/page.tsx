import { PageHeader } from "@/components/ui";
import { TrainingProposalComposer } from "@/components/menu/training-proposal-composer";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";

export const metadata = { title: "メニューを作成｜SACHIZU" };

/** 種目ピッカーは DB 由来。ビルド時に固定しないよう request time で読む。 */
export const dynamic = "force-dynamic";

/** 条件を確認し、練習候補から今回採用する内容を組み立てる。 */
export default async function NewMenuPage() {
  const exercises = await listComposerCatalog(DEFAULT_OWNER_ID);

  return (
    <>
      <PageHeader
        title="メニューを作成"
        description="場所・選手・目的に合わせて練習を提案します。取り組む種目を選び、編集して保存できます。"
      />
      <TrainingProposalComposer catalog={exercises} />
    </>
  );
}
