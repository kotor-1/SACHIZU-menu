/**
 * Running Prescription Engine v2 — R10-B3 RunningItemEditor の view model（server / pure）。
 *
 * - 推奨範囲 / コーチ調整可能範囲 / 安全上の範囲は、保存済み処方の FieldValue（plan 時点の snapshot）から表示する。
 *   FieldValue を持たない aggregate 型の field（totalReps / attempts / sessionVolumeM / flyVolumeM / vdecPercent /
 *   intensityPercent / decelerationM）の範囲は、**保存時と exact identity が一致した RuleSet** の Envelope から
 *   domain の `selectEnvelope()` で引く（active RuleSet で代用しない。一致しなければ出さない）。
 * - 現在値は「画面に表示できる値」だけ。totalReps / attempts は構造化 RationaleLine `COUNTS_RESOLVED.params.totalReps`
 *   から読み、範囲の中央値や他の量からの推定はしない。
 * - [R10-B4A] 直接編集できるのは、処方の中に一意に対応する一次 FieldValue を持つ field だけ。aggregate 型
 *   （`AGGREGATE_ENVELOPE_FIELDS`）・Envelope セルからだけ表示する field・助走距離は `readOnly=true`（現在値と範囲の
 *   表示だけで、編集・例外設定のボタンは出さない）。
 * - `editable` / `overrideLayers` は表示上の目安であり、最終的な可否は domain の再計画が検証する。
 *   override に二重確認（confirmedTwice）が必要かは、presentation で規則を複製せず domain の
 *   `coachOverrideSchema` へ問い合わせて決める。
 */
