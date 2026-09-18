/**
 * Running Prescription Engine v2 — planRunningPrescription()（§1.5, §9）。
 *
 * RuleSet は PlanRequest で指定させない（§9.1 / §18.1）。`planningDate` を基準に
 * `getActiveRuleSet()` が選ぶ（ACTIVE が無ければ最新 DRAFT。contentHash は検証済み manifest から）。
 * domain は現在時刻を読まない（`Date.now()` / `new Date()` を使わない）。
 *
 * `planRunningPrescriptionWithRuleSet` は、RuleSet の選択を呼び出し側に委ねる版。R1〜R9 ではテスト専用
 * だったが、[R10-B1] で application layer 向けの **production API** に昇格した。R10 の通常編集・
 * override・「現行ルールで再計算」は、それぞれ `getRuleSetByIdentity()`（保存済み版を固定）
 * または `getActiveRuleSet()`（明示的な再計算だけ）で解決した `ResolvedRuleSet` を渡してこの関数を呼ぶ
 * （§16。active selector による通常編集時の silent upgrade を防ぐ）。`planRunningPrescription()` 自体の
 * 挙動（`getActiveRuleSet` を内部で使う）はそのまま維持し、壊さない。
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

/**
 * RuleSet を明示して計画する。[R10-B1] からは application layer の production API
 * （通常編集・override・明示的な再計算が、保存済み版または active 版を明示的に選んでここへ渡す）。
 */
export function planRunningPrescriptionWithRuleSet(request: unknown, resolved: ResolvedRuleSet): PlanResult {
  return planWithResolvedRuleSet(request, resolved);
}

export type { PlanRequest, PlanResult, EligibilityReason, CoachFieldEdit, CoachOverride, CoachReferenceInput } from "./schema";
export type { ResolvedRuleSet } from "./build";
