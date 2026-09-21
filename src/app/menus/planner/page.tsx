import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { listMenusForPicker } from "@/infra/repositories/menu-repository";
import { MenuPlannerClient } from "@/components/menu-planner/menu-planner-client";

export const metadata = { title: "メニューを考える｜SACHIZU" };

/** DB-backed source choices must be read at request time, not frozen at build time. */
export const dynamic = "force-dynamic";

/**
 * MenuPlanner の入口。参照メニューは server-side で owner scope を適用し、
 * Client Component へは選択に必要な id/name だけを渡す。
 */
export default async function MenuPlannerPage() {
  const menus = await listMenusForPicker();
  const contextMenus = menus.map((menu) => ({ id: menu.id, name: menu.name }));

  return (
    <>
      <PageHeader
        title="練習メニューを考える"
        description="コーチの希望をもとに、確認・修正できる下書きを作成します。"
        actions={<LinkButton href="/menus" variant="secondary">メニュー一覧へ</LinkButton>}
      />

      {contextMenus.length === 0 ? (
        <EmptyState
          title="参照するメニューがありません"
          description="先に練習メニューを1つ作成してから、Plannerをお使いください。"
          action={<LinkButton href="/menus/new">メニューを作成</LinkButton>}
        />
      ) : (
        <MenuPlannerClient contextMenus={contextMenus} />
      )}
    </>
  );
}
