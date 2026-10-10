/** Goal labels understood by the menu interpreter but not mapped to approved doses. */
export const RUNNING_PURPOSES = [
  "ACCEL", "MAX_SPEED", "SPEED_ENDURANCE", "BASIC", "PRECOMP", "RECOVERY",
] as const;
export type RunningPurpose = (typeof RUNNING_PURPOSES)[number];

export const RUNNING_INTENSITY_PREFERENCES = ["LOW"] as const;
export type RunningIntensityPreference = (typeof RUNNING_INTENSITY_PREFERENCES)[number];

export type UnsupportedPurposeReason =
  | "ACCEL_PURPOSE_NOT_APPROVED"
  | "MAX_SPEED_PURPOSE_NOT_APPROVED"
  | "SPEED_ENDURANCE_PURPOSE_NOT_APPROVED"
  | "BASIC_PURPOSE_NOT_APPROVED"
  | "PRECOMP_PURPOSE_NOT_APPROVED"
  | "RECOVERY_PURPOSE_NOT_APPROVED"
  | "LOW_INTENSITY_NOT_APPROVED";

const PURPOSE_REASONS: Record<RunningPurpose, UnsupportedPurposeReason> = {
  ACCEL: "ACCEL_PURPOSE_NOT_APPROVED",
  MAX_SPEED: "MAX_SPEED_PURPOSE_NOT_APPROVED",
  SPEED_ENDURANCE: "SPEED_ENDURANCE_PURPOSE_NOT_APPROVED",
  BASIC: "BASIC_PURPOSE_NOT_APPROVED",
  PRECOMP: "PRECOMP_PURPOSE_NOT_APPROVED",
  RECOVERY: "RECOVERY_PURPOSE_NOT_APPROVED",
};

export function unsupportedPurposeReason(
  purpose: RunningPurpose | null | undefined,
  intensityPreference: RunningIntensityPreference | null | undefined,
): UnsupportedPurposeReason | null {
  if (purpose !== null && purpose !== undefined) return PURPOSE_REASONS[purpose];
  if (intensityPreference === "LOW") return "LOW_INTENSITY_NOT_APPROVED";
  return null;
}

/**
 * Compatibility guard for already-recorded v2 outputs that put purpose wording
 * only in unsupportedIntents. It only detects a positively stated, quoted goal
 * and only creates a policy gate; it never supplies a dose or numerical value.
 */
export function historicalPurposeFromGroundedText(sourceText: string): RunningPurpose | null {
  const text = sourceText.normalize("NFKC");
  if (/(?:以前|昔|過去には|前は|ではなく|じゃなく|のではない|したくない|避けたい|やめたい|目指さない|以外)/u.test(text) || hasNegatedPurposeCue(text)) return null;
  if (/(?:加速(?:力)?(?:の)?(?:向上|強化)|加速走)/u.test(text)) return "ACCEL";
  if (/(?:最高(?:速度|速|スピード)(?:の)?(?:向上|強化))/u.test(text)) return "MAX_SPEED";
  if (/(?:スピード持久(?:力)?|速度持久(?:力)?)(?:の)?(?:向上|強化)/u.test(text)) return "SPEED_ENDURANCE";
  if (/(?:基礎的な走能力|基礎走能力|基礎的な走力|基礎走力)(?:の)?(?:向上|強化)/u.test(text)) return "BASIC";
  if (/(?:大会|試合|競技会)前(?:日)?(?:なので|の|に|まで)?[^。！？]{0,30}(?:調整|疲労を残さない)|(?:前日|前々日)の調整/u.test(text)) return "PRECOMP";
  if (/(?:回復|リカバリー)/u.test(text)) return "RECOVERY";
  return null;
}

function hasNegatedPurposeCue(text: string): boolean {
  return /(?:加速(?:力)?|初速|最高速度|最高速|トップスピード|最大速度|スピード持久(?:力)?|速度持久(?:力)?|基礎.{0,6}(?:走力|走能力)|走力|回復|リカバリー)[^。！？]{0,12}(?:しない|さない|ない|望まない|避け|やめ|目指さない)/u.test(text);
}

/** Same quoted-history guard for a low-intensity request; no load reduction is inferred. */
export function historicalIntensityFromGroundedText(sourceText: string): RunningIntensityPreference | null {
  const text = sourceText.normalize("NFKC");
  if (/(?:低強度|強度を(?:下げ|低く|抑え)|軽い強度)/u.test(text) &&
      !/(?:低強度ではなく|低強度じゃなく|低強度にしない|低強度を望まない|強度を下げない|強度を低くしない)/u.test(text)) return "LOW";
  return null;
}
