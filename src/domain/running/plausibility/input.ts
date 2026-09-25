/**
 * Running Prescription Engine v2 — §8.5 の入力 plausibility（canonical 実装）。
 *
 * [R6] R3 は `context/plausibility.ts` に同じ判定を持っていたが、閾値・判定を2箇所に持たないため
 * **ここを canonical とし、`context/plausibility.ts` は再 export（互換ラッパ）にする**。
 * 閾値は一切ハードコードせず RuleSet の `plausibility`（scope=INPUT）から読む。
 */
import type { PlausibilityInputTarget, RuleSet } from "../rules/schema";
import type { FindingSourceRecord, PlausibilityCertainty, PlausibilityPolicy } from "../types/findings";

export const INPUT_PLAUSIBILITY_VERDICTS = ["OK", "REQUIRE_CONFIRMATION", "BLOCK"] as const;
export type InputPlausibilityVerdict = (typeof INPUT_PLAUSIBILITY_VERDICTS)[number];

export type PlausibilityBoundarySide = "MIN" | "MAX";
export type QuantityBounds = { lower: number | null; upper: number | null };

export function plausibilityMetadata(
  ruleId: string,
  policy: PlausibilityPolicy | "DATA_QUALITY",
  certainty: PlausibilityCertainty,
  boundary?: { side: PlausibilityBoundarySide; threshold: number },
  sourceRecord?: FindingSourceRecord,
) {
  const presentationKind =
    certainty === "POSSIBLE_EXCEED" || certainty === "UNEVALUABLE"
      ? "INTERVAL_UNCERTAIN"
      : policy === "DATA_QUALITY"
        ? "DATA_QUALITY"
        : policy === "METHOD_POLICY_HARD"
          ? "METHOD_POLICY"
          : policy === "PRODUCT_DATA_SANITY_HARD" || policy === "NON_OVERRIDABLE_DATA_SANITY_HARD"
            ? "PRODUCT_DATA_SANITY"
            : "STRONG_REVIEW_REQUIRED";
  return {
    ruleId,
    policy,
    certainty,
    presentationKind,
    ...(boundary ? { boundary } : {}),
    ...(sourceRecord ? { sourceRecord } : {}),
  } as const;
}

/** Compare an interval to one inclusive policy boundary. Equality is within the boundary. */
export function evaluatePlausibilityBoundary(
  value: QuantityBounds,
  threshold: number,
  side: PlausibilityBoundarySide,
): PlausibilityCertainty {
  if (side === "MAX") {
    if (value.lower !== null && value.lower > threshold) return "CONFIRMED_EXCEED";
    if (value.upper !== null && value.upper > threshold) return "POSSIBLE_EXCEED";
    if (value.upper !== null && value.upper <= threshold) return "CONFIRMED_WITHIN";
    return "UNEVALUABLE";
  }
  if (value.upper !== null && value.upper < threshold) return "CONFIRMED_EXCEED";
  if (value.lower !== null && value.lower < threshold) return "POSSIBLE_EXCEED";
  if (value.lower !== null && value.lower >= threshold) return "CONFIRMED_WITHIN";
  return "UNEVALUABLE";
}

/** Evaluate both configured sides of a threshold, preserving the strongest evidence. */
export function evaluatePlausibilityThreshold(
  value: QuantityBounds,
  threshold: { min: number | null; max: number | null } | null,
): { certainty: PlausibilityCertainty; side: PlausibilityBoundarySide | null; threshold: number | null } {
  if (threshold === null) return { certainty: "CONFIRMED_WITHIN", side: null, threshold: null };
  const results = ([
    threshold.min === null ? null : { side: "MIN" as const, threshold: threshold.min },
    threshold.max === null ? null : { side: "MAX" as const, threshold: threshold.max },
  ]).filter((entry): entry is { side: PlausibilityBoundarySide; threshold: number } => entry !== null)
    .map((entry) => ({ ...entry, certainty: evaluatePlausibilityBoundary(value, entry.threshold, entry.side) }));
  const rank: Record<PlausibilityCertainty, number> = {
    CONFIRMED_EXCEED: 4,
    POSSIBLE_EXCEED: 3,
    UNEVALUABLE: 2,
    CONFIRMED_WITHIN: 1,
    DATA_QUALITY: 0,
  };
  const strongest = results.sort((a, b) => rank[b.certainty] - rank[a.certainty])[0];
  return strongest ?? { certainty: "CONFIRMED_WITHIN", side: null, threshold: null };
}

/** R3 が参照する3つの入力 plausibility ruleId（R2 JSON 側の定義そのまま）。 */
export const CONTEXT_PLAUSIBILITY_RULE_IDS = {
  MARK_100M: "PLA_INPUT_100M_RECORD",
  FLY_10M: "PLA_INPUT_FLY_10M",
  HEIGHT: "PLA_INPUT_HEIGHT",
} as const;

export function outsideThreshold(value: number, threshold: { min: number | null; max: number | null } | null): boolean {
  if (!threshold) return false;
  if (threshold.min !== null && value < threshold.min) return true;
  if (threshold.max !== null && value > threshold.max) return true;
  return false;
}

/**
 * `ruleSet.plausibility` から `ruleId` の行を引き、`value` に対する判定を返す。
 * 対象ルールが存在しない RuleSet を渡した場合はエラー（rule が無いこと自体が RuleSet の不整合）。
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

/**
 * [R6] `inputTarget`（構造化メタデータ）で対象行を選ぶ入口。ruleId 文字列を呼び出し側に書かせない。
 * 該当行が無ければ `null`（チェック対象外）。
 */
export function evaluateInputPlausibilityFor(ruleSet: RuleSet, target: PlausibilityInputTarget, value: number): InputPlausibilityVerdict | null {
  const rule = ruleSet.plausibility.find((r) => {
    const t = r.inputTarget;
    if (t === null) return false;
    if (t.kind !== target.kind) return false;
    if (t.kind === "TIMED_MARK" && target.kind === "TIMED_MARK") return t.event === target.event;
    return true;
  });
  if (!rule) return null;
  if (outsideThreshold(value, rule.blockThreshold)) return "BLOCK";
  if (outsideThreshold(value, rule.confirmThreshold)) return "REQUIRE_CONFIRMATION";
  return "OK";
}
