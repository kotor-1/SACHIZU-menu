/**
 * Running Prescription Engine v2 — §13.5 未成年の健康情報（AI に渡す型）。
 *
 * AI MenuPlanner に渡してよいのはこの型だけ。`PainReport` / `ReadinessReport` / `birthDate` /
 * `sexForNorms` / `maturity` の詳細は**一切含めない**（§20 T-AI-06 でキーの不在を検証する）。
 *
 * [R5 errata] `ageBand` は canonical な `AgeBand` ではなく `ResolvedAgeBand`（`"UNKNOWN"` を含む）。
 * 生年月日が無い ATHLETE や空の GROUP では年齢帯が観測できないため、U12 等へ偽装しない。
 */
import type { RuleSet } from "../rules/schema";
import type { RunningTrainingMethod } from "../types/method";
import type { EnvelopeTier } from "../types/subject";
import type { ResolvedAgeBand } from "../context/ageBand";
import type { SubjectProfile } from "../context/subject";
import { resolveSubjectEligibility } from "../context/subject";
import type { ReadinessDecision } from "./schema";

export type AiSafeSubjectContext = {
  tier: EnvelopeTier;
  ageBand: ResolvedAgeBand;
  allowedMethods: RunningTrainingMethod[];
  autogenBlockedMethods: RunningTrainingMethod[];
  highIntensityAllowedToday: boolean | "UNKNOWN";
  primaryEvent: string;
};

/**
 * Method ごとに「コーチが選べるか（= どれかの template が不適格でない）」「AI が自動生成できるか
 * （= どれかの template が AUTO で、かつ当日の readiness が高強度を止めていない）」を R3 の eligibility から導く。
 * 健康情報は `highIntensityAllowedToday`（enum 相当のシグナル）にだけ要約する。
 */
export function buildAiSafeSubjectContext(args: {
  profile: SubjectProfile;
  ruleSet: RuleSet;
  decision: ReadinessDecision | null;
}): AiSafeSubjectContext {
  const { profile, ruleSet, decision } = args;
  const highIntensityAllowedToday: boolean | "UNKNOWN" = decision === null ? true : decision.highIntensityAllowedToday;

  const allowedMethods: RunningTrainingMethod[] = [];
  const autogenBlockedMethods: RunningTrainingMethod[] = [];

  for (const methodMeta of ruleSet.methods) {
    const templates = ruleSet.templates.filter((t) => t.method === methodMeta.method);
    const decisions = templates.map((t) => resolveSubjectEligibility(profile, methodMeta.method, t.id, ruleSet));
    const selectable = decisions.some((d) => d.mode !== "INELIGIBLE");
    // CONDITIONAL_AUTO は phase 評価待ちなので「自動生成できる可能性がある」側に数える
    // （最終拒否は planning の actor 判定が行う。ここで AI に「絶対に出せる」とは伝えない）。
    const autoCandidate = decisions.some((d) => d.mode === "AUTO" || d.mode === "CONDITIONAL_AUTO");
    const highIntensity = methodMeta.loadClass === "HIGH_NEURAL" || methodMeta.loadClass === "HIGH_METABOLIC";
    const blockedByReadiness = highIntensity && highIntensityAllowedToday !== true;

    if (selectable) allowedMethods.push(methodMeta.method);
    if (!autoCandidate || blockedByReadiness) autogenBlockedMethods.push(methodMeta.method);
  }

  const primaryEvent =
    profile.primaryEvents.length === 1 ? String(profile.primaryEvents[0]) : profile.primaryEvents.length === 0 ? "UNKNOWN" : "MIXED";

  return {
    tier: profile.envelopeTier,
    ageBand: profile.ageBand,
    allowedMethods,
    autogenBlockedMethods,
    highIntensityAllowedToday,
    primaryEvent,
  };
}
