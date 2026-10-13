/**
 * アプリへのログイン状態（cookie とその照合用の値）。
 *
 * Server-only: node:crypto を使う。cookie には乱数の値だけを入れ、DB にはその SHA-256 を置く。
 * DB の中身が読まれても、そのままログインには使えない。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const APP_SESSION_COOKIE = "sachizu_session";
export const APP_SESSION_DAYS = 30;
const TOKEN_BYTES = 32;

/** 公開URL（本番）では必ずログインを求める。手元の開発では、明示したときだけ求める。 */
export function appAuthRequired(): boolean {
  return process.env.NODE_ENV === "production" || process.env.APP_AUTH_ENABLED === "true";
}

export function newAppSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** cookie の値から、DB に置く照合用の id を作る。形式が違う値は null。 */
export function appSessionIdFromToken(token: string | undefined | null): string | null {
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function appSessionExpiry(now: Date): Date {
  return new Date(now.getTime() + APP_SESSION_DAYS * 24 * 60 * 60 * 1000);
}

export function appSessionCookieOptions(expiresAt: Date) {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", expires: expiresAt };
}

/** 初回登録コードの表記ゆれ（ハイフン・空白・小文字）を吸収する。 */
const normalizeSetupCode = (value: string) => value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");

/** 初回登録コードを、長さの違いも含めて一定時間で比べる。 */
export function setupCodeMatches(input: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(normalizeSetupCode(value), "utf8").digest();
  return timingSafeEqual(digest(input), digest(expected));
}

/** 初回登録コードとして使える設定値か（英数字8文字未満では初回登録を開かない）。 */
export function configuredSetupCode(): string | null {
  const code = process.env.ACCOUNT_SETUP_CODE ?? "";
  return normalizeSetupCode(code).length >= 8 ? code : null;
}

/**
 * ログイン後に戻る先。自分のサイト内の相対パスだけを許し、外部サイトへは飛ばさない。
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f]/u.test(next)) return "/";
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login/")) return "/";
  return next;
}
