/**
 * Running Prescription Engine v2 — planning pipeline の配線と §9.2 step 15: PRESCRIPTION OUTPUT。
 *
 * 接続している step: 1・2・3・4・5・6・7・8・9・10・11・12・13・14・15（全 step 接続完了）。
 *
 * 出力前に Zod（構造）と RuleSet-aware 検証の両方を通し、通らないものは OK として返さない。
 */
import type { EnvelopeCell, EnvelopeField, RuleSet } from "../rules/schema";
import type { Finding, RationaleLine } from "../types/findings";
import type { QuantityInterval } from "../types/primitives";
import type { RunningPrescriptionValue } from "../types/prescription";
import {
  runningPrescriptionSchema,
  stopPolicySnapshotSchema,
  timingToleranceSnapshotSchema,
  vdecClassificationPolicySnapshotSchema,
} from "../types/prescription";
import { runtimeSafetyPolicySnapshotSchema, type RuntimeSafetyPolicySnapshot } from "../types/monitoring";
import type { GenerationRecord } from "../types/actor";
import { resolveSubjectProfile, type SubjectProfile } from "../context/subject";
import { rationaleLine } from "../rationale/codes";
import { checkInputPlausibility, checkSelectedPerformanceInputPlausibility, normalizePlanRequest } from "./normalize";
import { validateSelection, resolveStopPolicy } from "./selection";
import { evaluateEligibility, type EligibilityEvaluation } from "./eligibility";
import { selectEnvelope, type SelectedEnvelope } from "./envelope";
import {
  computeIntensityTarget,
  computeItemExposure,
  flyRepHighSpeedExposure,
  measuredVmaxFor,
  raceEventDefinition,
  referenceCandidates,
  resolveAthleteVelocities,
  resolvePlanningReference,
  type ReferencePlan,
  type RepGeometry,
} from "./individualize";
import { derivePlanningConfidence } from "./confidence";
import {
  BASE_POSITION,
  createCoachInputs,
  lowestPosition,
  positionFromPreference,
  resolveCoachValue,
  resolveEnvelopeField,
  resolveRestPlan,
  solveCounts,
  type CoachInputs,
  type CountResolution,
  type PlacedPosition,
} from "./placement";
import { recheckHardSafety, type FieldValueRecord } from "./hardSafety";
import { resolveSwapTargets } from "../readiness/swap";
import { resolveReadinessApplication } from "../readiness/application";
import { normalizeReadinessActions, type ReadinessDecision } from "../readiness/schema";
import type { ReadinessActionCode, SafetyOutcome } from "../types/readiness";
import type { RangePosition } from "../types/prescription";
import type { RunningSelection } from "../types/template";
import type { RationaleCode } from "../rationale/codes";
import { validatePrescriptionAgainstRuleSet } from "./validatePrescription";
import { evaluateSessionAggregation } from "../aggregation";
import { checkOutputPlausibility, checkSessionPlausibility } from "../plausibility/output";
import { requiredConfirmationCodes } from "./confirmation";
import { isReviewablePlausibilityPolicy } from "../plausibility/review";
import { resolveCompetitionAndPhase } from "../competition";
import { evaluateWeeklyContext } from "../weekly";
import { hasUsedTemplateWithinDays } from "../weekly/events";
import { itemFinding, type EligibilityReason, type PlanRequest, type PlanResult } from "./schema";

export type ResolvedRuleSet = {
  ruleSet: RuleSet;
  contentHash: string;
  isDraftFallback: boolean;
};

type Eligible = Extract<EligibilityEvaluation, { status: "ELIGIBLE" }>;

// ---------------------------------------------------------------------------
// rep の組み立て（Method ごとの形は RepSpecByMethod で固定）
// ---------------------------------------------------------------------------

type RepBuild =
  | {
      ok: true;
      rep: RunningPrescriptionValue["rep"];
      geometry: RepGeometry;
      counts: Extract<CountResolution, { ok: true }>;
      repsField: EnvelopeField;
      records: FieldValueRecord[];
      findings: Finding[];
      segmentsPerRep: number;
      repDistanceForTarget: number | null;
      intensityPercent: { min: number; max: number } | null;
      decelerationM: number | null;
      /** 1本あたりの走行時間の下限（DURATION rep の時間・TARGET_SPLIT 目標の下限合計）。不明なら null。 */
      runningSecondsPerRepLowerBound: number | null;
    }
  | { ok: false; findings: Finding[] };

type RepContext = {
  request: PlanRequest;
  ruleSet: RuleSet;
  envelope: SelectedEnvelope;
  template: RuleSet["templates"][number];
  plan: ReferencePlan;
  position: PlacedPosition;
  eligibility: Eligible;
  inputs: CoachInputs;
  targetUsesIntensityPercent: boolean;
};

function missingCell(field: string): { ok: false; findings: Finding[] } {
  return { ok: false, findings: [itemFinding("ENVELOPE_INFEASIBLE", "BLOCK_AUTOGEN", { metric: `${field}:missing-cell` })] };
}

function countCells(envelope: SelectedEnvelope) {
  const f = envelope.fields;
  return {
    total: f.totalReps ? { field: "totalReps" as const, cell: f.totalReps } : f.attempts ? { field: "attempts" as const, cell: f.attempts } : null,
    sets: f.sets ?? null,
    repsPerSet: f.repsPerSet ?? null,
  };
}

function repsFieldFor(envelope: SelectedEnvelope): EnvelopeField {
  return envelope.fields.repsPerSet ? "repsPerSet" : envelope.fields.totalReps ? "totalReps" : "attempts";
}

function resolveIntensityPercent(ctx: RepContext): { ok: true; range: { min: number; max: number } | null } | { ok: false; findings: Finding[] } {
  const cell = ctx.envelope.fields.intensityPercent;
  if (!ctx.targetUsesIntensityPercent || !cell) return { ok: true, range: null };
  const coach = resolveCoachValue("intensityPercent", cell, ctx.inputs, { integer: false });
  if (coach.kind === "ERROR") return { ok: false, findings: coach.findings };
  if (coach.kind === "VALUE") return { ok: true, range: { min: coach.value, max: coach.value } };
  if (cell.recommended === null) {
    return { ok: false, findings: [itemFinding("MANUAL_INPUT_REQUIRED", "BLOCK", { metric: "intensityPercent" })] };
  }
  return { ok: true, range: { min: cell.recommended.min, max: cell.recommended.max } };
}

function buildDistanceRep(ctx: RepContext): RepBuild {
  const { envelope, template, position, inputs } = ctx;
  const cell = envelope.fields.repDistanceM;
  if (!cell) return missingCell("repDistanceM");
  const distance = resolveEnvelopeField({
    field: "repDistanceM",
    unit: "m",
    cell,
    inputs,
    engine:
      template.fixedDistanceField === "repDistanceM" && template.displayDistanceM !== undefined
        ? { kind: "TEMPLATE_FIXED", value: template.displayDistanceM }
        : { kind: "PLACE", position, rounding: "DISTANCE" },
  });
  if (!distance.ok) return distance;
  const intensity = resolveIntensityPercent(ctx);
  if (!intensity.ok) return intensity;
  const counts = solveCounts({
    cells: countCells(envelope),
    volume: envelope.fields.sessionVolumeM ? { field: "sessionVolumeM", cell: envelope.fields.sessionVolumeM, perRepM: distance.value.value } : null,
    position,
    maxAutoTotalReps: ctx.eligibility.modifiers.maxAutoTotalReps,
    inputs,
  });
  if (!counts.ok) return counts;
  return {
    ok: true,
    rep: { kind: "DISTANCE", distanceM: distance.value },
    geometry: { kind: "DISTANCE", distanceM: distance.value.value },
    counts,
    repsField: repsFieldFor(envelope),
    records: [{ field: "repDistanceM", fieldValue: distance.value }],
    findings: [...distance.findings, ...counts.findings],
    segmentsPerRep: 1,
    repDistanceForTarget: distance.value.value,
    intensityPercent: intensity.range,
    decelerationM: null,
    runningSecondsPerRepLowerBound: null,
  };
}

