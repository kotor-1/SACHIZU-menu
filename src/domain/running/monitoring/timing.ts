/**
 * Running Prescription Engine v2 — §10.4 step 3–4: TIMING RELIABILITY と PERFORMANCE vs REFERENCE。
 *
 * - FAIL = `timeS > 参照 + tolerance`（ちょうど等しいのは PASS）。
 * - `tolerance / 参照 > coachOnlyRatioThreshold` なら COACH_ONLY（ちょうど等しいのは数値評価する。`>` だけ）。
 * - 参照タイムが解決できなければ COACH_ONLY（ベストや目標を捏造しない）。
 * - UNKNOWN / RADAR_LASER / fps 無し VIDEO は COACH_ONLY であり、FAIL にしない。
 *
 * 参照の決め方は stop policy snapshot の `runtime.reference` だけで決まる（policy id を解析しない）。
 *   PRIOR_SESSION_BEST: 同じ処方の**これまでの**ログのうち、同じ effective timing の **参照候補**（下記
 *     `isReferenceCandidate`）のタイムの最小値。今回の本は参照に含めない。候補が無い最初の本は「参照の確立」
 *     （REFERENCE_ESTABLISHED・quality=PASS）とし、自分自身に対して架空のベストを作って FAIL 判定しない
 *     （[R8 representation errata]）。確立の本も比率条件（自分のタイムに対して）を満たさなければ COACH_ONLY。
 *   TARGET_UPPER: 処方 snapshot の `intensity.target`（秒）の上端。
 *   TARGET_UPPER_ELSE_PRIOR_SESSION_BEST: 目標上端があればそれ、無ければ PRIOR_SESSION_BEST。
 *
 * 2つの概念を1つの boolean に潰さない:
 *   - isReferenceCandidate: その本のタイムが **time-domain で有効な計測**か（数値 tolerance が定義される計時法
 *     — HAND / PHOTO_CELL / FAT / fps のある VIDEO — で記録され、STOP_SAFETY の本ではない）。比率条件で
 *     COACH_ONLY になった本も候補に含める（HAND fly10 の真のベスト 1.10 を外すと、後の遅い本が参照になり
 *     突然数値 stop が効くのを防ぐ）。UNKNOWN・fps 無し VIDEO・RADAR_LASER（時間 tolerance が無い）は候補にしない。
 *   - isNumericStopEvaluable: 今回の本を参照と数値比較して PASS / FAIL を出してよいか（候補であること +
 *     比率条件 `tolerance / 参照 ≤ threshold`）。
 */
import type { RunningPrescriptionValue } from "../types/prescription";
import type { StopPolicyReference } from "../types/monitoring";
import type { NormalizedTiming } from "./normalize";
import type { ReferenceSource, RepLogEntry, RepObservation, RepQuality, StopReason } from "./schema";

export type TimingEvaluation = {
  quality: RepQuality;
  referenceTimeS: number | null;
  referenceSource: ReferenceSource | null;
  reasons: StopReason[];
};

/** 処方の目標区間（秒）。単位が秒で bound が非 null のときだけ使う。 */
export function targetSecondsBound(p: RunningPrescriptionValue, bound: "lower" | "upper"): number | null {
  const target = p.intensity.target;
  if (target === null || target.unit !== "s") return null;
  const value = target[bound];
  return value !== null && value > 0 ? value : null;
}

/**
 * 過去ログの本が session-best の**参照候補**か。time-domain で有効な計測（数値 tolerance が定義される effective timing で
 * タイムがある）で、STOP_SAFETY の本ではないこと。quality（PASS / FAIL / COACH_ONLY）とは独立に判定する。
 */
export function isReferenceCandidate(log: Pick<RepLogEntry, "timeS" | "toleranceS" | "action">): boolean {
  return log.timeS !== null && log.toleranceS !== null && log.action !== "STOP_SAFETY";
}

/** これまでのログのうち、同じ effective timing の参照候補のタイムの最小値（今回の本は含めない）。 */
export function priorSessionBest(priorLogs: readonly RepLogEntry[], effectiveTiming: RepLogEntry["effectiveTiming"]): number | null {
  const times = priorLogs
    .filter((log) => log.effectiveTiming === effectiveTiming && isReferenceCandidate(log))
    .map((log) => log.timeS as number);
  return times.length === 0 ? null : Math.min(...times);
}

/** §10.2 の比率条件。threshold=null は追加条件なし。ちょうど等しいのは数値評価する（`>` のみ COACH_ONLY）。 */
export function exceedsToleranceRatio(toleranceS: number, referenceTimeS: number, threshold: number | null): boolean {
  return threshold !== null && toleranceS / referenceTimeS > threshold;
}

