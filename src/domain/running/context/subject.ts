/**
 * Running Prescription Engine v2 — resolveSubjectProfile()（§4 全体のオーケストレーション）。
 *
 * これは R3 の唯一の public API 関数（§1.5）。ageBand/maturity/trainingAge/
 * tier/constraints/performance の各モジュールを呼び出し、R4 が使う
 * `SubjectProfile` を1つにまとめる。ここ自体は新しい判定ロジックを持たず、
 * 「誰が何を個別に計算し、GROUP はどう積集合するか」の配線だけを担当する。
 *
 * GROUP は絶対に1人の架空選手へ平均化しない（§4.1・要件18）。各 member を
 * 個別に resolve してから、制約だけを積集合する。
 */
import type { AthleteProfile, GroupProfile, Subject, TrainingAgeTier, EnvelopeTier } from "../types/subject";
import type { Confidence, IsoDate, RaceEvent } from "../types/primitives";
import type { RuleSet } from "../rules/schema";
import { resolveAgeBand, type ResolvedAgeBand } from "./ageBand";
import { normalizeMaturity, type NormalizedMaturity, type MaturityConstraintCategory } from "./maturity";
import { deriveTrainingAgeTier, isTrainingAgeKnown } from "./trainingAge";
import { deriveEnvelopeTier } from "./tier";
import {
  resolveConstraints,
  intersectResolvedConstraints,
  resolveEligibility,
  intersectEligibilityDecisions,
  applyConstraintsToEligibility,
  type EligibilityDecision,
  type ResolvedConstraints,
} from "./constraints";

export type ResolveSubjectProfileInput = {
  subject: Subject;
  /** 処方対象日。`Date.now()` 等は一切使わない（すべて deterministic）。 */
  asOf: IsoDate;
  ruleSet: RuleSet;
};

export type SubjectProfile = {
  subjectKind: "ATHLETE" | "GROUP";
  ageBand: ResolvedAgeBand;
  /** ATHLETE のときだけ1件。GROUP は平均化しないため常に null。 */
  maturity: NormalizedMaturity | null;
  /** GROUP の各 member を個別に正規化した結果（平均化しない）。ATHLETE は空配列。 */
  memberMaturities: readonly NormalizedMaturity[];
  /** Eligibility 解決に使う実効カテゴリの集合。ATHLETE は要素数1。 */
  effectiveMaturityCategories: readonly MaturityConstraintCategory[];
  rapidGrowthFlag: boolean;
  trainingAgeTier: TrainingAgeTier;
  trainingAgeKnown: boolean;
  envelopeTier: EnvelopeTier;
  allowAdvancedMethods: boolean;
  /** ATHLETE の primaryEvent（1件）。GROUP は各 member の primaryEvent の集合（重複除去）。 */
  primaryEvents: readonly (AthleteProfile["primaryEvent"])[];
  resolvedConstraints: ResolvedConstraints;
  /** GROUP は常に false（個人の marks/vmax を使わない。§4.1）。 */
  performanceAvailable: boolean;
  /** GROUP は常に LOW 上限（§4.1: 個人記録を使わないため prescriptionConfidence は最大 LOW）。 */
  inputDataConfidenceCap: Confidence;
};

// ---------------------------------------------------------------------------
// ATHLETE
// ---------------------------------------------------------------------------

function resolveAthleteMember(
  profile: Pick<AthleteProfile, "birthDate" | "ageBandOverride" | "maturity" | "trainingAge">,
  asOf: IsoDate,
  ruleSet: RuleSet,
): {
  ageBand: ResolvedAgeBand;
  maturity: NormalizedMaturity;
  trainingAgeTier: TrainingAgeTier;
  trainingAgeKnown: boolean;
  envelopeTier: EnvelopeTier;
  resolvedConstraints: ResolvedConstraints;
} {
  const ageBand = resolveAgeBand({ birthDate: profile.birthDate, ageBandOverride: profile.ageBandOverride }, asOf);
  const maturity = normalizeMaturity({ ageBand, maturity: profile.maturity, asOf, ruleSet });
  const trainingAgeTier = deriveTrainingAgeTier(profile.trainingAge);
  const trainingAgeKnown = isTrainingAgeKnown(profile.trainingAge);
  const envelopeTier = deriveEnvelopeTier(maturity.constraintCategory, trainingAgeTier);
  const resolvedConstraints = resolveConstraints(ruleSet, ageBand, maturity.constraintCategory, trainingAgeTier);
  return { ageBand, maturity, trainingAgeTier, trainingAgeKnown, envelopeTier, resolvedConstraints };
}

