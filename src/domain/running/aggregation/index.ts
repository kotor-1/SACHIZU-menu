/**
 * Running Prescription Engine v2 — §11 Session aggregation の公開 API。
 *
 * `evaluateSessionAggregation(items, ctx)` は **メニュー全体**を評価する。
 * 1項目だけを見て終わらせない（監査 C-1 / H-5）。
 *
 * R7 で `competitionDay`（§14.3 n=0）の実値を受け取れるようになった。48h/72h・履歴・phase・taper・
 * 週次負荷そのものの評価は weekly/ と competition/ の責務であり、ここでは行わない（実測 rep は R8/R9）。
 */
import type { Finding } from "../types/findings";
import type { QuantityInterval } from "../types/primitives";
import { accelIntervalFor, estimateExposure } from "./exposure";
import { adaptLegacyItem } from "./legacyAdapter";
import {
  hasUnknownBound,
  itemMethodVolume,
  itemNearMaxSprintVolumeM,
  itemTimeBreakdown,
  itemTotalRunningDistanceM,
  knownZero,
  sumIntervals,
  unknownInterval,
} from "./metrics";
import {
  evaluateHighIntensityBudget,
  evaluateMethodVolume,
  evaluateRestFeasibility,
  evaluateSessionVolumeLimits,
  methodAggregationRule,
  resolveItemCap,
  sessionFinding,
  type ItemBudgetInput,
} from "./rules";
import { aggregationContextInputSchema, aggregationItemSchema, type AggregationContext, type AggregationItem, type SessionAggregate } from "./schema";

export type { AggregationContext, AggregationItem, LegacyItemSummary, SessionAggregate } from "./schema";

type VolumeCategory = "LONG_SPRINT" | "TEMPO" | "STRIDE";

