/**
 * Running Prescription Engine v2 — §9.2 step 6: METHOD ELIGIBILITY（+ step 7 の advancedOnly / complexity）。
 *
 * R3 の `resolveEligibility()` / `resolveSubjectEligibility()` / ConstraintRule をそのまま使い、
 * eligibility 表・制約・しきい値を TS へ写さない。R4 がここで足すのは:
 *   - actor の適用（AI_PLANNER / SYSTEM は AUTO だけ。COACH は MANUAL 可 + REVIEW、
 *     override 可能な INELIGIBLE は有効な CoachOverride があるときだけ、override 不可は常に不可）
 *   - EligibilityRule.conditions（RuleSet の構造化データ）の評価。AUTO 行で満たさなければ手動+REVIEW、
 *     MANUAL 行で満たさなければ override 不可の INELIGIBLE（`whenUnmet` に従う）
 *   - EligibilityRule.autoGenerationLimits（エンジンが置く値の上限）
 *   - requiresPhaseEvaluation の行を AUTO に昇格させない（phase を仮定しない）
 *   - advancedOnly（template / MethodMeta）と complexity 上限（§7.5）
 *
 * `conditionNote` は人間向けの説明専用で、ここでは一切読まない。ruleId / templateId / 表示名から
 * 意味を取り出すこともしない（RuleSet の行は ruleId の完全一致で参照するだけ）。
 */
import {
  eligibilityConditionsHaveRequirement,
  type Complexity,
  type EligibilityConditions,
  type EligibilityRule,
  type MethodMeta,
  type RuleSet,
  type RuleSetSessionTemplate,
} from "../rules/schema";
import type { Finding } from "../types/findings";
import type { Confidence } from "../types/primitives";
import type { RangePosition } from "../types/prescription";
import { resolveEligibility, type EligibilityDecision } from "../context/constraints";
import { isAssistedManualCandidate, resolveSubjectEligibility, type SubjectProfile } from "../context/subject";
import { itemFinding, type EligibilityReason, type EligibilityReasonCode, type PlanRequest } from "./schema";

export type EligibilityModifiers = {
  /** EligibilityRule.autoGenerationLimits.maxTotalReps（エンジンが選ぶ totalReps の上限）。 */
  maxAutoTotalReps: number | null;
  /** EligibilityRule.autoGenerationLimits.positionCap（rest 以外の位置上限）。 */
  positionCap: RangePosition | null;
};

export type EligibilityEvaluation =
  | { status: "INELIGIBLE"; reasons: EligibilityReason[]; findings: Finding[] }
  | { status: "BLOCKED"; findings: Finding[] }
  | {
      status: "ELIGIBLE";
      /** actor 適用前の最終モード（AUTO = 自動生成可、MANUAL = コーチの明示選択のみ）。 */
      mode: "AUTO" | "MANUAL";
      requiresReview: boolean;
      overriddenRuleIds: string[];
      modifiers: EligibilityModifiers;
      findings: Finding[];
    };

type BlockingRule = { code: EligibilityReasonCode; ruleId: string | null; overrideAllowed: boolean };

const COMPLEXITY_ORDER: Record<Complexity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const CONFIDENCE_ORDER: Record<Confidence, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export type EligibilityInput = {
  request: PlanRequest;
  profile: SubjectProfile;
  ruleSet: RuleSet;
  template: RuleSetSessionTemplate;
  methodMeta: MethodMeta;
  /** requiresVmaxConfidenceAtLeast の判定に使う実測速度の confidence。無ければ null。 */
  vmaxConfidence: Confidence | null;
};

/** EligibilityRule.conditions をすべて満たすか（requires* が無ければ true）。 */
export function eligibilityConditionsMet(
  conditions: EligibilityConditions,
  ctx: { profile: SubjectProfile; coachReference: PlanRequest["coachReference"]; vmaxConfidence: Confidence | null },
): boolean {
  const { profile, coachReference, vmaxConfidence } = ctx;
  if (conditions.requiresEnvelopeTier !== null && profile.envelopeTier !== conditions.requiresEnvelopeTier) return false;
  if (conditions.requiresTrainingAgeTiers !== null && !conditions.requiresTrainingAgeTiers.includes(profile.trainingAgeTier)) return false;
  if (conditions.requiresPrimaryEvents !== null) {
    const allowed = new Set<string>(conditions.requiresPrimaryEvents);
    if (profile.primaryEvents.length === 0 || !profile.primaryEvents.every((e) => allowed.has(e))) return false;
  }
  if (conditions.requiresAllowAdvancedMethods && !profile.allowAdvancedMethods) return false;
  if (conditions.requiresMeasuredVelocityDecrement && !(coachReference?.kind === "VELOCITY_DECREMENT" && coachReference.measured)) {
    return false;
  }
  if (conditions.requiresVmaxConfidenceAtLeast !== null) {
    if (vmaxConfidence === null || CONFIDENCE_ORDER[vmaxConfidence] < CONFIDENCE_ORDER[conditions.requiresVmaxConfidenceAtLeast]) return false;
  }
  return true;
}