function resolveAthleteProfile(athlete: AthleteProfile, asOf: IsoDate, ruleSet: RuleSet): SubjectProfile {
  const resolved = resolveAthleteMember(athlete, asOf, ruleSet);
  return {
    subjectKind: "ATHLETE",
    ageBand: resolved.ageBand,
    maturity: resolved.maturity,
    memberMaturities: [],
    effectiveMaturityCategories: [resolved.maturity.constraintCategory],
    rapidGrowthFlag: resolved.maturity.rapidGrowthFlag,
    trainingAgeTier: resolved.trainingAgeTier,
    trainingAgeKnown: resolved.trainingAgeKnown,
    envelopeTier: resolved.envelopeTier,
    allowAdvancedMethods: athlete.allowAdvancedMethods,
    primaryEvents: [athlete.primaryEvent],
    resolvedConstraints: resolved.resolvedConstraints,
    performanceAvailable: true,
    inputDataConfidenceCap: "HIGH", // 個人は上限を設けない（実際の confidence は performance.ts が個別に決める）
  };
}

// ---------------------------------------------------------------------------
// GROUP（§4.1・要件18・19）
// ---------------------------------------------------------------------------

const AGE_BAND_RESTRICTIVENESS: Record<"U12" | "U15" | "U18" | "ADULT", number> = {
  U12: 0,
  U15: 1,
  U18: 2,
  ADULT: 3,
};

function combineGroupAgeBand(bands: readonly ResolvedAgeBand[]): ResolvedAgeBand {
  if (bands.length === 0 || bands.some((b) => b === "UNKNOWN")) return "UNKNOWN";
  return bands.reduce((a, b) =>
    AGE_BAND_RESTRICTIVENESS[b as keyof typeof AGE_BAND_RESTRICTIVENESS] <
    AGE_BAND_RESTRICTIVENESS[a as keyof typeof AGE_BAND_RESTRICTIVENESS]
      ? b
      : a,
  );
}

const TRAINING_AGE_RESTRICTIVENESS: Record<TrainingAgeTier, number> = {
  BEGINNER: 0,
  DEVELOPING: 1,
  TRAINED: 2,
  ADVANCED: 3,
};

function combineGroupTrainingAgeTier(tiers: readonly TrainingAgeTier[]): TrainingAgeTier {
  return tiers.reduce((a, b) => (TRAINING_AGE_RESTRICTIVENESS[b] < TRAINING_AGE_RESTRICTIVENESS[a] ? b : a));
}

/**
 * 空 GROUP（members=[]）の観測状態（要件19）。ageBand=UNKNOWN・
 * maturity.method=NONE の「架空の1 member」を通常の member パイプラインへ
 * 流すことで、特別扱いのハードコードを避けつつ仕様どおりの結果
 * （ageBand=UNKNOWN, constraintCategory=EFFECTIVE_UNKNOWN,
 * trainingAgeTier=BEGINNER, envelopeTier=DEVELOPMENTAL）を得る。
 */
function emptyGroupVirtualMember(): Pick<AthleteProfile, "birthDate" | "ageBandOverride" | "maturity" | "trainingAge"> {
  return {
    birthDate: null,
    maturity: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
    trainingAge: { structuredSprintYears: null },
  };
}

function resolveGroupProfile(group: GroupProfile, asOf: IsoDate, ruleSet: RuleSet): SubjectProfile {
  const memberInputs = group.members.length > 0 ? group.members : [emptyGroupVirtualMember()];
  const resolvedMembers = memberInputs.map((m) => resolveAthleteMember(m, asOf, ruleSet));

  const ageBand = combineGroupAgeBand(resolvedMembers.map((m) => m.ageBand));
  const memberMaturities = resolvedMembers.map((m) => m.maturity);
  const effectiveMaturityCategories = memberMaturities.map((m) => m.constraintCategory);
  const rapidGrowthFlag = memberMaturities.some((m) => m.rapidGrowthFlag);
  const trainingAgeTier = combineGroupTrainingAgeTier(resolvedMembers.map((m) => m.trainingAgeTier));
  const trainingAgeKnown = resolvedMembers.some((m) => m.trainingAgeKnown);
  // GROUP の EnvelopeTier=ADVANCED は「全 member が個別に ADVANCED 条件を満たす場合のみ」
  // （1人でも DEVELOPMENTAL なら GROUP 全体も DEVELOPMENTAL。要件18）。
  const envelopeTier: EnvelopeTier = resolvedMembers.every((m) => m.envelopeTier === "ADVANCED") ? "ADVANCED" : "DEVELOPMENTAL";
  const resolvedConstraints = intersectResolvedConstraints(resolvedMembers.map((m) => m.resolvedConstraints));

  const primaryEventsSeen = new Set<AthleteProfile["primaryEvent"]>();
  for (const m of group.members) {
    primaryEventsSeen.add(m.primaryEvent);
  }

  return {
    subjectKind: "GROUP",
    ageBand,
    maturity: null,
    memberMaturities,
    effectiveMaturityCategories,
    rapidGrowthFlag,
    trainingAgeTier,
    trainingAgeKnown,
    envelopeTier,
    allowAdvancedMethods: group.allowAdvancedMethods,
    // GROUP では個人の目標を作らないため primaryEvent の集合は参考情報に留める（要件18）。
    primaryEvents: [...primaryEventsSeen],
    resolvedConstraints,
    performanceAvailable: false, // GROUP では marks/vmax を使わない（要件18）
    inputDataConfidenceCap: "LOW", // GROUP の prescriptionConfidence は最大 LOW（§4.1 RK-04）
  };
}

