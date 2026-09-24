/**
 * Running Prescription Engine v2 — Performance reference resolution（§4.6）。
 *
 * ここでは**処方値を一切生成しない**。「どの IntensityReference kind が
 * 使えるか」「どのくらいの confidence で使えるか」だけを決める。実際に
 * sets/reps/rest を決める `planRunningPrescription()` は R4。
 *
 * 絶対にしないこと:
 *   - 100m PB → Vmax 推定式（§4.6, §24 OPEN-02: `vmaxEstimationModels: []`）。
 *     100m PB しか無い athlete には常に MAX_INTENT/RELAXED_SUBMAX（数値目標
 *     なし・confidence LOW）を返す。
 *   - timing tolerance の数値を定数として書き写す（R2 の
 *     `RuleSet.timingTolerances` から都度引く）。
 */
import type { TimedMark, VelocityEstimate } from "../types/intensity";
import type { Confidence, IsoDate } from "../types/primitives";
import type { IntensityReference } from "../types/intensity";
import type { RuleSet } from "../rules/schema";
import type { ResolvedAgeBand } from "./ageBand";
import { daysBetween } from "./dateMath";

// ---------------------------------------------------------------------------
// fly split → velocity（§4.6: v = d / t、区間は timing tolerance 依存）
// ---------------------------------------------------------------------------

const FLY_EVENT_DISTANCE_M: Partial<Record<TimedMark["event"], number>> = {
  FLY10: 10,
  FLY20: 20,
  FLY30: 30,
};

function isFlyMark(mark: TimedMark): boolean {
  return mark.event in FLY_EVENT_DISTANCE_M;
}

/**
 * R2 の `RuleSet.timingTolerances` から `mark.timing` の許容誤差（秒）を取得する。
 * VIDEO は `toleranceSPerFps × 2` 相当（"2/fps" 秒）を `mark.videoFps` から計算。
 * fps 未入力なら §10.2 どおり UNKNOWN 扱い（＝ tolerance 無し）。
 */
function resolveToleranceSeconds(mark: TimedMark, ruleSet: RuleSet): number | null {
  const timing = mark.timing === "VIDEO" && mark.videoFps == null ? "UNKNOWN" : mark.timing;
  const rule = ruleSet.timingTolerances.find((t) => t.timing === timing);
  if (!rule) return null;
  if (rule.toleranceS !== null) return rule.toleranceS;
  if (rule.toleranceSPerFps !== null && mark.videoFps) {
    return rule.toleranceSPerFps / mark.videoFps;
  }
  return null;
}

export type FlySplitVelocity = {
  valueMps: number;
  lowerMps: number;
  upperMps: number;
  toleranceS: number | null;
  /** tolerance/参照 > 0.10 で COACH_ONLY（§10.2 の追加条件）。 */
  coachOnlyRatio: boolean;
};

/**
 * `v = d / t` を計算し、tolerance から区間を作る（§4.6: `d/(t+tol) .. d/(t-tol)`）。
 * fly マーク以外を渡すとエラー。
 */
export function computeFlySplitVelocity(mark: TimedMark, ruleSet: RuleSet): FlySplitVelocity {
  const distanceM = FLY_EVENT_DISTANCE_M[mark.event];
  if (distanceM === undefined) {
    throw new Error(`computeFlySplitVelocity: ${mark.event} is not a fly event`);
  }
  const valueMps = distanceM / mark.timeS;
  const toleranceS = resolveToleranceSeconds(mark, ruleSet);
  if (toleranceS === null) {
    // tolerance が定義されない（RADAR_LASER/UNKNOWN 等）→ 区間を作らず点推定のみ。
    return { valueMps, lowerMps: valueMps, upperMps: valueMps, toleranceS: null, coachOnlyRatio: false };
  }
  const lowerMps = distanceM / (mark.timeS + toleranceS);
  const upperMps = distanceM / (mark.timeS - toleranceS);
  const coachOnlyRatio = toleranceS / mark.timeS > 0.1;
  return { valueMps, lowerMps, upperMps, toleranceS, coachOnlyRatio };
}

// ---------------------------------------------------------------------------
// Mark freshness（§4.6: 非ADULT 180日超・ADULT 365日超で confidence を1段下げる）
// ---------------------------------------------------------------------------

const CONFIDENCE_DOWNGRADE: Record<Confidence, Confidence> = {
  HIGH: "MEDIUM",
  MEDIUM: "LOW",
  LOW: "LOW",
  NONE: "NONE",
};

/**
 * `>` 180日／365日（ちょうどはまだ fresh。181日目・366日目から downgrade）。
 */
