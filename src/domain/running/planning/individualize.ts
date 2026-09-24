/**
 * Running Prescription Engine v2 — §9.2 step 9: PERFORMANCE-BASED INDIVIDUALIZATION（§4.6, §9.5, §11.2）。
 *
 * - 参照の解決は R3 `resolveReference()`（performance.ts）をそのまま使う。1つの kind だけを
 *   評価するため、MethodMeta の候補を1件に絞った RuleSet ビューを渡す（鮮度・計時法・
 *   mark 選択・fly split の区間計算を R4 で書き直さない）。選択済み mark の plausibility は
 *   置換せず、選択後に F1 input policy が評価する。
 * - 100m PB → Vmax の推定はしない（R3 と同じ。`vmaxEstimationModels: []`）。
 * - 候補の優先順位は MethodMeta.allowedIntensityReferences（→ intensityFallback）の順。
 * - 記録の距離・fly 区間・同距離の判定・sled の band は RuleSet の構造化データ（eventDefinitions /
 *   SessionTemplate.resistanceBand）から読み、event 名や templateId の文字列を解析しない。
 * - 目標値は区間で出し、外側に丸める。材料が無いときは null（目標を捏造しない）。
 * - 露出は項目単位だけ（セッション集計は R6）。加速距離 A の数値は TS に持たないため、
 *   A を必要とする側の bound は null（0 にしない）。
 */
import type { EventDefinitions, MethodMeta, RuleSet, RuleSetSessionTemplate } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { IntensityReference, TimedMark, TimingMethod, VelocityEstimate } from "../types/intensity";
import type { Confidence, IsoDate, QuantityInterval } from "../types/primitives";
import type { InputDataConfidence } from "../types/prescription";
import type { AthleteProfile } from "../types/subject";
import type { RunningTrainingMethod } from "../types/method";
import { resolveReference } from "../context/performance";
import type { ResolvedAgeBand } from "../context/ageBand";
import type { SubjectProfile } from "../context/subject";
import type { SelectedEnvelope } from "./envelope";
import { itemFinding, type CoachReferenceInput, type EligibilityReason, type PlanRequest } from "./schema";

type ReferenceKind = IntensityReference["kind"];

const CONFIDENCE_ORDER: Record<Confidence, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER[a] <= CONFIDENCE_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// R3 resolveReference を1 kind だけで呼ぶ
// ---------------------------------------------------------------------------

function resolveSingleKind(
  kind: ReferenceKind,
  args: { marks: readonly TimedMark[]; vmax: VelocityEstimate | null; ageBand: ResolvedAgeBand; asOf: IsoDate; ruleSet: RuleSet },
) {
  // resolveReference は MAX_VELOCITY の MethodMeta の候補順に解決する。候補をこの kind 1件に絞った
  // ビューを渡し、R3 の解決ロジック（鮮度・計時法・plausibility）だけを再利用する。
  const view: RuleSet = {
    ...args.ruleSet,
    methods: args.ruleSet.methods.map((m) =>
      m.method === "MAX_VELOCITY" ? { ...m, allowedIntensityReferences: [kind], intensityFallback: null } : m,
    ),
  };
  return resolveReference({ method: "MAX_VELOCITY", marks: args.marks, vmax: args.vmax, ageBand: args.ageBand, asOf: args.asOf, ruleSet: view });
}

export type VelocityResolution = {
  kind: "MEASURED_VMAX" | "FLY_SPLIT";
  velocity: VelocityEstimate;
  confidence: Confidence;
  mark: TimedMark | null;
};

export type AthleteVelocities = { direct: VelocityResolution | null; flySplit: VelocityResolution | null };

