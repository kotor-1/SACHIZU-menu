import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { MenuForm, type MenuFormValues } from "@/components/menu/menu-form";
import { updateMenuAction } from "@/actions/menu-actions";
import { findMenu } from "@/infra/repositories/menu-repository";

export default async function EditMenuPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const menu = await findMenu(id);
  if (!menu) notFound();

  const initial: MenuFormValues = {
    name: menu.name,
    description: menu.description ?? "",
    purpose: menu.purpose ?? "",
    phase: menu.phase ?? "",
    estimatedMinutes: menu.estimatedMinutes == null ? "" : String(menu.estimatedMinutes),
    status: menu.status,
    tags: menu.tags.map((t) => t.tag.name).join(", "),
  };

  return (
    <>
      <PageHeader title="メニュー情報を編集" description={menu.name} />
      <MenuForm
        action={updateMenuAction.bind(null, menu.id)}
        initial={initial}
        submitLabel="保存する"
        cancelHref={`/menus/${menu.id}`}
      />
    </>
  );
}
