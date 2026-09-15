/**
 * Running Prescription Engine v2 — Eligibility / Constraint 解決（§4.4, §8.2, §7.5）。
 *
 * §4.4 の 64 件の EligibilityRule と、R3 で追加した ConstraintRule は
 * どちらも `RuleSet`（R2 JSON）に既にあるデータをそのまま読む。ここで
 * 別の switch 文へコピーしたり、しきい値を再定義したりしない
 * （「JSON と実装が乖離しないこと」が最重要）。
 *
 * R3 が評価しないこと（§22 R3 のスコープ外）:
 *   - competition phase 依存の条件（§4.5 の "phase≠TRANSITION" 等）。
 *     `EligibilityRule.requiresPhaseEvaluation=true` の行は、たとえ
 *     outcome="AUTO" でも `"CONDITIONAL_AUTO"` として返し、真の AUTO には
 *     昇格させない（R7 前に phase 判断を先行実装しない）。
 */
import type { RunningTrainingMethod } from "../types/method";
import type { TrainingAgeTier } from "../types/subject";
import type { RuleSet, ConstraintRule, Complexity } from "../rules/schema";
import type { MaturityConstraintCategory } from "./maturity";
import type { ResolvedAgeBand } from "./ageBand";

// ---------------------------------------------------------------------------
// Eligibility（§4.4 の64件をそのまま解決する）
// ---------------------------------------------------------------------------

export const ELIGIBILITY_MODES = ["AUTO", "CONDITIONAL_AUTO", "MANUAL", "INELIGIBLE"] as const;
export type EligibilityMode = (typeof ELIGIBILITY_MODES)[number];

export type EligibilityDecision = {
  method: RunningTrainingMethod;
  templateId: string;
  mode: EligibilityMode;
  requiresReview: boolean;
  overrideAllowed: boolean | null;
  conditionNote: string | null;
  /** 追跡用。どの EligibilityRule.ruleId から導かれたか（複数member集約時は null）。 */
  sourceRuleId: string | null;
};

/**
 * §4.4 の1行をそのまま `EligibilityDecision` に変換する。`requiresPhaseEvaluation`
 * が true の AUTO 行だけ `CONDITIONAL_AUTO` に変換する（R3 は phase を評価しない）。
 */
export function resolveEligibility(
  ruleSet: RuleSet,
  method: RunningTrainingMethod,
  templateId: string,
  maturityCategory: MaturityConstraintCategory,
): EligibilityDecision {
  const rule = ruleSet.eligibility.find(
    (r) => r.method === method && r.maturityCategory === maturityCategory && (r.templateIds as readonly string[]).includes(templateId),
  );
  if (!rule) {
    throw new Error(`No EligibilityRule found for method=${method} templateId=${templateId} maturityCategory=${maturityCategory}`);
  }
  const mode: EligibilityMode = rule.outcome === "AUTO" && rule.requiresPhaseEvaluation ? "CONDITIONAL_AUTO" : rule.outcome;
  return {
    method,
    templateId,
    mode,
    requiresReview: rule.requiresReview,
    overrideAllowed: rule.overrideAllowed,
    conditionNote: rule.conditionNote,
    sourceRuleId: rule.ruleId,
  };
}

const MODE_RESTRICTIVENESS: Record<EligibilityMode, number> = {
  AUTO: 0,
  CONDITIONAL_AUTO: 1,
  MANUAL: 2,
  INELIGIBLE: 3,
};

/**
 * GROUP 用: 複数 member（それぞれ別の maturityCategory を持ちうる）の
 * EligibilityDecision を「最も制約の強いものを採用する積集合」で1つに
 * まとめる（§4.1 GROUP resolution 方針）。平均化・多数決はしない。
 * 評価順序を変えても結果が同じになるよう、集合演算（最大値・OR・AND）
 * だけを使う。
 */
export function intersectEligibilityDecisions(decisions: readonly EligibilityDecision[]): EligibilityDecision {
  if (decisions.length === 0) {
    throw new Error("intersectEligibilityDecisions: at least one decision is required");
  }
  const worst = decisions.reduce((a, b) => (MODE_RESTRICTIVENESS[b.mode] > MODE_RESTRICTIVENESS[a.mode] ? b : a));
  const requiresReview = decisions.some((d) => d.requiresReview);
  // overrideAllowed は「INELIGIBLE の原因となった member 全員が override 可のときだけ true」
  // （1人でも override 不可なら group 全体も override 不可）。
  const overrideAllowed =
    worst.mode === "INELIGIBLE"
      ? decisions.filter((d) => d.mode === "INELIGIBLE").every((d) => d.overrideAllowed === true)
      : null;
  return {
    method: worst.method,
    templateId: worst.templateId,
    mode: worst.mode,
    requiresReview,
    overrideAllowed,
    conditionNote: worst.conditionNote,
    sourceRuleId: null,
  };
}

// ---------------------------------------------------------------------------
// ConstraintRule 解決（§8.2 ageBand制約 / §7.5 complexity cap）
// ---------------------------------------------------------------------------

const COMPLEXITY_ORDER: Record<Complexity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function constraintApplies(
  rule: ConstraintRule,
  ageBand: ResolvedAgeBand,
  maturityCategory: MaturityConstraintCategory,
  trainingAgeTier: TrainingAgeTier,
): boolean {
  switch (rule.match.dimension) {
    case "AGE_BAND":
      // ageBand が UNKNOWN のときは「全 AgeBand で許されるものの積集合」を
      // 採用する（§4.1 UNKNOWN group の方針）。これは AGE_BAND 制約を
      // 無条件に適用する（＝最も保守的な想定）ことと同値。
      if (ageBand === "UNKNOWN") return true;
      return (rule.match.ageBands as readonly string[]).includes(ageBand);
    case "MATURITY_CATEGORY":
      return (rule.match.categories as readonly string[]).includes(maturityCategory);
    case "TRAINING_AGE_TIER":
      return (rule.match.tiers as readonly string[]).includes(trainingAgeTier);
  }
}

