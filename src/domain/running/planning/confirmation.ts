/**
 * Running Prescription Engine v2 — [R10-B4A] REQUIRE_CONFIRMATION の明示確認 contract（純粋関数）。
 *
 * - 確認は **Finding code 単位**。同じ code の Finding が複数あっても、1回の明示確認でその code 群を確認した扱い。
 * - 確認は CoachOverride ではない（reason も confirmedTwice も持たない）。確認しても Finding は消さない。
 * - 「必要な code」は常に **現在の入力で再実行した plan / 評価の結果**から取る。以前の結果に対する確認を
 *   新しい結果へ流用しない（現在の結果に無い code が送られてきたら stale として再確認を求める）。
 */
import type { Finding } from "../types/findings";

/** 現在の結果に存在する REQUIRE_CONFIRMATION の code（重複なし・出現順）。 */
export function requiredConfirmationCodes(findings: readonly Finding[]): string[] {
  const codes: string[] = [];
  for (const f of findings) {
    if (f.severity === "REQUIRE_CONFIRMATION" && !codes.includes(f.code)) codes.push(f.code);
  }
  return codes;
}

export type FindingConfirmationOutcome =
  /** 保存してよい。`confirmedCodes` は監査記録に残す code（= 現在の結果の required code 全体）。 */
  | { kind: "CONFIRMED"; confirmedCodes: string[] }
  /** 現在の結果に必要な確認が足りない。 */
  | { kind: "CONFIRMATION_REQUIRED"; requiredFindingCodes: string[]; missingFindingCodes: string[] }
  /** 現在の結果に存在しない code の確認が含まれている（以前の結果の確認）。黙って受け入れない。 */
  | { kind: "CONFIRMATION_STATE_STALE"; requiredFindingCodes: string[]; staleFindingCodes: string[] };

export function evaluateFindingConfirmation(
  requiredFindingCodes: readonly string[],
  confirmedFindingCodes: readonly string[],
): FindingConfirmationOutcome {
  const required = [...new Set(requiredFindingCodes)];
  const confirmed = [...new Set(confirmedFindingCodes)];
  const stale = confirmed.filter((code) => !required.includes(code));
  if (stale.length > 0) return { kind: "CONFIRMATION_STATE_STALE", requiredFindingCodes: required, staleFindingCodes: stale };
  const missing = required.filter((code) => !confirmed.includes(code));
  if (missing.length > 0) return { kind: "CONFIRMATION_REQUIRED", requiredFindingCodes: required, missingFindingCodes: missing };
  return { kind: "CONFIRMED", confirmedCodes: required };
}
