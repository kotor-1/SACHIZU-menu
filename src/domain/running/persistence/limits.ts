/**
 * Running Prescription Engine v2 — 永続化時のサイズ上限と健康情報キーの検査（§19.2・§13.5）。
 *
 * [R9] SQLite に CHECK 制約は入れない（§19.2）。整合はアプリ層（repository の書込み前）で保証する。
 *   - JSON の上限は **UTF-8 のバイト数**で数える（`32KB = 32 * 1024 bytes`）。文字列の length（UTF-16 code unit）で
 *     代用しない（日本語は1文字 3 bytes のため、length だけでは上限を超えた JSON を通してしまう）。
 *   - rationale の上限は **文字数（Unicode code point 数）**で数える。
 */

export const BYTES_PER_KB = 1024;
export const PRESCRIPTION_JSON_MAX_BYTES = 32 * BYTES_PER_KB;
export const PROVENANCE_JSON_MAX_BYTES = 16 * BYTES_PER_KB;
export const ACTUAL_REP_LOG_JSON_MAX_BYTES = 64 * BYTES_PER_KB;
export const RATIONALE_MAX_CHARS = 4000;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** 上限を超えていれば issue 文字列を返す（内容そのものは issue に含めない）。 */
export function jsonByteLimitIssue(column: string, raw: string, maxBytes: number): string | null {
  const bytes = utf8ByteLength(raw);
  return bytes > maxBytes ? `${column}: UTF-8 で ${bytes} bytes あり、上限 ${maxBytes} bytes を超えています` : null;
}

/**
 * 実施ログ（R11 で書込み flow を作る）の上限検査 primitive。R9 では書込み API を作らない。
 */
export function actualRepLogJsonByteLimitIssue(raw: string): string | null {
  return jsonByteLimitIssue("actualRepLogJson", raw, ACTUAL_REP_LOG_JSON_MAX_BYTES);
}

/**
 * §13.5: 選手の健康情報（痛み・部位・red flag・尺度・報告者・生年月日・性別）を永続化 JSON に持たせない。
 * キー名（小文字化）がこの断片を含めば拒否する。strict schema に加えた二重の防御であり、
 * 値（自由記述）の意味までは判定しない。
 */
export const FORBIDDEN_HEALTH_KEY_FRAGMENTS = [
  "pain",
  "redflag",
  "soreness",
  "fatigue",
  "sleep",
  "birthdate",
  "sexfornorms",
  "athletereport",
  "readinessreport",
  "bodyregion",
  "reporter",
  "reportedat",
] as const;

/** 健康情報に該当するキーのパス（例 `inputsDigest.pain`）を返す。値は返さない。 */
export function findForbiddenHealthKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findForbiddenHealthKeys(v, `${path}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    const lower = key.toLowerCase();
    if (FORBIDDEN_HEALTH_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment))) found.push(childPath);
    found.push(...findForbiddenHealthKeys(child, childPath));
  }
  return found;
}