function buildFlyRep(ctx: RepContext): RepBuild {
  const { envelope, template, position, inputs } = ctx;
  const buildUpCell = envelope.fields.buildUpM;
  const flyCell = envelope.fields.flyZoneM;
  if (!buildUpCell) return missingCell("buildUpM");
  if (!flyCell) return missingCell("flyZoneM");
  const buildUp = resolveEnvelopeField({ field: "buildUpM", unit: "m", cell: buildUpCell, inputs, engine: { kind: "PLACE", position, rounding: "DISTANCE" } });
  if (!buildUp.ok) return buildUp;
  const fly = resolveEnvelopeField({
    field: "flyZoneM",
    unit: "m",
    cell: flyCell,
    inputs,
    engine:
      template.fixedDistanceField === "flyZoneM" && template.displayDistanceM !== undefined
        ? { kind: "TEMPLATE_FIXED", value: template.displayDistanceM }
        : { kind: "PLACE", position, rounding: "DISTANCE" },
  });
  if (!fly.ok) return fly;

  // 減速区間は安全のための距離。低 confidence / LOWER 希望で短くしない（rest と同じく MIDDLE 固定）。
  let decelerationM: number | null = null;
  const decelCell = envelope.fields.decelerationM;
  if (decelCell) {
    const decel = resolveEnvelopeField({ field: "decelerationM", unit: "m", cell: decelCell, inputs, engine: { kind: "PLACE", position: "MIDDLE", rounding: "DISTANCE" } });
    if (!decel.ok) return decel;
    decelerationM = decel.value.value;
  }

  const intensity = resolveIntensityPercent(ctx);
  if (!intensity.ok) return intensity;
  const counts = solveCounts({
    cells: countCells(envelope),
    volume: envelope.fields.flyVolumeM ? { field: "flyVolumeM", cell: envelope.fields.flyVolumeM, perRepM: fly.value.value } : null,
    position,
    maxAutoTotalReps: ctx.eligibility.modifiers.maxAutoTotalReps,
    inputs,
  });
  if (!counts.ok) return counts;

  const b = buildUp.value.value;
  const f = fly.value.value;
  return {
    ok: true,
    rep: {
      kind: "FLY",
      buildUpDistanceM: buildUp.value,
      flyZoneDistanceM: fly.value,
      decelerationDistanceM: decelerationM,
      totalRunningDistanceM: decelerationM === null ? null : b + f + decelerationM,
      plannedHighSpeedExposureM: flyRepHighSpeedExposure(b, f),
    },
    geometry: { kind: "FLY", buildUpM: b, flyZoneM: f },
    counts,
    repsField: repsFieldFor(envelope),
    records: [
      { field: "buildUpM", fieldValue: buildUp.value },
      { field: "flyZoneM", fieldValue: fly.value },
    ],
    findings: [...buildUp.findings, ...fly.findings, ...counts.findings],
    segmentsPerRep: 1,
    repDistanceForTarget: null,
    intensityPercent: intensity.range,
    decelerationM,
    runningSecondsPerRepLowerBound: null,
  };
}

function durationDisplayDistance(ctx: RepContext, durationS: number): QuantityInterval<"m"> {
  const { template, plan, request } = ctx;
  if (request.selection.method !== "LONG_SPRINT_RACE_SPECIFIC") {
    return template.displayDistanceM !== undefined
      ? { lower: template.displayDistanceM, upper: template.displayDistanceM, unit: "m", source: "RULE_DEFINITION", confidence: "MEDIUM" }
      : { lower: null, upper: null, unit: "m", source: "UNKNOWN", confidence: "NONE" };
  }
  const ref = plan.reference;
  if (ref.kind === "RACE_PACE") {
    const def = raceEventDefinition(ctx.ruleSet.eventDefinitions, ref.event);
    if (def !== null && ref.targetTimeS.lower !== null && ref.targetTimeS.upper !== null) {
      const d = def.distanceM;
      return {
        lower: Math.floor((durationS * d) / ref.targetTimeS.upper),
        upper: Math.ceil((durationS * d) / ref.targetTimeS.lower),
        unit: "m",
        source: "ESTIMATED",
        confidence: "MEDIUM",
      };
    }
  }
  if (ref.kind === "SAME_DISTANCE_BEST") {
    // 記録の平均速度より速くは走らない、という上端だけを持つ（練習強度の割合を持たないため下端は null）。
    return { lower: null, upper: Math.ceil((durationS * ref.distanceM) / ref.mark.timeS), unit: "m", source: "ESTIMATED", confidence: "LOW" };
  }
  return { lower: null, upper: null, unit: "m", source: "UNKNOWN", confidence: "NONE" };
}

function buildDurationRep(ctx: RepContext): RepBuild {
  const { envelope, position, inputs } = ctx;
  const cell = envelope.fields.repDurationS;
  if (!cell) return missingCell("repDurationS");
  const duration = resolveEnvelopeField({ field: "repDurationS", unit: "s", cell, inputs, engine: { kind: "PLACE", position, rounding: "REP_DURATION_SECONDS" } });
  if (!duration.ok) return duration;
  const display = durationDisplayDistance(ctx, duration.value.value);
  const findings: Finding[] = [...duration.findings];
  const volumeCell = envelope.fields.sessionVolumeM;
  let volume = null;
  if (volumeCell && display.upper !== null) {
    volume = { field: "sessionVolumeM" as const, cell: volumeCell, perRepM: display.upper };
  } else if (volumeCell) {
    findings.push(itemFinding("VOLUME_NOT_DETERMINABLE", "WARN", { metric: "sessionVolumeM" }));
  }
  const counts = solveCounts({ cells: countCells(envelope), volume, position, maxAutoTotalReps: ctx.eligibility.modifiers.maxAutoTotalReps, inputs });
  if (!counts.ok) return counts;
  return {
    ok: true,
    rep: { kind: "DURATION", durationS: duration.value, displayDistanceM: display },
    geometry: { kind: "DURATION", displayDistanceM: display },
    counts,
    repsField: repsFieldFor(envelope),
    records: [{ field: "repDurationS", fieldValue: duration.value }],
    findings: [...findings, ...counts.findings],
    segmentsPerRep: 1,
    repDistanceForTarget: null,
    intensityPercent: null,
    decelerationM: null,
    runningSecondsPerRepLowerBound: duration.value.value,
  };
}

function withinRange(v: number, r: { min: number; max: number }) {
  return v >= r.min - 1e-9 && v <= r.max + 1e-9;
}

