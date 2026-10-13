"use client";

import { useActionState } from "react";
import { Button, Field, INPUT_CLASS } from "@/components/ui";
import {
  changeAppPasswordAction, createAppMemberAction, registerFirstAppAdminAction, signInAppAction, type AppAuthFormState,
} from "@/actions/app-auth-actions";
import { APP_PASSWORD_MIN_LENGTH } from "@/domain/app-auth/credentials";

const loginIdProps = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false, inputMode: "text", maxLength: 32 } as const;

/** 送信のたびに作り直し、残す値（state.values）を入力欄の初期値にする。 */
const formKey = (state: AppAuthFormState) => (state ? JSON.stringify(state) : "initial");

function Message({ state }: { state: AppAuthFormState }) {
  if (!state) return null;
  return <p role={state.ok ? "status" : "alert"} className={`border-l-4 px-3 py-2 text-sm ${state.ok ? "border-emerald-600 bg-emerald-50 text-emerald-900" : "border-rose-600 bg-rose-50 text-rose-900"}`}>{state.message}</p>;
}

export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInAppAction, null);
  return <form key={formKey(state)} action={action} className="space-y-4">
    <input type="hidden" name="next" value={next} />
    <Field label="ログインID"><input name="loginId" required autoComplete="username" defaultValue={state?.values?.loginId} className={INPUT_CLASS} {...loginIdProps} /></Field>
    <Field label="パスワード"><input name="password" type="password" required autoComplete="current-password" className={INPUT_CLASS} /></Field>
    <Message state={state} />
    <Button type="submit" size="lg" className="w-full" disabled={pending}>{pending ? "確認しています…" : "ログイン"}</Button>
  </form>;
}

export function FirstAdminForm({ setupConfigured }: { setupConfigured: boolean }) {
  const [state, action, pending] = useActionState(registerFirstAppAdminAction, null);
  if (!setupConfigured) return <p className="border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900">初回登録コードが設定されていないため、まだ登録できません。</p>;
  return <form key={formKey(state)} action={action} className="space-y-4">
    <Field label="初回登録コード" hint="案内されたコード"><input name="setupCode" required autoComplete="one-time-code" defaultValue={state?.values?.setupCode} className={INPUT_CLASS} {...loginIdProps} /></Field>
    <Field label="ログインID" hint="3〜32文字の英数字と . _ -"><input name="loginId" required autoComplete="username" defaultValue={state?.values?.loginId} className={INPUT_CLASS} {...loginIdProps} /></Field>
    <Field label="パスワード" hint={`${APP_PASSWORD_MIN_LENGTH}文字以上`}><input name="password" type="password" required minLength={APP_PASSWORD_MIN_LENGTH} autoComplete="new-password" className={INPUT_CLASS} /></Field>
    <Field label="パスワード（確認）"><input name="passwordConfirm" type="password" required autoComplete="new-password" className={INPUT_CLASS} /></Field>
    <Message state={state} />
    <Button type="submit" size="lg" variant="accent" className="w-full" disabled={pending}>{pending ? "登録しています…" : "登録して始める"}</Button>
  </form>;
}

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changeAppPasswordAction, null);
  return <form key={formKey(state)} action={action} className="space-y-4">
    <Field label="今のパスワード"><input name="currentPassword" type="password" required autoComplete="current-password" className={INPUT_CLASS} /></Field>
    <Field label="新しいパスワード" hint={`${APP_PASSWORD_MIN_LENGTH}文字以上`}><input name="password" type="password" required minLength={APP_PASSWORD_MIN_LENGTH} autoComplete="new-password" className={INPUT_CLASS} /></Field>
    <Field label="新しいパスワード（確認）"><input name="passwordConfirm" type="password" required autoComplete="new-password" className={INPUT_CLASS} /></Field>
    <Message state={state} />
    <Button type="submit" variant="secondary" disabled={pending}>{pending ? "変更しています…" : "パスワードを変更"}</Button>
  </form>;
}

export function AddMemberForm() {
  const [state, action, pending] = useActionState(createAppMemberAction, null);
  return <form key={formKey(state)} action={action} className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="ログインID" hint="3〜32文字の英数字と . _ -"><input name="loginId" required autoComplete="off" defaultValue={state?.values?.loginId} className={INPUT_CLASS} {...loginIdProps} /></Field>
      <Field label="権限"><select name="role" defaultValue={state?.values?.role === "ADMIN" ? "ADMIN" : "MEMBER"} className={INPUT_CLASS}><option value="MEMBER">メンバー</option><option value="ADMIN">管理者（利用者を追加できる）</option></select></Field>
      <Field label="最初のパスワード" hint={`${APP_PASSWORD_MIN_LENGTH}文字以上`}><input name="password" type="password" required minLength={APP_PASSWORD_MIN_LENGTH} autoComplete="new-password" className={INPUT_CLASS} /></Field>
      <Field label="最初のパスワード（確認）"><input name="passwordConfirm" type="password" required autoComplete="new-password" className={INPUT_CLASS} /></Field>
    </div>
    <Message state={state} />
    <Button type="submit" disabled={pending}>{pending ? "追加しています…" : "利用者を追加"}</Button>
  </form>;
}
