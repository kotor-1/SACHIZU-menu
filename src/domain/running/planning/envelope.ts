/**
 * Running Prescription Engine v2 — §9.2 step 8: POPULATION-SPECIFIC EVIDENCE ENVELOPE。
 *
 * EnvelopeTier × template（× recoveryStructure）に一致する Envelope を RuleSet から選ぶ。
 * RESISTED_SPRINT のように「量の Envelope」と「band ごとの vdecPercent Envelope」が分かれている
 * 場合は、一致するものをすべて束ねる（同じ field が2つの Envelope に現れたら RuleSet 不整合）。
 *
 * 絶対にしないこと: 範囲へ係数を掛けて絞る（×0.6 / ×0.8 等）。制約は許可集合と
 * 位置上限（§9.3）で表し、Envelope の数値そのものは変えない。
 * 該当 Envelope が無い（例: DEVELOPMENTAL の TI_VITTORI_SE / LONG INCOMPLETE）場合は
 * ENVELOPE_INFEASIBLE で BLOCKED にし、他の tier の値で代用しない。
 */
import type { EnvelopeCell, EnvelopeField, RuleSet } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { EnvelopeTier } from "../types/subject";
import type { RecoveryStructure, RunningSelection } from "../types/template";
import { itemFinding } from "./schema";

export type SelectedEnvelope = {
  tier: EnvelopeTier;
  fields: Partial<Record<EnvelopeField, EnvelopeCell>>;
};

export type EnvelopeSelectionResult = { ok: true; envelope: SelectedEnvelope } | { ok: false; findings: Finding[] };

export function selectEnvelope(
  ruleSet: RuleSet,
  selection: RunningSelection,
  tier: EnvelopeTier,
  recoveryStructure: RecoveryStructure | null,
): EnvelopeSelectionResult {
  const matches = ruleSet.envelopes.filter(
    (e) =>
      e.method === selection.method &&
      e.tier === tier &&
      e.recoveryStructure === recoveryStructure &&
      (e.templateIds as readonly string[]).includes(selection.templateId),
  );
  if (matches.length === 0) {
    return {
      ok: false,
      findings: [itemFinding("ENVELOPE_INFEASIBLE", "BLOCK_AUTOGEN", { metric: `envelope-not-found:${tier}:${selection.templateId}` })],
    };
  }
  const fields: Partial<Record<EnvelopeField, EnvelopeCell>> = {};
  for (const envelope of matches) {
    for (const [field, cell] of Object.entries(envelope.fields) as [EnvelopeField, EnvelopeCell][]) {
      if (fields[field] !== undefined) {
        return {
          ok: false,
          findings: [itemFinding("ENVELOPE_INFEASIBLE", "BLOCK_AUTOGEN", { metric: `duplicate-cell:${field}` })],
        };
      }
      fields[field] = cell;
    }
  }
  return { ok: true, envelope: { tier, fields } };
}
