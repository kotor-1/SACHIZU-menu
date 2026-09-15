/**
 * Running Prescription Engine v2 — context input plausibility（§8.5 入力行）。
 *
 * R3 が必要とするのは、context の解決に関係する3種類の入力チェックだけ
 * （100m 記録・fly 10m・身長）。§8.5 のフル plausibility engine（総走行距離・
 * sets/reps 取り違え等）は R6 の責務であり、ここでは実装しない。
 *
 * 重要: 閾値は一切ハードコードしない。R2 の `RuleSet.plausibility`
 * （`rules/sets/rs-2026.09.0.json`）から `ruleId` で引く。数値が変わっても
 * このファイルを直す必要が無いようにする（Fable H-9 の再発防止）。
 */
import type { RuleSet } from "../rules/schema";

export const INPUT_PLAUSIBILITY_VERDICTS = ["OK", "REQUIRE_CONFIRMATION", "BLOCK"] as const;
export type InputPlausibilityVerdict = (typeof INPUT_PLAUSIBILITY_VERDICTS)[number];

/** R3 が参照する3つの入力 plausibility ruleId（R2 JSON 側の定義そのまま）。 */
export const CONTEXT_PLAUSIBILITY_RULE_IDS = {
  MARK_100M: "PLA_INPUT_100M_RECORD",
  FLY_10M: "PLA_INPUT_FLY_10M",
  HEIGHT: "PLA_INPUT_HEIGHT",
} as const;

function outsideThreshold(value: number, threshold: { min: number | null; max: number | null } | null): boolean {
  if (!threshold) return false;
  if (threshold.min !== null && value < threshold.min) return true;
  if (threshold.max !== null && value > threshold.max) return true;
  return false;
}

/**
 * `ruleSet.plausibility` から `ruleId` の行を引き、`value` に対する判定を返す。
 * 対象ルールが存在しない RuleSet を渡した場合はエラー（context 層は R2 の
 * データに依存しているため、rule が無いこと自体が RuleSet の不整合）。
 */
export function evaluateInputPlausibility(ruleSet: RuleSet, ruleId: string, value: number): InputPlausibilityVerdict {
  const rule = ruleSet.plausibility.find((r) => r.ruleId === ruleId);
  if (!rule) {
    throw new Error(`Context plausibility rule not found in RuleSet: ${ruleId}`);
  }
  if (outsideThreshold(value, rule.blockThreshold)) return "BLOCK";
  if (outsideThreshold(value, rule.confirmThreshold)) return "REQUIRE_CONFIRMATION";
  return "OK";
}
