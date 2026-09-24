/**
 * Running Prescription Engine v2 — §9.2 step 12: VALUE PLACEMENT（§7.3, §9.3, §9.4）。
 *
 * - position → 値は「範囲内の位置指定」であり、量への乗数ではない（係数・倍率を持たない）。
 * - 値の由来（FieldValue.origin）と位置（FieldValue.position）は別概念。position を持つのは
 *   エンジンが recommended 内の位置で置いた値（ENGINE_POSITIONED）だけ。
 * - rest は Envelope の repRestS / setRestS / intraRepRestS から §9.3 の位置で置くだけ。
 *   距離×秒・年齢/性別/期分けの係数などの計算式は持たない。rest の位置は常に MIDDLE 以上で、
 *   低 confidence・LOWER 希望・練習時間の不足によって短くしない。
 * - 数値の範囲はすべて RuleSet の EnvelopeCell から読む（TS に推奨値を書かない）。
 */
import type { EnvelopeCell, EnvelopeField } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { Unit } from "../types/primitives";
import type { FieldValue, PrescriptionConfidence, RangePosition, RestPlan, ValueOrigin } from "../types/prescription";
import { itemFinding, type CoachFieldEdit, type CoachOverride, type PlanRequest } from "./schema";

// ---------------------------------------------------------------------------
// position（§9.3）
// ---------------------------------------------------------------------------

/** 互換のための別名（§7.3 の RangePosition）。 */
export type PlacedPosition = RangePosition;

const POSITION_ORDER: Record<RangePosition, number> = { LOWER_BOUND: 0, LOWER_HALF: 1, MIDDLE: 2, UPPER_HALF: 3 };
const POSITION_FRACTION: Record<RangePosition, number> = { LOWER_BOUND: 0, LOWER_HALF: 0.25, MIDDLE: 0.5, UPPER_HALF: 0.75 };

/** §9.3「未指定の既定」。 */
export const BASE_POSITION: RangePosition = "MIDDLE";

/**
 * rest 系フィールドの既定位置。§9.3 により常に MIDDLE 以上。
 * confidence・positionPreference・eligibility の下半分制限は rest に適用しない（レストは短くしない）。
 * [R5] readiness の `INCREASE_REST` だけが `UPPER_HALF` へ引き上げる（下げる方向へは動かせない）。
 */
export const REST_POSITION: RangePosition = "MIDDLE";

/** rest 位置を既定（MIDDLE）以上に保ったまま引き上げる。MIDDLE 未満の指定は無視する。 */
export function raisedRestPosition(requested: RangePosition | null): RangePosition {
  if (requested === null) return REST_POSITION;
  return isAtOrAbove(requested, REST_POSITION) ? requested : REST_POSITION;
}

/** 候補のうち最も低い位置を採用する（§9.3）。null は「この由来による上限なし」。 */
export function lowestPosition(...candidates: readonly (RangePosition | null)[]): RangePosition {
  return candidates.reduce<RangePosition>(
    (lowest, c) => (c !== null && POSITION_ORDER[c] < POSITION_ORDER[lowest] ? c : lowest),
    "UPPER_HALF",
  );
}

export function isAtOrAbove(position: RangePosition, floor: RangePosition): boolean {
  return POSITION_ORDER[position] >= POSITION_ORDER[floor];
}

export function isAtOrBelow(position: RangePosition, cap: RangePosition): boolean {
  return POSITION_ORDER[position] <= POSITION_ORDER[cap];
}

/** §9.3: AI/コーチの positionPreference。LOWER=LOWER_HALF、MIDDLE / 未指定=MIDDLE。 */
export function positionFromPreference(preference: PlanRequest["positionPreference"]): RangePosition {
  return preference === "LOWER" ? "LOWER_HALF" : "MIDDLE";
}

/** §5.5: HIGH=上限なし、MODERATE=MIDDLE、LOW / POLICY_ONLY=LOWER_HALF。 */
export function positionCapForConfidence(confidence: PrescriptionConfidence): RangePosition | null {
  switch (confidence) {
    case "HIGH":
      return null;
    case "MODERATE":
      return "MIDDLE";
    case "LOW":
    case "POLICY_ONLY":
      return "LOWER_HALF";
  }
}

// ---------------------------------------------------------------------------
// 値の配置と丸め（§7.3）
// ---------------------------------------------------------------------------

