/**
 * Running Prescription Engine v2 — §10.4 step 2: SAFETY GATE（最優先・timing より前）。
 *
 * `painNow` / `redFlags` / `requestsStop` / `technique=UNSAFE` / `environmentUnsafe` のどれか1つでも → STOP_SAFETY。
 * timeS=null でも止める。phase・tier・recoveryStructure・stop policy によって緩めない（§10.3 共通行）。
 *
 * safetyOutcome:
 *   - red flag: 処方 snapshot の safetyPolicy（R5 readinessRules のコピー）のうち該当グループの最大 severityRank
 *   - 痛みあり（red flag なし）: safetyPolicy.painPresentOutcome
 *   - 本人の中止要請・UNSAFE・環境: COACH_REVIEW（[R8 errata] 健康情報ではない実施中の中止。RuleSet に対応する行が
 *     無く、R5 readinessRules は変更しないため、contract として COACH_REVIEW に固定する）
 *   複数に該当したら最も重い outcome を採る（評価順に依存しない）。
 *
 * 出力に健康情報（部位・red flag 名・痛みの有無）を残さない。reason は athlete 由来を1コードにまとめる。
 */
import type { RuntimeSafetyPolicySnapshot } from "../types/monitoring";
import type { SafetyOutcome } from "../types/readiness";
import type { RepObservation, StopReason } from "./schema";

export type SafetyGateResult = { stop: false } | { stop: true; safetyOutcome: SafetyOutcome; reasons: StopReason[] };

const OUTCOME_SEVERITY: Record<SafetyOutcome, number> = {
  NONE: 0,
  COACH_REVIEW: 1,
  STOP: 2,
  MEDICAL_EVALUATION_RECOMMENDED: 3,
};

export function worseSafetyOutcome(a: SafetyOutcome, b: SafetyOutcome): SafetyOutcome {
  return OUTCOME_SEVERITY[b] > OUTCOME_SEVERITY[a] ? b : a;
}

/** 実施中の中止のうち、健康情報に由来しないもの（本人の中止要請・UNSAFE・環境・ASSISTED の技術）の outcome。 */
export const NON_HEALTH_RUNTIME_STOP_OUTCOME: SafetyOutcome = "COACH_REVIEW";

export function evaluateSafetyGate(obs: RepObservation, policy: RuntimeSafetyPolicySnapshot): SafetyGateResult {
  const report = obs.athleteReport ?? null;
  const judgment = obs.coachJudgment ?? null;
  const reasons: StopReason[] = [];
  let outcome: SafetyOutcome = "NONE";

  if (report !== null) {
    const redFlags = report.redFlags ?? [];
    const athleteSignal = report.painNow || redFlags.length > 0 || report.requestsStop === true;
    if (athleteSignal) reasons.push("SAFETY_STOP_ATHLETE");
    if (redFlags.length > 0) {
      const reported = new Set<string>(redFlags);
      const matched = policy.redFlagGroups.filter((g) => g.redFlags.some((flag) => reported.has(flag)));
      const worstGroup = matched.reduce<(typeof matched)[number] | null>(
        (worst, g) => (worst === null || g.severityRank > worst.severityRank ? g : worst),
        null,
      );
      // snapshot schema が全 RedFlag のグループ所属を保証するため worstGroup は必ずある。無ければ保守側に倒す。
      outcome = worseSafetyOutcome(outcome, worstGroup?.safetyOutcome ?? "MEDICAL_EVALUATION_RECOMMENDED");
    }
    if (report.painNow) outcome = worseSafetyOutcome(outcome, policy.painPresentOutcome);
    if (report.requestsStop === true) outcome = worseSafetyOutcome(outcome, NON_HEALTH_RUNTIME_STOP_OUTCOME);
  }
  if (judgment?.technique === "UNSAFE") {
    reasons.push("SAFETY_STOP_TECHNIQUE_UNSAFE");
    outcome = worseSafetyOutcome(outcome, NON_HEALTH_RUNTIME_STOP_OUTCOME);
  }
  if (judgment?.environmentUnsafe === true) {
    reasons.push("SAFETY_STOP_ENVIRONMENT");
    outcome = worseSafetyOutcome(outcome, NON_HEALTH_RUNTIME_STOP_OUTCOME);
  }

  if (reasons.length === 0) return { stop: false };
  // STOP_SAFETY で outcome が NONE のままになることはない（どの trigger も NONE 以外を与える）。
  return { stop: true, safetyOutcome: outcome === "NONE" ? NON_HEALTH_RUNTIME_STOP_OUTCOME : outcome, reasons };
}
