/**
 * HMAC-SHA256 signed token（R12-A3A）。§18.6 [R12-A1] の
 * 「preview binding の HMAC / digest / revision token の具体実装は application phase」に対応する実装層。
 *
 * Server-only: node:crypto を使うため client bundle へ出さない（`src/application/menu-planner/binding.ts` と同じ
 * prose convention。repo に `server-only` package は入っていない）。domain からは import しない。
 *
 * 形式:
 *   token = base64url(payload bytes) "." base64url(HMAC-SHA256(key, payload bytes))
 *
 * 設計上の要点:
 *   - payload bytes は呼び出し側が決める（canonical JSON）。ここは bytes をそのまま扱う。
 *   - signature 比較は `timingSafeEqual`（constant-time）。`===` は使わない。
 *   - base64url は alphabet 検証 + round-trip 検証で **canonical な表現だけ**を受け付ける。
 *   - UTF-8 は fatal decoder で厳密に検証する（不正 byte 列を黙って置換しない）。
 *   - 巨大 input は decode 前に長さ上限で弾く。
 *   - 例外・期待値・実値は一切外へ出さない（呼び出し側は種類だけを受け取り、安全な error に畳む）。
 *
 * 契約の正確な範囲:
 *   - `verifyHmacToken` は「署名された bytes」を UTF-8 として解釈した文字列を返す。UTF-8 decoder は
 *     strict（不正 byte 列は拒否）だが、string としての完全な同一性は保証しない（先頭 BOM は落ちる）。
 *     本 repo の唯一の入力は `canonicalStringify` が作る JSON（先頭は `{`）であり、この差は到達しない。
 *   - 鍵長の下限は **長さの検査だけ**で、エントロピーは測れない。高エントロピーな秘密の配置は
 *     server composition の責務（この module は default fallback を持たない）。
 *   - `keyBytes` は最初に鍵を使う時点で検証される（malformed token では鍵に触れない）。application 境界は
 *     `assertUsableSigningKey` を先に呼び、compose 異常を token 不正として隠さない。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** 署名方式。独自方式は使わない（§18.6 の frozen design）。 */
export const HMAC_TOKEN_ALGORITHM = "sha256" as const;

/**
 * 鍵長の下限。**implementation safety constant** であり domain rule ではない
 * （HMAC-SHA256 の security floor に合わせた実装上の下限。production の鍵配置は server composition の責務）。
 */
export const HMAC_TOKEN_MIN_KEY_BYTES = 32;

/**
 * decode 前に弾く token 長の上限（巨大 input 対策の **implementation safety constant**。業務 rule ではない）。
 *
 * 値は「schema 上ありうる最大 payload より必ず大きい」ように取る:
 *   proposal 20 item × (reason 300 字 + blockName 80 字 + id) ≈ 25 KB、
 *   constraints + requestDigest + identity / hash ≈ 2 KB → 生で ~27 KB。
 *   日本語は UTF-8 で 1 文字 3 byte、base64url で 4/3 倍 → 符号化後 ~36 KB。
 * 256 KiB はその約 7 倍で、schema 合法な token がこの上限で検証不能になることはない。
 */
export const HMAC_TOKEN_MAX_LENGTH = 256 * 1024;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TOKEN_SEGMENT_COUNT = 2;

export class InvalidSigningKeyError extends Error {
  readonly name = "InvalidSigningKeyError";
  constructor(readonly reason: "EMPTY" | "TOO_SHORT" | "INVALID_TYPE") {
    super("HMAC signing key is not usable");
  }
}

export type HmacSigningKey = string | Uint8Array;

/** 鍵を bytes へ正規化する。空・短すぎる・型違いは署名前に落とす（**default fallback は持たない**）。 */
function keyBytes(key: HmacSigningKey): Buffer {
  if (typeof key !== "string" && !(key instanceof Uint8Array)) throw new InvalidSigningKeyError("INVALID_TYPE");
  const bytes = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  if (bytes.length === 0) throw new InvalidSigningKeyError("EMPTY");
  if (bytes.length < HMAC_TOKEN_MIN_KEY_BYTES) throw new InvalidSigningKeyError("TOO_SHORT");
  return bytes;
}

export type HmacTokenFailureKind = "MALFORMED" | "SIGNATURE_MISMATCH";

export type HmacTokenVerifyResult =
  | { ok: true; payload: string }
  | { ok: false; kind: HmacTokenFailureKind };

function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** alphabet 検証 + round-trip 検証。canonical でない表現は null。 */
function base64UrlDecode(segment: string): Buffer | null {
  if (segment.length === 0 || !BASE64URL_PATTERN.test(segment)) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(segment, "base64url");
  } catch {
    return null;
  }
  // 非 canonical（長さ不正・trailing bit など）は round-trip で落ちる。
  if (base64UrlEncode(decoded) !== segment) return null;
  return decoded;
}

/** payload bytes を署名して token を作る。 */
export function signHmacToken(payload: string, key: HmacSigningKey): string {
  const payloadBytes = Buffer.from(payload, "utf8");
  const signature = createHmac(HMAC_TOKEN_ALGORITHM, keyBytes(key)).update(payloadBytes).digest();
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`;
}

/**
 * token を **署名検証してから** payload 文字列を返す。
 * 失敗は種類だけを返し、期待値・実値・例外内容は外へ出さない。
 */
export function verifyHmacToken(token: string, key: HmacSigningKey): HmacTokenVerifyResult {
  if (typeof token !== "string" || token.length === 0 || token.length > HMAC_TOKEN_MAX_LENGTH) {
    return { ok: false, kind: "MALFORMED" };
  }
  const segments = token.split(".");
  if (segments.length !== TOKEN_SEGMENT_COUNT) return { ok: false, kind: "MALFORMED" };

  const payloadBytes = base64UrlDecode(segments[0]!);
  const presentedSignature = base64UrlDecode(segments[1]!);
  if (payloadBytes === null || presentedSignature === null) return { ok: false, kind: "MALFORMED" };

  const expectedSignature = createHmac(HMAC_TOKEN_ALGORITHM, keyBytes(key)).update(payloadBytes).digest();
  // 長さは秘密ではないため先に比較してよい（`timingSafeEqual` は長さ不一致で throw する）。
  if (presentedSignature.length !== expectedSignature.length) return { ok: false, kind: "SIGNATURE_MISMATCH" };
  if (!timingSafeEqual(presentedSignature, expectedSignature)) return { ok: false, kind: "SIGNATURE_MISMATCH" };

  try {
    return { ok: true, payload: new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes) };
  } catch {
    return { ok: false, kind: "MALFORMED" };
  }
}

/** 鍵が署名・検証に使えるかの事前検査（composition 側の fail-fast 用）。 */
export function assertUsableSigningKey(key: HmacSigningKey): void {
  keyBytes(key);
}
