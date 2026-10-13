/**
 * 公開URL（Fly.io）全体を守る Basic 認証の判定。
 *
 * Server-only: node:crypto を使うため client bundle へ出さない（hmac-token.ts と同じ扱い）。
 *
 * 設計上の要点:
 *   - 本番でユーザー名かパスワードが未設定（または短すぎる）なら、開かずに止める（fail closed）。
 *     開発・テストでは未設定のまま使えるよう、そのまま通す。
 *   - 比較は SHA-256 digest 同士の `timingSafeEqual`。長さの違いも時間差で漏らさない。
 *     ユーザー名とパスワードは必ず両方比べ、どちらが違ったかを時間で区別させない。
 *   - 期待値・入力値は一切返さない（呼び出し側は判定の種類だけを受け取る）。
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type BasicAuthDecision = "ALLOW" | "CHALLENGE" | "NOT_CONFIGURED";
export type BasicAuthSettings = { user: string | undefined; password: string | undefined; production: boolean };

/** 公開URLを守るのに短すぎるパスワードは、設定されていても未設定として扱う。 */
export const BASIC_AUTH_MIN_PASSWORD_LENGTH = 12;
/** decode 前に弾くヘッダー長の上限（巨大 input 対策の implementation safety constant）。 */
const MAX_HEADER_LENGTH = 1024;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
const sameText = (actual: string, expected: string) => timingSafeEqual(digest(actual), digest(expected));

export function basicAuthDecision(authorization: string | null, settings: BasicAuthSettings): BasicAuthDecision {
  const { user, password } = settings;
  if (!user || !password || password.length < BASIC_AUTH_MIN_PASSWORD_LENGTH) return settings.production ? "NOT_CONFIGURED" : "ALLOW";
  if (!authorization || authorization.length > MAX_HEADER_LENGTH) return "CHALLENGE";
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/u.exec(authorization.trim());
  if (!match) return "CHALLENGE";
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return "CHALLENGE";
  const userMatches = sameText(decoded.slice(0, separator), user);
  const passwordMatches = sameText(decoded.slice(separator + 1), password);
  return userMatches && passwordMatches ? "ALLOW" : "CHALLENGE";
}
