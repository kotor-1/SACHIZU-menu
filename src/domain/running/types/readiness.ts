/**
 * Running Prescription Engine v2 — Readiness の型（§13.1、§2.2）。
 *
 * R1 では入力の型だけを定義した。R5 で `.strict()` と整合条件（§13.1 の選択式のみ・自由記述なし）を
 * 追加している。判定ロジック（pain gate・action 選択）は `src/domain/running/readiness/` にある。
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

export const PAIN_STATUSES = ["NONE_REPORTED", "PRESENT", "NOT_ASKED"] as const;
export const painStatusSchema = z.enum(PAIN_STATUSES);
export type PainStatus = z.infer<typeof painStatusSchema>;

/**
 * [R5] `.strict()`（自由記述欄や未知のキーを受け付けない）＋ 整合条件:
 *   - status=NONE_REPORTED / NOT_ASKED のとき regions・redFlags は空
 *     （red flag があるのに「痛みなし」という矛盾入力を拒否する）
 *   - status=PRESENT は regions が空でもよい（「痛いが部位未選択」を勝手に OTHER へ変換しない）
 *   - regions / redFlags の重複は拒否（同じ入力を2回数えない）
 */
export const painReportSchema = z
  .object({
    status: painStatusSchema,
    regions: z.array(bodyRegionSchema),
    redFlags: z.array(redFlagSchema),
  })
  .strict()
  .superRefine((pain, ctx) => {
    if (pain.status !== "PRESENT") {
      if (pain.regions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `status=${pain.status} のとき regions は空である必要があります`,
          path: ["regions"],
        });
      }
      if (pain.redFlags.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `status=${pain.status} のとき redFlags は空である必要があります（矛盾した入力）`,
          path: ["redFlags"],
        });
      }
    }
    if (new Set(pain.regions).size !== pain.regions.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "regions に重複があります", path: ["regions"] });
    }
    if (new Set(pain.redFlags).size !== pain.redFlags.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "redFlags に重複があります", path: ["redFlags"] });
    }
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

/**
 * [R5] `.strict()`。尺度は 1–5 の選択式リテラルだけ（`z.number()` を使わないので NaN / Infinity /
 * 小数は型として入らない）。自由記述欄は持たない（§13.1・Fable M-12）。
 */
export const readinessReportSchema = z
  .object({
    pain: painReportSchema,
    soreness: oneToFiveSchema.nullable(),
    fatigue: oneToFiveSchema.nullable(),
    sleepQuality: oneToFiveSchema.nullable(),
    performanceStatus: z.enum(["NORMAL", "DOWN", "UNKNOWN"]),
    reporter: z.enum(["ATHLETE", "COACH", "PARENT"]),
    reportedAt: isoDateTimeSchema,
  })
  .strict();
export type ReadinessReport = z.infer<typeof readinessReportSchema>;