/** athlete.vmax（直接の実測）と fly 記録由来の速度を別々に解決する（GROUP は常に null）。 */
export function resolveAthleteVelocities(request: PlanRequest, profile: SubjectProfile, ruleSet: RuleSet): AthleteVelocities {
  if (request.subject.kind !== "ATHLETE") return { direct: null, flySplit: null };
  const athlete: AthleteProfile = request.subject.profile;
  const common = { ageBand: profile.ageBand, asOf: request.planningDate, ruleSet };
  const direct = resolveSingleKind("MEASURED_VMAX", { ...common, marks: [], vmax: athlete.vmax ?? null });
  const fly = resolveSingleKind("FLY_SPLIT", { ...common, marks: athlete.marks, vmax: null });
  return {
    direct:
      direct.kind === "MEASURED_VMAX" && direct.velocityEstimate
        ? { kind: "MEASURED_VMAX", velocity: direct.velocityEstimate, confidence: direct.confidence, mark: null }
        : null,
    flySplit:
      fly.kind === "FLY_SPLIT" && fly.velocityEstimate
        ? { kind: "FLY_SPLIT", velocity: fly.velocityEstimate, confidence: fly.confidence, mark: fly.usableMark }
        : null,
  };
}

/** MEASURED_VMAX として使える速度（直接の実測を優先。fly split 由来は FLY_SPLIT を別 kind に持たない Method でだけ使う）。 */
export function measuredVmaxFor(velocities: AthleteVelocities, candidates: readonly ReferenceKind[]): VelocityResolution | null {
  if (velocities.direct) return velocities.direct;
  if (!candidates.includes("FLY_SPLIT")) return velocities.flySplit;
  return null;
}

// ---------------------------------------------------------------------------
// 参照の解決（§4.6 / MethodMeta 優先順位）
// ---------------------------------------------------------------------------

export type ReferencePlan = {
  reference: IntensityReference;
  /** Timed marks selected as inputs for this plan; never a new numeric authority by itself. */
  selectedInputMarks: readonly TimedMark[];
  /** [R4 errata] 参照が performance データを必要としない場合は NOT_REQUIRED（HIGH と区別する）。 */
  inputData: InputDataConfidence;
  velocity: VelocityResolution | null;
  /** 目標タイムの丸め単位の元になる計時法（HAND/UNKNOWN → 0.1秒、それ以外 → 0.01秒）。 */
  timing: TimingMethod | null;
};

export type ReferenceResult =
  | { ok: true; plan: ReferencePlan }
  | { ok: false; status: "INELIGIBLE"; reasons: EligibilityReason[] }
  | { ok: false; status: "BLOCKED"; findings: Finding[] };

const COACH_KINDS: readonly ReferenceKind[] = ["RACE_PACE", "TARGET_SPLIT", "COACH_DEFINED", "VELOCITY_DECREMENT"];
const DATA_FREE_KINDS: readonly ReferenceKind[] = ["MAX_INTENT", "RELAXED_SUBMAX"];

export function referenceCandidates(methodMeta: MethodMeta): ReferenceKind[] {
  const allowed = [...methodMeta.allowedIntensityReferences] as ReferenceKind[];
  const fallback = methodMeta.intensityFallback as ReferenceKind | null;
  return fallback !== null && !allowed.includes(fallback) ? [...allowed, fallback] : allowed;
}

function velocityTiming(v: VelocityResolution): TimingMethod {
  if (v.mark) return v.mark.timing;
  switch (v.velocity.source) {
    case "RADAR_LASER":
      return "RADAR_LASER";
    case "FLY_SPLIT_FAT":
      return "FAT";
    case "FLY_SPLIT_PHOTO_CELL":
      return "PHOTO_CELL";
    case "FLY_SPLIT_HAND":
      return "HAND";
    case "FLY_SPLIT_VIDEO":
      return "VIDEO";
    case "ESTIMATED_MODEL":
    case "COACH_ESTIMATE":
      return "UNKNOWN";
  }
}

export function timedMarkDefinition(definitions: EventDefinitions, event: TimedMark["event"]) {
  return definitions.timedMarks.find((d) => d.event === event) ?? null;
}

export function raceEventDefinition(definitions: EventDefinitions, event: string) {
  return definitions.raceEvents.find((d) => d.event === event) ?? null;
}

/**
 * SAME_DISTANCE_BEST として使える記録の距離（m）。
 *   - LONG: template.primaryEvents の（ハードルでない）レース種目の距離
 *   - それ以外: template.displayDistanceM
 * 距離は eventDefinitions から読む。
 */