function buildSplitRep(ctx: RepContext, recoveryStructure: "FULL" | "INCOMPLETE"): RepBuild {
  const { envelope, position, inputs, plan } = ctx;
  const ref = plan.reference;
  if (ref.kind !== "TARGET_SPLIT") {
    return { ok: false, findings: [itemFinding("LONG_SPLIT_REQUIRES_TARGET_SPLIT", "BLOCK", { metric: ref.kind })] };
  }
  const findings: Finding[] = [];
  if (recoveryStructure === "FULL") {
    // 1本の目標合計時間は repDurationS の範囲で検査する（コーチ入力値なので coachEditable 外は override 必須）。
    const cell = envelope.fields.repDurationS;
    if (cell) {
      const lower = ref.segments.reduce((s, seg) => s + (seg.targetS.lower as number), 0);
      const upper = ref.segments.reduce((s, seg) => s + (seg.targetS.upper as number), 0);
      if (!withinRange(lower, cell.coachEditable) || !withinRange(upper, cell.coachEditable)) {
        const ov = inputs.fieldOverrides.get("repDurationS");
        if (!ov || ov.newValue !== upper) {
          return {
            ok: false,
            findings: [itemFinding("COACH_EDITABLE_OVERRIDE_REQUIRED", "BLOCK", { metric: "repDurationS:targetSplit", limit: cell.coachEditable })],
          };
        }
        inputs.consumedOverrides.add("repDurationS");
        findings.push(itemFinding("COACH_OVERRIDE_APPLIED", "REQUIRE_COACH_REVIEW", { metric: "repDurationS:targetSplit" }));
      } else if (cell.recommended !== null && (!withinRange(lower, cell.recommended) || !withinRange(upper, cell.recommended))) {
        findings.push(itemFinding("OUTSIDE_RECOMMENDED", "WARN", { metric: "repDurationS:targetSplit", limit: cell.recommended }));
      }
    }
  }
  const totalDistanceM = ref.segments.reduce((s, seg) => s + seg.distanceM, 0);
  const counts = solveCounts({
    cells: countCells(envelope),
    volume: envelope.fields.sessionVolumeM ? { field: "sessionVolumeM", cell: envelope.fields.sessionVolumeM, perRepM: totalDistanceM } : null,
    position,
    maxAutoTotalReps: ctx.eligibility.modifiers.maxAutoTotalReps,
    inputs,
  });
  if (!counts.ok) return counts;
  return {
    ok: true,
    // restAfterS は rest 解決後に埋める（区間休息は intraRepRestS と同一の FieldValue）。
    rep: { kind: "SPLIT", segments: ref.segments.map((seg) => ({ distanceM: seg.distanceM, restAfterS: null })) },
    geometry: { kind: "SPLIT", totalDistanceM },
    counts,
    repsField: repsFieldFor(envelope),
    records: [],
    findings: [...findings, ...counts.findings],
    segmentsPerRep: ref.segments.length,
    repDistanceForTarget: null,
    intensityPercent: null,
    decelerationM: null,
    runningSecondsPerRepLowerBound: ref.segments.reduce((sum, seg) => sum + (seg.targetS.lower as number), 0),
  };
}

function buildAttemptsRep(ctx: RepContext): RepBuild {
  const { envelope, position, inputs, template } = ctx;
  if (!envelope.fields.attempts) return missingCell("attempts");
  // SHORT / FULL は SessionTemplate.approachType（構造化データ）から読む。
  const approach = template.approachType;
  if (approach === null) {
    return { ok: false, findings: [itemFinding("RULESET_TEMPLATE_METADATA_MISSING", "BLOCK", { metric: "approachType" })] };
  }

  let approachDistanceM: { value: number; unit: "m"; source: "COACH_ENTERED" } | null = null;
  const edit = inputs.edits.get("approachDistanceM");
  if (edit) {
    inputs.consumedEdits.add("approachDistanceM");
    if (edit.unit !== "m" || !(edit.value > 0)) {
      return { ok: false, findings: [itemFinding("COACH_EDIT_INVALID", "BLOCK", { metric: "approachDistanceM" })] };
    }
    approachDistanceM = { value: edit.value, unit: "m", source: "COACH_ENTERED" };
    inputs.materializedCoachEdits.add("approachDistanceM");
  }

  const counts = solveCounts({ cells: countCells(envelope), volume: null, position, maxAutoTotalReps: ctx.eligibility.modifiers.maxAutoTotalReps, inputs });
  if (!counts.ok) return counts;
  return {
    ok: true,
    rep: { kind: "ATTEMPTS", approach, approachDistanceM },
    geometry: { kind: "ATTEMPTS", approach, approachDistanceM: approachDistanceM?.value ?? null },
    counts,
    repsField: repsFieldFor(envelope),
    records: [],
    findings: counts.findings,
    segmentsPerRep: 1,
    repDistanceForTarget: null,
    intensityPercent: null,
    decelerationM: null,
    runningSecondsPerRepLowerBound: null,
  };
}

function buildRep(ctx: RepContext, recoveryStructure: "FULL" | "INCOMPLETE" | null): RepBuild {
  const built = buildRepByMethod(ctx, recoveryStructure);
  if (!built.ok) return built;
  // SessionTemplate.fixedDistanceField が、この rep の形で使われるフィールドを指していること。
  const fixed = ctx.template.fixedDistanceField;
  if ((fixed === "repDistanceM" && built.rep.kind !== "DISTANCE") || (fixed === "flyZoneM" && built.rep.kind !== "FLY")) {
    return { ok: false, findings: [itemFinding("RULESET_TEMPLATE_METADATA_INCONSISTENT", "BLOCK", { metric: `fixedDistanceField:${fixed}` })] };
  }
  return built;
}

function buildRepByMethod(ctx: RepContext, recoveryStructure: "FULL" | "INCOMPLETE" | null): RepBuild {
  switch (ctx.request.selection.method) {
    case "ACCELERATION":
    case "TEMPO_EXTENSIVE":
    case "TEMPO_INTENSIVE":
    case "RESISTED_SPRINT":
    case "STRIDE":
      return buildDistanceRep(ctx);
    case "MAX_VELOCITY":
    case "ASSISTED_SPRINT":
      return buildFlyRep(ctx);
    case "SPRINT_ENDURANCE_SHORT":
      return buildDurationRep(ctx);
    case "LONG_SPRINT_RACE_SPECIFIC":
      if (recoveryStructure === "INCOMPLETE" || ctx.plan.reference.kind === "TARGET_SPLIT") {
        return buildSplitRep(ctx, recoveryStructure ?? "FULL");
      }
      return buildDurationRep(ctx);
    case "EVENT_APPROACH_SPEED":
      return buildAttemptsRep(ctx);
  }
}

// ---------------------------------------------------------------------------
// generatedBy（§18.4）
// ---------------------------------------------------------------------------

export function generationRecordFor(actor: PlanRequest["actor"]): GenerationRecord {
  switch (actor.kind) {
    case "COACH":
      return { proposer: { kind: "ENGINE" }, createdByCoach: true, acceptedByCoachAt: null };
    case "AI_PLANNER":
      return {
        proposer: { kind: "AI_PLANNER", provider: actor.provider, model: actor.model, requestId: actor.requestId },
        createdByCoach: false,
        acceptedByCoachAt: null,
      };
    case "SYSTEM":
      return { proposer: { kind: "ENGINE" }, createdByCoach: false, acceptedByCoachAt: null };
  }
}

// ---------------------------------------------------------------------------
// rationale
// ---------------------------------------------------------------------------