/** 今回の本を参照と数値比較して PASS / FAIL を出してよいか（参照候補であることとは別の判定）。 */
export function isNumericStopEvaluable(toleranceS: number, referenceTimeS: number, threshold: number | null): boolean {
  return !exceedsToleranceRatio(toleranceS, referenceTimeS, threshold);
}

function coachOnly(reasons: StopReason[], referenceTimeS: number | null = null, referenceSource: ReferenceSource | null = null): TimingEvaluation {
  return { quality: "NOT_EVALUATED_COACH_ONLY", referenceTimeS, referenceSource, reasons };
}

/**
 * timingEvaluation=SLOWER_THAN_REFERENCE_FAILS の policy で、今回の本の quality を決める。
 */
export function evaluateSlowerThanReference(args: {
  prescription: RunningPrescriptionValue;
  priorLogs: readonly RepLogEntry[];
  obs: RepObservation;
  timing: NormalizedTiming;
  reference: StopPolicyReference;
}): TimingEvaluation {
  const { prescription, priorLogs, obs, timing, reference } = args;
  if (!timing.timeDomainMeasurement || timing.toleranceS === null || obs.timeS === null) {
    return coachOnly(timing.coachOnlyReasons);
  }
  const tol = timing.toleranceS;
  const timeS = obs.timeS;

  const target = reference === "TARGET_UPPER" || reference === "TARGET_UPPER_ELSE_PRIOR_SESSION_BEST" ? targetSecondsBound(prescription, "upper") : null;
  let referenceTimeS: number | null = null;
  let referenceSource: ReferenceSource | null = null;
  if (target !== null) {
    referenceTimeS = target;
    referenceSource = "TARGET_UPPER";
  } else if (reference === "PRIOR_SESSION_BEST" || reference === "TARGET_UPPER_ELSE_PRIOR_SESSION_BEST") {
    const best = priorSessionBest(priorLogs, timing.effectiveTiming);
    if (best === null) {
      // 参照の確立（候補が無い最初の本）。自分自身に対して架空のベストを作って FAIL 判定しない。
      // 計時の信頼性（比率条件）は自分のタイムに対して確認する。COACH_ONLY でもこの本は以降の参照候補になる。
      if (!isNumericStopEvaluable(tol, timeS, timing.ratioThreshold)) return coachOnly(["TIMING_TOLERANCE_RATIO_EXCEEDED"]);
      return { quality: "PASS", referenceTimeS: null, referenceSource: null, reasons: ["REFERENCE_ESTABLISHED"] };
    }
    referenceTimeS = best;
    referenceSource = "PRIOR_SESSION_BEST";
  }
  if (referenceTimeS === null || referenceSource === null) return coachOnly(["NO_NUMERIC_REFERENCE"]);
  if (!isNumericStopEvaluable(tol, referenceTimeS, timing.ratioThreshold)) {
    return coachOnly(["TIMING_TOLERANCE_RATIO_EXCEEDED"], referenceTimeS, referenceSource);
  }
  const fail = timeS > referenceTimeS + tol;
  return { quality: fail ? "FAIL" : "PASS", referenceTimeS, referenceSource, reasons: fail ? ["TIMING_FAIL"] : [] };
}

/**
 * timingEvaluation=FASTER_THAN_TARGET_LOWER_WARNS（SP_TE）: quality は常に COACH_ONLY。目標下端より
 * `timeS < 下端 − tolerance` なら「速すぎ」。計時の信頼性・目標が無ければ判定しない（null）。
 */
export function evaluateFasterThanTargetLower(args: {
  prescription: RunningPrescriptionValue;
  obs: RepObservation;
  timing: NormalizedTiming;
}): { evaluation: TimingEvaluation; fasterThanTargetLower: boolean | null } {
  const { prescription, obs, timing } = args;
  const lower = targetSecondsBound(prescription, "lower");
  if (!timing.timeDomainMeasurement || timing.toleranceS === null || obs.timeS === null) {
    return { evaluation: coachOnly(["POLICY_COACH_ONLY", ...timing.coachOnlyReasons]), fasterThanTargetLower: null };
  }
  if (lower === null) {
    return { evaluation: coachOnly(["POLICY_COACH_ONLY", "NO_NUMERIC_REFERENCE"]), fasterThanTargetLower: null };
  }
  if (!isNumericStopEvaluable(timing.toleranceS, lower, timing.ratioThreshold)) {
    return { evaluation: coachOnly(["POLICY_COACH_ONLY", "TIMING_TOLERANCE_RATIO_EXCEEDED"], lower, "TARGET_LOWER"), fasterThanTargetLower: null };
  }
  return {
    evaluation: coachOnly(["POLICY_COACH_ONLY"], lower, "TARGET_LOWER"),
    fasterThanTargetLower: obs.timeS < lower - timing.toleranceS,
  };
}
