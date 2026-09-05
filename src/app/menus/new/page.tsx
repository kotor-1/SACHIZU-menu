import { PageHeader } from "@/components/ui";
import { EMPTY_MENU_FORM, MenuForm } from "@/components/menu/menu-form";
import { createMenuAction } from "@/actions/menu-actions";

export const metadata = { title: "メニューを作成｜SACHIZU" };

export default function NewMenuPage() {
  return (
    <>
      <PageHeader
        title="メニューを作成"
        description="まず名前と狙いを決めます。種目の中身は次の画面で組み立てます。"
      />
      <MenuForm
        action={createMenuAction}
        initial={EMPTY_MENU_FORM}
        submitLabel="作成して中身を組む"
        cancelHref="/menus"
        showDefaultBlocksOption
      />
    </>
  );
}
