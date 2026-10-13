import { redirect } from "next/navigation";
import { FirstAdminForm, SignInForm } from "@/components/auth/auth-forms";
import { appAuthRequired, configuredSetupCode, safeNextPath } from "@/infra/auth/app-session";
import { currentAppSession } from "@/infra/auth/current-app-user";
import { countAppUsers } from "@/infra/repositories/app-user-repository";

export const metadata = { title: "ログイン｜SACHIZU" };

/** DB を読むため、ビルド時に固定せず毎回サーバーで描画する。 */
export const dynamic = "force-dynamic";

/** 利用者がまだいなければ初回登録、いればログイン。 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!appAuthRequired()) redirect("/");
  if (await currentAppSession()) redirect("/");
  const { next } = await searchParams;
  const firstRun = await countAppUsers() === 0;
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <div className="border-t-2 border-slate-900 bg-white px-5 pt-5 pb-6">
        <p className="text-xs font-bold tracking-wider text-indigo-700">SACHIZU 練習メニュー</p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">{firstRun ? "はじめての登録" : "ログイン"}</h1>
        <p className="mt-1.5 mb-5 text-sm leading-relaxed text-slate-600">
          {firstRun ? "最初に登録した人が管理者になります。ほかの人は、管理者が「設定」から追加します。" : "ログインIDとパスワードを入力してください。"}
        </p>
        {firstRun ? <FirstAdminForm setupConfigured={configuredSetupCode() !== null} /> : <SignInForm next={safeNextPath(next)} />}
      </div>
    </div>
  );
}