export function isMarkStale(markDate: IsoDate, asOf: IsoDate, ageBand: ResolvedAgeBand): boolean {
  const age = daysBetween(markDate, asOf);
  const thresholdDays = ageBand === "ADULT" ? 365 : 180;
  return age > thresholdDays;
}

export function applyFreshnessDowngrade(
  confidence: Confidence,
  markDate: IsoDate,
  asOf: IsoDate,
  ageBand: ResolvedAgeBand,
): Confidence {
  return isMarkStale(markDate, asOf, ageBand) ? CONFIDENCE_DOWNGRADE[confidence] : confidence;
}

// ---------------------------------------------------------------------------
// timing method → base confidence（§4.6）
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] §4.6 は RADAR/PHOTO_CELL/FAT の fresh fly を高 confidence、
 * HAND fly を LOW とだけ明記しており、VIDEO の扱いは明記されていない。
 * 勝手に HIGH 扱いにはせず、既存の最も保守的な定義（HAND と同じ LOW）を
 * 採用する。VIDEO の正式な confidence は将来の仕様改訂で決める。
 */
function baseConfidenceForTiming(timing: TimedMark["timing"]): Confidence {
  switch (timing) {
    case "RADAR_LASER":
    case "PHOTO_CELL":
    case "FAT":
      return "HIGH";
    case "HAND":
      return "LOW";
    case "VIDEO":
      return "LOW"; // [DEVIATION] 仕様未定義。最も保守的な既存値を流用。
    case "UNKNOWN":
      return "LOW";
  }
}

// ---------------------------------------------------------------------------
// mark の使用可否（future / plausibility BLOCK の除外）
// ---------------------------------------------------------------------------

function isUsableMark(mark: TimedMark, asOf: IsoDate): boolean {
  // Numeric plausibility is assessed only after this selector identifies a record actually
  // used by the current plan. Filtering here would silently substitute an older mark.
  return mark.date <= asOf;
}

// ---------------------------------------------------------------------------
// ReferenceResolution（§4.6 の Method 別解決）
// ---------------------------------------------------------------------------

export const REFERENCE_RESOLUTION_METHODS = [
  "MAX_VELOCITY",
  "TEMPO_EXTENSIVE",
  "SPRINT_ENDURANCE_SHORT",
  "LONG_SPRINT_RACE_SPECIFIC",
] as const;
export type ReferenceResolutionMethod = (typeof REFERENCE_RESOLUTION_METHODS)[number];

export type ReferenceResolutionInput = {
  method: ReferenceResolutionMethod;
  marks: readonly TimedMark[];
  vmax: VelocityEstimate | null;
  ageBand: ResolvedAgeBand;
  asOf: IsoDate;
  ruleSet: RuleSet;
};

export type ReferenceResolution = {
  method: ReferenceResolutionMethod;
  availability: "AVAILABLE" | "UNAVAILABLE";
  /** 解決できた IntensityReference の kind。UNAVAILABLE のときは null。 */
  kind: IntensityReference["kind"] | null;
  confidence: Confidence;
  velocityEstimate: VelocityEstimate | null;
  usableMark: TimedMark | null;
  unavailableReason: string | null;
};

function bestFlyMark(marks: readonly TimedMark[], asOf: IsoDate): TimedMark | null {
  const usable = marks.filter((m) => isFlyMark(m) && isUsableMark(m, asOf));
  if (usable.length === 0) return null;
  // 最新の記録を優先する（同一 confidence 帯なら新しい方が参考になる）。
  return [...usable].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
}

function bestSameDistanceMark(marks: readonly TimedMark[], asOf: IsoDate): TimedMark | null {
  const usable = marks.filter((m) => !isFlyMark(m) && m.event !== "100m" && isUsableMark(m, asOf));
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
}

function has100mOnly(marks: readonly TimedMark[], asOf: IsoDate): TimedMark | null {
  const usable100m = marks.filter((m) => m.event === "100m" && isUsableMark(m, asOf));
  return usable100m.length > 0 ? usable100m[0] : null;
}

/**
 * §4.6 の ReferenceResolution 表を、R2 `MethodMeta.allowedIntensityReferences`
 * の優先順位（先頭が優先。§3.2）に沿って解決する。RACE_PACE / TARGET_SPLIT は
 * コーチの明示入力が必要なため（PlanRequest 側の責務）、AthleteProfile の
 * データだけからは自動解決しない —— この2つの kind は候補から外れ、
 * 該当 Method の `intensityFallback` または残りの候補（SAME_DISTANCE_BEST 等）
 * にフォールバックする。
 */
