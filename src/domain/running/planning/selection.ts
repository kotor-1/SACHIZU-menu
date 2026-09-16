/**
 * Running Prescription Engine v2 — §9.2 step 7: METHOD + SESSION TEMPLATE SELECTION。
 *
 * 要求された selection を RuleSet と照合する（MethodMeta・template の実在、method の一致、
 * recoveryStructure の導出）。advancedOnly / complexity / 制約は eligibility（step 6）と
 * 一緒に評価する（override の対象 ruleId を1か所にまとめるため）。
 *
 * recoveryStructure は TS の対応表を持たず、RuleSet の SessionTemplate.recoveryStructure
 * から読む。stop policy は MethodMeta.stopPolicyIds・StopPolicy.appliesToRecoveryStructure・
 * StopPolicy.appliesToEligibilityPath（構造化データ）から選ぶ。monitor の判定ロジックは持たない（R8）。
 */
import type { MethodMeta, RuleSet, RuleSetSessionTemplate, StopPolicy } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { RecoveryStructure, RunningSelection } from "../types/template";
import { itemFinding } from "./schema";

export type SelectionResolution = {
  template: RuleSetSessionTemplate;
  methodMeta: MethodMeta;
  recoveryStructure: RecoveryStructure | null;
};

export type SelectionResult = { ok: true; value: SelectionResolution } | { ok: false; findings: Finding[] };

export function validateSelection(selection: RunningSelection, ruleSet: RuleSet): SelectionResult {
  const template = ruleSet.templates.find((t) => t.id === selection.templateId);
  if (!template) {
    return { ok: false, findings: [itemFinding("TEMPLATE_NOT_IN_RULESET", "BLOCK", { metric: selection.templateId })] };
  }
  if (template.method !== selection.method) {
    return { ok: false, findings: [itemFinding("TEMPLATE_METHOD_MISMATCH", "BLOCK", { metric: `${selection.method}/${selection.templateId}` })] };
  }
  const methodMeta = ruleSet.methods.find((m) => m.method === selection.method);
  if (!methodMeta) {
    return { ok: false, findings: [itemFinding("METHOD_META_MISSING", "BLOCK", { metric: selection.method })] };
  }
  const recoveryStructure = template.recoveryStructure;
  if (methodMeta.requiresRecoveryStructure && recoveryStructure === null) {
    return { ok: false, findings: [itemFinding("RECOVERY_STRUCTURE_REQUIRED", "BLOCK", { metric: template.id })] };
  }
  if (!methodMeta.requiresRecoveryStructure && recoveryStructure !== null) {
    return { ok: false, findings: [itemFinding("RECOVERY_STRUCTURE_NOT_ALLOWED", "BLOCK", { metric: template.id })] };
  }
  return { ok: true, value: { template, methodMeta, recoveryStructure } };
}

/**
 * §10.3: MethodMeta.stopPolicyIds のうち method と recoveryStructure が一致し、
 * StopPolicy.appliesToEligibilityPath が今回の処方経路に適用されるものを選ぶ（policy id の文字列では選ばない）。
 *   - ANY: 経路に依らず適用
 *   - AUTO_CONDITIONS_MET: eligibility が override なしで AUTO（構造化条件を満たす）だった処方
 *   - MANUAL_OR_OVERRIDE: 手動選択・override 経由の処方
 * 一意に決まらない場合は null（RuleSet 不整合として BLOCKED）。返すのは RuleSet の行そのもの（snapshot は build でコピー）。
 */
export function resolveStopPolicy(
  ruleSet: RuleSet,
  methodMeta: MethodMeta,
  recoveryStructure: RecoveryStructure | null,
  options: { autoConditionsMetWithoutOverride: boolean },
): StopPolicy | null {
  const path = options.autoConditionsMetWithoutOverride ? "AUTO_CONDITIONS_MET" : "MANUAL_OR_OVERRIDE";
  const matches = methodMeta.stopPolicyIds
    .map((id) => ruleSet.stopPolicies.find((sp) => sp.id === id))
    .filter((sp): sp is StopPolicy => sp !== undefined)
    .filter((sp) => sp.method === methodMeta.method && sp.appliesToRecoveryStructure === recoveryStructure)
    .filter((sp) => sp.appliesToEligibilityPath === "ANY" || sp.appliesToEligibilityPath === path);
  return matches.length === 1 ? matches[0] : null;
}
