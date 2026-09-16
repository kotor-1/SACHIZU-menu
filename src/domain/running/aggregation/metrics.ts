/**
 * Running Prescription Engine v2 — §11.2 指標の定義と §11.3 の null 伝播。
 *
 * ここでの絶対規則:
 *   - **null を 0 にしない。** 片方の bound が null なら合計のその bound も null。
 *   - source / confidence を楽観側へ丸めない（ESTIMATED を含む合計を MEASURED にしない）。
 *   - Method の判定は RuleSet の METHOD_AGGREGATION と rep の判別共用体だけから行う
 *     （templateId / ruleId / 表示名を解析しない）。
 */
import type { AggregationRule, AggregationVolumeMetric } from "../rules/schema";
import type { Confidence, DataSource, QuantityInterval, Unit } from "../types/primitives";
import type { RunningPrescriptionValue } from "../types/prescription";

// ---------------------------------------------------------------------------
// QuantityInterval の演算
// ---------------------------------------------------------------------------

/**
 * [R6 errata] source の合成（ENGINE-POLICY）: 「既知の 0」（RULE_DEFINITION で lower=upper=0）は
 * 合計の確からしさを下げないので無視し、残りのうち **最も弱い** ものを採る。
 * 弱さの順序: MEASURED < PLANNED < COACH_ENTERED < ESTIMATED < UNKNOWN。
 * 残りが1つも無い（すべて既知の 0）ときだけ RULE_DEFINITION。
 */
const SOURCE_WEAKNESS: Record<DataSource, number> = {
  MEASURED: 0,
  PLANNED: 1,
  COACH_ENTERED: 2,
  ESTIMATED: 3,
  UNKNOWN: 4,
  RULE_DEFINITION: -1,
};

/** confidence の合成: 最も低いものを採る（LOW を含む合計を HIGH にしない）。 */
const CONFIDENCE_ORDER: Record<Confidence, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export function interval<U extends Unit>(
  lower: number | null,
  upper: number | null,
  unit: U,
  source: DataSource,
  confidence: Confidence,
): QuantityInterval<U> {
  return { lower, upper, unit, source, confidence };
}

/** 定義上 0（STRIDE の高速曝露など）。unknown ではないので completeness を下げない。 */
export function knownZero<U extends Unit>(unit: U): QuantityInterval<U> {
  return interval(0, 0, unit, "RULE_DEFINITION", "HIGH");
}

/** 値が分からない（0 と区別する）。 */
export function unknownInterval<U extends Unit>(unit: U): QuantityInterval<U> {
  return interval(null, null, unit, "UNKNOWN", "NONE");
}

function isKnownZero(i: QuantityInterval): boolean {
  return i.source === "RULE_DEFINITION" && i.lower === 0 && i.upper === 0;
}

export function sumIntervals<U extends Unit>(unit: U, parts: readonly QuantityInterval<U>[]): QuantityInterval<U> {
  if (parts.length === 0) return knownZero(unit);
  let lower: number | null = 0;
  let upper: number | null = 0;
  for (const p of parts) {
    lower = lower === null || p.lower === null ? null : lower + p.lower;
    upper = upper === null || p.upper === null ? null : upper + p.upper;
  }
  const meaningful = parts.filter((p) => !isKnownZero(p));
  if (meaningful.length === 0) return interval(lower, upper, unit, "RULE_DEFINITION", "HIGH");
  const source = meaningful.reduce<DataSource>(
    (worst, p) => (SOURCE_WEAKNESS[p.source] > SOURCE_WEAKNESS[worst] ? p.source : worst),
    "MEASURED",
  );
  const confidence = meaningful.reduce<Confidence>(
    (lowest, p) => (CONFIDENCE_ORDER[p.confidence] < CONFIDENCE_ORDER[lowest] ? p.confidence : lowest),
    "HIGH",
  );
  return interval(lower, upper, unit, source, confidence);
}

/** 区間を本数倍する（null は null のまま）。 */
export function scaleInterval<U extends Unit>(i: QuantityInterval<U>, n: number): QuantityInterval<U> {
  return interval(i.lower === null ? null : i.lower * n, i.upper === null ? null : i.upper * n, i.unit, i.source, i.confidence);
}

/** 区間のどちらかの bound が null か。 */
export function hasUnknownBound(i: QuantityInterval): boolean {
  return i.lower === null || i.upper === null;
}

// ---------------------------------------------------------------------------
// 処方から1項目ぶんの量を取り出す
// ---------------------------------------------------------------------------

export function itemTotalReps(p: RunningPrescriptionValue): number {
  return p.sets.value * p.repsPerSet.value;
}

/**
 * 1本あたりの走行距離（§11.2「1本の距離」）。deceleration は含めない（R4 と同じ除外）。
 * rep の判別共用体だけで決める（Method 名を見ない）。
 */
