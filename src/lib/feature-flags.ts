/**
 * Running Prescription Engine v2 — UI 機能フラグ（R10-B1）。
 *
 * server-only contract: このファイルは Server Action / Server Component からだけ呼ぶ。
 * Client Component から直接 `process.env` を読まない（`NEXT_PUBLIC_` を使わないので
 * client bundle にも値は含まれない）。
 */

/**
 * `RUNNING_V2_UI_ENABLED` が文字列として厳密に `"true"` のときだけ ON。
 * 未設定・`"1"`・`"TRUE"`・`"false"` 等はすべて OFF（既定は OFF）。
 */
export function isRunningV2UiEnabled(): boolean {
  return process.env.RUNNING_V2_UI_ENABLED === "true";
}