/**
 * - DISTANCE: 50m 以上は 10m、未満は 5m 単位に切り捨て（recommended.min 未満にしない）
 * - REST_SECONDS: 60秒以上は 30秒、未満は 15秒単位。[R4 errata] rest は「最低この時間」なので
 *   **切り上げ**（位置より短くしない）、recommended.max を超える場合は max
 * - REP_DURATION_SECONDS: [R4 errata] 1本の時間（7–15秒等）に 15/30秒単位を当てると範囲が潰れるため
 *   1秒単位で切り捨て（recommended.min 未満にしない）
 * - COUNT: UPPER_HALF のみ四捨五入、それ以外は切り捨て（recommended.min 未満にしない）
 */
export type RoundingKind = "DISTANCE" | "REST_SECONDS" | "REP_DURATION_SECONDS" | "COUNT";

const EPS = 1e-9;

/** 単位換算（分→秒）。rest を生成する係数ではない。 */
const SECONDS_PER_MINUTE = 60;

export function positionPoint(range: { min: number; max: number }, position: RangePosition): number {
  return range.min + (range.max - range.min) * POSITION_FRACTION[position];
}

export function placeValue(range: { min: number; max: number }, position: RangePosition, rounding: RoundingKind): number {
  const raw = positionPoint(range, position);
  switch (rounding) {
    case "DISTANCE": {
      const step = raw >= 50 ? 10 : 5;
      return Math.max(range.min, Math.floor(raw / step + EPS) * step);
    }
    case "REST_SECONDS": {
      const step = raw >= 60 ? 30 : 15;
      return Math.min(range.max, Math.max(range.min, Math.ceil(raw / step - EPS) * step));
    }
    case "REP_DURATION_SECONDS":
      return Math.max(range.min, Math.floor(raw + EPS));
    case "COUNT": {
      const rounded = position === "UPPER_HALF" ? Math.round(raw) : Math.floor(raw + EPS);
      return Math.min(range.max, Math.max(range.min, rounded));
    }
  }
}

function within(value: number, range: { min: number; max: number } | null): boolean {
  return range !== null && value >= range.min - EPS && value <= range.max + EPS;
}

// ---------------------------------------------------------------------------
// コーチ入力（CoachFieldEdit / CoachOverride）の解決
// ---------------------------------------------------------------------------

export type CoachInputs = {
  edits: ReadonlyMap<string, CoachFieldEdit>;
  fieldOverrides: ReadonlyMap<EnvelopeField, CoachOverride>;
  /** 実際に処方へ反映された edit / override の field。未消費のものは build で BLOCKED にする。 */
  consumedEdits: Set<string>;
  /** COACH authority として値を materialize した CoachFieldEdit の field。固定値一致の no-op は含めない。 */
  materializedCoachEdits: Set<string>;
  consumedOverrides: Set<string>;
};

export function createCoachInputs(request: PlanRequest): CoachInputs {
  const edits = new Map<string, CoachFieldEdit>();
  for (const e of request.coachEdits) edits.set(e.field, e);
  const fieldOverrides = new Map<EnvelopeField, CoachOverride>();
  for (const o of request.overrides) {
    if (o.target.kind === "FIELD") fieldOverrides.set(o.target.field, o);
  }
  return { edits, fieldOverrides, consumedEdits: new Set(), materializedCoachEdits: new Set(), consumedOverrides: new Set() };
}

type CoachOrigin = Extract<ValueOrigin, "COACH" | "COACH_OVERRIDE">;

type CoachValue =
  | { kind: "NONE" }
  | { kind: "VALUE"; value: number; origin: CoachOrigin; findings: Finding[] }
  | { kind: "ERROR"; findings: Finding[] };

type CoachValueOptions = { integer: boolean; fixedValue?: number };

/**
 * §7.1 / §8.3:
 *   recommended の外・coachEditable の内 → OK（WARN `OUTSIDE_RECOMMENDED`）
 *   coachEditable の外 → CoachOverride 必須（無ければ BLOCK）
 *   hardSafety の外 → HARD_SAFETY 層の CoachOverride 必須（hardSafety=null は「上限なし」で 0 ではない）
 */