export type ResolvedConstraints = {
  /** method → override 可否（false = override 不可）。存在しなければ制約なし。 */
  disallowedMethods: ReadonlyMap<RunningTrainingMethod, boolean>;
  disallowedTemplateIds: ReadonlyMap<string, boolean>;
  maxAutoComplexity: Complexity;
  appliedConstraintIds: readonly string[];
};

/**
 * 適用対象の ConstraintRule をすべて集め、集合として統合する（上書き順序に
 * 依存しない）。disallowed 系は和集合、override 可否は「不可が1件でもあれば
 * 不可」、complexity 上限は最小値を採用する。
 */
export function resolveConstraints(
  ruleSet: RuleSet,
  ageBand: ResolvedAgeBand,
  maturityCategory: MaturityConstraintCategory,
  trainingAgeTier: TrainingAgeTier,
): ResolvedConstraints {
  const applicable = ruleSet.constraints.filter((c) => constraintApplies(c, ageBand, maturityCategory, trainingAgeTier));

  const disallowedMethods = new Map<RunningTrainingMethod, boolean>();
  const disallowedTemplateIds = new Map<string, boolean>();
  let maxAutoComplexity: Complexity = "HIGH";

  for (const c of applicable) {
    for (const m of c.disallowedMethods) {
      const existing = disallowedMethods.get(m);
      const overrideAllowed = c.overrideAllowed ?? true;
      disallowedMethods.set(m, existing === undefined ? overrideAllowed : existing && overrideAllowed);
    }
    for (const t of c.disallowedTemplateIds) {
      const existing = disallowedTemplateIds.get(t);
      const overrideAllowed = c.overrideAllowed ?? true;
      disallowedTemplateIds.set(t, existing === undefined ? overrideAllowed : existing && overrideAllowed);
    }
    if (c.maxAutoComplexity !== null && COMPLEXITY_ORDER[c.maxAutoComplexity] < COMPLEXITY_ORDER[maxAutoComplexity]) {
      maxAutoComplexity = c.maxAutoComplexity;
    }
  }

  return {
    disallowedMethods,
    disallowedTemplateIds,
    maxAutoComplexity,
    appliedConstraintIds: applicable.map((c) => c.id),
  };
}

/**
 * GROUP 用: 複数 member の ResolvedConstraints を積集合する。
 * 1人でも disallow されていれば group 全体も disallow、
 * complexity 上限は最小値（最も厳しい方）を採用する。
 */
export function intersectResolvedConstraints(all: readonly ResolvedConstraints[]): ResolvedConstraints {
  if (all.length === 0) {
    return { disallowedMethods: new Map(), disallowedTemplateIds: new Map(), maxAutoComplexity: "HIGH", appliedConstraintIds: [] };
  }
  const disallowedMethods = new Map<RunningTrainingMethod, boolean>();
  const disallowedTemplateIds = new Map<string, boolean>();
  let maxAutoComplexity: Complexity = "HIGH";
  const appliedConstraintIds = new Set<string>();

  for (const rc of all) {
    for (const [m, overrideAllowed] of rc.disallowedMethods) {
      const existing = disallowedMethods.get(m);
      disallowedMethods.set(m, existing === undefined ? overrideAllowed : existing && overrideAllowed);
    }
    for (const [t, overrideAllowed] of rc.disallowedTemplateIds) {
      const existing = disallowedTemplateIds.get(t);
      disallowedTemplateIds.set(t, existing === undefined ? overrideAllowed : existing && overrideAllowed);
    }
    if (COMPLEXITY_ORDER[rc.maxAutoComplexity] < COMPLEXITY_ORDER[maxAutoComplexity]) {
      maxAutoComplexity = rc.maxAutoComplexity;
    }
    for (const id of rc.appliedConstraintIds) appliedConstraintIds.add(id);
  }

  return { disallowedMethods, disallowedTemplateIds, maxAutoComplexity, appliedConstraintIds: [...appliedConstraintIds] };
}

/**
 * §4.4 の EligibilityRule（Method×Template×maturityCategory）と、
 * §8.2/§7.5 の ConstraintRule（ageBand/maturity/trainingAge 横断の
 * disallow・complexity 上限）は別レイヤーであり、どちらか一方だけでは
 * 最終的な可否を決められない（例: U12 の ASSISTED_SPRINT は §4.4 の
 * eligibility 表だけを見ても分からず、§8.2 の ConstraintRule 側で
 * override 不可として追加されている）。
 *
 * この関数は両者を「より制約の強い方」に統合する。ConstraintRule が
 * 対象 method/template を disallow していない場合は EligibilityRule の
 * 判定をそのまま返す。
 */
export function applyConstraintsToEligibility(
  decision: EligibilityDecision,
  constraints: ResolvedConstraints,
  templateId: string,
): EligibilityDecision {
  const methodOverride = constraints.disallowedMethods.get(decision.method);
  const templateOverride = constraints.disallowedTemplateIds.get(templateId);
  const applicable = [methodOverride, templateOverride].filter((v): v is boolean => v !== undefined);
  if (applicable.length === 0) {
    return decision;
  }
  const constraintOverrideAllowed = applicable.every((v) => v === true);
  if (decision.mode === "INELIGIBLE") {
    return { ...decision, overrideAllowed: decision.overrideAllowed === true && constraintOverrideAllowed };
  }
  return {
    ...decision,
    mode: "INELIGIBLE",
    requiresReview: false,
    overrideAllowed: constraintOverrideAllowed,
  };
}