export function resolveReference(input: ReferenceResolutionInput): ReferenceResolution {
  const { method, marks, vmax, ageBand, asOf, ruleSet } = input;
  const methodMeta = ruleSet.methods.find((m) => m.method === method);
  if (!methodMeta) {
    throw new Error(`resolveReference: MethodMeta not found for ${method}`);
  }

  const flyMark = bestFlyMark(marks, asOf);
  const sameDistanceMark = bestSameDistanceMark(marks, asOf);
  const only100m = has100mOnly(marks, asOf);

  const candidateKinds: IntensityReference["kind"][] = [
    ...methodMeta.allowedIntensityReferences,
    ...(methodMeta.intensityFallback ? [methodMeta.intensityFallback] : []),
  ] as IntensityReference["kind"][];

  for (const kind of candidateKinds) {
    if (kind === "MEASURED_VMAX") {
      // MEASURED_VMAX は athlete.vmax として直接与えられた VelocityEstimate
      // だけを使う。fly split から導出した速度は別の kind = "FLY_SPLIT"
      // として扱う（R1 の IntensityReference discriminated union の意味に
      // 合わせる。fly split 由来のデータをここに混ぜない）。
      if (vmax) {
        const confidence = applyFreshnessDowngrade(vmax.confidence, vmax.measuredAt, asOf, ageBand);
        return {
          method,
          availability: "AVAILABLE",
          kind: "MEASURED_VMAX",
          confidence,
          velocityEstimate: vmax,
          usableMark: null,
          unavailableReason: null,
        };
      }
      continue;
    }

    if (kind === "FLY_SPLIT") {
      if (flyMark) {
        const split = computeFlySplitVelocity(flyMark, ruleSet);
        const base = baseConfidenceForTiming(flyMark.timing);
        const confidence = applyFreshnessDowngrade(base, flyMark.date, asOf, ageBand);
        return {
          method,
          availability: "AVAILABLE",
          kind: "FLY_SPLIT",
          confidence,
          velocityEstimate: {
            valueMps: split.valueMps,
            lowerMps: split.lowerMps,
            upperMps: split.upperMps,
            source:
              flyMark.timing === "FAT"
                ? "FLY_SPLIT_FAT"
                : flyMark.timing === "PHOTO_CELL"
                  ? "FLY_SPLIT_PHOTO_CELL"
                  : flyMark.timing === "HAND"
                    ? "FLY_SPLIT_HAND"
                    : "FLY_SPLIT_VIDEO",
            confidence,
            measuredAt: flyMark.date,
          },
          usableMark: flyMark,
          unavailableReason: null,
        };
      }
      continue;
    }

    if (kind === "SAME_DISTANCE_BEST") {
      if (sameDistanceMark) {
        const base = baseConfidenceForTiming(sameDistanceMark.timing);
        const confidence = applyFreshnessDowngrade(base, sameDistanceMark.date, asOf, ageBand);
        return {
          method,
          availability: "AVAILABLE",
          kind: "SAME_DISTANCE_BEST",
          confidence,
          velocityEstimate: null,
          usableMark: sameDistanceMark,
          unavailableReason: null,
        };
      }
      continue;
    }

    if (kind === "MAX_INTENT") {
      // §4.6: 100m PB のみ、または何も無い → MAX_INTENT・confidence LOW。
      // 100m PB → Vmax 推定式は絶対に使わない（§24 OPEN-02）。
      return {
        method,
        availability: "AVAILABLE",
        kind: "MAX_INTENT",
        confidence: "LOW",
        velocityEstimate: null,
        usableMark: only100m,
        unavailableReason: null,
      };
    }

    if (kind === "RELAXED_SUBMAX") {
      // TEMPO_EXTENSIVE の fallback。数値目標を作らない。
      return {
        method,
        availability: "AVAILABLE",
        kind: "RELAXED_SUBMAX",
        confidence: "LOW",
        velocityEstimate: null,
        usableMark: only100m,
        unavailableReason: null,
      };
    }

    // RACE_PACE / TARGET_SPLIT / COACH_DEFINED / VELOCITY_DECREMENT はコーチの
    // 明示入力が前提であり、AthleteProfile のデータだけからは自動解決しない
    // （PlanRequest 側の責務。R4）。
  }

  return {
    method,
    availability: "UNAVAILABLE",
    kind: null,
    confidence: "NONE",
    velocityEstimate: null,
    usableMark: null,
    unavailableReason:
      "利用可能な参照データが無く、この Method の intensityFallback も null です（例: LONG は TARGET_SPLIT のコーチ手入力まで不適格）。",
  };
}