export function resolveCoachValue(field: EnvelopeField, cell: EnvelopeCell, inputs: CoachInputs, options: CoachValueOptions): CoachValue {
  const override = inputs.fieldOverrides.get(field);
  const edit = inputs.edits.get(field);
  const findings: Finding[] = [];

  const invalidNumber = (value: number) =>
    !Number.isFinite(value) || value < 0 || (options.integer && (!Number.isInteger(value) || value < 1));

  if (override) {
    inputs.consumedOverrides.add(field);
    const value = override.newValue as number;
    if (invalidNumber(value)) {
      return { kind: "ERROR", findings: [itemFinding("COACH_EDIT_INVALID", "BLOCK", { metric: field })] };
    }
    if (options.fixedValue !== undefined && value !== options.fixedValue) {
      return { kind: "ERROR", findings: [itemFinding("TEMPLATE_FIXED_FIELD_EDIT", "BLOCK", { metric: field })] };
    }
    if (override.target.kind === "FIELD" && override.target.layer === "HARD_SAFETY") {
      if (cell.hardSafety === null) {
        return { kind: "ERROR", findings: [itemFinding("OVERRIDE_TARGET_INVALID", "BLOCK", { metric: `${field}:HARD_SAFETY(null)` })] };
      }
    } else if (cell.hardSafety !== null && !within(value, cell.hardSafety)) {
      return { kind: "ERROR", findings: [itemFinding("HARD_SAFETY_OVERRIDE_REQUIRED", "BLOCK", { metric: field, limit: cell.hardSafety })] };
    }
    findings.push(itemFinding("COACH_OVERRIDE_APPLIED", "REQUIRE_COACH_REVIEW", { metric: field }));
    if (cell.recommended !== null && !within(value, cell.recommended)) {
      findings.push(itemFinding("OUTSIDE_RECOMMENDED", "WARN", { metric: field, limit: cell.recommended }));
    }
    return { kind: "VALUE", value, origin: "COACH_OVERRIDE", findings };
  }

  if (edit) {
    inputs.consumedEdits.add(field);
    if (edit.unit !== cell.coachEditable.unit || invalidNumber(edit.value)) {
      return { kind: "ERROR", findings: [itemFinding("COACH_EDIT_INVALID", "BLOCK", { metric: field })] };
    }
    if (options.fixedValue !== undefined) {
      if (edit.value === options.fixedValue) return { kind: "NONE" };
      return { kind: "ERROR", findings: [itemFinding("TEMPLATE_FIXED_FIELD_EDIT", "BLOCK", { metric: field })] };
    }
    if (!within(edit.value, cell.coachEditable)) {
      return {
        kind: "ERROR",
        findings: [itemFinding("COACH_EDITABLE_OVERRIDE_REQUIRED", "BLOCK", { metric: field, limit: cell.coachEditable })],
      };
    }
    if (cell.hardSafety !== null && !within(edit.value, cell.hardSafety)) {
      return { kind: "ERROR", findings: [itemFinding("HARD_SAFETY_OVERRIDE_REQUIRED", "BLOCK", { metric: field, limit: cell.hardSafety })] };
    }
    if (cell.recommended !== null && !within(edit.value, cell.recommended)) {
      findings.push(itemFinding("OUTSIDE_RECOMMENDED", "WARN", { metric: field, limit: cell.recommended }));
    }
    inputs.materializedCoachEdits.add(field);
    return { kind: "VALUE", value: edit.value, origin: "COACH", findings };
  }

  return { kind: "NONE" };
}

// ---------------------------------------------------------------------------
// FieldValue の組み立て
// ---------------------------------------------------------------------------

function assertCellUnit(field: string, cell: EnvelopeCell, unit: Unit): void {
  const units = [cell.coachEditable.unit, cell.recommended?.unit, cell.hardSafety?.unit].filter((u) => u !== undefined);
  if (units.some((u) => u !== unit)) {
    throw new Error(`EnvelopeCell ${field} has unit ${cell.coachEditable.unit}, expected ${unit}`);
  }
}

export function fieldValueFromCell<U extends Unit>(
  field: string,
  cell: EnvelopeCell,
  unit: U,
  value: number,
  position: RangePosition | null,
  origin: ValueOrigin,
): FieldValue<U> {
  assertCellUnit(field, cell, unit);
  return {
    value,
    unit,
    recommended: cell.recommended === null ? null : { min: cell.recommended.min, max: cell.recommended.max, unit },
    coachEditable: { min: cell.coachEditable.min, max: cell.coachEditable.max, unit },
    hardSafety: cell.hardSafety === null ? null : { min: cell.hardSafety.min, max: cell.hardSafety.max, unit },
    position,
    origin,
    evidenceIds: [...cell.evidenceIds],
  };
}

export type FieldResolution<U extends Unit> =
  | { ok: true; value: FieldValue<U>; findings: Finding[] }
  | { ok: false; findings: Finding[] };

