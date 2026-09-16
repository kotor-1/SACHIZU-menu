/**
 * Running Prescription Engine v2 — JSON 文字列列（prescriptionJson / provenanceJson / runningContextJson）の検証結果の型。
 *
 * [R9] 検証（parse）と保存（元の文字列）を分離する。ここで parse した値を stringify し直して保存しない。
 * 失敗理由は安全な理由コードだけを返し、Zod のメッセージや JSON の中身（健康情報を含みうる）を外へ出さない。
 */
import type { z } from "zod";
import { findForbiddenHealthKeys } from "./limits";

export type JsonColumnInvalidReason = "MISSING" | "JSON_SYNTAX_ERROR" | "SCHEMA_INVALID" | "HEALTH_DATA_PRESENT";

export type JsonColumnParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: JsonColumnInvalidReason; issues: string[] };

/**
 * 文字列を JSON として読み、schema で検証する。`rejectHealthKeys` のときは schema より先に
 * 健康情報キーの有無を見る（strict schema の unknown key エラーに埋もれさせない）。
 */
export function parseJsonColumn<S extends z.ZodTypeAny>(
  raw: string | null,
  schema: S,
  opts: { rejectHealthKeys: boolean },
): JsonColumnParseResult<z.infer<S>> {
  if (raw === null) return { ok: false, reason: "MISSING", issues: ["値がありません"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "JSON_SYNTAX_ERROR", issues: ["JSON として読めません"] };
  }
  if (opts.rejectHealthKeys) {
    const keys = findForbiddenHealthKeys(parsed);
    if (keys.length > 0) {
      return { ok: false, reason: "HEALTH_DATA_PRESENT", issues: keys.map((k) => `健康情報のキーは保存できません: ${k}`) };
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    // path だけを返す（message には入力値が含まれうるため出さない）
    return {
      ok: false,
      reason: "SCHEMA_INVALID",
      issues: result.error.issues.map((issue) => `schema 不一致: ${issue.path.join(".") || "(root)"} (${issue.code})`),
    };
  }
  return { ok: true, value: result.data };
}
