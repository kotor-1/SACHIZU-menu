/**
 * Running Prescription Engine v2 — context input plausibility（§8.5 入力行）。
 *
 * [R6] 判定の実体は canonical 実装 `src/domain/running/plausibility/input.ts` にある。
 * 同じ閾値・同じ判定を2箇所に持たないため、このファイルは **互換のための再 export** に徹する
 * （R3 の API と import パスを壊さない）。
 */
export {
  CONTEXT_PLAUSIBILITY_RULE_IDS,
  INPUT_PLAUSIBILITY_VERDICTS,
  evaluateInputPlausibility,
  type InputPlausibilityVerdict,
} from "../plausibility/input";
