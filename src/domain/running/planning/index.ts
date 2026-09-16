/**
 * Running Prescription Engine v2 — planRunningPrescription()（§1.5, §9）。
 *
 * RuleSet は PlanRequest で指定させない（§9.1 / §18.1）。`planningDate` を基準に
 * `getActiveRuleSet()` が選ぶ（ACTIVE が無ければ最新 DRAFT。contentHash は検証済み manifest から）。
 * domain は現在時刻を読まない（`Date.now()` / `new Date()` を使わない）。
 *
 * `planRunningPrescriptionWithRuleSet` はテスト用に RuleSet を差し替える口（§9.1「loader を差し替える口
 * だけ用意」）。root の `src/domain/running/index.ts` からは export しない。
 */
import { getActiveRuleSet } from "../rules/loader";
import { isValidCalendarDate, itemFinding, type PlanRequest, type PlanResult } from "./schema";
import { planWithResolvedRuleSet, type ResolvedRuleSet } from "./build";

export function planRunningPrescription(request: PlanRequest): PlanResult {
  const planningDate = (request as { planningDate?: unknown } | null)?.planningDate;
  if (typeof planningDate !== "string" || !isValidCalendarDate(planningDate)) {
    return { status: "BLOCKED", findings: [itemFinding("PLAN_REQUEST_INVALID", "BLOCK", { metric: "planningDate" })] };
  }
  const active = getActiveRuleSet(planningDate);
  return planWithResolvedRuleSet(request, active);
}

/** テスト専用: RuleSet を明示して計画する（本番経路は planRunningPrescription）。 */
export function planRunningPrescriptionWithRuleSet(request: unknown, resolved: ResolvedRuleSet): PlanResult {
  return planWithResolvedRuleSet(request, resolved);
}

export type { PlanRequest, PlanResult, EligibilityReason, CoachFieldEdit, CoachOverride, CoachReferenceInput } from "./schema";
export type { ResolvedRuleSet } from "./build";
