"use client";

import { useState, type FormEvent } from "react";
import { Button, Field, INPUT_CLASS } from "@/components/ui";

const failureMessage = "ログインできませんでした。入力内容を確認して、もう一度お試しください。";

export function VideoGuidanceSignIn() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(values.get("email") ?? "").trim(),
          password: String(values.get("password") ?? ""),
          rememberMe: false,
        }),
      });
      if (!response.ok) {
        setError(failureMessage);
        return;
      }
      form.reset();
      window.location.replace("/video-guidance");
    } catch {
      setError(failureMessage);
    } finally {
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
      setPending(false);
    }
  }

  return <form method="post" onSubmit={signIn} className="mt-6 space-y-4" aria-busy={pending}>
    <fieldset disabled={pending} className="space-y-4">
      <Field label="メールアドレス" required>
        <input className={INPUT_CLASS} type="email" name="email" autoComplete="username" required />
      </Field>
      <Field label="パスワード" required>
        <input className={INPUT_CLASS} type="password" name="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "ログイン中…" : "ログイン"}</Button>
    </fieldset>
    {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
  </form>;
}
