import { PageHeader } from "@/components/ui";
import { FreeformMenuComposer } from "@/components/menu/freeform-menu-composer";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";

export const metadata = { title: "メニューを作成｜SACHIZU" };

/** 種目ピッカーは DB 由来。ビルド時に固定しないよう request time で読む。 */
export const dynamic = "force-dynamic";

/**
 * 統合メニュー Composer。AI 生成と手動編集を 1 つの画面に統合する。
 * AI 生成結果は保存前の下書きとして同じ画面に表示され、保存して初めて MenuTemplate になる。
 */
export default async function NewMenuPage() {
  const exercises = await listComposerCatalog(DEFAULT_OWNER_ID);

  return (
    <>
      <PageHeader
        title="メニューを作成"
        description="希望を自然文で伝えると AI が下書きを作ります。そのまま並べ替え・編集して保存できます。"
      />
      <FreeformMenuComposer exercises={exercises} />
    </>
  );
}