export type EngineRule =
  | { kind: "PLACE"; position: RangePosition; rounding: RoundingKind }
  /** template が固定する値（§7.3 ①、SessionTemplate.fixedDistanceField）。clamp しない。範囲外は Finding / override。 */
  | { kind: "TEMPLATE_FIXED"; value: number };

/**
 * 1フィールドを「コーチ入力 → template 固定値 → エンジン配置」の順で解決する。
 * recommended=null のセルはエンジンが値を置かない（コーチ入力が無ければ BLOCK。0 を入れない）。
 */
export function resolveEnvelopeField<U extends Unit>(args: {
  field: EnvelopeField;
  unit: U;
  cell: EnvelopeCell;
  inputs: CoachInputs;
  engine: EngineRule;
  integer?: boolean;
}): FieldResolution<U> {
  const { field, unit, cell, inputs, engine } = args;
  const fixedValue = engine.kind === "TEMPLATE_FIXED" ? engine.value : undefined;
  const coach = resolveCoachValue(field, cell, inputs, { integer: args.integer ?? false, fixedValue });
  if (coach.kind === "ERROR") return { ok: false, findings: coach.findings };
  if (coach.kind === "VALUE") {
    return { ok: true, value: fieldValueFromCell(field, cell, unit, coach.value, null, coach.origin), findings: coach.findings };
  }

  if (engine.kind === "TEMPLATE_FIXED") {
    const findings: Finding[] = [];
    if (!within(engine.value, cell.coachEditable)) {
      return {
        ok: false,
        findings: [itemFinding("COACH_EDITABLE_OVERRIDE_REQUIRED", "BLOCK", { metric: `${field}:template`, limit: cell.coachEditable })],
      };
    }
    if (cell.hardSafety !== null && !within(engine.value, cell.hardSafety)) {
      return { ok: false, findings: [itemFinding("HARD_SAFETY_VIOLATION", "BLOCK", { metric: field, limit: cell.hardSafety })] };
    }
    if (cell.recommended === null || !within(engine.value, cell.recommended)) {
      findings.push(
        itemFinding("TEMPLATE_FIXED_OUTSIDE_RECOMMENDED", "WARN", {
          metric: field,
          ...(cell.recommended !== null ? { limit: cell.recommended } : {}),
        }),
      );
    }
    return { ok: true, value: fieldValueFromCell(field, cell, unit, engine.value, null, "TEMPLATE_FIXED"), findings };
  }

  if (cell.recommended === null) {
    return { ok: false, findings: [itemFinding("MANUAL_INPUT_REQUIRED", "BLOCK", { metric: field })] };
  }
  const value = placeValue(cell.recommended, engine.position, engine.rounding);
  return { ok: true, value: fieldValueFromCell(field, cell, unit, value, engine.position, "ENGINE_POSITIONED"), findings: [] };
}

// ---------------------------------------------------------------------------
// 回数の解決（§7.3 ②③）
// ---------------------------------------------------------------------------

export type CountCells = {
  /** totalReps（または EVENT_APPROACH_SPEED の attempts）セル。 */
  total: { field: "totalReps" | "attempts"; cell: EnvelopeCell } | null;
  sets: EnvelopeCell | null;
  repsPerSet: EnvelopeCell | null;
};

export type VolumeConstraint = {
  field: "sessionVolumeM" | "flyVolumeM";
  cell: EnvelopeCell;
  /** 1本あたりの距離（sessionVolumeM は1本の距離、flyVolumeM は fly zone）。 */
  perRepM: number;
} | null;

export type CountResolution =
  | { ok: true; totalReps: number; sets: FieldValue<"sets">; repsPerSet: FieldValue<"reps">; findings: Finding[] }
  | { ok: false; findings: Finding[] };

function descendingRange(hi: number, lo: number): number[] {
  const out: number[] = [];
  for (let v = hi; v >= lo; v--) out.push(v);
  return out;
}

function ascendingRange(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let v = lo; v <= hi; v++) out.push(v);
  return out;
}

/**
 * [R4 errata] RunningPrescription schemaVersion=1 の構造正規化規則: RuleSet に sets セルが無い template
 * （LONG / RESISTED / ASSISTED / EVENT_APPROACH）は、単一 set の表現として sets=1 を origin=STRUCTURAL_FIXED で持つ。
 * training dose の推奨ではなく、sets / repsPerSet 非 null の不変条件を満たすための表現（evidenceIds は空）。
 * RuleSet に sets セルが追加されたら必ずそちらを使う（この関数は呼ばれない）。
 */