// ---------------------------------------------------------------------------
// 公開 API（§1.5）
// ---------------------------------------------------------------------------

export function resolveSubjectProfile(input: ResolveSubjectProfileInput): SubjectProfile {
  const { subject, asOf, ruleSet } = input;
  if (subject.kind === "ATHLETE") {
    return resolveAthleteProfile(subject.profile, asOf, ruleSet);
  }
  return resolveGroupProfile(subject.profile, asOf, ruleSet);
}

// ---------------------------------------------------------------------------
// §27 LONG primaryEvent 判定 / §28 ASSISTED manual candidate 判定
// ---------------------------------------------------------------------------

/** §4.5: LONG FULL/INCOMPLETE の候補となる primaryEvent（200m/400m/400mH）。 */
export const LONG_SPRINT_QUALIFYING_EVENTS: readonly RaceEvent[] = ["200m", "400m", "400mH"];

export function qualifiesForLongSprintEvent(primaryEvent: AthleteProfile["primaryEvent"] | null): boolean {
  if (primaryEvent === null) return false;
  return (LONG_SPRINT_QUALIFYING_EVENTS as readonly string[]).includes(primaryEvent);
}

/**
 * §4.5: LONG INCOMPLETE の条件（POST & EnvelopeTier=ADVANCED & 対象 primaryEvent）。
 * template selection 自体は R4 の責務。ここでは「候補になりうるか」だけを返す。
 */
export function qualifiesForLongIncomplete(profile: SubjectProfile, primaryEvent: AthleteProfile["primaryEvent"] | null): boolean {
  return profile.envelopeTier === "ADVANCED" && qualifiesForLongSprintEvent(primaryEvent);
}

/**
 * subject の全 effectiveMaturityCategory について §4.4 の eligibility を積集合し、
 * さらに ConstraintRule（§8.2 の年齢帯制約など）を重ねた最終判定を返す。
 * GROUP でも平均化せず、最も制約の強い判定になる。
 */
export function resolveSubjectEligibility(
  profile: SubjectProfile,
  method: EligibilityDecision["method"],
  templateId: string,
  ruleSet: RuleSet,
): EligibilityDecision {
  const perCategory = profile.effectiveMaturityCategories.map((category) =>
    resolveEligibility(ruleSet, method, templateId, category),
  );
  return applyConstraintsToEligibility(intersectEligibilityDecisions(perCategory), profile.resolvedConstraints, templateId);
}

/**
 * §4.5: ASSISTED_SPRINT が「手動候補」になれるか。
 *
 * 次のすべてを満たす場合だけ true:
 *   - §4.4 の eligibility と §8.2 の ConstraintRule を重ねた判定が INELIGIBLE でない
 *     （U12/U15、PRE/CIRCA/EFFECTIVE_UNKNOWN はここで除外される。override 不可）
 *   - EnvelopeTier = ADVANCED
 *   - allowAdvancedMethods = true
 *   - vmax.confidence ≥ MEDIUM
 *
 * true でも AUTO にはしない（§4.5「それでも自動生成はしない」）。actor=AI の最終拒否は R4/R12。
 */
export function isAssistedManualCandidate(
  profile: SubjectProfile,
  vmaxConfidence: Confidence | null,
  ruleSet: RuleSet,
): boolean {
  const assistedTemplateIds = ruleSet.templates.filter((t) => t.method === "ASSISTED_SPRINT").map((t) => t.id);
  const eligibleSomewhere = assistedTemplateIds.some(
    (templateId) => resolveSubjectEligibility(profile, "ASSISTED_SPRINT", templateId, ruleSet).mode !== "INELIGIBLE",
  );
  if (!eligibleSomewhere) return false;
  if (profile.envelopeTier !== "ADVANCED") return false;
  if (!profile.allowAdvancedMethods) return false;
  if (vmaxConfidence === null) return false;
  return vmaxConfidence === "MEDIUM" || vmaxConfidence === "HIGH";
}