import { AGGREGATE_ENVELOPE_FIELDS, coachOverrideSchema, type CoachOverride, type EligibilityReason } from "@/domain/running/planning/schema";
import { selectEnvelope } from "@/domain/running/planning/envelope";
import type { EnvelopeCell, EnvelopeField } from "@/domain/running/rules/schema";
import { createCoachActor } from "@/domain/running/types/actor";
import type { FieldValue, RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { RunningSelection } from "@/domain/running/types/template";
import type {
  EditableFieldDto,
  EditableFieldKey,
  EligibilityOverrideOptionDto,
  OverrideLayer,
  OverrideLayerOptionDto,
  RangeDto,
  RunningItemEditorDto,
} from "./dto";
import { eligibilityReasonMessageJa } from "./finding-messages";
import { formatRangeJa, formatValueJa } from "./format";
import { EDITABLE_FIELD_DISPLAY, OVERRIDE_LAYER_LABEL_JA, UNIT_LABEL_JA, VALUE_ORIGIN_LABEL_JA } from "./labels";
import type { ExactRuleSetLookup } from "./provenance";

// ---------------------------------------------------------------------------
// domain への問い合わせ（confirmedTwice が必要か）
// ---------------------------------------------------------------------------

const PROBE_ACTOR = createCoachActor("presentation-probe");
const PROBE_AT = "2000-01-01T00:00:00+00:00";
/** reason の最小文字数に引っかからない十分な長さ（schema の他の検証に埋もれさせないため）。 */
const PROBE_REASON = "表示用の確認".repeat(40);

/** domain の CoachOverride schema が、この target に `confirmedTwice=true` を要求するか。 */
export function overrideRequiresDoubleConfirmation(target: CoachOverride["target"]): boolean {
  const probe = coachOverrideSchema.safeParse({
    target,
    ...(target.kind === "FIELD" ? { newValue: 1 } : {}),
    reason: PROBE_REASON,
    confirmedTwice: false,
    actor: PROBE_ACTOR,
    at: PROBE_AT,
  });
  return !probe.success && probe.error.issues.some((issue) => issue.path[0] === "confirmedTwice");
}

// ---------------------------------------------------------------------------
// field
// ---------------------------------------------------------------------------

type Ranges = {
  recommended: { min: number; max: number } | null;
  coachEditable: { min: number; max: number } | null;
  hardSafety: { min: number; max: number } | null;
};

function rangeDto(range: { min: number; max: number } | null, key: EditableFieldKey): RangeDto | null {
  return range === null ? null : { min: range.min, max: range.max, label: formatRangeJa(range, EDITABLE_FIELD_DISPLAY[key].unit) };
}

function overrideLayersFor(field: EditableFieldKey, ranges: Ranges): OverrideLayerOptionDto[] {
  if (field === "approachDistanceM" || ranges.coachEditable === null) return [];
  const layers: OverrideLayer[] = ranges.hardSafety === null ? ["COACH_EDITABLE"] : ["COACH_EDITABLE", "HARD_SAFETY"];
  return layers.map((layer) => ({
    layerInternal: layer,
    label: OVERRIDE_LAYER_LABEL_JA[layer],
    requiresDoubleConfirmation: overrideRequiresDoubleConfirmation({ kind: "FIELD", field: field as EnvelopeField, layer }),
  }));
}

export const AGGREGATE_FIELD_READ_ONLY_REASON_JA = "他の値から決まる合計・制約の値のため、直接は変更できません。";
export const ENVELOPE_ONLY_FIELD_READ_ONLY_REASON_JA = "処方の中に対応する入力値が無いため、この画面では変更できません。";
export const APPROACH_DISTANCE_READ_ONLY_REASON_JA = "助走距離の推奨範囲・コーチ調整可能範囲がルールセットに無いため、この画面では変更できません。";

function fieldDto(args: {
  key: EditableFieldKey;
  currentValue: number | null;
  origin: FieldValue["origin"] | null;
  ranges: Ranges;
  /** [R10-B4A] 表示専用（直接編集・例外設定のボタンを出さない）にする理由。 */
  readOnlyReason?: string;
  emptyValueLabel?: string;
}): EditableFieldDto {
  const { key, currentValue, origin, ranges } = args;
  const display = EDITABLE_FIELD_DISPLAY[key];
  const readOnly = args.readOnlyReason !== undefined;
  const fixed = origin === "TEMPLATE_FIXED" || origin === "STRUCTURAL_FIXED";
  const notEditableReason =
    args.readOnlyReason !== undefined
      ? args.readOnlyReason
      : origin === "TEMPLATE_FIXED"
        ? "練習の型で決まっている値です。"
        : origin === "STRUCTURAL_FIXED"
          ? "セットの区切りを表すための値のため、ここでは変更できません。"
          : currentValue === null
            ? "現在の値を表示できないため、この画面では変更できません。"
            : null;
  return {
    keyInternal: key,
    label: display.label,
    unitLabel: UNIT_LABEL_JA[display.unit],
    currentValue,
    currentValueLabel: currentValue === null ? (args.emptyValueLabel ?? "表示できません") : formatValueJa(currentValue, display.unit),
    originLabel: origin === null ? null : VALUE_ORIGIN_LABEL_JA[origin],
    recommended: rangeDto(ranges.recommended, key),
    coachEditable: rangeDto(ranges.coachEditable, key),
    hardSafety: rangeDto(ranges.hardSafety, key),
    editable: notEditableReason === null,
    readOnly,
    notEditableReason,
    overrideLayers: fixed || readOnly ? [] : overrideLayersFor(key, ranges),
  };
}

function fromFieldValue(key: EditableFieldKey, fv: FieldValue): EditableFieldDto {
  return fieldDto({
    key,
    currentValue: fv.value,
    origin: fv.origin,
    ranges: { recommended: fv.recommended, coachEditable: fv.coachEditable, hardSafety: fv.hardSafety },
  });
}

/**
 * Envelope セルからの表示（一次 FieldValue を持たない field）。[R10-B4A] 直接編集できるのは処方の中に一意に対応する
 * 一次 FieldValue だけなので、ここから作る field は常に read-only（aggregate 型は理由を分けて示す）。
 */
function fromCell(key: EnvelopeField, cell: EnvelopeCell, currentValue: number | null): EditableFieldDto {
  const aggregate = (AGGREGATE_ENVELOPE_FIELDS as readonly string[]).includes(key);
  return fieldDto({
    key,
    currentValue,
    origin: null,
    ranges: { recommended: cell.recommended, coachEditable: cell.coachEditable, hardSafety: cell.hardSafety },
    readOnlyReason: aggregate ? AGGREGATE_FIELD_READ_ONLY_REASON_JA : ENVELOPE_ONLY_FIELD_READ_ONLY_REASON_JA,
  });
}

/** 構造化 RationaleLine `COUNTS_RESOLVED.params.totalReps`（plan 時点で解決した総本数）。 */
function resolvedTotalRepsOf(p: RunningPrescriptionValue): number | null {
  const value = p.rationale.find((l) => l.code === "COUNTS_RESOLVED")?.params?.totalReps;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 数値の強度目標が1点（lower === upper）のときだけ現在値として扱う（範囲を中央値にしない）。 */
function singlePercentTargetOf(p: RunningPrescriptionValue): number | null {
  const t = p.intensity.target;
  return t !== null && t.unit === "percent" && t.lower !== null && t.lower === t.upper ? t.lower : null;
}

function exactEnvelopeFields(p: RunningPrescriptionValue, lookup: ExactRuleSetLookup): Partial<Record<EnvelopeField, EnvelopeCell>> | null {
  if (lookup.status !== "OK") return null;
  const selected = selectEnvelope(lookup.ruleSet, { method: p.method, templateId: p.templateId } as RunningSelection, p.tier, p.recoveryStructure);
  return selected.ok ? selected.envelope.fields : null;
}

export function presentEditableFields(p: RunningPrescriptionValue, lookup: ExactRuleSetLookup): EditableFieldDto[] {
  const fields: EditableFieldDto[] = [fromFieldValue("sets", p.sets), fromFieldValue("repsPerSet", p.repsPerSet)];
  const rep = p.rep;
  if (rep.kind === "DISTANCE") fields.push(fromFieldValue("repDistanceM", rep.distanceM));
  if (rep.kind === "FLY") fields.push(fromFieldValue("buildUpM", rep.buildUpDistanceM), fromFieldValue("flyZoneM", rep.flyZoneDistanceM));
  if (rep.kind === "DURATION") fields.push(fromFieldValue("repDurationS", rep.durationS));
  if (rep.kind === "ATTEMPTS") {
    // [R10-B4A] コーチ手入力専用の値（§7.4 R2 errata）。編集用の EnvelopeCell（推奨 / コーチ調整可能範囲）が RuleSet に
    // 無く、Action / Provenance.coachEdits も対応していないため表示専用（APPROACH_DISTANCE_EDIT_SOURCE_MISSING）。
    fields.push(
      fieldDto({
        key: "approachDistanceM",
        currentValue: rep.approachDistanceM?.value ?? null,
        origin: null,
        ranges: { recommended: null, coachEditable: null, hardSafety: null },
        readOnlyReason: APPROACH_DISTANCE_READ_ONLY_REASON_JA,
        emptyValueLabel: "未入力",
      }),
    );
  }
  fields.push(fromFieldValue("repRestS", p.rest.repRestS));
  if (p.rest.setRestS !== null) fields.push(fromFieldValue("setRestS", p.rest.setRestS));
  if (p.rest.intraRepRestS !== null) fields.push(fromFieldValue("intraRepRestS", p.rest.intraRepRestS));

  const cells = exactEnvelopeFields(p, lookup);
  if (cells !== null) {
    const totalReps = resolvedTotalRepsOf(p);
    if (rep.kind === "FLY" && cells.decelerationM) fields.push(fromCell("decelerationM", cells.decelerationM, rep.decelerationDistanceM));
    if (cells.totalReps) fields.push(fromCell("totalReps", cells.totalReps, totalReps));
    if (cells.attempts) fields.push(fromCell("attempts", cells.attempts, totalReps));
    if (cells.sessionVolumeM) fields.push(fromCell("sessionVolumeM", cells.sessionVolumeM, null));
    if (cells.flyVolumeM) fields.push(fromCell("flyVolumeM", cells.flyVolumeM, null));
    if (cells.intensityPercent) fields.push(fromCell("intensityPercent", cells.intensityPercent, singlePercentTargetOf(p)));
    if (cells.vdecPercent) fields.push(fromCell("vdecPercent", cells.vdecPercent, null));
  }
  return fields;
}

export function presentEligibilityOverrides(reasons: readonly EligibilityReason[]): EligibilityOverrideOptionDto[] {
  const seen = new Set<string>();
  const options: EligibilityOverrideOptionDto[] = [];
  for (const reason of reasons) {
    if (reason.overrideAllowed !== true || reason.ruleId === null || seen.has(reason.ruleId)) continue;
    seen.add(reason.ruleId);
    options.push({
      ruleIdInternal: reason.ruleId,
      message: eligibilityReasonMessageJa(reason.code),
      requiresDoubleConfirmation: overrideRequiresDoubleConfirmation({ kind: "ELIGIBILITY", ruleId: reason.ruleId }),
    });
  }
  return options;
}

/**
 * [R10-B4A.2] 保存済みのコーチ入力目標スプリット。区間の目標タイムが1点（lower === upper）で表せるときだけ exact な値を返す
 * （範囲を中央値にしない）。受け付け可否は保存時と一致した RuleSet の MethodMeta から読む（確認できなければ null）。
 */
function presentTargetSplit(p: RunningPrescriptionValue, lookup: ExactRuleSetLookup): RunningItemEditorDto["targetSplit"] {
  const ref = p.intensity.reference;
  const current =
    ref.kind === "TARGET_SPLIT" && ref.segments.every((s) => s.targetS.lower !== null && s.targetS.lower === s.targetS.upper)
      ? ref.segments.map((s) => ({ distanceM: s.distanceM, targetTimeS: s.targetS.lower as number }))
      : null;
  const acceptsInput =
    lookup.status === "OK"
      ? ((lookup.ruleSet.methods.find((m) => m.method === p.method)?.allowedIntensityReferences as readonly string[] | undefined)?.includes("TARGET_SPLIT") ?? false)
      : null;
  return { current, acceptsInput };
}

export function presentEditor(
  p: RunningPrescriptionValue,
  lookup: ExactRuleSetLookup,
  eligibilityReasons: readonly EligibilityReason[] = [],
): RunningItemEditorDto {
  return {
    fields: presentEditableFields(p, lookup),
    eligibilityOverrides: presentEligibilityOverrides(eligibilityReasons),
    targetSplit: presentTargetSplit(p, lookup),
  };
}
