/**
 * Running Prescription Engine v2 — RationaleLine のコード一覧（§2.5, §22 R4）。
 *
 * `RationaleLine` は「コード + パラメータ」だけを持つ。日本語の文章は
 * `render-ja.ts` がこのコードから組み立てる（エンジン内部の enum キーを
 * そのまま表示しない）。params に入る enum 値（例: "LOWER_HALF"）も
 * render-ja 側で必ず自然文へ変換する。
 */
import type { RationaleLine } from "../types/findings";

export const RATIONALE_CODES = [
  /** params: version */
  "RULESET_DRAFT",
  /** params: templateLabelJa */
  "TEMPLATE_SELECTED",
  /** params: tier (EnvelopeTier) */
  "TIER",
  /** params: mode ("AUTO" | "MANUAL" | "OVERRIDDEN"), review (0 | 1) */
  "ELIGIBILITY",
  /** params: sourceBacked, enginePolicy, open（使用したセル数） */
  "ENVELOPE_EVIDENCE",
  /** params: position（回数・距離・時間に適用した位置） */
  "POSITION",
  /** params: confidence（PrescriptionConfidence） */
  "POSITION_CAP_CONFIDENCE",
  "POSITION_CAP_PREFERENCE",
  "POSITION_CAP_ELIGIBILITY",
  /** params: sets, repsPerSet, totalReps, source ("ENGINE" | "COACH") */
  "COUNTS_RESOLVED",
  /** params: field (EnvelopeField), value, unit */
  "TEMPLATE_FIXED_VALUE",
  /** sets セルの無い template の sets=1（構造正規化規則。量の推奨ではない） */
  "STRUCTURAL_SINGLE_SET",
  /** params: field */
  "COACH_MANUAL_INPUT",
  /** params: field */
  "COACH_OVERRIDE_APPLIED",
  /** params: kind (IntensityReference kind) */
  "REFERENCE",
  /** params: lower, upper, unit ("s" | "percent"), source (DataSource) */
  "TARGET_INTERVAL",
  /** params: kind */
  "NO_NUMERIC_TARGET",
  /** params: prescription, directness, inputData */
  "CONFIDENCE",
  /** params: repRestS, setRestS?（秒） */
  "REST_FROM_ENVELOPE",
  "REST_NOT_SHORTENED",
  /** params: minimumSeconds（mandatory rest + 時間が確定している走行時間の下限）, availableMinutes */
  "REST_EXCEEDS_AVAILABLE_TIME",
  /** params: decelerationM */
  "DECELERATION_EXCLUDED",
  "STRIDE_RELAXED",
  /** params: structure (RecoveryStructure) */
  "LONG_RECOVERY_STRUCTURE",
  /** params: stopPolicyId */
  "STOP_POLICY",
  "EXPOSURE_ESTIMATED",
  "PHASE_NOT_EVALUATED",
  "WEEKLY_NOT_EVALUATED",
  "READINESS_NOT_EVALUATED",
] as const;

export type RationaleCode = (typeof RATIONALE_CODES)[number];

export function rationaleLine(code: RationaleCode, params?: Record<string, string | number>): RationaleLine {
  return params === undefined ? { code } : { code, params };
}
