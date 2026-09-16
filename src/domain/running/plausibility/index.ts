/**
 * Running Prescription Engine v2 — §8.5 Plausibility の入口。
 *
 * 入力（step 1）と出力（step 14）を1つの責務として束ねる。閾値は RuleSet だけが持つ。
 */
export {
  CONTEXT_PLAUSIBILITY_RULE_IDS,
  INPUT_PLAUSIBILITY_VERDICTS,
  evaluateInputPlausibility,
  evaluateInputPlausibilityFor,
  type InputPlausibilityVerdict,
} from "./input";
export {
  PLAUSIBILITY_FINDING_CODES,
  checkLegacyItemPlausibility,
  checkOutputPlausibility,
  checkSessionPlausibility,
  type OutputPlausibilityResult,
} from "./output";
