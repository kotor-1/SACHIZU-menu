import { safeNextPath } from "./app-session";

export type AppAuthGateDecision = { kind: "ALLOW" } | { kind: "REDIRECT"; location: string } | { kind: "UNAUTHORIZED" };

/** ログインしていなくても開ける場所（ログイン画面・ヘルスチェック・画面の表示に要るファイル）。 */
export function isPublicAppPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/healthz" || pathname === "/favicon.ico"
    || pathname.startsWith("/_next/static/") || pathname.startsWith("/_next/image");
}

/**
 * 入口での判定。ログインが要らない環境と公開してよい場所はそのまま通す。
 * それ以外はログイン状態を確かめ、画面ならログイン画面へ案内し、保存などの操作は断る。
 */
export async function appAuthGate(input: {
  required: boolean; pathname: string; search: string; method: string; signedIn: () => Promise<boolean>;
}): Promise<AppAuthGateDecision> {
  if (!input.required || isPublicAppPath(input.pathname)) return { kind: "ALLOW" };
  if (await input.signedIn()) return { kind: "ALLOW" };
  if (input.method === "GET" || input.method === "HEAD") {
    const next = safeNextPath(`${input.pathname}${input.search}`);
    return { kind: "REDIRECT", location: next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}` };
  }
  return { kind: "UNAUTHORIZED" };
}
