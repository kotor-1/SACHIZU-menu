/**
 * Running Prescription Engine v2 — Readiness の型（§13.1、§2.2）。
 *
 * 重要: これは入力の**型**だけ。判定ロジック（pain gate、
 * `resolveReadinessAction()` 等、§13.2〜§13.4）は R5 の責務であり、
 * R1 では一切実装しない。
 */
import { z } from "zod";
import { isoDateTimeSchema } from "./primitives";

// ---------------------------------------------------------------------------
// ReadinessActionCode / SafetyOutcome
// ---------------------------------------------------------------------------

export const READINESS_ACTION_CODES = [
  "NO_CHANGE",
  "USE_LOWER_BOUND",
  "INCREASE_REST",
  "SWAP_TO_LOWER_LOAD_METHOD",
  "CANCEL_HIGH_INTENSITY",
  "REQUIRE_COACH_REVIEW",
] as const;
export const readinessActionCodeSchema = z.enum(READINESS_ACTION_CODES);
export type ReadinessActionCode = z.infer<typeof readinessActionCodeSchema>;

export const SAFETY_OUTCOMES = ["NONE", "STOP", "COACH_REVIEW", "MEDICAL_EVALUATION_RECOMMENDED"] as const;
export const safetyOutcomeSchema = z.enum(SAFETY_OUTCOMES);
export type SafetyOutcome = z.infer<typeof safetyOutcomeSchema>;

// ---------------------------------------------------------------------------
// BodyRegion / RedFlag / PainReport（§13.1）
// ---------------------------------------------------------------------------

export const BODY_REGIONS = [
  "HEEL",
  "KNEE",
  "HIP_PELVIS",
  "HAMSTRING",
  "CALF_ACHILLES",
  "SHIN",
  "FOOT_ANKLE",
  "LOWER_BACK",
  "GROIN",
  "OTHER",
] as const;
export const bodyRegionSchema = z.enum(BODY_REGIONS);
export type BodyRegion = z.infer<typeof bodyRegionSchema>;

export const RED_FLAGS = [
  "PAIN_AT_REST_OR_NIGHT",
  "SWELLING",
  "LIMPING",
  "PAIN_WORSENING_DURING_SESSION",
  "SUDDEN_SHARP_PAIN",
  "NUMBNESS_TINGLING",
  "DIZZINESS_OR_BREATHING_DIFFICULTY",
  "PAIN_PERSISTING_OVER_DAYS",
] as const;
export const redFlagSchema = z.enum(RED_FLAGS);
export type RedFlag = z.infer<typeof redFlagSchema>;

export const painReportSchema = z.object({
  status: z.enum(["NONE_REPORTED", "PRESENT", "NOT_ASKED"]),
  regions: z.array(bodyRegionSchema),
  redFlags: z.array(redFlagSchema),
});
export type PainReport = z.infer<typeof painReportSchema>;

// ---------------------------------------------------------------------------
// ReadinessReport（§13.1）
// ---------------------------------------------------------------------------

const oneToFiveSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const readinessReportSchema = z.object({
  pain: painReportSchema,
  soreness: oneToFiveSchema.nullable(),
  fatigue: oneToFiveSchema.nullable(),
  sleepQuality: oneToFiveSchema.nullable(),
  performanceStatus: z.enum(["NORMAL", "DOWN", "UNKNOWN"]),
  reporter: z.enum(["ATHLETE", "COACH", "PARENT"]),
  reportedAt: isoDateTimeSchema,
});
export type ReadinessReport = z.infer<typeof readinessReportSchema>;
