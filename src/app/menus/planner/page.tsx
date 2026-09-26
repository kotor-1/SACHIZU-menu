import { redirect } from "next/navigation";

export const metadata = { title: "メニューを考える｜SACHIZU" };

/**
 * 旧 MenuPlanner の入口。AI 生成と手動編集は統合 Composer（/menus/new）に一本化した。
 * 旧フローのコード（MenuPlannerClient / operation-coordinator / generateMenuPlannerAction 等）は
 * テスト済みのため残し、到達しないようここで転送する。
 */
export default function MenuPlannerPage() {
  redirect("/menus/new");
}
