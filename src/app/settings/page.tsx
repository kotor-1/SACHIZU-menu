import { redirect } from "next/navigation";
import { Button, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { AddMemberForm, ChangePasswordForm } from "@/components/auth/auth-forms";
import { deleteAppMemberAction, signOutAppAction } from "@/actions/app-auth-actions";
import { APP_ROLE_LABELS } from "@/domain/app-auth/credentials";
import { appAuthRequired } from "@/infra/auth/app-session";
import { currentAppSession } from "@/infra/auth/current-app-user";
import { listAppUsers } from "@/infra/repositories/app-user-repository";
import { formatDate } from "@/lib/format";

export const metadata = { title: "設定｜SACHIZU" };

/** DB を読むため、ビルド時に固定せず毎回サーバーで描画する。 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  if (!appAuthRequired()) {
    return <>
      <PageHeader title="設定" />
      <p className="text-sm text-slate-600">この環境（手元の開発）ではログインを使っていません。公開URLでは、ここでパスワードの変更や利用者の追加ができます。</p>
    </>;
  }
  const session = await currentAppSession();
  if (!session) redirect("/login?next=%2Fsettings");
  const { user } = session;
  const users = user.role === "ADMIN" ? await listAppUsers() : [];
  const admins = users.filter(entry => entry.role === "ADMIN").length;

  return <>
    <PageHeader title="設定" description={`ログイン中：${user.loginId}（${APP_ROLE_LABELS[user.role]}）`}
      actions={<form action={signOutAppAction}><Button type="submit" variant="secondary">ログアウト</Button></form>} />
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><h2 className="text-sm font-bold text-slate-900">パスワードの変更</h2></CardHeader>
        <CardBody><ChangePasswordForm /></CardBody>
      </Card>
      {user.role === "ADMIN" && <Card>
        <CardHeader><h2 className="text-sm font-bold text-slate-900">利用者</h2></CardHeader>
        <CardBody className="space-y-6">
          <ul className="divide-y divide-slate-200 border-y border-slate-200">
            {users.map(entry => <li key={entry.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">{entry.loginId}{entry.id === user.id && <span className="ml-2 text-xs font-medium text-slate-500">（自分）</span>}</p>
                <p className="text-xs text-slate-600">{APP_ROLE_LABELS[entry.role]}・{formatDate(entry.createdAt)} 追加</p>
              </div>
              {entry.id !== user.id && !(entry.role === "ADMIN" && admins <= 1) && <form action={deleteAppMemberAction}>
                <input type="hidden" name="userId" value={entry.id} />
                <ConfirmSubmitButton message={`${entry.loginId} を削除しますか？この人はログインできなくなります。`}>削除</ConfirmSubmitButton>
              </form>}
            </li>)}
          </ul>
          <div>
            <h3 className="mb-3 text-sm font-bold text-slate-900">利用者を追加</h3>
            <AddMemberForm />
          </div>
        </CardBody>
      </Card>}
    </div>
  </>;
}
