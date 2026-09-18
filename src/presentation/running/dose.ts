/**
 * Running Prescription Engine v2 — R10-B3 RunningPrescription の量・レスト・強度の表示。
 *
 * 表示の整形だけを行う（量の再計算・範囲の判定はしない）:
 *   - `MAX_INTENT` / `RELAXED_SUBMAX` 等、数値目標を持たない強度に % を付けない
 *   - null の値・片側不明の区間を 0 にしない、範囲を中央値にしない
 *   - rest は `displayAsFloor=true`（最低この時間）なので「以上」を必ず付ける
 *   - FLY は助走 / フライ / 減速を分けて表示し、減速をフライ区間へ合算しない
 */
import type { IntensityReference } from "@/domain/running/types/intensity";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { DosePresentationDto, RepStructurePresentationDto } from "./dto";
import { formatIntervalJa, formatNumberJa, formatSecondsJa, formatValueJa } from "./format";
import { APPROACH_LABEL_JA, INTENSITY_REFERENCE_LABEL_JA, VELOCITY_DECREMENT_BAND_LABEL_JA } from "./labels";

function meters(value: number): string {
  return formatValueJa(value, "m");
}

function repStructureOf(p: RunningPrescriptionValue): RepStructurePresentationDto {
  const rep = p.rep;
  switch (rep.kind) {
    case "DISTANCE":
      return { kind: "DISTANCE", distanceLabel: meters(rep.distanceM.value) };
    case "FLY":
      return {
        kind: "FLY",
        buildUpLabel: `助走 ${meters(rep.buildUpDistanceM.value)}`,
        flyZoneLabel: `フライ ${meters(rep.flyZoneDistanceM.value)}`,
        decelerationLabel: rep.decelerationDistanceM === null ? null : `減速 ${meters(rep.decelerationDistanceM)}（高速で走る量には含めない）`,
        totalRunningLabel: rep.totalRunningDistanceM === null ? null : `1本の走行距離 ${meters(rep.totalRunningDistanceM)}（助走・フライ・減速の合計）`,
      };
    case "DURATION": {
      const approx = formatIntervalJa(rep.displayDistanceM, "m");
      return { kind: "DURATION", durationLabel: formatSecondsJa(rep.durationS.value), approxDistanceLabel: approx === null ? null : `距離の目安 ${approx}` };
    }
    case "SPLIT":
      return { kind: "SPLIT", segmentsLabel: rep.segments.map((s) => meters(s.distanceM)).join(" ＋ ") };
    case "ATTEMPTS":
      return {
        kind: "ATTEMPTS",
        approachLabel: APPROACH_LABEL_JA[rep.approach],
        approachDistanceLabel: rep.approachDistanceM === null ? "助走距離: 未入力" : `助走距離 ${meters(rep.approachDistanceM.value)}`,
      };
  }
}

function distanceSummaryOf(structure: RepStructurePresentationDto): string | null {
  switch (structure.kind) {
    case "DISTANCE":
      return structure.distanceLabel;
    case "FLY":
      return `${structure.buildUpLabel} ＋ ${structure.flyZoneLabel}`;
    case "SPLIT":
      return structure.segmentsLabel;
    case "DURATION":
    case "ATTEMPTS":
      return null;
  }
}

function floorLabel(prefix: string, seconds: number): string {
  return `${prefix} ${formatSecondsJa(seconds)}以上`;
}

/** 強度の基準（参照の種類 + コーチ入力の構造化値）。数値の % はここでは作らない。 */
export function intensityReferenceLabelJa(reference: IntensityReference): string {
  const base = INTENSITY_REFERENCE_LABEL_JA[reference.kind];
  switch (reference.kind) {
    case "COACH_DEFINED":
      return `${base}：${reference.label}`;
    case "VELOCITY_DECREMENT":
      return `${base}（${VELOCITY_DECREMENT_BAND_LABEL_JA[reference.band]}・${reference.measured ? "実測" : "推定"}）`;
    case "RACE_PACE":
      return `${base}（${reference.event}）`;
    case "SAME_DISTANCE_BEST":
      return `${base}（${meters(reference.distanceM)}）`;
    case "FLY_SPLIT":
      return `${base}（フライ ${meters(reference.flyZoneM)}）`;
    case "TARGET_SPLIT":
      // 区間ごとの値は coachTargetSplit に分けて表示する（ここは基準の種類だけ）。
      return base;
    case "MAX_INTENT":
    case "MEASURED_VMAX":
    case "RELAXED_SUBMAX":
      return base;
  }
}

/**
 * 数値目標の表示。% の意味は強度の基準で異なる（VELOCITY_DECREMENT = 速度低下率、それ以外 = 最高速度に対する割合）ため、
 * 参照の種類と一緒に言い分ける（「強度 10%」のような誤読を招く書き方をしない）。
 */
function intensityTargetLabel(intensity: RunningPrescriptionValue["intensity"]): string | null {
  const target = intensity.target;
  if (target === null) return null;
  const text = formatIntervalJa(target, target.unit);
  if (text === null) return null;
  // RACE_PACE / TARGET_SPLIT の目標はコーチ入力値そのもの（エンジンが推定した個別目標タイムと区別して表示する）。
  if (target.unit === "s") return target.source === "COACH_ENTERED" ? `コーチ設定の目標タイム ${text}` : `目標タイム ${text}`;
  return intensity.reference.kind === "VELOCITY_DECREMENT" ? `速度低下率の目安 ${text}` : `強度の目安（最高速度に対する割合） ${text}`;
}

export function presentDose(p: RunningPrescriptionValue): DosePresentationDto {
  const repStructure = repStructureOf(p);
  const sets = p.sets.value;
  const reps = p.repsPerSet.value;
  const unit = p.rep.kind === "ATTEMPTS" ? "回" : "本";
  const countsLabel =
    p.sets.origin === "STRUCTURAL_FIXED" ? `${formatNumberJa(reps)}${unit}` : `${formatNumberJa(sets)}セット × ${formatNumberJa(reps)}${unit}`;

  return {
    sets,
    reps,
    countsLabel,
    repStructure,
    distanceLabel: distanceSummaryOf(repStructure),
    durationLabel: repStructure.kind === "DURATION" ? repStructure.durationLabel : null,
    restLabel: floorLabel("本間レスト", p.rest.repRestS.value),
    setRestLabel: p.rest.setRestS === null ? null : floorLabel("セット間", p.rest.setRestS.value),
    intraRepRestLabel: p.rest.intraRepRestS === null ? null : floorLabel("区間の間", p.rest.intraRepRestS.value),
    restFeasibilityLabel:
      p.rest.feasibility === "EXCEEDS_AVAILABLE_TIME" ? "必要なレストが、予定の練習時間を超える可能性があります（レストは短くしません）。" : null,
    intensityLabel: intensityReferenceLabelJa(p.intensity.reference),
    intensityTargetLabel: intensityTargetLabel(p.intensity),
    coachTargetSplit: coachTargetSplitOf(p.intensity.reference),
  };
}

/** [R10-B4A.2] TARGET_SPLIT の区間表示（「300m：38秒」）。片側不明の区間は「不明」と書き、0 にしない。 */
function coachTargetSplitOf(reference: IntensityReference): DosePresentationDto["coachTargetSplit"] {
  if (reference.kind !== "TARGET_SPLIT") return null;
  return {
    heading: INTENSITY_REFERENCE_LABEL_JA.TARGET_SPLIT,
    segments: reference.segments.map((s) => ({
      distanceLabel: meters(s.distanceM),
      targetTimeLabel: formatIntervalJa(s.targetS, "s") ?? "不明",
    })),
  };
}
