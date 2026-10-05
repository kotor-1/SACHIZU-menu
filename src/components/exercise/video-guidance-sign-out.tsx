"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

export function VideoGuidanceSignOut() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      window.location.replace("/video-guidance/sign-in");
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return <div>
    <Button type="button" variant="secondary" onClick={signOut} disabled={pending}>
      {pending ? "ログアウト中…" : "ログアウト"}
    </Button>
    {failed && <p role="alert" className="mt-2 text-sm text-rose-700">ログアウトできませんでした。もう一度お試しください。</p>}
  </div>;
}
