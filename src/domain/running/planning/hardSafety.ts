/**
 * Running Prescription Engine v2 — §9.2 step 13: HARD SAFETY RE-CHECK。
 *
 * coach edit / override を適用した後の最終値を、FieldValue ごとに再検証する:
 *   - coachEditable の外 → 対応する FIELD CoachOverride（origin=COACH_OVERRIDE）が必須
 *   - hardSafety の外 → HARD_SAFETY 層の CoachOverride（confirmedTwice=true）が必須
 *     （hardSafety=null は「出典のある上限が無い」であり 0 や recommended.max に読み替えない）
 *   - recommended=null の手動専用セルにエンジンが値を置いていないこと
 *   - eligibility の override が、override 可能な規則にだけ使われていること
 * rs-2026.09.0 の EnvelopeCell には `nonOverridable` 属性が無いため、数値の hardSafety は
 * すべて HARD_SAFETY override の対象として扱う（override 不可の規則は eligibility 側で強制済み）。
 */
import type { Finding } from "../types/findings";
import type { FieldValue } from "../types/prescription";
import type { Unit } from "../types/primitives";
import { itemFinding, type CoachOverride } from "./schema";

export type FieldValueRecord = {
  /** override を照合するための Envelope field 名（repsPerSet が totalReps セル由来なら "totalReps"）。 */
  field: string;
  fieldValue: FieldValue<Unit>;
};

function within(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min - 1e-9 && value <= range.max + 1e-9;
}

export function recheckHardSafety(args: {
  records: readonly FieldValueRecord[];
  overrides: readonly CoachOverride[];
  overriddenEligibilityRuleIds: readonly string[];
}): Finding[] {
  const { records, overrides, overriddenEligibilityRuleIds } = args;
  const blocking: Finding[] = [];

  for (const { field, fieldValue: fv } of records) {
    const fieldOverrides = overrides.filter((o) => o.target.kind === "FIELD" && o.target.field === field);
    const hardSafetyOverride = fieldOverrides.some((o) => o.target.kind === "FIELD" && o.target.layer === "HARD_SAFETY" && o.confirmedTwice);

    if (fv.origin === "COACH_OVERRIDE" && fieldOverrides.length === 0) {
      blocking.push(itemFinding("COACH_OVERRIDE_WITHOUT_RECORD", "BLOCK", { metric: field }));
    }
    if (!within(fv.value, fv.coachEditable) && !(fv.origin === "COACH_OVERRIDE" && fieldOverrides.length > 0)) {
      blocking.push(itemFinding("COACH_EDITABLE_OVERRIDE_REQUIRED", "BLOCK", { metric: field, limit: fv.coachEditable }));
    }
    if (fv.hardSafety !== null && !within(fv.value, fv.hardSafety) && !hardSafetyOverride) {
      blocking.push(itemFinding("HARD_SAFETY_VIOLATION", "BLOCK", { metric: field, limit: fv.hardSafety }));
    }
    if (fv.recommended === null && fv.origin !== "COACH" && fv.origin !== "COACH_OVERRIDE") {
      blocking.push(itemFinding("ENGINE_VALUE_FOR_MANUAL_CELL", "BLOCK", { metric: field }));
    }
  }

  for (const ruleId of overriddenEligibilityRuleIds) {
    const ok = overrides.some((o) => o.target.kind === "ELIGIBILITY" && o.target.ruleId === ruleId && o.confirmedTwice);
    if (!ok) blocking.push(itemFinding("ELIGIBILITY_OVERRIDE_WITHOUT_RECORD", "BLOCK", { metric: ruleId }));
  }

  return blocking;
}