export function structuralSingleSet(): FieldValue<"sets"> {
  return {
    value: 1,
    unit: "sets",
    recommended: { min: 1, max: 1, unit: "sets" },
    coachEditable: { min: 1, max: 1, unit: "sets" },
    hardSafety: null,
    position: null,
    origin: "STRUCTURAL_FIXED",
    evidenceIds: [],
  };
}

/**
 * §7.3 の解決順:
 *   ② totalReps を「reps 範囲（位置上限まで）」かつ「総量（sessionVolumeM / flyVolumeM の位置上限まで）」に
 *      収まる最大値で決める（RuleSet の EligibilityRule.autoGenerationLimits.maxTotalReps も上限に含める）
 *   ③ sets を最小にし、repsPerSet を recommended 内に収める（sets × repsPerSet = totalReps、端数を作らない）
 * totalReps セルを持つ Method では位置上限は totalReps と総量に適用し、sets / repsPerSet は
 * recommended 内の構造的な分解（origin=SOLVER_DERIVED）。totalReps セルを持たない Method（TEMPO / STRIDE）では
 * sets と repsPerSet 自体に位置上限を適用する。解が無ければ ENVELOPE_INFEASIBLE。
 */
export function solveCounts(args: {
  cells: CountCells;
  volume: VolumeConstraint;
  position: RangePosition;
  maxAutoTotalReps: number | null;
  inputs: CoachInputs;
}): CountResolution {
  const { cells, volume, position, maxAutoTotalReps, inputs } = args;
  const findings: Finding[] = [];
  /**
   * [R5 errata] 回数・総量は相互依存する（fixed distance × totalReps × sets × repsPerSet × sessionVolumeM /
   * flyVolumeM × maxTotalReps）。この連立において position=LOWER_BOUND（readiness の USE_LOWER_BOUND）は
   * 「各セルを個別に recommended.min へ固定する」ことではなく、
   * **すべての recommended 制約を満たす実行可能解のうち最小 dose の解を選ぶ**ことを意味する。
   * 探索の向きだけが §7.3 ②（総本数の最大化）と逆になり、制約そのものは一切緩めない
   * （readiness を理由に recommended を下回る値は作らない）。解が無ければ ENVELOPE_INFEASIBLE。
   */
  const lowestFeasible = position === "LOWER_BOUND";

  if (cells.total === null && cells.repsPerSet === null) {
    return { ok: false, findings: [itemFinding("ENVELOPE_INFEASIBLE", "BLOCK_AUTOGEN", { metric: "counts:no-count-cells" })] };
  }

  const coachTotal = cells.total ? resolveCoachValue(cells.total.field, cells.total.cell, inputs, { integer: true }) : ({ kind: "NONE" } as const);
  const coachSets = cells.sets ? resolveCoachValue("sets", cells.sets, inputs, { integer: true }) : ({ kind: "NONE" } as const);
  const coachReps = cells.repsPerSet ? resolveCoachValue("repsPerSet", cells.repsPerSet, inputs, { integer: true }) : ({ kind: "NONE" } as const);
  for (const c of [coachTotal, coachSets, coachReps]) {
    if (c.kind === "ERROR") return { ok: false, findings: c.findings };
    if (c.kind === "VALUE") findings.push(...c.findings);
  }
  const tFixed = coachTotal.kind === "VALUE" ? coachTotal.value : undefined;
  const sFixed = coachSets.kind === "VALUE" ? coachSets.value : undefined;
  const rFixed = coachReps.kind === "VALUE" ? coachReps.value : undefined;
  const totalDeterminedByCoach = tFixed !== undefined || (sFixed !== undefined && rFixed !== undefined);
  // コーチが回数のどれかを明示したら、総量は位置上限ではなく coachEditable で検査する
  // （範囲外は後段で override / WARN）。エンジンが選ぶ残りの回数には位置上限が適用される。
  const anyCountFromCoach = tFixed !== undefined || sFixed !== undefined || rFixed !== undefined;

  // sets の候補
  let setsCandidates: number[];
  if (sFixed !== undefined) {
    setsCandidates = [sFixed];
  } else if (cells.sets) {
    const rec = cells.sets.recommended;
    if (rec === null) return { ok: false, findings: [itemFinding("MANUAL_INPUT_REQUIRED", "BLOCK", { metric: "sets" })] };
    setsCandidates = ascendingRange(rec.min, cells.total !== null || lowestFeasible ? rec.max : placeValue(rec, position, "COUNT"));
  } else {
    setsCandidates = [1];
  }

  // repsPerSet の候補（null = セルが無く totalReps / sets から構造的に決まる）
  let repsCandidates: number[] | null;
  if (rFixed !== undefined) {
    repsCandidates = [rFixed];
  } else if (cells.repsPerSet) {
    const rec = cells.repsPerSet.recommended;
    if (rec === null) return { ok: false, findings: [itemFinding("MANUAL_INPUT_REQUIRED", "BLOCK", { metric: "repsPerSet" })] };
    repsCandidates = ascendingRange(rec.min, cells.total !== null || lowestFeasible ? rec.max : placeValue(rec, position, "COUNT"));
  } else {
    repsCandidates = null;
  }

  // totalReps の候補（大きい順）
  let totalCandidates: number[];
  if (tFixed !== undefined) {
    totalCandidates = [tFixed];
  } else if (sFixed !== undefined && rFixed !== undefined) {
    totalCandidates = [sFixed * rFixed];
  } else if (cells.total) {
    const rec = cells.total.cell.recommended;
    if (rec === null) {
      return { ok: false, findings: [itemFinding("MANUAL_INPUT_REQUIRED", "BLOCK", { metric: cells.total.field })] };
    }
    let hi = lowestFeasible ? rec.max : placeValue(rec, position, "COUNT");
    if (maxAutoTotalReps !== null) hi = Math.min(hi, maxAutoTotalReps);
    totalCandidates = lowestFeasible ? ascendingRange(rec.min, hi) : descendingRange(hi, rec.min);
  } else {
    const products = new Set<number>();
    for (const s of setsCandidates) for (const r of repsCandidates ?? []) products.add(s * r);
    totalCandidates = [...products].sort((a, b) => (lowestFeasible ? a - b : b - a));
  }

  let volumeBounds: { min: number; max: number } | null = null;
  if (volume && totalDeterminedByCoach) {
    volumeBounds = null; // 総本数はコーチが決めた。coachEditable / override の検査は後段
  } else if (volume && anyCountFromCoach) {
    volumeBounds = { min: volume.cell.coachEditable.min, max: volume.cell.coachEditable.max };
    if (inputs.fieldOverrides.has(volume.field)) volumeBounds = null; // override の newValue と一致するかは後段で検査
  } else if (volume) {
    const rec = volume.cell.recommended;
    if (rec !== null) {
      // LOWER_BOUND でも総量の recommended 範囲はそのまま使う（下限を割り込まない）。
      // 探索が昇順になるため、この範囲を満たす最小の総量が選ばれる。
      volumeBounds = lowestFeasible ? { min: rec.min, max: rec.max } : { min: rec.min, max: positionPoint(rec, position) };
    }
  }

  let solution: { t: number; s: number; r: number } | null = null;
  search: for (const t of totalCandidates) {
    if (!Number.isInteger(t) || t < 1) continue;
    if (volumeBounds && volume && !within(t * volume.perRepM, volumeBounds)) continue;
    for (const s of setsCandidates) {
      if (t % s !== 0) continue;
      const r = t / s;
      if (repsCandidates !== null && !repsCandidates.includes(r)) continue;
      solution = { t, s, r };
      break search;
    }
  }
  if (!solution) {
    return {
      ok: false,
      findings: [
        itemFinding("ENVELOPE_INFEASIBLE", "BLOCK_AUTOGEN", {
          metric: `counts:position=${position}${volume ? `,perRepM=${volume.perRepM}` : ""}`,
        }),
      ],
    };
  }
  const { t, s, r } = solution;

  // 総量のコーチ入力検査（総量はコーチが直接入力するフィールドではなく、回数×距離の結果）
  if (volume) {
    const total = t * volume.perRepM;
    if (inputs.edits.has(volume.field)) {
      inputs.consumedEdits.add(volume.field);
      return { ok: false, findings: [itemFinding("COACH_EDIT_INVALID", "BLOCK", { metric: `${volume.field}:derived` })] };
    }
    if (!within(total, volume.cell.coachEditable)) {
      const ov = inputs.fieldOverrides.get(volume.field);
      if (!ov || ov.newValue !== total) {
        return {
          ok: false,
          findings: [itemFinding("COACH_EDITABLE_OVERRIDE_REQUIRED", "BLOCK", { metric: volume.field, limit: volume.cell.coachEditable })],
        };
      }
      inputs.consumedOverrides.add(volume.field);
      findings.push(itemFinding("COACH_OVERRIDE_APPLIED", "REQUIRE_COACH_REVIEW", { metric: volume.field }));
    }
    if (volume.cell.recommended !== null && !within(total, volume.cell.recommended)) {
      findings.push(itemFinding("OUTSIDE_RECOMMENDED", "WARN", { metric: volume.field, limit: volume.cell.recommended }));
    }
  }

  // sets × repsPerSet から決まった総本数も totalReps セルの coachEditable を超えられない
  if (cells.total && tFixed === undefined && totalDeterminedByCoach) {
    const cell = cells.total.cell;
    if (!within(t, cell.coachEditable)) {
      const ov = inputs.fieldOverrides.get(cells.total.field);
      if (!ov || ov.newValue !== t) {
        return {
          ok: false,
          findings: [itemFinding("COACH_EDITABLE_OVERRIDE_REQUIRED", "BLOCK", { metric: cells.total.field, limit: cell.coachEditable })],
        };
      }
      inputs.consumedOverrides.add(cells.total.field);
      findings.push(itemFinding("COACH_OVERRIDE_APPLIED", "REQUIRE_COACH_REVIEW", { metric: cells.total.field }));
    } else if (cell.recommended !== null && !within(t, cell.recommended)) {
      findings.push(itemFinding("OUTSIDE_RECOMMENDED", "WARN", { metric: cells.total.field, limit: cell.recommended }));
    }
  }

  if (maxAutoTotalReps !== null && totalDeterminedByCoach && t > maxAutoTotalReps) {
    findings.push(itemFinding("AUTO_GENERATION_LIMIT_EXCEEDED", "REQUIRE_COACH_REVIEW", { metric: `totalReps>${maxAutoTotalReps}` }));
  }

  // sets FieldValue
  const sets: FieldValue<"sets"> = cells.sets
    ? coachSets.kind === "VALUE"
      ? fieldValueFromCell("sets", cells.sets, "sets", s, null, coachSets.origin)
      : fieldValueFromCell("sets", cells.sets, "sets", s, null, "SOLVER_DERIVED")
    : structuralSingleSet();

  // repsPerSet FieldValue
  let repsPerSet: FieldValue<"reps">;
  if (cells.repsPerSet) {
    repsPerSet =
      coachReps.kind === "VALUE"
        ? fieldValueFromCell("repsPerSet", cells.repsPerSet, "reps", r, null, coachReps.origin)
        : fieldValueFromCell("repsPerSet", cells.repsPerSet, "reps", r, null, "SOLVER_DERIVED");
  } else {
    // [R4 errata] repsPerSet セルが無い Method は totalReps（attempts）セルの範囲で表す（構造正規化規則）。
    const total = cells.total as NonNullable<CountCells["total"]>;
    if (s === 1 && coachTotal.kind === "VALUE") {
      repsPerSet = fieldValueFromCell(total.field, total.cell, "reps", r, null, coachTotal.origin);
    } else if (s === 1) {
      repsPerSet = fieldValueFromCell(total.field, total.cell, "reps", r, null, "SOLVER_DERIVED");
    } else if (within(r, total.cell.coachEditable)) {
      // sets > 1（コーチが sets を入力）: 1セットあたりの本数は総本数 ÷ sets の表現
      repsPerSet = fieldValueFromCell(total.field, total.cell, "reps", r, null, "STRUCTURAL_FIXED");
      if (!within(r, total.cell.recommended)) {
        findings.push(itemFinding("STRUCTURAL_VALUE_OUTSIDE_RECOMMENDED", "WARN", { metric: "repsPerSet" }));
      }
    } else {
      return {
        ok: false,
        findings: [itemFinding("COACH_EDITABLE_OVERRIDE_REQUIRED", "BLOCK", { metric: "repsPerSet:structural", limit: total.cell.coachEditable })],
      };
    }
  }

  return { ok: true, totalReps: t, sets, repsPerSet, findings };
}

