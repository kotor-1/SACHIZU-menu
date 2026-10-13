import type { AppRole } from "@/domain/app-auth/credentials";
import { safeNextPath } from "./app-session";

export type AppAuthGateDecision = { kind: "ALLOW" } | { kind: "REDIRECT"; location: string } | { kind: "UNAUTHORIZED" } | { kind: "FORBIDDEN" };

/** ログインしていなくても開ける場所（ログイン画面・ヘルスチェック・画面の表示に要るファイル）。 */
export function isPublicAppPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/healthz" || pathname === "/favicon.ico"
    || pathname.startsWith("/_next/static/") || pathname.startsWith("/_next/image");
}

/**
 * 管理者だけが使う場所。種目の登録・編集・削除・お気に入り（全員で共有する種目一覧への書き込み）と、
 * 動画解析。メンバーの練習には関係しない。
 * 動画解説（/video-guidance）は専用のログインがあるので、ここでは扱わない。
 */
export function isAdminOnlyAppPath(pathname: string, method: string): boolean {
  if (/^\/ai(?:\/|$)/u.test(pathname)) return true;
  if (pathname === "/exercises/new" || /^\/exercises\/[^/]+\/edit\/?$/u.test(pathname)) return true;
  // 種目のページでの保存・削除・お気に入りは、どれも Server Action（POST）で届く。
  return /^\/exercises(?:\/|$)/u.test(pathname) && method !== "GET" && method !== "HEAD";
}

/**
 * 入口での判定。ログインが要らない環境と公開してよい場所はそのまま通す。
 * それ以外はログイン状態を確かめ、画面ならログイン画面へ案内し、保存などの操作は断る。
 * メンバーが管理者だけの場所を開いたら、画面ならホームへ戻し、操作は断る。
 */
export async function appAuthGate(input: {
  required: boolean; pathname: string; search: string; method: string; session: () => Promise<{ role: AppRole } | null>;
}): Promise<AppAuthGateDecision> {
  if (!input.required || isPublicAppPath(input.pathname)) return { kind: "ALLOW" };
  const page = input.method === "GET" || input.method === "HEAD";
  const session = await input.session();
  if (!session) {
    if (!page) return { kind: "UNAUTHORIZED" };
    const next = safeNextPath(`${input.pathname}${input.search}`);
    return { kind: "REDIRECT", location: next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}` };
  }
  if (session.role !== "ADMIN" && isAdminOnlyAppPath(input.pathname, input.method)) return page ? { kind: "REDIRECT", location: "/" } : { kind: "FORBIDDEN" };
  return { kind: "ALLOW" };
}