export function repRunningDistanceM(p: RunningPrescriptionValue): QuantityInterval<"m"> {
  const rep = p.rep;
  switch (rep.kind) {
    case "DISTANCE":
      return interval(rep.distanceM.value, rep.distanceM.value, "m", "PLANNED", "HIGH");
    case "FLY": {
      const total = rep.buildUpDistanceM.value + rep.flyZoneDistanceM.value;
      return interval(total, total, "m", "PLANNED", "HIGH");
    }
    case "DURATION":
      // 表示距離は個別化で求めた区間（不明なら null のまま）。
      return rep.displayDistanceM;
    case "SPLIT": {
      const total = rep.segments.reduce((sum, s) => sum + s.distanceM, 0);
      return interval(total, total, "m", "PLANNED", "HIGH");
    }
    case "ATTEMPTS":
      // 助走距離はコーチ手入力。未入力なら「不明」であって 0 ではない。
      return rep.approachDistanceM === null
        ? unknownInterval("m")
        : interval(rep.approachDistanceM.value, rep.approachDistanceM.value, "m", "COACH_ENTERED", "HIGH");
  }
}

/** §11.2 totalRunningDistanceM（1項目ぶん）。 */
export function itemTotalRunningDistanceM(p: RunningPrescriptionValue): QuantityInterval<"m"> {
  return scaleInterval(repRunningDistanceM(p), itemTotalReps(p));
}

/** fly 区間の距離（flyVolumeM の集計に使う）。FLY 以外は定義上 0。 */
export function itemFlyVolumeM(p: RunningPrescriptionValue): QuantityInterval<"m"> {
  if (p.rep.kind !== "FLY") return knownZero("m");
  const fly = p.rep.flyZoneDistanceM.value;
  return scaleInterval(interval(fly, fly, "m", "PLANNED", "HIGH"), itemTotalReps(p));
}

/**
 * §11.2 nearMaxSprintVolumeM（1項目ぶん）。どの式を使うかは RuleSet の
 * METHOD_AGGREGATION.nearMaxModel が決める（TS に Method のグループ分けを複製しない）。
 */
export function itemNearMaxSprintVolumeM(
  p: RunningPrescriptionValue,
  rule: Extract<AggregationRule, { kind: "METHOD_AGGREGATION" }>,
  approachType: "SHORT" | "FULL" | null,
): QuantityInterval<"m"> {
  const n = itemTotalReps(p);
  switch (rule.nearMaxModel) {
    case "NONE":
      return knownZero("m");
    case "REP_DISTANCE":
    case "BUILD_UP_PLUS_FLY":
    case "DISPLAY_DISTANCE":
      return scaleInterval(repRunningDistanceM(p), n);
    case "APPROACH_IF_FULL":
      // SHORT を FULL 扱いしない（approachType は R4 の構造化メタデータ）。
      if (approachType !== "FULL") return knownZero("m");
      return scaleInterval(repRunningDistanceM(p), n);
  }
}

/** Method 合計の比較に使う量（RuleSet の volumeMetric ごと）。attempts は本数そのもの。 */
export function itemMethodVolume(
  p: RunningPrescriptionValue,
  metric: AggregationVolumeMetric,
): QuantityInterval<"m"> | QuantityInterval<"reps"> {
  switch (metric) {
    case "sessionVolumeM":
      return itemTotalRunningDistanceM(p);
    case "flyVolumeM":
      return itemFlyVolumeM(p);
    case "attempts": {
      const n = itemTotalReps(p);
      return interval(n, n, "reps", "PLANNED", "HIGH");
    }
  }
}

// ---------------------------------------------------------------------------
// rest / 走行時間（§11.4 AGG_REST_INFEASIBLE）
// ---------------------------------------------------------------------------

export type ItemTimeBreakdown = {
  /** 必ず取る休息の合計秒（同じ休息を二重に数えない）。 */
  mandatoryRestS: number;
  /** 時間が確定している走行秒（不明なら null。推測しない）。 */
  knownRunningS: number | null;
};

export function itemTimeBreakdown(p: RunningPrescriptionValue): ItemTimeBreakdown {
  const sets = p.sets.value;
  const repsPerSet = p.repsPerSet.value;
  const totalReps = sets * repsPerSet;

  // set 内の本間 + set 間 + 分割走の区間休息。
  const repRestCount = sets * Math.max(0, repsPerSet - 1);
  const setRestCount = Math.max(0, sets - 1);
  const betweenSetsS = p.rest.setRestS ? p.rest.setRestS.value : p.rest.repRestS.value;
  let mandatoryRestS = repRestCount * p.rest.repRestS.value + setRestCount * betweenSetsS;
  if (p.rep.kind === "SPLIT" && p.rest.intraRepRestS) {
    mandatoryRestS += Math.max(0, p.rep.segments.length - 1) * totalReps * p.rest.intraRepRestS.value;
  }

  let knownRunningS: number | null = null;
  if (p.rep.kind === "DURATION") {
    knownRunningS = p.rep.durationS.value * totalReps;
  } else if (p.intensity.reference.kind === "TARGET_SPLIT") {
    const lower = p.intensity.reference.segments.reduce<number | null>(
      (sum, seg) => (sum === null || seg.targetS.lower === null ? null : sum + seg.targetS.lower),
      0,
    );
    knownRunningS = lower === null ? null : lower * totalReps;
  }
  return { mandatoryRestS, knownRunningS };
}
