/**
 * Running Prescription Engine v2 — §10.4 step 1: OBSERVATION NORMALIZATION。
 *
 * 入力（MonitorState / RepObservation）を Zod で検証し、計時の「実効的な扱い」を決める。入力値そのものは
 * 書き換えない（正規化結果は別オブジェクトとして返す）。policy 値（tolerance 等）は処方の monitoringSnapshot
 * からだけ読む（RuleSet を読まない）。
 */
import type { TimingMethod } from "../types/intensity";
import type { TimingToleranceSnapshot } from "../types/prescription";
import {
  isAfterLastLog,
  monitorStateSchema,
  repObservationSchema,
  type MonitorState,
  type RepObservation,
  type StopReason,
} from "./schema";

export type NormalizedTiming = {
  /** 入力どおりの計時法。 */
  timing: TimingMethod;
  /** VIDEO で fps が無ければ UNKNOWN（§10.2・§20 T-TIM-05）。 */
  effectiveTiming: TimingMethod;
  /** effective timing の snapshot 行（無ければ null）。 */
  policy: TimingToleranceSnapshot | null;
  /** 数値 tolerance（秒）。数値 stop が許されない計時法・解決できない場合は null。 */
  toleranceS: number | null;
  /** tolerance / 参照 がこれを超えたら COACH_ONLY（null = 追加条件なし）。 */
  ratioThreshold: number | null;
  /**
   * 今回の本のタイムが time-domain で有効な計測か（数値 tolerance が定義される計時法でタイムがある）。
   * 参照候補になれるかの前提であり、「数値 stop を評価してよいか」（比率条件。timing.ts の
   * `isNumericStopEvaluable`）とは別。
   */
  timeDomainMeasurement: boolean;
  /** time-domain の計測として扱えない理由（timeDomainMeasurement=false のとき）。 */
  coachOnlyReasons: StopReason[];
};

export type NormalizedInput = {
  state: MonitorState;
  obs: RepObservation;
  timing: NormalizedTiming;
};

/**
 * 計時法ごとの tolerance を snapshot から解決する。
 *   - `numericStopAllowed=false`（RADAR_LASER / UNKNOWN）→ COACH_ONLY
 *   - `toleranceS` が数値 → その値
 *   - `toleranceSPerFps`（VIDEO）→ toleranceSPerFps / fps（fps が無ければ UNKNOWN へ格下げ済み）
 */
export function normalizeTiming(obs: RepObservation, tolerances: readonly TimingToleranceSnapshot[]): NormalizedTiming {
  const fpsMissing = obs.timing === "VIDEO" && obs.videoFps == null;
  const effectiveTiming: TimingMethod = fpsMissing ? "UNKNOWN" : obs.timing;
  const policy = tolerances.find((t) => t.timing === effectiveTiming) ?? null;
  const reasons: StopReason[] = [];
  if (fpsMissing) reasons.push("TIMING_VIDEO_FPS_MISSING");

  let toleranceS: number | null = null;
  if (policy === null) {
    reasons.push("TIMING_POLICY_MISSING");
  } else if (!policy.numericStopAllowed) {
    reasons.push("TIMING_METHOD_COACH_ONLY");
  } else if (policy.toleranceS !== null) {
    toleranceS = policy.toleranceS;
  } else if (policy.toleranceSPerFps !== null && obs.videoFps != null) {
    toleranceS = policy.toleranceSPerFps / obs.videoFps;
  } else {
    reasons.push("TIMING_METHOD_COACH_ONLY");
  }
  if (obs.timeS === null) reasons.push("TIMING_NOT_RECORDED");

  const timeDomainMeasurement = toleranceS !== null && obs.timeS !== null;
  return {
    timing: obs.timing,
    effectiveTiming,
    policy,
    toleranceS,
    ratioThreshold: policy?.coachOnlyRatioThreshold ?? null,
    timeDomainMeasurement,
    coachOnlyReasons: timeDomainMeasurement ? [] : reasons,
  };
}

/**
 * MonitorState と観測を検証する。次の場合は例外（Zod / Error）で拒否する:
 *   - 処方が RunningPrescriptionSchema を通らない（monitoringSnapshot 必須・stopPolicyId と snapshot id の一致・
 *     timing 行の重複なし は処方 schema 側で検証済み）
 *   - priorLogs が別の処方のもの・昇順でない・重複している
 *   - 観測の (setIndex, repIndex) が既にログ済み、または最後のログより前（同じ本を2回判定しない＝EXTEND_REST の二重発行を防ぐ）
 */
export function normalizeInput(rawState: unknown, rawObs: unknown): NormalizedInput {
  const state = monitorStateSchema.parse(rawState);
  const obs = repObservationSchema.parse(rawObs);
  if (!isAfterLastLog(state.priorLogs, obs)) {
    throw new Error(
      `RepObservation(set=${obs.setIndex}, rep=${obs.repIndex}) は既にログ済み、または最後のログより前です（同じ本を再判定しない）`,
    );
  }
  return { state, obs, timing: normalizeTiming(obs, state.prescription.monitoringSnapshot.timingTolerances) };
}
