/**
 * Running Prescription Engine v2 — §10.3 stop policy（Method × recoveryStructure）の実行。
 *
 * 挙動はすべて処方 snapshot の `monitoringSnapshot.stopPolicy.runtime` と `consecutiveFailuresToStop` から決める。
 * policy id（"SP_ACC" 等）・`ruleDescriptionJa`・method 名で分岐しない。連続判定の閾値も snapshot から読む。
 *
 * [R8 representation errata]（§10.3 に記載）:
 *   - 連続 FAIL: PASS で途切れる。NOT_EVALUATED_COACH_ONLY の本でも途切れる（FAIL→COACH_ONLY→FAIL は
 *     「2回連続」ではない）。action=END_SET で終わった本より前の FAIL は次の set へ持ち越さない。
 *   - `firstFailureAction`（EXTEND_REST）は連続 FAIL がちょうど1回目のときだけ。閾値未満の2回目以降は CONTINUE。
 *   - startQuality=POOR の連続: GOOD で途切れる。未入力（null）でも途切れる（連続 POOR を進めない）。
 *   - SP_TE の「速すぎ」: 評価できない本（計時の信頼性・目標が無い）で途切れる。連続しても action は CONTINUE
 *     （END にしない）で、reason `TEMPO_FASTER_THAN_TARGET_REPEATED`（WARN 相当）だけを出す。
 */
import type { RunningPrescriptionValue } from "../types/prescription";
import type { MonitorAction } from "../types/monitoring";
import type { SafetyOutcome } from "../types/readiness";
import type { NormalizedTiming } from "./normalize";
import { NON_HEALTH_RUNTIME_STOP_OUTCOME } from "./safety";
import type { ReferenceSource, RepLogEntry, RepObservation, RepQuality, StopReason } from "./schema";
import { evaluateFasterThanTargetLower, evaluateSlowerThanReference } from "./timing";

export type ActionCandidate = { action: MonitorAction; reasons: StopReason[]; safetyOutcome?: SafetyOutcome };

export type PolicyEvaluation = {
  quality: RepQuality;
  referenceTimeS: number | null;
  referenceSource: ReferenceSource | null;
  fasterThanTargetLower: boolean | null;
  startQuality: "GOOD" | "POOR" | null;
  consecutiveFailures: number;
  candidates: ActionCandidate[];
  /** action を変えない説明用 reason（COACH_ONLY の理由・参照の確立など）。 */
  notes: StopReason[];
};

type StreakEntry = Pick<RepLogEntry, "quality" | "action" | "fasterThanTargetLower" | "startQuality">;

/** 末尾から数えた連続 FAIL 数（今回を含む）。PASS / COACH_ONLY / END_SET で終わった本で途切れる。 */
export function trailingFailureStreak(prior: readonly StreakEntry[], current: Pick<StreakEntry, "quality">): number {
  if (current.quality !== "FAIL") return 0;
  let count = 1;
  for (let i = prior.length - 1; i >= 0; i--) {
    const entry = prior[i];
    if (entry.action === "END_SET" || entry.quality !== "FAIL") break;
    count++;
  }
  return count;
}

function trailingStreak(values: readonly (boolean | null)[]): number {
  let count = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== true) break;
    count++;
  }
  return count;
}