function envelopeEvidenceCounts(envelope: SelectedEnvelope, usedFields: readonly EnvelopeField[]) {
  const cells = usedFields.map((f) => envelope.fields[f]).filter((c): c is EnvelopeCell => c !== undefined);
  return {
    sourceBacked: cells.filter((c) => c.judgement === "SOURCE_BACKED").length,
    enginePolicy: cells.filter((c) => c.judgement === "ENGINE_POLICY").length,
    open: cells.filter((c) => c.judgement === "OPEN").length,
  };
}


// ---------------------------------------------------------------------------
// step 2 / 11: readiness（§13）
//
// **倍率・割合は一切作らない。** readiness が planning に与える影響は次の4つだけ:
//   - STOP（step 2 で BLOCKED。override 不可）
//   - CANCEL_HIGH_INTENSITY / SWAP_TO_LOWER_LOAD_METHOD（この Method では作らない → INELIGIBLE + substitutes）
//   - USE_LOWER_BOUND（rest 以外のエンジン配置値の position 上限を LOWER_BOUND に）
//   - INCREASE_REST（rest の position を UPPER_HALF に）
//
// [R5 errata] 判断の適用は **raw trigger（signal 単位）→ effective action** の順に行う。
// 高優先 action が「この Method には適用できない」または「有効な CoachOverride で解除された」場合は、
// その action **だけ**を取り除いて残りの raw trigger から優先順位を決め直す（独立した signal を消さない）。
// ---------------------------------------------------------------------------

/** 処方に保存してよい finding だけを使う（部位名・red flag 名・尺度値は決して含めない。§13.5・§20 T-AI-06）。 */
const READINESS_RATIONALE_ORDER: readonly RationaleCode[] = [
  "READINESS_CANCEL_OVERRIDDEN",
  "READINESS_LOWER_BOUND",
  "READINESS_INCREASE_REST",
  "READINESS_COACH_REVIEW_REQUIRED",
  "READINESS_NO_CHANGE",
];

type ReadinessApplication =
  | {
      kind: "PROCEED";
      /** この項目へ実際に適用した effective action だけ（raw trigger は保存しない。§13.6）。 */
      applied: ReadinessActionCode[];
      safetyOutcome: SafetyOutcome;
      /** rest 以外のエンジン配置値に効く位置上限。 */
      positionCap: RangePosition | null;
      /** rest の位置（既定 MIDDLE より上げるときだけ非 null）。 */
      restPosition: RangePosition | null;
      findings: Finding[];
      rationale: RationaleLine[];
      overrideConsumed: boolean;
    }
  | { kind: "INELIGIBLE"; reasons: EligibilityReason[]; substitutes: RunningSelection[] };


/** SWAP を取り除いた判断（置換そのものが SWAP の適用）。raw trigger も同時に更新して整合を保つ。 */
function decisionWithoutSwap(readiness: ReadinessDecision, evaluatedFor: ReadinessDecision["evaluatedFor"]): ReadinessDecision {
  const triggers = readiness.triggers
    .map((t) => ({ ruleId: t.ruleId, actions: t.actions.filter((a) => a !== "SWAP_TO_LOWER_LOAD_METHOD") }))
    .filter((t) => t.actions.length > 0);
  const actions = normalizeReadinessActions(triggers.flatMap((t) => t.actions));
  return {
    ...readiness,
    triggers,
    actions: actions.length > 0 ? actions : (["NO_CHANGE"] as ReadinessActionCode[]),
    evaluatedFor,
  };
}

/**
 * §13.4: SWAP 先の候補を RuleSet から列挙し、**R3/R4 の eligibility をもう一度すべて通した**ものだけを返す
 * （「swap 先だから安全」とは仮定しない）。候補側の再評価では SWAP だけを取り除く
 * （候補でもう一度 SWAP を要求すると候補が消えるため）。候補の候補までは辿らない（depth ガード）。
 */
function readinessSubstitutes(args: {
  request: PlanRequest;
  resolved: ResolvedRuleSet;
  readiness: ReadinessDecision;
  depth: number;
}): RunningSelection[] {
  const { request, resolved, readiness, depth } = args;
  if (depth > 0) return [];
  const targets = resolveSwapTargets(resolved.ruleSet, request.selection.method);
  if (targets.outcome !== "SWAP") return [];

  const substitutes: RunningSelection[] = [];
  for (const candidate of targets.candidates) {
    const meta = resolved.ruleSet.methods.find((m) => m.method === candidate.method);
    if (!meta) continue;
    const candidateRequest = {
      ...request,
      selection: candidate,
      readiness: decisionWithoutSwap(readiness, { method: candidate.method, loadClass: meta.loadClass }),
      // この項目に対するコーチ入力（field 編集・override・参照）は別 Method へは引き継がない。
      coachEdits: [],
      overrides: [],
      coachReference: null,
    };
    if (planWithResolvedRuleSet(candidateRequest, resolved, depth + 1).status === "OK") substitutes.push(candidate);
  }
  return substitutes;
}