function sameDistanceTargets(method: RunningTrainingMethod, template: RuleSetSessionTemplate, definitions: EventDefinitions): number[] {
  if (method === "LONG_SPRINT_RACE_SPECIFIC") {
    return (template.primaryEvents ?? []).flatMap((event) => {
      const def = raceEventDefinition(definitions, event);
      return def !== null && !def.hurdles ? [def.distanceM] : [];
    });
  }
  return template.displayDistanceM !== undefined ? [template.displayDistanceM] : [];
}

/**
 * VELOCITY_DECREMENT は sled の負荷 band を持つ template（SessionTemplate.resistanceBand）でだけ意味を持つ。
 * それ以外の kind は常に「その Method で使いうる参照」。
 */
function isApplicable(kind: ReferenceKind, template: RuleSetSessionTemplate, envelope: SelectedEnvelope): boolean {
  return kind === "VELOCITY_DECREMENT" ? template.resistanceBand !== null && envelope.fields.vdecPercent !== undefined : true;
}

export function resolvePlanningReference(args: {
  request: PlanRequest;
  profile: SubjectProfile;
  ruleSet: RuleSet;
  template: RuleSetSessionTemplate;
  methodMeta: MethodMeta;
  envelope: SelectedEnvelope;
  velocities: AthleteVelocities;
}): ReferenceResult {
  const { request, profile, ruleSet, template, methodMeta, envelope, velocities } = args;
  const method = request.selection.method;
  const candidates = referenceCandidates(methodMeta);
  const coachRef: CoachReferenceInput | null = request.coachReference;
  const definitions = ruleSet.eventDefinitions;
  const athlete = request.subject.kind === "ATHLETE" ? request.subject.profile : null;

  if (coachRef !== null) {
    if (!candidates.includes(coachRef.kind)) {
      return { ok: false, status: "BLOCKED", findings: [itemFinding("COACH_REFERENCE_INVALID", "BLOCK", { metric: `kind-not-allowed:${coachRef.kind}` })] };
    }
    if (coachRef.kind === "VELOCITY_DECREMENT") {
      // band は SessionTemplate.resistanceBand と一致しなければならない。band を持たない template（HILL）では使わない（§7.4）。
      if (!isApplicable("VELOCITY_DECREMENT", template, envelope) || coachRef.band !== template.resistanceBand) {
        return { ok: false, status: "BLOCKED", findings: [itemFinding("COACH_REFERENCE_INVALID", "BLOCK", { metric: `vdec-band:${coachRef.band}` })] };
      }
    }
  }

  let earlierApplicable = false;

  const finish = (plan: Omit<ReferencePlan, "selectedInputMarks"> & { selectedInputMarks?: readonly TimedMark[] }): ReferenceResult => ({
    ok: true,
    plan: {
      ...plan,
      selectedInputMarks: plan.selectedInputMarks ?? [],
      // §4.1: GROUP の上限（最大 LOW）は参照データに依存するときだけ適用する。NOT_REQUIRED は上限の対象外。
      inputData: plan.inputData === "NOT_REQUIRED" ? "NOT_REQUIRED" : minConfidence(plan.inputData, profile.inputDataConfidenceCap),
    },
  });

  for (const kind of candidates) {
    if (COACH_KINDS.includes(kind)) {
      if (coachRef !== null && coachRef.kind === kind) {
        const inputData: Confidence = coachRef.kind === "VELOCITY_DECREMENT" && !coachRef.measured ? "LOW" : "MEDIUM";
        return finish({ reference: coachRef, inputData, velocity: null, timing: null });
      }
      if (isApplicable(kind, template, envelope)) earlierApplicable = true;
      continue;
    }
    if (DATA_FREE_KINDS.includes(kind)) {
      // [R4 errata] 設計上データを必要としない参照（ACCELERATION の MAX_INTENT、STRIDE の RELAXED_SUBMAX、
      // HILL の MAX_INTENT）は NOT_REQUIRED。より優先度の高い適用可能な参照が使えずに落ちてきた fallback は
      // LOW（§4.6 表。例: MV の MAX_INTENT、TE の RELAXED_SUBMAX、sled の MAX_INTENT）。
      return finish({
        reference: { kind } as IntensityReference,
        // A usable 100m mark may be returned as contextual metadata by R3, but
        // data-free references do not use it to determine a numeric result.
        selectedInputMarks: [],
        inputData: earlierApplicable ? "LOW" : "NOT_REQUIRED",
        velocity: null,
        timing: null,
      });
    }
    earlierApplicable = true;
    if (athlete === null) continue;

    if (kind === "MEASURED_VMAX") {
      const v = measuredVmaxFor(velocities, candidates);
      if (v) {
        return finish({
          reference: { kind: "MEASURED_VMAX", vmax: v.velocity },
          // Preserve the exact fly mark if this MEASURED_VMAX fallback was
          // derived from it, so F15 evaluates the datum that supplied the value.
          selectedInputMarks: v.mark ? [v.mark] : [],
          inputData: v.confidence,
          velocity: v,
          timing: velocityTiming(v),
        });
      }
    } else if (kind === "FLY_SPLIT") {
      const v = velocities.flySplit;
      const def = v?.mark ? timedMarkDefinition(definitions, v.mark.event) : null;
      if (v && v.mark && def !== null && def.segment === "FLY_ZONE") {
        return finish({
          reference: { kind: "FLY_SPLIT", flyZoneM: def.distanceM, mark: v.mark },
          selectedInputMarks: [v.mark],
          inputData: v.confidence,
          velocity: v,
          timing: v.mark.timing,
        });
      }
    } else if (kind === "SAME_DISTANCE_BEST") {
      const distances = sameDistanceTargets(method, template, definitions);
      const marks = athlete.marks.filter((m) => {
        const def = timedMarkDefinition(definitions, m.event);
        return def !== null && def.segment === "FROM_START" && distances.includes(def.distanceM);
      });
      const resolved = resolveSingleKind("SAME_DISTANCE_BEST", {
        marks,
        vmax: null,
        ageBand: profile.ageBand,
        asOf: request.planningDate,
        ruleSet,
      });
      const mark = resolved.usableMark;
      const def = mark ? timedMarkDefinition(definitions, mark.event) : null;
      if (resolved.kind === "SAME_DISTANCE_BEST" && mark && def !== null) {
        return finish({
          reference: { kind: "SAME_DISTANCE_BEST", distanceM: def.distanceM, mark },
          selectedInputMarks: [mark],
          inputData: resolved.confidence,
          velocity: null,
          timing: mark.timing,
        });
      }
    }
  }

  return { ok: false, status: "INELIGIBLE", reasons: [{ code: "REFERENCE_UNAVAILABLE", ruleId: null, overrideAllowed: false }] };
}

