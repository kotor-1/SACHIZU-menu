/**
 * Running Prescription Engine v2 — `monitorRunningPrescription(state, obs)`（§10・§1.5）。
 *
 * **plan ではない。** 処方を再生成しない・Envelope を再選択しない・athlete context / weekly / competition /
 * readiness を再評価しない・RuleSet を読まない。判定に使う policy は `state.prescription.monitoringSnapshot`
 * （plan 時点の StopPolicy / TimingTolerance / safety policy のコピー）だけ。永続化もしない（R11 が保存する）。
 *
 * §10.4 の順:
 *   1 OBSERVATION NORMALIZATION → 2 SAFETY GATE（STOP_SAFETY なら以降を評価しない）→ 3 TIMING RELIABILITY →
 *   4 PERFORMANCE vs REFERENCE → 5 COACH JUDGMENT → 6 CUMULATIVE CHECK → 7 DECISION + RepLogEntry
 */
import { cumulativeExposure, repHighSpeedExposure, resolveDecision, orderedReasons } from "./decision";
import { normalizeInput } from "./normalize";
import { evaluateSafetyGate } from "./safety";
import { evaluateStopPolicy } from "./stopPolicies";
import { repLogEntrySchema, type MonitorDecision, type MonitorState, type RepLogEntry, type RepObservation } from "./schema";

export type { MonitorAction, MonitorDecision, MonitorState, RepLogEntry, RepObservation, StopReason } from "./schema";
export { repObservationSchema, repLogEntrySchema, monitorStateSchema } from "./schema";

export function monitorRunningPrescription(state: MonitorState, obs: RepObservation): MonitorDecision {
  // ---- 1: normalization（不正な state / 観測・二重判定は例外で拒否） ----
  const input = normalizeInput(state, obs);
  const { prescription, priorLogs } = input.state;
  const observation = input.obs;
  const timing = input.timing;
  const plannedRepCount = prescription.sets.value * prescription.repsPerSet.value;
  const completedRepCount = priorLogs.length + 1;

  const baseLog = {
    stopPolicyId: prescription.stopPolicyId,
    setIndex: observation.setIndex,
    repIndex: observation.repIndex,
    timeS: observation.timeS,
    timing: timing.timing,
    effectiveTiming: timing.effectiveTiming,
    toleranceS: timing.toleranceS,
    startQuality: observation.coachJudgment?.startQuality ?? null,
    measuredVelocityDecrementPercent: observation.measuredVelocityDecrementPercent ?? null,
    restTakenS: observation.restTakenS ?? null,
    highSpeedExposureM: repHighSpeedExposure(prescription, observation),
  };

  // ---- 2: safety gate（timing より前。timeS=null でも止める） ----
  const safety = evaluateSafetyGate(observation, prescription.monitoringSnapshot.safetyPolicy);
  if (safety.stop) {
    const reasons = orderedReasons(safety.reasons);
    const logEntry: RepLogEntry = repLogEntrySchema.parse({
      ...baseLog,
      referenceTimeS: null,
      referenceSource: null,
      quality: "NOT_EVALUATED_COACH_ONLY",
      fasterThanTargetLower: null,
      action: "STOP_SAFETY",
      safetyOutcome: safety.safetyOutcome,
      reasons,
    });
    return finish(logEntry, 0);
  }

  // ---- 3–6: timing / reference / coach judgment / cumulative（stop policy snapshot だけで判定） ----
  const policy = evaluateStopPolicy({ prescription, priorLogs, obs: observation, timing });
  const decision = resolveDecision(prescription, policy.candidates, policy.notes);

  // ---- 7: decision + log ----
  const logEntry: RepLogEntry = repLogEntrySchema.parse({
    ...baseLog,
    referenceTimeS: policy.referenceTimeS,
    referenceSource: policy.referenceSource,
    quality: policy.quality,
    fasterThanTargetLower: policy.fasterThanTargetLower,
    action: decision.action,
    safetyOutcome: decision.safetyOutcome,
    reasons: decision.reasons,
  });
  return { ...finish(logEntry, policy.consecutiveFailures), nextRepRestS: decision.nextRepRestS };

  function finish(entry: RepLogEntry, consecutiveFailures: number): MonitorDecision {
    return {
      action: entry.action,
      safetyOutcome: entry.safetyOutcome,
      nextRepRestS: null,
      quality: entry.quality,
      consecutiveFailures,
      reasons: [...entry.reasons],
      logEntry: entry,
      completedRepCount,
      plannedRepCount,
      cumulativeHighSpeedExposureM: cumulativeExposure([...priorLogs, entry]),
      exposureLimitEvaluation: "NOT_EVALUATED",
    };
  }
}