export function evaluateEligibility(input: EligibilityInput): EligibilityEvaluation {
  const { request, profile, ruleSet, template, methodMeta, vmaxConfidence } = input;
  const { method, templateId } = request.selection;
  const actor = request.actor;

  let perCategory: EligibilityDecision[];
  let rows: EligibilityRule[];
  let combined: EligibilityDecision;
  try {
    perCategory = profile.effectiveMaturityCategories.map((category) => resolveEligibility(ruleSet, method, templateId, category));
    combined = resolveSubjectEligibility(profile, method, templateId, ruleSet);
    rows = perCategory.map((d) => {
      const row = ruleSet.eligibility.find((r) => r.ruleId === d.sourceRuleId);
      if (!row) throw new Error(`EligibilityRule not found: ${d.sourceRuleId}`);
      return row;
    });
  } catch (e) {
    return {
      status: "BLOCKED",
      findings: [itemFinding("ELIGIBILITY_RULESET_INCONSISTENT", "BLOCK", { metric: e instanceof Error ? e.message : String(e) })],
    };
  }

  const conditionCtx = { profile, coachReference: request.coachReference, vmaxConfidence };

  // ---- INELIGIBLE の原因（override 対象の ruleId を必ず持つ） ----------------
  const blocking: BlockingRule[] = [];
  for (const d of perCategory) {
    if (d.mode === "INELIGIBLE") {
      blocking.push({ code: "ELIGIBILITY_RULE_INELIGIBLE", ruleId: d.sourceRuleId, overrideAllowed: d.overrideAllowed === true });
    }
  }
  for (const constraintId of profile.resolvedConstraints.appliedConstraintIds) {
    const rule = ruleSet.constraints.find((c) => c.id === constraintId);
    if (!rule) continue;
    const disallows =
      (rule.disallowedMethods as readonly string[]).includes(method) || (rule.disallowedTemplateIds as readonly string[]).includes(templateId);
    if (disallows) {
      blocking.push({ code: "CONSTRAINT_DISALLOWED", ruleId: rule.id, overrideAllowed: rule.overrideAllowed === true });
    }
  }
  // R3 の統合判定と矛盾していないこと（R4 が別の eligibility を作っていない保証）。
  if ((combined.mode === "INELIGIBLE") !== (blocking.length > 0)) {
    return {
      status: "BLOCKED",
      findings: [itemFinding("ELIGIBILITY_RULESET_INCONSISTENT", "BLOCK", { metric: `${method}:${templateId}` })],
    };
  }

  // 構造化条件（MANUAL 行など whenUnmet=INELIGIBLE_NON_OVERRIDABLE）
  let downgradeToManual = false;
  for (const [i, row] of rows.entries()) {
    if (perCategory[i].mode === "INELIGIBLE" || !eligibilityConditionsHaveRequirement(row.conditions)) continue;
    if (eligibilityConditionsMet(row.conditions, conditionCtx)) continue;
    if (row.conditions.whenUnmet === "INELIGIBLE_NON_OVERRIDABLE") {
      blocking.push({ code: "ELIGIBILITY_CONDITIONS_UNMET", ruleId: row.ruleId, overrideAllowed: false });
    } else {
      downgradeToManual = true;
    }
  }

  // R3 の ASSISTED 手動候補判定と、RuleSet の構造化条件の結果が一致すること（防御的な整合確認）。
  if (method === "ASSISTED_SPRINT") {
    const r3Candidate = isAssistedManualCandidate(profile, vmaxConfidence, ruleSet);
    const structuredCandidate = combined.mode !== "INELIGIBLE" && !blocking.some((b) => b.code === "ELIGIBILITY_CONDITIONS_UNMET");
    if (r3Candidate !== structuredCandidate) {
      return {
        status: "BLOCKED",
        findings: [itemFinding("ELIGIBILITY_RULESET_INCONSISTENT", "BLOCK", { metric: "ASSISTED_SPRINT:structured-conditions-vs-R3" })],
      };
    }
  }

  if (template.advancedOnly || methodMeta.advancedOnly) {
    if (!(profile.envelopeTier === "ADVANCED" && profile.allowAdvancedMethods)) {
      // R4 の gate 識別子（templateId から組み立てるだけで、文字列を解析しない）。
      blocking.push({ code: "ADVANCED_ONLY_NOT_PERMITTED", ruleId: `ADVANCED_ONLY:${templateId}`, overrideAllowed: true });
    }
  }

  const modifiers: EligibilityModifiers = {
    maxAutoTotalReps: rows.reduce<number | null>((acc, row) => {
      const max = row.autoGenerationLimits.maxTotalReps;
      return max === null ? acc : acc === null ? max : Math.min(acc, max);
    }, null),
    positionCap: rows.some((row) => row.autoGenerationLimits.positionCap === "LOWER_HALF") ? "LOWER_HALF" : null,
  };

  const findings: Finding[] = [];
  const overrideRuleIds = new Set(request.overrides.flatMap((o) => (o.target.kind === "ELIGIBILITY" ? [o.target.ruleId] : [])));
  const blockingIds = new Set(blocking.flatMap((b) => (b.ruleId === null ? [] : [b.ruleId])));
  for (const id of overrideRuleIds) {
    if (!blockingIds.has(id)) {
      return { status: "BLOCKED", findings: [itemFinding("OVERRIDE_TARGET_INVALID", "BLOCK", { metric: `ELIGIBILITY:${id}` })] };
    }
  }

  const toReason = (b: BlockingRule): EligibilityReason => ({ code: b.code, ruleId: b.ruleId, overrideAllowed: b.overrideAllowed });

  // ---- INELIGIBLE（override の適用は COACH のみ） ----------------------------
  if (blocking.length > 0) {
    if (actor.kind !== "COACH") {
      return { status: "INELIGIBLE", reasons: blocking.map(toReason), findings };
    }
    if (blocking.some((b) => !b.overrideAllowed)) {
      return {
        status: "INELIGIBLE",
        reasons: [...blocking.map(toReason), { code: "OVERRIDE_NOT_ALLOWED", ruleId: null, overrideAllowed: false }],
        findings,
      };
    }
    const uncovered = blocking.filter((b) => b.ruleId === null || !overrideRuleIds.has(b.ruleId));
    if (uncovered.length > 0) {
      return {
        status: "INELIGIBLE",
        reasons: [...blocking.map(toReason), { code: "OVERRIDE_REQUIRED", ruleId: null, overrideAllowed: true }],
        findings,
      };
    }
    const ids = blocking.map((b) => b.ruleId as string);
    findings.push(itemFinding("ELIGIBILITY_OVERRIDDEN", "REQUIRE_COACH_REVIEW", { metric: ids.join(",") }));
    return { status: "ELIGIBLE", mode: "MANUAL", requiresReview: true, overriddenRuleIds: ids, modifiers, findings };
  }

  // ---- 適格: AUTO / MANUAL の確定（下向きの gate のみ） ------------------------
  let mode: "AUTO" | "MANUAL";
  let requiresReview = combined.requiresReview;
  const autoBlockers: EligibilityReasonCode[] = [];

  if (combined.mode === "CONDITIONAL_AUTO") {
    // requiresPhaseEvaluation=true の行（SES POST 等）。R4 は phase を評価しないため AUTO にしない。
    mode = "MANUAL";
    requiresReview = true;
    autoBlockers.push("CONDITIONAL_AUTO_REQUIRES_PHASE");
  } else if (combined.mode === "MANUAL") {
    mode = "MANUAL";
    autoBlockers.push("AUTOGEN_NOT_ALLOWED_FOR_MANUAL_MODE");
    if (downgradeToManual) requiresReview = true;
  } else {
    mode = "AUTO";
    if (downgradeToManual) {
      mode = "MANUAL";
      requiresReview = true;
      autoBlockers.push("CONDITIONAL_AUTO_NOT_MET");
    }
    if (COMPLEXITY_ORDER[template.complexity] > COMPLEXITY_ORDER[profile.resolvedConstraints.maxAutoComplexity]) {
      mode = "MANUAL";
      requiresReview = true;
      autoBlockers.push("COMPLEXITY_ABOVE_AUTO_CAP");
    }
  }

  if (mode === "MANUAL" && actor.kind !== "COACH") {
    // §18.4: 自動生成の制限は AI_PLANNER / SYSTEM にだけ適用する。
    return {
      status: "INELIGIBLE",
      reasons: [...new Set(autoBlockers)].map((code) => ({ code, ruleId: combined.sourceRuleId, overrideAllowed: null })),
      findings,
    };
  }

  if (mode === "MANUAL") {
    findings.push(itemFinding("ELIGIBILITY_MANUAL_SELECTION", "INFO", { metric: [...new Set(autoBlockers)].join(",") }));
    if (requiresReview) {
      findings.push(itemFinding("ELIGIBILITY_MANUAL_REVIEW", "REQUIRE_COACH_REVIEW", { metric: `${method}:${templateId}` }));
    }
  }

  return { status: "ELIGIBLE", mode, requiresReview, overriddenRuleIds: [], modifiers, findings };
}