// ---------------------------------------------------------------------------
// 目標値（§9.5）
// ---------------------------------------------------------------------------

function roundingStep(timing: TimingMethod | null): number {
  return timing === "HAND" || timing === "UNKNOWN" || timing === null ? 10 : 100;
}

/** 区間を外側に丸める（下端は切り捨て、上端は切り上げ）。 */
function outward(lower: number, upper: number, timing: TimingMethod | null): { lower: number; upper: number } {
  const perSecond = roundingStep(timing);
  return {
    lower: Math.floor(lower * perSecond + 1e-9) / perSecond,
    upper: Math.ceil(upper * perSecond - 1e-9) / perSecond,
  };
}

export type IntensityTarget = QuantityInterval<"s"> | QuantityInterval<"percent"> | null;

/**
 * - MAX_INTENT / RELAXED_SUBMAX / FLY_SPLIT / COACH_DEFINED、および MAX_VELOCITY: target=null
 * - MEASURED_VMAX（距離 rep）: distance / (v × p)、v=[lower, upper]、p=intensityPercent の区間
 * - SAME_DISTANCE_BEST: best / p（rep 距離と記録の距離が一致するときだけ）
 * - RACE_PACE / TARGET_SPLIT: コーチ入力値をそのまま区間化
 * - VELOCITY_DECREMENT: 分類 band は monitoring snapshot に保存するが、数値 Vdec target は処方しない
 * - GROUP では目標タイムを出さない
 * 材料（intensityPercent・rep 距離）が無ければ null。
 */
