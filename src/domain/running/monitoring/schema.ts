/**
 * Running Prescription Engine v2 — Runtime monitoring の入出力 contract（§10.1）。
 *
 * [R8 helper file] §22 R8 の新規ファイル一覧に無いが、normalize / safety / timing / stopPolicies / decision が
 * 同じ型を参照するため、循環 import を避けてここに集約する。判定ロジック・policy 値は一切持たない。
 *
 * [R8 representation errata]（§10 / §19 に記載）:
 *   - setIndex / repIndex は **1 始まり**（リポジトリに既存の慣習が無いため R8 で採用）。
 *   - VIDEO で fps が無い観測は schema で拒否しない（§20 T-TIM-05 を採用し、§19 の「VIDEO なら fps 必須」を撤回）。
 *     正規化で effective timing を UNKNOWN に落とし、数値 stop をしない。
 *   - RESISTED_SPRINT の vdec は、処方 snapshot に無抵抗時の基準速度が存在しないため `measuredVelocityDecrementPercent`
 *     （0–100）として直接受け取る（`measuredVelocityMps` から勝手な Vmax で計算しない）。
 *   - STRIDE の「全力化」はコーチの明示判定 `coachJudgment.effortBecameMaximal` で受け取る
 *     （DETERIORATING 等を全力化と読み替えない）。
 *   - 観測は「実施した1本」を表す（走る前に中止した本は観測にしない）。予定数・露出はログ件数で数える。
 *   - RepLogEntry には健康情報（痛み・部位・red flag・athleteReport の生値）を保存しない（§13.5）。
 */
import { z } from "zod";
import { confidenceSchema, rangeSchema, stopPolicyIdSchema, type QuantityInterval, type Range } from "../types/primitives";
import { timingMethodSchema } from "../types/intensity";
import { bodyRegionSchema, redFlagSchema, safetyOutcomeSchema } from "../types/readiness";
import { runningPrescriptionSchema } from "../types/prescription";
import { monitorActionSchema, type MonitorAction } from "../types/monitoring";

export { monitorActionSchema, type MonitorAction };

const finitePositive = z.number().finite().positive();
const finiteNonNegative = z.number().finite().nonnegative();
const repIndexSchema = z.number().int().min(1);

// ---------------------------------------------------------------------------
// RepObservation（§10.1 + R8 errata）
// ---------------------------------------------------------------------------

/** 実測露出。MEASURED 以外（ESTIMATED / PLANNED）を「実測」として受け取らない（§10.5）。 */
export const measuredExposureIntervalSchema = z
  .object({
    lower: finiteNonNegative.nullable(),
    upper: finiteNonNegative.nullable(),
    unit: z.literal("m"),
    source: z.literal("MEASURED"),
    confidence: confidenceSchema,
  })
  .strict()
  .refine((v) => v.lower === null || v.upper === null || v.lower <= v.upper, {
    message: "actualHighSpeedExposureM.lower は upper 以下である必要があります",
  })
  .refine((v) => v.lower !== null || v.upper !== null, {
    message: "actualHighSpeedExposureM は少なくとも一方の bound が必要です（不明なら null を渡す）",
  });

export const TECHNIQUE_JUDGMENTS = ["GOOD", "ACCEPTABLE", "DETERIORATING", "UNSAFE"] as const;

export const coachJudgmentSchema = z
  .object({
    technique: z.enum(TECHNIQUE_JUDGMENTS).optional(),
    startQuality: z.enum(["GOOD", "POOR"]).optional(),
    environmentUnsafe: z.boolean().optional(),
    /** [R8] STRIDE: コーチが「流しが全力化した」と判定した。 */
    effortBecameMaximal: z.boolean().optional(),
  })
  .strict();

export const athleteReportSchema = z
  .object({
    painNow: z.boolean(),
    painRegion: bodyRegionSchema.nullable().optional(),
    redFlags: z.array(redFlagSchema).optional(),
    requestsStop: z.boolean().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (!r.painNow && r.painRegion != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "painNow=false のとき painRegion は指定できません（矛盾した入力）", path: ["painRegion"] });
    }
    if (r.redFlags && new Set(r.redFlags).size !== r.redFlags.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "redFlags に重複があります", path: ["redFlags"] });
    }
  });

