/**
 * Running Prescription Engine v2 — §14.1〜§14.2 Phase の評価。
 *
 * Phase が変えるのは methodPriority（候補の並び。selection は変えない）と dose の位置上限だけ
 * （§14.1）。hard stop・pain gate・rest 短縮には一切関与しない。RuleSet の `phaseRules` を
 * そのまま読むだけで、phase 名の switch を TS 側に複製しない。
 */
import type { RuleSet } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { RangePosition } from "../types/prescription";
import type { RunningTrainingMethod } from "../types/method";
import type { TrainingPhase } from "../../menu/constants";

export function phaseRuleFor(ruleSet: RuleSet, phase: TrainingPhase): RuleSet["phaseRules"][number] | null {
  return ruleSet.phaseRules.find((r) => r.phase === phase) ?? null;
}

export type PhaseEvaluation = {
  dosePositionCap: RangePosition | null;
  blockedAutogenLoadClasses: RuleSet["methods"][number]["loadClass"][];
  methodPriority: RunningTrainingMethod[] | null;
  findings: Finding[];
};

/**
 * phase=null は「未評価」であり、位置上限なし（既定 MIDDLE。§9.3）・自動生成制限なしとして扱う
 * （§14.1 の表の「null」行どおり）。
 */
export function evaluatePhase(ruleSet: RuleSet, phase: TrainingPhase | null): PhaseEvaluation {
  if (phase === null) {
    return { dosePositionCap: null, blockedAutogenLoadClasses: [], methodPriority: null, findings: [] };
  }
  const rule = phaseRuleFor(ruleSet, phase);
  if (!rule) {
    // RuleSet に phase 行が無い（不整合）。安全側 = 制限なしにはせず、位置上限だけ最も保守的にする。
    return {
      dosePositionCap: "LOWER_BOUND",
      blockedAutogenLoadClasses: [],
      methodPriority: null,
      findings: [{ code: "PHASE_RULE_MISSING", severity: "WARN", scope: "ITEM", evidenceIds: [] }],
    };
  }
  const findings: Finding[] = [];
  if (rule.infoFindingCode !== null) {
    findings.push({ code: rule.infoFindingCode, severity: "INFO", scope: "ITEM", evidenceIds: rule.infoEvidenceIds });
  }
  return {
    dosePositionCap: rule.dosePositionCap,
    blockedAutogenLoadClasses: rule.blockedAutogenLoadClasses,
    methodPriority: rule.methodPriority.length > 0 ? [...rule.methodPriority] : null,
    findings,
  };
}