export function computeIntensityTarget(args: {
  method: RunningTrainingMethod;
  subjectKind: "ATHLETE" | "GROUP";
  plan: ReferencePlan;
  repDistanceM: number | null;
  /** 百分率（例 60–70）。recommended の範囲、またはコーチ入力の1点。 */
  intensityPercent: { min: number; max: number } | null;
}): IntensityTarget {
  const { method, subjectKind, plan, repDistanceM, intensityPercent } = args;
  const ref = plan.reference;
  if (method === "MAX_VELOCITY") return null;
  // 数値目標は performance / コーチ入力の参照に基づくときだけ。NOT_REQUIRED の参照は目標を持たない。
  const confidence: Confidence | null = plan.inputData === "NOT_REQUIRED" ? null : plan.inputData;

  switch (ref.kind) {
    case "MAX_INTENT":
    case "RELAXED_SUBMAX":
    case "FLY_SPLIT":
    case "COACH_DEFINED":
      return null;
    case "VELOCITY_DECREMENT": {
      // E10: Vdec は measured observation の classification にのみ使用する。
      // classification から sled load / recommended Vdec target を逆算しない。
      return null;
    }
    case "MEASURED_VMAX": {
      if (intensityPercent === null) return null;
      if (method === "ASSISTED_SPRINT") {
        if (confidence === null) return null;
        return { lower: intensityPercent.min, upper: intensityPercent.max, unit: "percent", source: "COACH_ENTERED", confidence };
      }
      if (subjectKind !== "ATHLETE" || repDistanceM === null || !plan.velocity || confidence === null) return null;
      const v = plan.velocity.velocity;
      if (v.lowerMps <= 0 || v.upperMps <= 0) return null;
      const fastest = repDistanceM / (v.upperMps * (intensityPercent.max / 100));
      const slowest = repDistanceM / (v.lowerMps * (intensityPercent.min / 100));
      const r = outward(fastest, slowest, plan.timing);
      return { lower: r.lower, upper: r.upper, unit: "s", source: "ESTIMATED", confidence };
    }
    case "SAME_DISTANCE_BEST": {
      // [R4 errata] 数値目標は該当 Envelope に versioned な intensityPercent の範囲があるときだけ（無い SES / LONG は null）。
      if (subjectKind !== "ATHLETE" || intensityPercent === null || repDistanceM === null || ref.distanceM !== repDistanceM || confidence === null) return null;
      const fastest = ref.mark.timeS / (intensityPercent.max / 100);
      const slowest = ref.mark.timeS / (intensityPercent.min / 100);
      const r = outward(fastest, slowest, plan.timing);
      return { lower: r.lower, upper: r.upper, unit: "s", source: "ESTIMATED", confidence };
    }
    case "RACE_PACE": {
      if (subjectKind !== "ATHLETE" || confidence === null) return null;
      return { lower: ref.targetTimeS.lower, upper: ref.targetTimeS.upper, unit: "s", source: "COACH_ENTERED", confidence };
    }
    case "TARGET_SPLIT": {
      if (subjectKind !== "ATHLETE" || confidence === null) return null;
      const lower = ref.segments.reduce((sum, s) => sum + (s.targetS.lower as number), 0);
      const upper = ref.segments.reduce((sum, s) => sum + (s.targetS.upper as number), 0);
      return { lower, upper, unit: "s", source: "COACH_ENTERED", confidence };
    }
  }
}

// ---------------------------------------------------------------------------
// 露出（§11.2、項目単位のみ）
// ---------------------------------------------------------------------------

export type RepGeometry =
  | { kind: "DISTANCE"; distanceM: number }
  | { kind: "FLY"; buildUpM: number; flyZoneM: number }
  | { kind: "DURATION"; displayDistanceM: QuantityInterval<"m"> }
  | { kind: "SPLIT"; totalDistanceM: number }
  | { kind: "ATTEMPTS"; approach: "SHORT" | "FULL"; approachDistanceM: number | null };