function applyReadinessActions(args: {
  readiness: ReadinessDecision | null;
  request: PlanRequest;
  resolved: ResolvedRuleSet;
  loadClass: RuleSet["methods"][number]["loadClass"];
  depth: number;
}): ReadinessApplication {
  const { readiness, request, resolved, loadClass, depth } = args;
  if (readiness === null) {
    return {
      kind: "PROCEED",
      applied: [],
      safetyOutcome: "NONE",
      positionCap: null,
      restPosition: null,
      findings: [],
      rationale: [rationaleLine("READINESS_NOT_EVALUATED")],
      overrideConsumed: false,
    };
  }

  const application = resolveReadinessApplication({
    readiness, ruleSet: resolved.ruleSet, method: request.selection.method, loadClass,
    isCoach: request.actor.kind === "COACH",
    canOverrideCancel: request.actor.kind === "COACH" && request.overrides.some((o) => o.target.kind === "READINESS"),
  });
  const { safetyOutcome, overrideConsumed, reviewRequired, remaining } = application;
  const findings: Finding[] = application.effects.map((code) =>
    itemFinding(code, code === "READINESS_CANCEL_NOT_APPLICABLE" || code === "READINESS_SWAP_KEEP_CURRENT" ? "INFO" : "REQUIRE_COACH_REVIEW"),
  );
  const codes = new Set<RationaleCode>();
  if (overrideConsumed) codes.add("READINESS_CANCEL_OVERRIDDEN");
  if (application.kind !== "PROCEED") {
    const code = application.kind === "CHECK_REQUIRED" ? "READINESS_CHECK_REQUIRED"
      : application.kind === "SWAP" ? "READINESS_SWAP_RECOMMENDED" : "READINESS_HIGH_INTENSITY_CANCELLED";
    return {
      kind: "INELIGIBLE",
      reasons: [{ code, ruleId: null, overrideAllowed: application.kind === "CANCELLED" && request.actor.kind === "COACH" }],
      substitutes: readinessSubstitutes({ request, resolved, readiness, depth }),
    };
  }

  // Remaining triggers are resolved by the shared R5 application helper.
  const applied = new Set<ReadinessActionCode>();
  let positionCap: RangePosition | null = null;
  let restPosition: RangePosition | null = null;
  if (remaining.has("USE_LOWER_BOUND")) {
    positionCap = "LOWER_BOUND";
    applied.add("USE_LOWER_BOUND");
    codes.add("READINESS_LOWER_BOUND");
  }
  if (remaining.has("INCREASE_REST")) {
    restPosition = "UPPER_HALF";
    applied.add("INCREASE_REST");
    codes.add("READINESS_INCREASE_REST");
  }
  if (remaining.has("REQUIRE_COACH_REVIEW") || reviewRequired) {
    applied.add("REQUIRE_COACH_REVIEW");
    codes.add("READINESS_COACH_REVIEW_REQUIRED");
    if (remaining.has("REQUIRE_COACH_REVIEW")) findings.push(itemFinding("READINESS_COACH_REVIEW_REQUIRED", "REQUIRE_COACH_REVIEW"));
  }

  const normalized = normalizeReadinessActions(applied);
  // [R5 errata] readiness を評価した以上 readinessApplied は空にしない（評価していない `null` と区別する）。
  const appliedList: ReadinessActionCode[] = normalized.length > 0 ? normalized : ["NO_CHANGE"];
  if (appliedList.length === 1 && appliedList[0] === "NO_CHANGE") codes.add("READINESS_NO_CHANGE");

  return {
    kind: "PROCEED",
    applied: appliedList,
    safetyOutcome,
    positionCap,
    restPosition,
    findings,
    rationale: READINESS_RATIONALE_ORDER.filter((c) => codes.has(c)).map((c) => rationaleLine(c)),
    overrideConsumed,
  };
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

/**
 * [R8] §13.2 の red flag グループと「痛みあり（red flag なし）」の safetyOutcome を、実施中の safety 判定用に
 * 処方へコピーする（monitor は RuleSet を読めない）。R5 readinessRules の行をそのまま写すだけで、グループや
 * outcome を TS に複製しない。必要な行が RuleSet に無ければ null（計画を BLOCKED にする）。
 */
function buildRuntimeSafetyPolicySnapshot(ruleSet: RuleSet): RuntimeSafetyPolicySnapshot | null {
  const redFlagGroups = ruleSet.readinessRules.flatMap((r) =>
    r.kind === "PAIN_RED_FLAG_GROUP"
      ? [{ redFlags: [...r.redFlags], safetyOutcome: r.safetyOutcome, severityRank: r.severityRank }]
      : [],
  );
  const painPresent = ruleSet.readinessRules.find((r) => r.kind === "PAIN_PRESENT");
  if (redFlagGroups.length === 0 || !painPresent || painPresent.kind !== "PAIN_PRESENT") return null;
  const parsed = runtimeSafetyPolicySnapshotSchema.safeParse({ redFlagGroups, painPresentOutcome: painPresent.safetyOutcome });
  return parsed.success ? parsed.data : null;
}

export type PlausibilityCandidateResult = PlanResult | {
  status: "REVIEW_CANDIDATE";
  prescription: RunningPrescriptionValue;
  sessionFindings: Finding[];
};

export function planWithResolvedRuleSet(raw: unknown, resolved: ResolvedRuleSet, depth = 0): PlanResult {
  const result = buildPlan(raw, resolved, depth, false);
  if (result.status === "REVIEW_CANDIDATE") throw new Error("Unexpected review candidate");
  return result;
}

/** Server evaluation seam. A candidate is unapproved and must never be saved directly. */
export function evaluatePlausibilityCandidate(raw: unknown, resolved: ResolvedRuleSet): PlausibilityCandidateResult {
  return buildPlan(raw, resolved, 0, true);
}

function buildPlan(raw: unknown, resolved: ResolvedRuleSet, depth: number, collectReviews: boolean): PlausibilityCandidateResult {
  const { ruleSet, contentHash } = resolved;

  // ---- step 1: normalization + input plausibility ----
  const normalized = normalizePlanRequest(raw);
  // PlanRequest が parse できない場合は RuleSet 選択以前なので RULESET_DRAFT を付けない。
  if (!normalized.ok) return { status: "BLOCKED", findings: normalized.findings };
  const request = normalized.request;
  const canCollect = collectReviews && request.actor.kind === "COACH";
  const canDefer = (finding: Finding) => canCollect &&
    isReviewablePlausibilityPolicy(finding.plausibility?.policy ?? "") &&
    (finding.plausibility?.certainty === "CONFIRMED_EXCEED" || finding.plausibility?.certainty === "POSSIBLE_EXCEED");
  const method = request.selection.method;

  // [R4 errata] 結果の種類（OK / INELIGIBLE / BLOCKED）に依らない横断情報。不適格の理由そのものは含めない。
  const plausibility = checkInputPlausibility(request, ruleSet);
  const contextFindings: Finding[] = [
    ...(ruleSet.status === "DRAFT" ? [itemFinding("RULESET_DRAFT", "INFO", { metric: ruleSet.ruleSetVersion })] : []),
    ...plausibility.findings,
  ];
  const blocked = (extra: Finding[]): PlanResult => ({ status: "BLOCKED", findings: [...contextFindings, ...extra] });
  const ineligible = (reasons: EligibilityReason[], extra: Finding[] = []): PlanResult => ({
    status: "INELIGIBLE",
    reasons,
    substitutes: [],
    findings: [...contextFindings, ...extra],
  });

  if (plausibility.blocking.some((finding) => !canDefer(finding))) return blocked(plausibility.blocking);
  contextFindings.push(...plausibility.blocking);

  // ---- step 2: pain / safety gate（§13.2）----
  // envelope / placement より前に止める。STOP はどの actor の override でも解除できない。
  const readiness = request.readiness;
  if (readiness !== null) {
    if (
      readiness.ruleSet.version !== ruleSet.ruleSetVersion ||
      readiness.ruleSet.contentHash !== contentHash ||
      readiness.ruleSet.status !== ruleSet.status
    ) {
      // 別バージョン / 別内容の RuleSet で出した判断を、この計画の RuleSet に適用しない。
      return blocked([itemFinding("READINESS_RULESET_MISMATCH", "BLOCK", { metric: readiness.ruleSet.version })]);
    }
    if (readiness.stopPlanning) {
      // 判断に含まれる表示用 finding はコードだけを写す（部位・red flag・尺度値は元から持たない）。
      return blocked(readiness.transientFindings.map((f) => itemFinding(f.code, f.severity)));
    }
  }

  // ---- step 7（RuleSet 照合）: template / MethodMeta / recoveryStructure ----
  const selection = validateSelection(request.selection, ruleSet);
  if (!selection.ok) return blocked(selection.findings);
  const { template, methodMeta, recoveryStructure } = selection.value;

  // ---- step 3: subject profile（asOf = planningDate） ----
  const profile: SubjectProfile = resolveSubjectProfile({ subject: request.subject, asOf: request.planningDate, ruleSet });

  // ---- step 4: competition priority / phase（§14）----
  // §14 は一貫して暦日（plannedDate）で動く。plannedAt（時刻）は §12 の 48h/72h window だけが必要とする。
  const coverage28d = request.history?.coverage28d ?? "NONE";
  const templateUsedWithin28d =
    request.menuContext.plannedDate !== null && request.history !== null
      ? hasUsedTemplateWithinDays(request.history.events, request.menuContext.plannedDate, 28, request.selection.templateId)
      : false;
  const phaseCompetition = resolveCompetitionAndPhase({
    ruleSet,
    phase: request.menuContext.phase,
    competitions: request.menuContext.competitions,
    plannedDate: request.menuContext.plannedDate,
    tier: profile.envelopeTier,
    method,
    loadClass: methodMeta.loadClass,
    template,
    coverage28d,
    templateUsedWithin28d,
    history: request.history?.events ?? [],
  });
  if (recoveryStructure === "INCOMPLETE" && phaseCompetition.longIncompleteBlocked !== null) {
    // §14.3 PEAK×ADVANCED n5-7: LONG の INCOMPLETE を明示的に不適格にする（override 可）。
    return ineligible([
      { code: "COMPETITION_LONG_INCOMPLETE_BLOCKED", ruleId: phaseCompetition.longIncompleteBlocked.ruleId, overrideAllowed: true },
    ]);
  }
  if (request.menuContext.phase === null && request.menuContext.competitions.length === 0) {
    contextFindings.push(itemFinding("PHASE_COMPETITION_NOT_EVALUATED", "INFO"));
  }

  // ---- step 5: recent training / weekly context（§12）----
  const weekly = evaluateWeeklyContext(request.history, {
    ruleSet,
    evaluatedAt: request.menuContext.plannedAt,
    method,
    loadClass: methodMeta.loadClass,
    ageBand: profile.ageBand,
    hasExistingReadinessDecision: readiness !== null,
  });
  const historyCoverage72h = weekly.evaluatedAt === null ? "NOT_EVALUATED" : weekly.coverage72h;
  contextFindings.push(...phaseCompetition.findings, ...weekly.findings);

  // §14/§12 由来の自動生成ブロック（hard ineligible ではない。COACH は手動 + REVIEW で継続できる）。
  const contextAutogenBlocked =
    (phaseCompetition.autogenBlockedLoadClasses as readonly string[]).includes(methodMeta.loadClass) ||
    weekly.autogenBlockedMethods.includes(method);

  // contextFindings は BLOCKED / INELIGIBLE の横断情報。findings は OK まで到達したときの
  // prescription.findings。ここで初めて分岐するため、step 4/5 の finding は両方に反映される。
  const findings: Finding[] = [...contextFindings];

  // ---- step 6: eligibility（advancedOnly / complexity / actor） ----
  const velocities = resolveAthleteVelocities(request, profile, ruleSet);
  const candidates = referenceCandidates(methodMeta);
  const eligibility = evaluateEligibility({
    request,
    profile,
    ruleSet,
    template,
    methodMeta,
    vmaxConfidence: measuredVmaxFor(velocities, candidates)?.confidence ?? null,
  });
  if (eligibility.status === "INELIGIBLE") return ineligible(eligibility.reasons, eligibility.findings);
  if (eligibility.status === "BLOCKED") return blocked(eligibility.findings);
  findings.push(...eligibility.findings);

  // ---- step 8: envelope ----
  const envelopeResult = selectEnvelope(ruleSet, request.selection, profile.envelopeTier, recoveryStructure);
  if (!envelopeResult.ok) return blocked([...envelopeResult.findings]);
  const envelope = envelopeResult.envelope;

  // ---- step 9: individualization（参照の解決） ----
  const referenceResult = resolvePlanningReference({ request, profile, ruleSet, template, methodMeta, envelope, velocities });
  if (!referenceResult.ok) {
    return referenceResult.status === "INELIGIBLE" ? ineligible(referenceResult.reasons) : blocked(referenceResult.findings);
  }
  const plan = referenceResult.plan;
  const selectedInputPlausibility = checkSelectedPerformanceInputPlausibility(request, ruleSet, plan.selectedInputMarks);
  contextFindings.push(...selectedInputPlausibility.findings);
  findings.push(...selectedInputPlausibility.findings);
  if (selectedInputPlausibility.blocking.some((finding) => !canDefer(finding))) return blocked(selectedInputPlausibility.blocking);
  contextFindings.push(...selectedInputPlausibility.blocking);
  findings.push(...selectedInputPlausibility.blocking);
  if (recoveryStructure === "INCOMPLETE" && (plan.reference.kind !== "TARGET_SPLIT" || plan.reference.segments.length < 2)) {
    // 分割走の区間はコーチの TARGET_SPLIT（2区間以上）でしか決まらない。
    return ineligible([{ code: "REFERENCE_UNAVAILABLE", ruleId: null, overrideAllowed: false }]);
  }

  // ---- step 10: confidence / directness ----
  const targetUsesIntensityPercent =
    envelope.fields.intensityPercent !== undefined &&
    (plan.reference.kind === "MEASURED_VMAX" || plan.reference.kind === "SAME_DISTANCE_BEST") &&
    (request.subject.kind === "ATHLETE" || method === "ASSISTED_SPRINT");
  const usedFields = (Object.keys(envelope.fields) as EnvelopeField[]).filter((f) =>
    f === "intensityPercent" ? targetUsesIntensityPercent : f === "vdecPercent" ? plan.reference.kind === "VELOCITY_DECREMENT" : true,
  );
  const confidence = derivePlanningConfidence({ ruleSet, envelope, usedFields, request, profile, inputData: plan.inputData, historyCoverage72h });
  findings.push(...confidence.findings);
  if (
    request.actor.kind !== "COACH" &&
    (confidence.prescription === "LOW" || confidence.prescription === "POLICY_ONLY") &&
    methodMeta.loadClass === "HIGH_METABOLIC"
  ) {
    return ineligible([{ code: "LOW_CONFIDENCE_HIGH_METABOLIC_AUTOGEN_BLOCKED", ruleId: null, overrideAllowed: null }]);
  }
  if (request.actor.kind !== "COACH" && contextAutogenBlocked) {
    // §12.3 / §14.3 由来の自動生成停止（hard ineligible ではない。COACH は手動 + REVIEW で継続できる）。
    return ineligible([{ code: "WEEKLY_PHASE_COMPETITION_AUTOGEN_BLOCKED", ruleId: null, overrideAllowed: null }]);
  }

  // ---- step 11: readiness action（§13.3）----
  const readinessPlan = applyReadinessActions({ readiness, request, resolved, loadClass: methodMeta.loadClass, depth });
  if (readinessPlan.kind === "INELIGIBLE") {
    return {
      status: "INELIGIBLE",
      reasons: readinessPlan.reasons,
      substitutes: readinessPlan.substitutes,
      findings: [...contextFindings],
    };
  }
  findings.push(...readinessPlan.findings);

  // ---- step 12: value placement ----
  const preferenceCap = request.positionPreference === "LOWER" ? positionFromPreference("LOWER") : null;
  // 位置の制約は順序に依存せず積み重なる（最も低いものが勝つ）。dose field だけに効く
  // （§14.2 の Phase / §14.3 の Competition / §12.3 の weekly fallback は intensity reference に触れない）。
  const position = lowestPosition(
    BASE_POSITION,
    preferenceCap,
    confidence.positionCap,
    eligibility.modifiers.positionCap,
    readinessPlan.positionCap,
    phaseCompetition.dosePositionCap,
    weekly.weeklyPositionCap,
  );
  const inputs = createCoachInputs(request);
  const repBuild = buildRep(
    { request, ruleSet, envelope, template, plan, position, eligibility, inputs, targetUsesIntensityPercent },
    recoveryStructure,
  );
  if (!repBuild.ok) return blocked([...repBuild.findings]);
  findings.push(...repBuild.findings);

  const { counts } = repBuild;
  const restResult = resolveRestPlan({
    cells: {
      repRestS: envelope.fields.repRestS ?? null,
      setRestS: envelope.fields.setRestS ?? null,
      intraRepRestS: envelope.fields.intraRepRestS ?? null,
    },
    sets: counts.sets.value,
    totalReps: counts.totalReps,
    segmentsPerRep: repBuild.segmentsPerRep,
    needsIntraRepRest: recoveryStructure === "INCOMPLETE",
    runningSecondsPerRepLowerBound: repBuild.runningSecondsPerRepLowerBound,
    availableMinutes: request.menuContext.availableMinutes,
    inputs,
    restPosition: readinessPlan.restPosition,
  });
  if (!restResult.ok) return blocked([...restResult.findings]);
  findings.push(...restResult.findings);
  const rest = restResult.rest;

  let rep = repBuild.rep;
  if (rep.kind === "SPLIT" && rest.intraRepRestS) {
    const intra = rest.intraRepRestS;
    rep = { kind: "SPLIT", segments: rep.segments.map((seg, i, all) => ({ distanceM: seg.distanceM, restAfterS: i < all.length - 1 ? intra : null })) };
  }

  const unconsumed: Finding[] = [];
  for (const edit of request.coachEdits) {
    if (!inputs.consumedEdits.has(edit.field)) unconsumed.push(itemFinding("COACH_EDIT_NOT_APPLICABLE", "BLOCK", { metric: edit.field }));
  }
  for (const o of request.overrides) {
    if (o.target.kind === "FIELD" && !inputs.consumedOverrides.has(o.target.field)) {
      unconsumed.push(itemFinding("OVERRIDE_TARGET_INVALID", "BLOCK", { metric: `FIELD:${o.target.field}` }));
    }
    if (o.target.kind === "READINESS" && !readinessPlan.overrideConsumed) {
      // 解除すべき CANCEL が無いのに readiness override が付いている（対象の無い override）。
      unconsumed.push(itemFinding("OVERRIDE_TARGET_INVALID", "BLOCK", { metric: `READINESS:${o.target.action}` }));
    }
  }
  if (unconsumed.length > 0) return blocked([...unconsumed]);

  // ---- step 13: hard safety re-check ----
  const records: FieldValueRecord[] = [
    { field: "sets", fieldValue: counts.sets },
    { field: repBuild.repsField, fieldValue: counts.repsPerSet },
    ...repBuild.records,
    { field: "repRestS", fieldValue: rest.repRestS },
    ...(rest.setRestS ? [{ field: "setRestS", fieldValue: rest.setRestS }] : []),
    ...(rest.intraRepRestS ? [{ field: "intraRepRestS", fieldValue: rest.intraRepRestS }] : []),
  ];
  const safety = recheckHardSafety({ records, overrides: request.overrides, overriddenEligibilityRuleIds: eligibility.overriddenRuleIds });
  if (safety.length > 0) return blocked([...safety]);

  // ---- step 9（続き）: 目標区間と露出 ----
  const target = computeIntensityTarget({
    method,
    subjectKind: request.subject.kind,
    plan,
    repDistanceM: repBuild.repDistanceForTarget,
    intensityPercent: repBuild.intensityPercent,
  });
  const exposure = computeItemExposure(method, methodMeta.highSpeedExposureModel, repBuild.geometry, counts.totalReps);

  const stopPolicy = resolveStopPolicy(ruleSet, methodMeta, recoveryStructure, {
    autoConditionsMetWithoutOverride: eligibility.mode === "AUTO" && eligibility.overriddenRuleIds.length === 0,
  });
  if (stopPolicy === null) {
    return blocked([itemFinding("STOP_POLICY_UNRESOLVED", "BLOCK", { metric: `${method}:${recoveryStructure}` })]);
  }
  const stopPolicyId = stopPolicy.id;
  // §17.1 / [R4 errata]: monitor が RuleSet を再読込しないよう、plan 時点の StopPolicy と全 TimingTolerance の
  // データをコピーして処方に埋め込む（RuleSet の object への参照を持たない）。
  const safetyPolicy = buildRuntimeSafetyPolicySnapshot(ruleSet);
  if (safetyPolicy === null) {
    return blocked([itemFinding("MONITORING_SAFETY_POLICY_UNRESOLVED", "BLOCK")]);
  }
  const monitoringSnapshot = {
    stopPolicy: stopPolicySnapshotSchema.parse(structuredClone(stopPolicy)),
    timingTolerances: ruleSet.timingTolerances.map((t) => timingToleranceSnapshotSchema.parse(structuredClone(t))),
    safetyPolicy,
    ...(method === "RESISTED_SPRINT"
      ? {
          vdecClassificationPolicy: vdecClassificationPolicySnapshotSchema.parse({
            bands: structuredClone(ruleSet.vdecClassificationBands),
          }),
        }
      : {}),
  };

  // ---- step 15: rationale / output ----
  const rationale: RationaleLine[] = [];
  if (ruleSet.status === "DRAFT") rationale.push(rationaleLine("RULESET_DRAFT", { version: ruleSet.ruleSetVersion }));
  rationale.push(rationaleLine("TEMPLATE_SELECTED", { templateLabelJa: template.labelJa }));
  rationale.push(rationaleLine("TIER", { tier: profile.envelopeTier }));
  rationale.push(
    rationaleLine("ELIGIBILITY", {
      mode: eligibility.overriddenRuleIds.length > 0 ? "OVERRIDDEN" : eligibility.mode,
      review: eligibility.requiresReview ? 1 : 0,
    }),
  );
  rationale.push(rationaleLine("ENVELOPE_EVIDENCE", envelopeEvidenceCounts(envelope, usedFields)));
  rationale.push(rationaleLine("REFERENCE", { kind: plan.reference.kind }));
  if (target !== null && target.lower !== null && target.upper !== null) {
    rationale.push(rationaleLine("TARGET_INTERVAL", { lower: target.lower, upper: target.upper, unit: target.unit, source: target.source }));
  } else {
    rationale.push(rationaleLine("NO_NUMERIC_TARGET", { kind: plan.reference.kind }));
  }
  rationale.push(rationaleLine("CONFIDENCE", { prescription: confidence.prescription, directness: confidence.directness, inputData: plan.inputData }));
  const nonRestRecords = records.filter((r) => !["repRestS", "setRestS", "intraRepRestS"].includes(r.field));
  const enginePlacedNonRest = nonRestRecords.some((r) => r.fieldValue.origin === "ENGINE_POSITIONED" || r.fieldValue.origin === "SOLVER_DERIVED");
  if (enginePlacedNonRest) {
    rationale.push(rationaleLine("POSITION", { position }));
    if (confidence.positionCap !== null && confidence.positionCap === position && position !== BASE_POSITION) {
      rationale.push(rationaleLine("POSITION_CAP_CONFIDENCE", { confidence: confidence.prescription }));
    }
    if (preferenceCap !== null) rationale.push(rationaleLine("POSITION_CAP_PREFERENCE"));
    if (eligibility.modifiers.positionCap !== null) rationale.push(rationaleLine("POSITION_CAP_ELIGIBILITY"));
  }
  const countsFromCoach = [counts.sets, counts.repsPerSet].some((fv) => fv.origin === "COACH" || fv.origin === "COACH_OVERRIDE");
  rationale.push(
    rationaleLine("COUNTS_RESOLVED", {
      sets: counts.sets.value,
      repsPerSet: counts.repsPerSet.value,
      totalReps: counts.totalReps,
      source: countsFromCoach ? "COACH" : "ENGINE",
    }),
  );
  if (counts.sets.origin === "STRUCTURAL_FIXED") rationale.push(rationaleLine("STRUCTURAL_SINGLE_SET"));
  for (const r of records) {
    const fv = r.fieldValue;
    if (fv.origin === "TEMPLATE_FIXED") {
      rationale.push(rationaleLine("TEMPLATE_FIXED_VALUE", { field: r.field, value: fv.value, unit: fv.unit }));
    } else if (fv.origin === "COACH_OVERRIDE") {
      rationale.push(rationaleLine("COACH_OVERRIDE_APPLIED", { field: r.field }));
    }
  }
  // This existing rationale code records origin, including coach-controlled values with no
  // standalone FieldValue (for example intensityPercent and decelerationM). Fixed-value
  // equality consumes an input but never enters materializedCoachEdits, so it is not attributed.
  for (const field of inputs.materializedCoachEdits) {
    rationale.push(rationaleLine("COACH_MANUAL_INPUT", { field }));
  }
  if (rest.repRestS.origin === "ENGINE_POSITIONED") {
    rationale.push(
      rationaleLine(
        "REST_FROM_ENVELOPE",
        rest.setRestS ? { repRestS: rest.repRestS.value, setRestS: rest.setRestS.value } : { repRestS: rest.repRestS.value },
      ),
    );
  }
  rationale.push(rationaleLine("REST_NOT_SHORTENED"));
  if (rest.feasibility === "EXCEEDS_AVAILABLE_TIME" && request.menuContext.availableMinutes !== null) {
    rationale.push(
      rationaleLine("REST_EXCEEDS_AVAILABLE_TIME", {
        minimumSeconds: restResult.minimumSecondsLowerBound,
        availableMinutes: request.menuContext.availableMinutes,
      }),
    );
  }
  if (repBuild.decelerationM !== null) rationale.push(rationaleLine("DECELERATION_EXCLUDED", { decelerationM: repBuild.decelerationM }));
  if (method === "STRIDE") rationale.push(rationaleLine("STRIDE_RELAXED"));
  if (recoveryStructure !== null) rationale.push(rationaleLine("LONG_RECOVERY_STRUCTURE", { structure: recoveryStructure }));
  rationale.push(rationaleLine("STOP_POLICY", { stopPolicyId }));
  if ([exposure.plannedHighSpeedExposureM, exposure.totalRunningDistanceM].some((e) => e.source === "ESTIMATED" || e.lower === null)) {
    rationale.push(rationaleLine("EXPOSURE_ESTIMATED"));
  }
  rationale.push(rationaleLine("PHASE_NOT_EVALUATED"), rationaleLine("WEEKLY_NOT_EVALUATED"));
  rationale.push(...readinessPlan.rationale);

  const candidate = {
    schemaVersion: 1,
    method,
    templateId: request.selection.templateId,
    recoveryStructure,
    tier: profile.envelopeTier,
    sets: counts.sets,
    repsPerSet: counts.repsPerSet,
    rep,
    rest,
    intensity: { reference: plan.reference, target },
    exposure,
    stopPolicyId,
    monitoringSnapshot,
    confidence: { prescription: confidence.prescription, directness: confidence.directness, inputData: plan.inputData },
    readinessApplied: readinessPlan.applied,
    safetyOutcome: readinessPlan.safetyOutcome,
    findings,
    rationale,
    ruleSet: { version: ruleSet.ruleSetVersion, contentHash, status: ruleSet.status },
    generatedBy: generationRecordFor(request.actor),
    // [R9] 週次文脈用の MethodMeta のコピー（metadata のみ。量・強度の計算には使わない）
    loadSnapshot: { loadClass: methodMeta.loadClass, weeklyLoadCategory: methodMeta.weeklyLoadCategory },
    // [R10-B1] PlanRequest.positionPreference のコピー（他の入力から復元できない唯一のフィールド）
    planningControls: { positionPreference: request.positionPreference },
  };

  const parsed = runningPrescriptionSchema.safeParse(candidate);
  if (!parsed.success) {
    return blocked(
      parsed.error.issues.map((issue) =>
        itemFinding("INTERNAL_PRESCRIPTION_INVALID", "BLOCK", { metric: `${issue.path.join(".")}: ${issue.message}` }),
      ),
    );
  }
  const problems = validatePrescriptionAgainstRuleSet(parsed.data, ruleSet, contentHash);
  if (problems.length > 0) {
    return blocked(problems.map((p) => itemFinding("INTERNAL_PRESCRIPTION_INVALID", "BLOCK", { metric: p })));
  }

  // ---- step 14: session aggregation + 出力 plausibility ----
  // コーチ編集・override をすべて適用した後の最終値を見る「最後の防波堤」。
  // plausibility は入力の訂正・確認の層なので、どの override でも解除できない（§8.5）。
  const itemPlausibility = checkOutputPlausibility(parsed.data, ruleSet);
  const prescription =
    itemPlausibility.findings.length === 0
      ? parsed.data
      : runningPrescriptionSchema.parse({ ...parsed.data, findings: [...parsed.data.findings, ...itemPlausibility.findings] });

  // otherItems は「現在計画中の項目を含まない」契約。ここで自分を1回だけ足す（二重計上しない）。
  const aggregate = evaluateSessionAggregation([...request.menuContext.otherItems, { kind: "RUNNING_V2", prescription }], {
    ruleSet,
    tier: profile.envelopeTier,
    availableMinutes: request.menuContext.availableMinutes,
    // [R7] plannedDate が無ければ大会当日かどうか評価できない（false と推測しない）。
    competitionDay: phaseCompetition.competitionDay ?? "NOT_EVALUATED",
    mode: "PLANNING",
  });
  const sessionPlausibility = checkSessionPlausibility(aggregate.totalRunningDistanceM, ruleSet);
  const sessionFindings: Finding[] = [...aggregate.findings, ...sessionPlausibility.findings];

  // Keep every blocker, including other hard gates. Application review satisfaction
  // must bind individual current findings and check all remaining gates before saving.
  if (canCollect && prescription.findings.some((finding) => finding.severity === "BLOCK" && canDefer(finding))) {
    return { status: "REVIEW_CANDIDATE", prescription, sessionFindings };
  }

  if (itemPlausibility.blocked) return blocked(itemPlausibility.findings.filter((f) => f.severity === "BLOCK"));
  if (sessionPlausibility.blocked) return blocked(sessionFindings);
  if (itemPlausibility.requiresConfirmation || sessionPlausibility.requiresConfirmation) {
    // [R10-B4A] 確認 contract（R6 integration policy の置き換え）: REQUIRE_CONFIRMATION は、COACH が
    // その code を `confirmedFindingCodes` で明示確認したときだけ通す（code 単位）。override では突破させない。
    // 確認済みでも Finding は消さない（item は prescription.findings、session は sessionFindings に残る）。
    const confirmationFindings = [
      ...itemPlausibility.findings.filter((f) => f.severity === "REQUIRE_CONFIRMATION"),
      ...sessionPlausibility.findings.filter((f) => f.severity === "REQUIRE_CONFIRMATION"),
    ];
    const confirmed = new Set(request.actor.kind === "COACH" ? request.confirmedFindingCodes : []);
    if (!confirmationFindings.every((f) => confirmed.has(f.code))) {
      const findings = [...contextFindings, ...confirmationFindings];
      return { status: "BLOCKED", findings, confirmationRequired: { requiredFindingCodes: requiredConfirmationCodes(findings) } };
    }
  }
  if (request.actor.kind !== "COACH" && sessionFindings.some((f) => f.severity === "BLOCK_AUTOGEN")) {
    // AI / SYSTEM はメニュー全体の合計が上限を超えた状態で自動生成できない（コーチは手動で継続可能）。
    return blocked(sessionFindings);
  }

  return { status: "OK", prescription, sessionFindings };
}