export const repObservationSchema = z
  .object({
    setIndex: repIndexSchema,
    repIndex: repIndexSchema,
    timeS: finitePositive.nullable(),
    timing: timingMethodSchema,
    /** VIDEO の fps。無い / null の VIDEO は拒否せず UNKNOWN 扱い（§20 T-TIM-05）。 */
    videoFps: finitePositive.nullable().optional(),
    measuredVelocityMps: finitePositive.nullable().optional(),
    /** [R8] RESISTED_SPRINT の実測速度低下率（%）。 */
    measuredVelocityDecrementPercent: z.number().finite().min(0).max(100).nullable().optional(),
    actualHighSpeedExposureM: measuredExposureIntervalSchema.nullable().optional(),
    restTakenS: finiteNonNegative.nullable().optional(),
    coachJudgment: coachJudgmentSchema.nullable().optional(),
    athleteReport: athleteReportSchema.nullable().optional(),
  })
  .strict()
  .refine((o) => o.timing === "VIDEO" || o.videoFps == null, {
    message: "videoFps は timing=VIDEO のときだけ指定できます",
    path: ["videoFps"],
  });
export type RepObservation = z.infer<typeof repObservationSchema>;

// ---------------------------------------------------------------------------
// StopReason（永続化・日本語レンダリング可能な安全な enum。部位・症状を含めない）
// ---------------------------------------------------------------------------

export const STOP_REASONS = [
  // safety gate（athlete 由来はまとめて1コード。痛み・red flag・中止要請を区別して保存しない）
  "SAFETY_STOP_ATHLETE",
  "SAFETY_STOP_TECHNIQUE_UNSAFE",
  "SAFETY_STOP_ENVIRONMENT",
  // timing reliability（§10.2）
  "TIMING_NOT_RECORDED",
  "TIMING_METHOD_COACH_ONLY",
  "TIMING_VIDEO_FPS_MISSING",
  "TIMING_TOLERANCE_RATIO_EXCEEDED",
  "TIMING_POLICY_MISSING",
  // reference / performance（§10.3）
  "POLICY_COACH_ONLY",
  "NO_NUMERIC_REFERENCE",
  "REFERENCE_ESTABLISHED",
  "TIMING_FAIL",
  "CONSECUTIVE_TIMING_FAILURES",
  "TEMPO_FASTER_THAN_TARGET_REPEATED",
  // coach judgment（§10.3）
  "START_QUALITY_POOR_REPEATED",
  "TECHNIQUE_DETERIORATING",
  "ASSISTED_TECHNIQUE_NOT_GOOD",
  "TECHNIQUE_NOT_ASSESSED",
  "VELOCITY_DECREMENT_OUT_OF_BAND",
  "VELOCITY_DECREMENT_BAND_UNAVAILABLE",
  "EFFORT_BECAME_MAXIMAL",
  // rest / cumulative（§10.4 step 6・§10.5）
  "REST_EXTENSION_UNAVAILABLE",
  "PLANNED_REPS_COMPLETE",
  "ATTEMPTS_COMPLETE",
] as const;
export const stopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof stopReasonSchema>;

export const REP_QUALITIES = ["PASS", "FAIL", "NOT_EVALUATED_COACH_ONLY"] as const;
export const repQualitySchema = z.enum(REP_QUALITIES);
export type RepQuality = z.infer<typeof repQualitySchema>;

export const REFERENCE_SOURCES = ["PRIOR_SESSION_BEST", "TARGET_UPPER", "TARGET_LOWER"] as const;
export const referenceSourceSchema = z.enum(REFERENCE_SOURCES);
export type ReferenceSource = z.infer<typeof referenceSourceSchema>;

// ---------------------------------------------------------------------------
// RepLogEntry（R8 で正式化。次回の monitor 判定に必要なものだけ）
// ---------------------------------------------------------------------------

/** ログに残す1本分の高速曝露（実測 MEASURED か、計画のコピー PLANNED）。null bound は null のまま。 */
export const loggedExposureIntervalSchema = z
  .object({
    lower: finiteNonNegative.nullable(),
    upper: finiteNonNegative.nullable(),
    unit: z.literal("m"),
    source: z.enum(["MEASURED", "PLANNED"]),
    confidence: confidenceSchema,
  })
  .strict()
  .refine((v) => v.lower === null || v.upper === null || v.lower <= v.upper, { message: "lower は upper 以下である必要があります" });

