/**
 * Running Prescription Engine v2 — Runtime monitoring 用の構造化 policy 型（§10.3 / §17.1）。
 *
 * [R8 representation errata]（§10 に記載）:
 *   - R2〜R7 の `StopPolicy` は実行時の挙動を `ruleDescriptionJa`（自然文）にしか持っておらず、monitor が
 *     policy id やテキストを解析しないと判定できなかった。R8 で `StopPolicy.runtime`（下の
 *     `stopPolicyRuntimeSchema`）を追加し、§10.3 の表をそのまま機械可読にする。数値・意味は変えない。
 *   - §13.2 の red flag グループ（R5 の readinessRules）は monitor から RuleSet を読めないため、plan 時に
 *     必要最小限の `RuntimeSafetyPolicySnapshot` として処方へコピーする（健康情報ではなく versioned policy）。
 *
 * このファイルは RuleSet（rules/schema.ts）と処方（types/prescription.ts）の両方から参照される。
 */
import { z } from "zod";
import { RED_FLAGS, redFlagSchema, safetyOutcomeSchema } from "./readiness";

// ---------------------------------------------------------------------------
// MonitorAction（§10.1）
// ---------------------------------------------------------------------------

export const MONITOR_ACTIONS = ["CONTINUE", "EXTEND_REST", "END_SET", "END_SESSION_QUALITY", "STOP_SAFETY", "COACH_REVIEW"] as const;
export const monitorActionSchema = z.enum(MONITOR_ACTIONS);
export type MonitorAction = z.infer<typeof monitorActionSchema>;

// ---------------------------------------------------------------------------
// StopPolicy.runtime（§10.3 の表の機械可読表現）
// ---------------------------------------------------------------------------

/**
 * 数値 timing の使い方。
 *   SLOWER_THAN_REFERENCE_FAILS: `timeS > 参照 + tolerance` を FAIL とする（SP_ACC / SP_MV / SP_SES / SP_LSR_* / SP_TI）
 *   FASTER_THAN_TARGET_LOWER_WARNS: 数値 stop は無い（quality は常に COACH_ONLY）。目標下端より速すぎる rep を
 *     数え、連続したら WARN 相当の reason だけを出す（SP_TE）
 *   NONE: timing を数値判定に使わない（SP_RS / SP_AS / SP_EA / SP_STRIDE）
 */
export const TIMING_EVALUATIONS = ["SLOWER_THAN_REFERENCE_FAILS", "FASTER_THAN_TARGET_LOWER_WARNS", "NONE"] as const;

/**
 * 参照タイムの決め方（処方 snapshot と同じ処方内のログだけから決まる。RuleSet・PB を再読込しない）。
 *   PRIOR_SESSION_BEST: 同じ処方のこれまでの rep のうち、同じ計時法で数値評価できたタイムの最小値
 *   TARGET_UPPER: 処方の `intensity.target`（秒）の上端
 *   TARGET_UPPER_ELSE_PRIOR_SESSION_BEST: 目標上端があればそれ、無ければ PRIOR_SESSION_BEST
 *   TARGET_LOWER: 処方の `intensity.target`（秒）の下端（速すぎの観測用）
 *   NONE: 参照を持たない
 */
export const STOP_POLICY_REFERENCES = [
  "PRIOR_SESSION_BEST",
  "TARGET_UPPER",
  "TARGET_UPPER_ELSE_PRIOR_SESSION_BEST",
  "TARGET_LOWER",
  "NONE",
] as const;
export type StopPolicyReference = (typeof STOP_POLICY_REFERENCES)[number];

export const stopPolicyRuntimeSchema = z
  .object({
    timingEvaluation: z.enum(TIMING_EVALUATIONS),
    reference: z.enum(STOP_POLICY_REFERENCES),
    /** 連続 FAIL が1回目（閾値未満）のときの action（SP_ACC / SP_MV の EXTEND_REST）。null = CONTINUE。 */
    firstFailureAction: z.enum(["EXTEND_REST"]).nullable(),
    /** 連続 FAIL が `consecutiveFailuresToStop` に達したときの action。 */
    consecutiveFailureAction: z.enum(["END_SESSION_QUALITY", "END_SET", "COACH_REVIEW"]).nullable(),
    /** SP_TE: 目標下端より速すぎる rep がこの回数連続したら WARN 相当の reason（action は変えない）。 */
    tooFastConsecutiveThreshold: z.number().int().positive().nullable(),
    /** SP_ACC / SP_MV: startQuality=POOR がこの回数連続したら COACH_REVIEW。 */
    poorStartConsecutiveThreshold: z.number().int().positive().nullable(),
    /** technique=DETERIORATING のときの action（ASSISTED 以外）。 */
    techniqueDeterioratingAction: z.enum(["COACH_REVIEW"]).nullable(),
    /** technique≠GOOD（ACCEPTABLE / DETERIORATING）のときの action（SP_AS）。UNSAFE は共通 safety gate。 */
    techniqueNotGoodAction: z.enum(["STOP_SAFETY"]).nullable(),
    /** technique が未入力のときの action（SP_AS。エンジンは GOOD と推測しない）。 */
    techniqueMissingAction: z.enum(["COACH_REVIEW"]).nullable(),
    /** 実測 vdec が処方の band 外のときの action（SP_RS）。 */
    velocityDecrementOutOfBandAction: z.enum(["COACH_REVIEW"]).nullable(),
    /** コーチが「全力化した」と判定したときの action（SP_STRIDE）。 */
    effortBecameMaximalAction: z.enum(["COACH_REVIEW"]).nullable(),
    /** 予定数（sets × repsPerSet）の単位。到達時の reason を PLANNED_REPS_COMPLETE / ATTEMPTS_COMPLETE で区別する。 */
    plannedCountUnit: z.enum(["REPS", "ATTEMPTS"]),
  })
  .strict();