export function evaluateSessionAggregation(items: readonly AggregationItem[], ctx: AggregationContext): SessionAggregate {
  const parsedItems = items.map((i) => aggregationItemSchema.parse(i));
  aggregationContextInputSchema.parse({
    tier: ctx.tier,
    availableMinutes: ctx.availableMinutes,
    competitionDay: ctx.competitionDay,
    mode: ctx.mode,
  });
  const { ruleSet, tier } = ctx;
  const accel = accelIntervalFor(ruleSet, tier);

  const totalRunning: QuantityInterval<"m">[] = [];
  const exposure: QuantityInterval<"m">[] = [];
  const nearMax: QuantityInterval<"m">[] = [];
  const contacts: QuantityInterval<"contacts">[] = [];
  const byCategory: Record<VolumeCategory, QuantityInterval<"m">[]> = { LONG_SPRINT: [], TEMPO: [], STRIDE: [] };
  /** [R6 pre-commit correction] Method 全体の1個の上限ではなく、item ごとに実際に使っている
   * template/tier/recoveryStructure の Envelope 上限を紐づけて持つ（per-item normalized budget）。 */
  const budgetItems: ItemBudgetInput[] = [];
  const findings: Finding[] = [];
  let mandatoryRestS = 0;
  let knownRunningS = 0;
  let missingAccelInterval = false;
  /** [R7] 大会当日に race 以外の HIGH_* 項目があるか（§14.3 n=0 / R6 AGG_COMPETITION_DAY_EXTRA）。 */
  let hasNonRaceHighIntensityItem = false;

  for (const item of parsedItems) {
    if (item.kind === "LEGACY") {
      const c = adaptLegacyItem(ruleSet, item.item);
      totalRunning.push(c.totalRunningDistanceM);
      exposure.push(c.plannedHighSpeedExposureM);
      nearMax.push(c.nearMaxSprintVolumeM);
      contacts.push(c.plyometricContacts);
      mandatoryRestS += c.mandatoryRestS;
      if (c.contribution === "UNKNOWN" && item.item.distanceMeters !== null) {
        findings.push(sessionFinding("AGG_LEGACY_CATEGORY_UNKNOWN", "INFO", { metric: item.item.category }));
      }
      continue;
    }

    const p = item.prescription;
    const meta = ruleSet.methods.find((m) => m.method === p.method);
    const aggRule = methodAggregationRule(ruleSet, p.method);
    if (!meta || !aggRule) {
      findings.push(sessionFinding("AGG_METHOD_METADATA_MISSING", "WARN", { metric: p.method }));
      totalRunning.push(unknownInterval("m"));
      exposure.push(unknownInterval("m"));
      nearMax.push(unknownInterval("m"));
      continue;
    }
    const template = ruleSet.templates.find((t) => t.id === p.templateId);
    if (meta.loadClass === "HIGH_NEURAL" || meta.loadClass === "HIGH_METABOLIC") hasNonRaceHighIntensityItem = true;

    totalRunning.push(itemTotalRunningDistanceM(p));
    if (accel === null && meta.highSpeedExposureModel !== "NONE") missingAccelInterval = true;
    exposure.push(estimateExposure({ prescription: p, model: meta.highSpeedExposureModel, accel }));
    nearMax.push(itemNearMaxSprintVolumeM(p, aggRule, template?.approachType ?? null));
    contacts.push(knownZero("contacts"));

    if (aggRule.volumeCategory !== "NONE") byCategory[aggRule.volumeCategory].push(itemTotalRunningDistanceM(p));

    const contribution = itemMethodVolume(p, aggRule.volumeMetric);
    const cap = resolveItemCap({
      ruleSet,
      method: p.method,
      tier,
      metric: aggRule.volumeMetric,
      templateId: p.templateId,
      recoveryStructure: p.recoveryStructure,
    });
    budgetItems.push({ method: p.method, metric: aggRule.volumeMetric, templateId: p.templateId, contribution, cap });

    const time = itemTimeBreakdown(p);
    mandatoryRestS += time.mandatoryRestS;
    if (time.knownRunningS !== null) knownRunningS += time.knownRunningS;
  }

  const totalRunningDistanceM = sumIntervals("m", totalRunning);
  const plannedHighSpeedExposureM = sumIntervals("m", exposure);
  const nearMaxSprintVolumeM = sumIntervals("m", nearMax);
  const longSprintVolumeM = sumIntervals("m", byCategory.LONG_SPRINT);
  const tempoVolumeM = sumIntervals("m", byCategory.TEMPO);
  const strideVolumeM = sumIntervals("m", byCategory.STRIDE);
  const plyometricContacts = sumIntervals("contacts", contacts);

  if (missingAccelInterval) {
    findings.push(sessionFinding("AGG_ACCEL_INTERVAL_MISSING", "WARN", { metric: tier }));
  }
  // [R7] §14.3 n=0: 大会当日のセッションに race 以外の HIGH_* 項目があれば確認を求める。
  // race 自体は RUNNING_V2 の AggregationItem として表現されない（CompetitionRef は別 metadata）ため、
  // 「HIGH_* item が1つでもあれば race 以外」という判定でよい。
  if (ctx.competitionDay === true && hasNonRaceHighIntensityItem) {
    findings.push(sessionFinding("AGG_COMPETITION_DAY_EXTRA", "REQUIRE_COACH_REVIEW"));
  }
  findings.push(...evaluateMethodVolume({ items: budgetItems }));
  const budget = evaluateHighIntensityBudget({ ruleSet, items: budgetItems });
  findings.push(...budget.findings);
  findings.push(
    ...evaluateSessionVolumeLimits({ ruleSet, tier, volumes: { TEMPO: tempoVolumeM, STRIDE: strideVolumeM, LONG_SPRINT: longSprintVolumeM } }),
  );
  findings.push(...evaluateRestFeasibility({ availableMinutes: ctx.availableMinutes, mandatoryRestS, knownRunningS }));

  const aggregated: QuantityInterval[] = [
    totalRunningDistanceM,
    plannedHighSpeedExposureM,
    nearMaxSprintVolumeM,
    longSprintVolumeM,
    tempoVolumeM,
    strideVolumeM,
    plyometricContacts,
  ];
  const completeness = aggregated.some(hasUnknownBound) ? "PARTIAL" : "COMPLETE";
  if (completeness === "PARTIAL") findings.push(sessionFinding("AGG_INCOMPLETE_DATA", "INFO"));

  return {
    totalRunningDistanceM,
    plannedHighSpeedExposureM,
    // R6（計画時）は実測記録を持たない。「未実測だから 0」にはしない。
    actualHighSpeedExposureM: null,
    nearMaxSprintVolumeM,
    longSprintVolumeM,
    tempoVolumeM,
    strideVolumeM,
    plyometricContacts,
    strengthLoad: null,
    // race / relay は standalone 入力（R7 の大会判定はここに無い）。R6 の planning 経路では常に 0 件。
    raceExposure: { count: 0, distanceM: knownZero("m") },
    relayExposure: { count: 0, legDistanceM: knownZero("m") },
    highIntensityBudgetUse: { recommended: budget.recommended, coachEditable: budget.coachEditable },
    highIntensityMethods: budget.highIntensityMethods,
    completeness,
    findings,
  };
}
