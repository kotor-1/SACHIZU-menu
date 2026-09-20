import { PageHeader } from "@/components/ui";
import { NewSessionFromMenu } from "@/components/session/new-session-from-menu";
import { SessionForm } from "@/components/session/session-form";
import { createSessionAction } from "@/actions/session-actions";
import { listMenusForPicker } from "@/infra/repositories/menu-repository";
import { isRunningV2UiEnabled } from "@/lib/feature-flags";
import { todayInputValue } from "@/lib/format";

/** DB を直接読むため、ビルド時に固定せず毎回サーバーで描画する。 */
export const dynamic = "force-dynamic";


export const metadata = { title: "練習を作成｜SACHIZU" };

export default async function NewSessionPage() {
  const menus = await listMenusForPicker();

  return (
    <>
      <PageHeader
        title="練習を作成"
        description="メニューから起こすのが基本です。単発の練習は空から作れます。"
      />

      <div className="space-y-6">
        <NewSessionFromMenu menus={menus} runningV2Enabled={isRunningV2UiEnabled()} />

        <div>
          <h2 className="mb-2 text-sm font-semibold text-slate-500">
            メニューを使わずに作る
          </h2>
          <SessionForm
            action={createSessionAction}
            initial={{
              title: "",
              date: todayInputValue(),
              groupName: "",
              location: "",
              weather: "",
              condition: "",
              status: "PLANNED",
              coachNote: "",
            }}
            submitLabel="空の練習記録を作成"
            cancelHref="/sessions"
          />
        </div>
      </div>
    </>
  );
}