// ---------------------------------------------------------------------------
// Rest（§9.4）
// ---------------------------------------------------------------------------

export type RestResolution =
  | { ok: true; rest: RestPlan; minimumSecondsLowerBound: number; findings: Finding[] }
  | { ok: false; findings: Finding[] };

/**
 * Envelope の rest セルから MIDDLE（以上）で置くだけ。式は持たない。
 *
 * [R4 errata] feasibility（R4 と R6 の責務境界）: R4 は「mandatory な rest（＋時間が確定している走行時間）だけで
 * availableMinutes を明らかに超える」ときだけ `EXCEEDS_AVAILABLE_TIME` を出す。移動・準備・他の項目を含む総所要時間は
 * R4 では確定できないため、収まりそうでも `OK` とは断定せず `UNKNOWN`（総所要時間の評価は R6）。
 * rest を時間に合わせて短くすることはしない。
 */
export function resolveRestPlan(args: {
  cells: { repRestS: EnvelopeCell | null; setRestS: EnvelopeCell | null; intraRepRestS: EnvelopeCell | null };
  sets: number;
  totalReps: number;
  /** LONG INCOMPLETE の分割区間数（それ以外は 1）。 */
  segmentsPerRep: number;
  needsIntraRepRest: boolean;
  /** 1本あたりの走行時間の下限（DURATION rep の時間・TARGET_SPLIT の目標下限の合計）。不明なら null。 */
  runningSecondsPerRepLowerBound: number | null;
  availableMinutes: number | null;
  inputs: CoachInputs;
  /** [R5] readiness の INCREASE_REST（UPPER_HALF）。null / 未指定は既定の MIDDLE。 */
  restPosition?: RangePosition | null;
}): RestResolution {
  const { cells, sets, totalReps, segmentsPerRep, needsIntraRepRest, availableMinutes, inputs } = args;
  const restPosition = raisedRestPosition(args.restPosition ?? null);
  const findings: Finding[] = [];

  if (!cells.repRestS) {
    return { ok: false, findings: [itemFinding("ENVELOPE_INFEASIBLE", "BLOCK_AUTOGEN", { metric: "repRestS:missing-cell" })] };
  }
  const repRest = resolveEnvelopeField({
    field: "repRestS",
    unit: "s",
    cell: cells.repRestS,
    inputs,
    engine: { kind: "PLACE", position: restPosition, rounding: "REST_SECONDS" },
  });
  if (!repRest.ok) return repRest;
  findings.push(...repRest.findings);

  let setRest: FieldValue<"s"> | null = null;
  const setRestTouched = inputs.edits.has("setRestS") || inputs.fieldOverrides.has("setRestS");
  if (cells.setRestS && (sets > 1 || setRestTouched)) {
    const resolved = resolveEnvelopeField({
      field: "setRestS",
      unit: "s",
      cell: cells.setRestS,
      inputs,
      engine: { kind: "PLACE", position: restPosition, rounding: "REST_SECONDS" },
    });
    if (!resolved.ok) return resolved;
    findings.push(...resolved.findings);
    setRest = resolved.value;
  } else if (!cells.setRestS && sets > 1) {
    findings.push(itemFinding("SET_REST_NOT_DEFINED", "INFO", { metric: "setRestS" }));
  }

  let intraRest: FieldValue<"s"> | null = null;
  if (needsIntraRepRest) {
    if (!cells.intraRepRestS) {
      return { ok: false, findings: [itemFinding("ENVELOPE_INFEASIBLE", "BLOCK_AUTOGEN", { metric: "intraRepRestS:missing-cell" })] };
    }
    const resolved = resolveEnvelopeField({
      field: "intraRepRestS",
      unit: "s",
      cell: cells.intraRepRestS,
      inputs,
      engine: { kind: "PLACE", position: restPosition, rounding: "REST_SECONDS" },
    });
    if (!resolved.ok) return resolved;
    findings.push(...resolved.findings);
    intraRest = resolved.value;
  }

  // mandatory rest: セット内の本間 (totalReps − sets) + セット間 (sets − 1) + 分割走の区間休息
  const betweenSetsRest = setRest ? setRest.value : repRest.value.value;
  const restSeconds =
    (totalReps - sets) * repRest.value.value +
    (sets - 1) * betweenSetsRest +
    (intraRest ? intraRest.value * (segmentsPerRep - 1) * totalReps : 0);
  const minimumSecondsLowerBound = restSeconds + (args.runningSecondsPerRepLowerBound ?? 0) * totalReps;

  let feasibility: RestPlan["feasibility"] = "UNKNOWN";
  if (availableMinutes !== null && minimumSecondsLowerBound > availableMinutes * SECONDS_PER_MINUTE) {
    feasibility = "EXCEEDS_AVAILABLE_TIME";
    findings.push(itemFinding("REST_INFEASIBLE_FOR_PRACTICE", "WARN", { metric: "minimumSecondsLowerBound" }));
  }

  return {
    ok: true,
    rest: { repRestS: repRest.value, setRestS: setRest, intraRepRestS: intraRest, displayAsFloor: true, feasibility },
    minimumSecondsLowerBound,
    findings,
  };
}