export type ItemExposure = {
  totalRunningDistanceM: QuantityInterval<"m">;
  plannedHighSpeedExposureM: QuantityInterval<"m">;
  nearMaxSprintVolumeM: QuantityInterval<"m">;
};

function interval(lower: number | null, upper: number | null, source: QuantityInterval["source"], confidence: Confidence): QuantityInterval<"m"> {
  return { lower, upper, unit: "m", source, confidence };
}

const ZERO_BY_RULE = (): QuantityInterval<"m"> => interval(0, 0, "RULE_DEFINITION", "HIGH");
const UNKNOWN = (): QuantityInterval<"m"> => interval(null, null, "UNKNOWN", "NONE");

function scale(v: QuantityInterval<"m">, n: number): QuantityInterval<"m"> {
  return interval(v.lower === null ? null : v.lower * n, v.upper === null ? null : v.upper * n, v.source, v.confidence);
}

/** 1本の走行距離（deceleration を含めない）。 */
function perRepRunning(rep: RepGeometry): QuantityInterval<"m"> {
  switch (rep.kind) {
    case "DISTANCE":
      return interval(rep.distanceM, rep.distanceM, "PLANNED", "HIGH");
    case "FLY":
      return interval(rep.buildUpM + rep.flyZoneM, rep.buildUpM + rep.flyZoneM, "PLANNED", "HIGH");
    case "DURATION":
      return rep.displayDistanceM;
    case "SPLIT":
      return interval(rep.totalDistanceM, rep.totalDistanceM, "PLANNED", "HIGH");
    case "ATTEMPTS":
      return rep.approachDistanceM === null
        ? UNKNOWN()
        : interval(rep.approachDistanceM, rep.approachDistanceM, "COACH_ENTERED", "MEDIUM");
  }
}

/** FlyRep.plannedHighSpeedExposureM（1本分）: fly は確実、build-up 側は不確実なので上端にだけ含める。 */
export function flyRepHighSpeedExposure(buildUpM: number, flyZoneM: number): QuantityInterval<"m"> {
  return interval(flyZoneM, flyZoneM + buildUpM, "ESTIMATED", "LOW");
}

export function computeItemExposure(method: RunningTrainingMethod, model: MethodMeta["highSpeedExposureModel"], rep: RepGeometry, totalReps: number): ItemExposure {
  const running = perRepRunning(rep);
  const totalRunningDistanceM = scale(running, totalReps);

  let plannedHighSpeedExposureM: QuantityInterval<"m">;
  switch (model) {
    case "NONE":
      plannedHighSpeedExposureM = ZERO_BY_RULE();
      break;
    case "FLY_ZONE":
      plannedHighSpeedExposureM =
        rep.kind === "FLY" ? scale(flyRepHighSpeedExposure(rep.buildUpM, rep.flyZoneM), totalReps) : UNKNOWN();
      break;
    case "DISTANCE_MINUS_ACCEL_INTERVAL":
    case "WHOLE_REP":
      // 加速距離 A の区間を TS に持たないため下端は null（0 ではない）。上端は1本の距離そのもの。
      plannedHighSpeedExposureM =
        running.upper === null ? UNKNOWN() : interval(null, running.upper * totalReps, "ESTIMATED", "LOW");
      break;
  }

  let nearMaxSprintVolumeM: QuantityInterval<"m">;
  switch (method) {
    case "TEMPO_EXTENSIVE":
    case "TEMPO_INTENSIVE":
    case "STRIDE":
      nearMaxSprintVolumeM = ZERO_BY_RULE();
      break;
    case "EVENT_APPROACH_SPEED":
      nearMaxSprintVolumeM = rep.kind === "ATTEMPTS" && rep.approach === "SHORT" ? ZERO_BY_RULE() : totalRunningDistanceM;
      break;
    default:
      // ACC・RS: 距離×本数／MV・AS: (build-up + fly)×本数／SES・LONG: 表示距離（分割走は計画区間）×本数
      nearMaxSprintVolumeM = totalRunningDistanceM;
  }

  return { totalRunningDistanceM, plannedHighSpeedExposureM, nearMaxSprintVolumeM };
}