export type StopPolicyRuntime = z.infer<typeof stopPolicyRuntimeSchema>;

/**
 * StopPolicy 行の構造整合（RuleSet 側と snapshot 側の両方の superRefine から使う）。
 * 既存の `numericStopAvailable` / `consecutiveFailuresToStop` と `runtime` が矛盾しないことだけを検証する。
 */
export function stopPolicyRuntimeIssues(policy: {
  numericStopAvailable: boolean;
  consecutiveFailuresToStop: number | null;
  runtime: StopPolicyRuntime;
}): string[] {
  const { runtime: r } = policy;
  const issues: string[] = [];
  const numeric = r.timingEvaluation === "SLOWER_THAN_REFERENCE_FAILS";
  if (policy.numericStopAvailable !== numeric) {
    issues.push("numericStopAvailable は runtime.timingEvaluation=SLOWER_THAN_REFERENCE_FAILS のときだけ true");
  }
  if (numeric) {
    if (policy.consecutiveFailuresToStop === null) issues.push("数値 stop の policy は consecutiveFailuresToStop が必須");
    if (r.consecutiveFailureAction === null) issues.push("数値 stop の policy は runtime.consecutiveFailureAction が必須");
    if (r.reference === "NONE" || r.reference === "TARGET_LOWER") issues.push("数値 stop の policy は遅すぎを判定できる reference が必須");
  } else {
    if (policy.consecutiveFailuresToStop !== null) issues.push("数値 stop の無い policy は consecutiveFailuresToStop=null");
    if (r.consecutiveFailureAction !== null || r.firstFailureAction !== null) issues.push("数値 stop の無い policy は failure action を持たない");
  }
  if ((r.timingEvaluation === "FASTER_THAN_TARGET_LOWER_WARNS") !== (r.reference === "TARGET_LOWER")) {
    issues.push("reference=TARGET_LOWER は timingEvaluation=FASTER_THAN_TARGET_LOWER_WARNS のときだけ");
  }
  if ((r.timingEvaluation === "FASTER_THAN_TARGET_LOWER_WARNS") !== (r.tooFastConsecutiveThreshold !== null)) {
    issues.push("tooFastConsecutiveThreshold は timingEvaluation=FASTER_THAN_TARGET_LOWER_WARNS のときだけ（かつ必須）");
  }
  if (r.timingEvaluation === "NONE" && r.reference !== "NONE") {
    issues.push("timingEvaluation=NONE の policy は reference=NONE");
  }
  if ((r.techniqueNotGoodAction !== null) !== (r.techniqueMissingAction !== null)) {
    issues.push("techniqueNotGoodAction と techniqueMissingAction は対で指定する（未入力を GOOD と推測しない）");
  }
  if (r.techniqueNotGoodAction !== null && r.techniqueDeterioratingAction !== null) {
    issues.push("techniqueNotGoodAction がある policy は DETERIORATING を別 action にしない（≠GOOD に含まれる）");
  }
  return issues;
}

// ---------------------------------------------------------------------------
// RuntimeSafetyPolicySnapshot（§13.2 の red flag グループの runtime コピー）
// ---------------------------------------------------------------------------

export const runtimeRedFlagGroupSchema = z
  .object({
    redFlags: z.array(redFlagSchema).min(1),
    safetyOutcome: safetyOutcomeSchema,
    severityRank: z.number().int().nonnegative(),
  })
  .strict();
export type RuntimeRedFlagGroup = z.infer<typeof runtimeRedFlagGroupSchema>;

/**
 * plan 時点の R5 readinessRules から、実施中の safety 判定に必要な最小限だけをコピーしたもの。
 * 健康情報（誰がどの部位を痛めたか）ではなく「red flag → safetyOutcome」の versioned policy。
 */
export const runtimeSafetyPolicySnapshotSchema = z
  .object({
    redFlagGroups: z.array(runtimeRedFlagGroupSchema).min(1),
    /** red flag を伴わない「痛みあり」の safetyOutcome（R5 PAIN_PRESENT 行のコピー）。 */
    painPresentOutcome: safetyOutcomeSchema,
  })
  .strict()
  .superRefine((policy, ctx) => {
    const covered = new Set(policy.redFlagGroups.flatMap((g) => g.redFlags));
    for (const flag of RED_FLAGS) {
      if (!covered.has(flag)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `safetyPolicy に RedFlag ${flag} を含むグループがありません`, path: ["redFlagGroups"] });
      }
    }
    const all = policy.redFlagGroups.flatMap((g) => g.redFlags);
    if (new Set(all).size !== all.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "safetyPolicy の RedFlag が複数グループに重複しています", path: ["redFlagGroups"] });
    }
  });
export type RuntimeSafetyPolicySnapshot = z.infer<typeof runtimeSafetyPolicySnapshotSchema>;
