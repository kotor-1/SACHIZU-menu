"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { changeAppPassword, createAppMember, deleteAppMember, registerFirstAppAdmin, signInAppUser } from "@/application/app-auth/sign-in";
import { appAuthDeps } from "@/infra/auth/app-auth-deps";
import { APP_SESSION_COOKIE, appSessionCookieOptions, appSessionExpiry, appSessionIdFromToken, newAppSessionToken, safeNextPath } from "@/infra/auth/app-session";
import { currentAppSession } from "@/infra/auth/current-app-user";
import { createAppSession, deleteAppSession, listAppUsers } from "@/infra/repositories/app-user-repository";

/** values は、エラーのあとも入力欄に残す値（パスワードは含めない）。 */
export type AppAuthFormState = { ok: boolean; message: string; values?: Record<string, string> } | null;
const keep = (formData: FormData, ...names: string[]) => Object.fromEntries(names.map(name => [name, String(formData.get(name) ?? "").slice(0, 64)]));

async function startSession(userId: string) {
  const token = newAppSessionToken();
  const expiresAt = appSessionExpiry(new Date());
  await createAppSession({ id: appSessionIdFromToken(token)!, userId, expiresAt });
  (await cookies()).set(APP_SESSION_COOKIE, token, appSessionCookieOptions(expiresAt));
}

/** 最初の管理者を作り、そのままログインする。 */
export async function registerFirstAppAdminAction(_previous: AppAuthFormState, formData: FormData): Promise<AppAuthFormState> {
  const result = await registerFirstAppAdmin(Object.fromEntries(formData), appAuthDeps());
  if (!result.ok) return { ok: false, message: result.message, values: keep(formData, "setupCode", "loginId") };
  await startSession(result.userId);
  redirect("/");
}

export async function signInAppAction(_previous: AppAuthFormState, formData: FormData): Promise<AppAuthFormState> {
  const result = await signInAppUser(Object.fromEntries(formData), appAuthDeps());
  if (!result.ok) return { ok: false, message: result.message, values: keep(formData, "loginId") };
  await startSession(result.userId);
  redirect(safeNextPath(String(formData.get("next") ?? "")));
}

export async function signOutAppAction() {
  const store = await cookies();
  const sessionId = appSessionIdFromToken(store.get(APP_SESSION_COOKIE)?.value);
  if (sessionId) await deleteAppSession(sessionId);
  store.delete(APP_SESSION_COOKIE);
  redirect("/login");
}

export async function createAppMemberAction(_previous: AppAuthFormState, formData: FormData): Promise<AppAuthFormState> {
  const session = await currentAppSession();
  if (!session) return { ok: false, message: "ログインしてください。" };
  const result = await createAppMember(session.user, Object.fromEntries(formData), appAuthDeps());
  if (!result.ok) return { ok: false, message: result.message, values: keep(formData, "loginId", "role") };
  revalidatePath("/settings");
  return { ok: true, message: "利用者を追加しました。ログインIDとパスワードを本人に伝えてください。" };
}

export async function deleteAppMemberAction(formData: FormData) {
  const session = await currentAppSession();
  if (!session) redirect("/login");
  await deleteAppMember(session.user, String(formData.get("userId") ?? ""), await listAppUsers(), appAuthDeps());
  revalidatePath("/settings");
}

export async function changeAppPasswordAction(_previous: AppAuthFormState, formData: FormData): Promise<AppAuthFormState> {
  const session = await currentAppSession();
  if (!session) return { ok: false, message: "ログインしてください。" };
  const result = await changeAppPassword(session.user, session.sessionId, Object.fromEntries(formData), appAuthDeps());
  return result.ok ? { ok: true, message: "パスワードを変更しました。ほかの端末では、もう一度ログインが必要です。" } : { ok: false, message: result.message };
}
