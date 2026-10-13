/**
 * アプリへのログイン用のパスワード処理（scrypt）。
 *
 * Server-only: node:crypto を使うため client bundle へ出さない。
 * 保存形式: scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>。平文は保存しない。
 * 比較は timingSafeEqual。形式が壊れた値は「一致しない」として扱い、例外を外へ出さない。
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashAppPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyAppPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n !== N || r !== R || p !== P) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length !== SALT_BYTES || expected.length !== KEY_LENGTH) return false;
  try {
    return timingSafeEqual(await derive(password, salt, n, r, p), expected);
  } catch {
    return false;
  }
}
