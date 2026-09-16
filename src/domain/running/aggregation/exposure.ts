/**
 * Running Prescription Engine v2 — §11.2 高速曝露の区間計算。
 *
 * 推定加速距離 A は **RuleSet の ACCEL_INTERVAL**（tier ごとの区間）から読む。
 * 「最高速度に達する距離 = 25m」のような1値にしない（常に区間・source=ESTIMATED・confidence=LOW）。
 * どの式を使うかは MethodMeta.highSpeedExposureModel だけで決める（別の対応表を作らない）。
 */
import type { AggregationRule, RuleSet } from "../rules/schema";
import type { QuantityInterval } from "../types/primitives";
import type { EnvelopeTier } from "../types/subject";
import type { RunningPrescriptionValue } from "../types/prescription";
import { interval, itemTotalReps, knownZero, repRunningDistanceM, scaleInterval, unknownInterval } from "./metrics";

export type AccelInterval = { lowerM: number; upperM: number };

/** RuleSet から tier の A を引く（見つからなければ null。TS 側に既定値を持たない）。 */
export function accelIntervalFor(ruleSet: RuleSet, tier: EnvelopeTier): AccelInterval | null {
  const rule = ruleSet.aggregationRules.find(
    (r): r is Extract<AggregationRule, { kind: "ACCEL_INTERVAL" }> => r.kind === "ACCEL_INTERVAL" && r.tier === tier,
  );
  return rule ? { lowerM: rule.lowerM, upperM: rule.upperM } : null;
}

/** RuleSet から RELAY の助走許容を引く。 */
export function relayAllowanceM(ruleSet: RuleSet): number | null {
  const rule = ruleSet.aggregationRules.find(
    (r): r is Extract<AggregationRule, { kind: "RELAY_ALLOWANCE" }> => r.kind === "RELAY_ALLOWANCE",
  );
  return rule ? rule.allowanceM : null;
}

const ESTIMATED_LOW = { source: "ESTIMATED" as const, confidence: "LOW" as const };

function minusAccel(d: number | null, a: number): number | null {
  return d === null ? null : Math.max(0, d - a);
}

/**
 * §11.2 の式をそのまま実装する。
 *   NONE                          → [0, 0]（RULE_DEFINITION。定義上 0 であり unknown ではない）
 *   FLY_ZONE                      → [fly×n, (fly + max(0, buildUp − A_lo))×n]
 *   DISTANCE_MINUS_ACCEL_INTERVAL → [max(0, d − A_hi)×n, max(0, d − A_lo)×n]
 *   WHOLE_REP                     → [max(0, d − A_hi)×n, d×n]
 * deceleration は含めない（`repRunningDistanceM` が最初から除外している）。
 * A が RuleSet に無い場合は 0 と決めつけず unknown を返す。
 */
export function estimateExposure(args: {
  prescription: RunningPrescriptionValue;
  model: RuleSet["methods"][number]["highSpeedExposureModel"];
  accel: AccelInterval | null;
}): QuantityInterval<"m"> {
  const { prescription: p, model, accel } = args;
  if (model === "NONE") return knownZero("m");
  const n = itemTotalReps(p);
  if (accel === null) return unknownInterval("m");

  if (model === "FLY_ZONE") {
    if (p.rep.kind !== "FLY") return unknownInterval("m");
    const fly = p.rep.flyZoneDistanceM.value;
    const buildUp = p.rep.buildUpDistanceM.value;
    const lower = fly;
    const upper = fly + Math.max(0, buildUp - accel.lowerM);
    return scaleInterval(interval(lower, upper, "m", ESTIMATED_LOW.source, ESTIMATED_LOW.confidence), n);
  }

  const d = repRunningDistanceM(p);
  if (model === "DISTANCE_MINUS_ACCEL_INTERVAL") {
    return scaleInterval(
      interval(minusAccel(d.lower, accel.upperM), minusAccel(d.upper, accel.lowerM), "m", ESTIMATED_LOW.source, ESTIMATED_LOW.confidence),
      n,
    );
  }
  // WHOLE_REP
  return scaleInterval(
    interval(minusAccel(d.lower, accel.upperM), d.upper, "m", ESTIMATED_LOW.source, ESTIMATED_LOW.confidence),
    n,
  );
}

/**
 * §11.2 RELAY（助走付き区間）。R6 では standalone の集計入力としてのみ使う。
 * 大会・R7 の competition ロジックはここには無い。
 */
export function relayExposure(legDistanceM: number, count: number, allowanceM: number | null): QuantityInterval<"m"> {
  if (allowanceM === null) return unknownInterval("m");
  return scaleInterval(
    interval(Math.max(0, legDistanceM - allowanceM), legDistanceM, "m", ESTIMATED_LOW.source, ESTIMATED_LOW.confidence),
    count,
  );
}
