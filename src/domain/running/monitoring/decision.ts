/**
 * Running Prescription Engine v2 — §10.4 step 7: DECISION + RepLogEntry。
 *
 * 同じ本で複数の trigger があれば、下の順位表で最も強い action を1つ選ぶ（if の順番や配列の順序に依存しない）。
 *   STOP_SAFETY > END_SESSION_QUALITY > END_SET > EXTEND_REST > COACH_REVIEW > CONTINUE
 * reason はすべての trigger のものを残す（弱い trigger の reason も消さない）。
 */
import type { QuantityInterval } from "../types/primitives";
import type { RunningPrescriptionValue } from "../types/prescription";
import type { MonitorAction } from "../types/monitoring";
import type { SafetyOutcome } from "../types/readiness";
import { sumIntervals } from "../aggregation/metrics";
import type { ActionCandidate } from "./stopPolicies";
import { NON_HEALTH_RUNTIME_STOP_OUTCOME, worseSafetyOutcome } from "./safety";
import { STOP_REASONS, type RepLogEntry, type RepObservation, type StopReason } from "./schema";

/** action の強さ（唯一の定義）。 */
export const MONITOR_ACTION_RANK: Record<MonitorAction, number> = {
  CONTINUE: 0,
  COACH_REVIEW: 1,
  EXTEND_REST: 2,
  END_SET: 3,
  END_SESSION_QUALITY: 4,
  STOP_SAFETY: 5,
};

export function strongestAction(actions: readonly MonitorAction[]): MonitorAction {
  return actions.reduce<MonitorAction>((best, a) => (MONITOR_ACTION_RANK[a] > MONITOR_ACTION_RANK[best] ? a : best), "CONTINUE");
}

/**
 * [R8 representation errata] EXTEND_REST の休息: 延長量の式（+30秒・割合）を作らない。
 * `min` = 計画の repRest（最低でも現行の休息を確保）、`max` = `repRestS.coachEditable.max`。
 * 延長の余地が無い（計画値 ≥ coachEditable.max）なら null（呼び出し側で COACH_REVIEW へ fallback）。
 */
export function restExtensionRange(p: RunningPrescriptionValue): { min: number; max: number; unit: "s" } | null {
  const planned = p.rest.repRestS.value;
  const max = p.rest.repRestS.coachEditable.max;
  return planned < max ? { min: planned, max, unit: "s" } : null;
}

/**
 * 1本分の高速曝露。実測（MEASURED）があればそれ、無ければ計画の項目合計を予定数で割った1本分を PLANNED で
 * コピーする（§10.5）。計画は全本同一の積算（sets × repsPerSet 本）なので割り算で1本分に戻る。null は null のまま。
 */
export function repHighSpeedExposure(p: RunningPrescriptionValue, obs: RepObservation): RepLogEntry["highSpeedExposureM"] {
  const measured = obs.actualHighSpeedExposureM ?? null;
  if (measured !== null) return { ...measured };
  const planned = p.exposure.plannedHighSpeedExposureM;
  const count = p.sets.value * p.repsPerSet.value;
  return {
    lower: planned.lower === null ? null : planned.lower / count,
    upper: planned.upper === null ? null : planned.upper / count,
    unit: "m",
    source: "PLANNED",
    confidence: planned.confidence,
  };
}

export function cumulativeExposure(logs: readonly RepLogEntry[]): QuantityInterval<"m"> {
  return sumIntervals("m", logs.map((l) => l.highSpeedExposureM));
}

/** reason を重複なく、enum の定義順（安定した順序）に並べる。 */
export function orderedReasons(reasons: readonly StopReason[]): StopReason[] {
  const set = new Set(reasons);
  return STOP_REASONS.filter((r) => set.has(r));
}

export type ResolvedDecision = {
  action: MonitorAction;
  safetyOutcome: SafetyOutcome;
  nextRepRestS: { min: number; max: number; unit: "s" } | null;
  reasons: StopReason[];
};

/** 候補から最終 action を決める。EXTEND_REST に延長余地が無ければ COACH_REVIEW に置き換えてから順位付けする。 */
export function resolveDecision(p: RunningPrescriptionValue, candidates: readonly ActionCandidate[], notes: readonly StopReason[]): ResolvedDecision {
  const extension = restExtensionRange(p);
  const effective: ActionCandidate[] = candidates.map((c) =>
    c.action === "EXTEND_REST" && extension === null ? { action: "COACH_REVIEW", reasons: [...c.reasons, "REST_EXTENSION_UNAVAILABLE"] } : c,
  );
  const action = strongestAction(effective.map((c) => c.action));
  let safetyOutcome: SafetyOutcome = "NONE";
  if (action === "STOP_SAFETY") {
    for (const c of effective) {
      if (c.action === "STOP_SAFETY") safetyOutcome = worseSafetyOutcome(safetyOutcome, c.safetyOutcome ?? NON_HEALTH_RUNTIME_STOP_OUTCOME);
    }
  }
  return {
    action,
    safetyOutcome,
    nextRepRestS: action === "EXTEND_REST" ? extension : null,
    reasons: orderedReasons([...effective.flatMap((c) => c.reasons), ...notes]),
  };
}