export function evaluateStopPolicy(args: {
  prescription: RunningPrescriptionValue;
  priorLogs: readonly RepLogEntry[];
  obs: RepObservation;
  timing: NormalizedTiming;
}): PolicyEvaluation {
  const { prescription, priorLogs, obs, timing } = args;
  const policy = prescription.monitoringSnapshot.stopPolicy;
  const runtime = policy.runtime;
  const judgment = obs.coachJudgment ?? null;
  const candidates: ActionCandidate[] = [];
  const notes: StopReason[] = [];

  // ---- step 3–4: timing / performance vs reference ----
  let quality: RepQuality = "NOT_EVALUATED_COACH_ONLY";
  let referenceTimeS: number | null = null;
  let referenceSource: ReferenceSource | null = null;
  let fasterThanTargetLower: boolean | null = null;
  let consecutiveFailures = 0;

  if (runtime.timingEvaluation === "SLOWER_THAN_REFERENCE_FAILS") {
    const evaluation = evaluateSlowerThanReference({ prescription, priorLogs, obs, timing, reference: runtime.reference });
    quality = evaluation.quality;
    referenceTimeS = evaluation.referenceTimeS;
    referenceSource = evaluation.referenceSource;
    consecutiveFailures = trailingFailureStreak(priorLogs, { quality });
    const threshold = policy.consecutiveFailuresToStop;
    if (quality === "FAIL" && threshold !== null && runtime.consecutiveFailureAction !== null && consecutiveFailures >= threshold) {
      candidates.push({ action: runtime.consecutiveFailureAction, reasons: ["CONSECUTIVE_TIMING_FAILURES"] });
    } else if (quality === "FAIL" && consecutiveFailures === 1 && runtime.firstFailureAction !== null) {
      candidates.push({ action: runtime.firstFailureAction, reasons: ["TIMING_FAIL"] });
    } else {
      notes.push(...evaluation.reasons);
    }
  } else if (runtime.timingEvaluation === "FASTER_THAN_TARGET_LOWER_WARNS") {
    const { evaluation, fasterThanTargetLower: fast } = evaluateFasterThanTargetLower({ prescription, obs, timing });
    quality = evaluation.quality;
    referenceTimeS = evaluation.referenceTimeS;
    referenceSource = evaluation.referenceSource;
    fasterThanTargetLower = fast;
    notes.push(...evaluation.reasons);
    const streak = trailingStreak([...priorLogs.map((l) => l.fasterThanTargetLower), fast]);
    if (runtime.tooFastConsecutiveThreshold !== null && streak >= runtime.tooFastConsecutiveThreshold) {
      // WARN 相当: action は CONTINUE のまま（END_SET / END_SESSION にしない）。
      candidates.push({ action: "CONTINUE", reasons: ["TEMPO_FASTER_THAN_TARGET_REPEATED"] });
    }
  } else {
    notes.push("POLICY_COACH_ONLY");
  }

  // ---- step 5: coach judgment ----
  const startQuality = judgment?.startQuality ?? null;
  if (runtime.poorStartConsecutiveThreshold !== null) {
    const streak = trailingStreak([...priorLogs.map((l) => (l.startQuality === null ? null : l.startQuality === "POOR")), startQuality === null ? null : startQuality === "POOR"]);
    if (streak >= runtime.poorStartConsecutiveThreshold) {
      candidates.push({ action: "COACH_REVIEW", reasons: ["START_QUALITY_POOR_REPEATED"] });
    }
  }
  const technique = judgment?.technique;
  if (runtime.techniqueNotGoodAction !== null && (technique === "ACCEPTABLE" || technique === "DETERIORATING")) {
    candidates.push({ action: runtime.techniqueNotGoodAction, reasons: ["ASSISTED_TECHNIQUE_NOT_GOOD"], safetyOutcome: NON_HEALTH_RUNTIME_STOP_OUTCOME });
  }
  if (runtime.techniqueMissingAction !== null && technique === undefined) {
    candidates.push({ action: runtime.techniqueMissingAction, reasons: ["TECHNIQUE_NOT_ASSESSED"] });
  }
  if (runtime.techniqueDeterioratingAction !== null && technique === "DETERIORATING") {
    candidates.push({ action: runtime.techniqueDeterioratingAction, reasons: ["TECHNIQUE_DETERIORATING"] });
  }
  if (runtime.velocityDecrementOutOfBandAction !== null) {
    const vdec = obs.measuredVelocityDecrementPercent ?? null;
    const target = prescription.intensity.target;
    const band =
      prescription.intensity.reference.kind === "VELOCITY_DECREMENT" && target !== null && target.unit === "percent" && target.lower !== null && target.upper !== null
        ? { lower: target.lower, upper: target.upper }
        : null;
    if (vdec !== null && band === null) {
      notes.push("VELOCITY_DECREMENT_BAND_UNAVAILABLE");
    } else if (vdec !== null && band !== null && (vdec < band.lower || vdec > band.upper)) {
      candidates.push({ action: runtime.velocityDecrementOutOfBandAction, reasons: ["VELOCITY_DECREMENT_OUT_OF_BAND"] });
    }
  }
  if (runtime.effortBecameMaximalAction !== null && judgment?.effortBecameMaximal === true) {
    candidates.push({ action: runtime.effortBecameMaximalAction, reasons: ["EFFORT_BECAME_MAXIMAL"] });
  }

  // ---- step 6: cumulative（予定数への到達） ----
  const plannedCount = prescription.sets.value * prescription.repsPerSet.value;
  const completedCount = priorLogs.length + 1;
  if (completedCount >= plannedCount) {
    // formal enum 上は END_SESSION_QUALITY だが、reason で「品質低下による終了」と区別する。
    candidates.push({
      action: "END_SESSION_QUALITY",
      reasons: [runtime.plannedCountUnit === "ATTEMPTS" ? "ATTEMPTS_COMPLETE" : "PLANNED_REPS_COMPLETE"],
    });
  }

  return { quality, referenceTimeS, referenceSource, fasterThanTargetLower, startQuality, consecutiveFailures, candidates, notes };
}