export const repLogEntrySchema = z
  .object({
    /** どの処方（stop policy）に対するログか。別の処方のログを混ぜないための照合用。 */
    stopPolicyId: stopPolicyIdSchema,
    setIndex: repIndexSchema,
    repIndex: repIndexSchema,
    timeS: finitePositive.nullable(),
    timing: timingMethodSchema,
    /** 正規化後の計時法（VIDEO で fps が無ければ UNKNOWN）。 */
    effectiveTiming: timingMethodSchema,
    toleranceS: finiteNonNegative.nullable(),
    referenceTimeS: finitePositive.nullable(),
    referenceSource: referenceSourceSchema.nullable(),
    quality: repQualitySchema,
    /** SP_TE: 目標下端より速すぎたか（評価できなければ null）。 */
    fasterThanTargetLower: z.boolean().nullable(),
    /** ACC / MV の startQuality 連続判定用（未入力は null）。 */
    startQuality: z.enum(["GOOD", "POOR"]).nullable(),
    measuredVelocityDecrementPercent: z.number().finite().min(0).max(100).nullable(),
    action: monitorActionSchema,
    safetyOutcome: safetyOutcomeSchema,
    restTakenS: finiteNonNegative.nullable(),
    highSpeedExposureM: loggedExposureIntervalSchema,
    reasons: z.array(stopReasonSchema),
  })
  .strict();
export type RepLogEntry = z.infer<typeof repLogEntrySchema>;

// ---------------------------------------------------------------------------
// MonitorState
// ---------------------------------------------------------------------------

function compareIndex(a: { setIndex: number; repIndex: number }, b: { setIndex: number; repIndex: number }): number {
  return a.setIndex !== b.setIndex ? a.setIndex - b.setIndex : a.repIndex - b.repIndex;
}

/**
 * SessionItem の計画スナップショット（`plannedPrescriptionJson`）+ これまでのログ。RuleSet の version / hash を
 * 別に受け取らない（処方の snapshot が唯一の出所）。ログは (setIndex, repIndex) の昇順で重複なし。
 */
export const monitorStateSchema = z
  .object({
    prescription: runningPrescriptionSchema,
    priorLogs: z.array(repLogEntrySchema),
  })
  .strict()
  .superRefine((state, ctx) => {
    state.priorLogs.forEach((log, i) => {
      if (log.stopPolicyId !== state.prescription.stopPolicyId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "priorLogs に別の stop policy（別の処方）のログが含まれています",
          path: ["priorLogs", i, "stopPolicyId"],
        });
      }
      if (i > 0 && compareIndex(state.priorLogs[i - 1], log) >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "priorLogs は (setIndex, repIndex) の昇順・重複なしである必要があります",
          path: ["priorLogs", i],
        });
      }
    });
  });
export type MonitorState = z.infer<typeof monitorStateSchema>;

export function isAfterLastLog(priorLogs: readonly RepLogEntry[], obs: { setIndex: number; repIndex: number }): boolean {
  const last = priorLogs[priorLogs.length - 1];
  return last === undefined || compareIndex(last, obs) < 0;
}

// ---------------------------------------------------------------------------
// MonitorDecision（§10.1 + R8）
// ---------------------------------------------------------------------------

export type MonitorDecision = {
  action: MonitorAction;
  safetyOutcome: z.infer<typeof safetyOutcomeSchema>;
  /**
   * [R8 errata] EXTEND_REST のときだけ非 null。`min` = 計画の repRest（最低でも現行の休息を確保）、
   * `max` = `repRestS.coachEditable.max`。延長量はコーチが決める（+30秒・割合などの式を作らない）。
   */
  nextRepRestS: Range<"s"> | null;
  quality: RepQuality;
  consecutiveFailures: number;
  reasons: StopReason[];
  logEntry: RepLogEntry;
  /** これまでに実施した本数（今回を含む）と予定数（sets × repsPerSet）。 */
  completedRepCount: number;
  plannedRepCount: number;
  /** 完了した本数分だけの累積高速曝露（未来の予定本数は足さない。null を 0 にしない）。 */
  cumulativeHighSpeedExposureM: QuantityInterval<"m">;
  /**
   * [R8 deviation] セッション全体の曝露上限は1項目の処方 snapshot から再構成できないため評価しない
   * （「上限内」と楽観しない。R9/R11 でセッション単位の snapshot を接続する）。
   */
  exposureLimitEvaluation: "NOT_EVALUATED";
};

export const restRangeSchema = rangeSchema(z.literal("s"));
