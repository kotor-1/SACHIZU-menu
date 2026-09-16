/**
 * Running Prescription Engine v2 — legacy 項目（v2 ではない MenuItem）の集計変換（§11.2 の legacy 行）。
 *
 * legacy の `sets` / `reps` は意味が確定していない（監査 C-1）。数を確定させずに **区間**で表す:
 *   下限 = 距離 × sets、上限 = 距離 × sets × (reps ?? 1)
 *
 * category が走なのか接地なのかは **RuleSet の LEGACY_CATEGORY** が決める。
 * RuleSet に無い category は「走ではない」と決めつけず UNKNOWN として扱う。
 * legacy には強度の情報が無いため、**高速曝露を 0 と決めつけない**（unknown を伝播する）。
 */
import type { AggregationRule, LegacyCategoryContribution, RuleSet } from "../rules/schema";
import type { QuantityInterval } from "../types/primitives";
import type { LegacyItemSummary } from "./schema";
import { interval, knownZero, unknownInterval } from "./metrics";

export type LegacyContribution = {
  contribution: LegacyCategoryContribution;
  totalRunningDistanceM: QuantityInterval<"m">;
  /** legacy は強度が分からないので「不明」。走らない category だけ既知の 0。 */
  plannedHighSpeedExposureM: QuantityInterval<"m">;
  nearMaxSprintVolumeM: QuantityInterval<"m">;
  plyometricContacts: QuantityInterval<"contacts">;
  mandatoryRestS: number;
};

export function legacyCategoryContribution(ruleSet: RuleSet, category: string): LegacyCategoryContribution {
  const rule = ruleSet.aggregationRules.find(
    (r): r is Extract<AggregationRule, { kind: "LEGACY_CATEGORY" }> => r.kind === "LEGACY_CATEGORY" && r.category === category,
  );
  return rule ? rule.contribution : "UNKNOWN";
}

/** §11.2: 下限 = d × sets、上限 = d × sets × (reps ?? 1)。 */
export function legacyDistanceInterval(item: LegacyItemSummary): QuantityInterval<"m"> {
  if (item.distanceMeters === null) return unknownInterval("m");
  const sets = item.sets ?? 1;
  const lower = item.distanceMeters * sets;
  const upper = lower * (item.reps ?? 1);
  return interval(lower, upper, "m", "ESTIMATED", "LOW");
}

/** §11.2: 下限 = sets × (reps ?? 1)、上限 = reps が null なら null。 */
export function legacyContacts(item: LegacyItemSummary): QuantityInterval<"contacts"> {
  const sets = item.sets ?? 1;
  const lower = sets * (item.reps ?? 1);
  const upper = item.reps === null ? null : sets * item.reps;
  return interval(lower, upper, "contacts", "ESTIMATED", "LOW");
}

function legacyMandatoryRestS(item: LegacyItemSummary): number {
  if (item.restSeconds === null) return 0;
  const sets = item.sets ?? 1;
  const reps = item.reps ?? 1;
  // legacy は rest の適用単位が定義されていないため、本間だけを数える（セット間を二重計上しない）。
  return sets * Math.max(0, reps - 1) * item.restSeconds;
}

export function adaptLegacyItem(ruleSet: RuleSet, item: LegacyItemSummary): LegacyContribution {
  const contribution = legacyCategoryContribution(ruleSet, item.category);
  const mandatoryRestS = legacyMandatoryRestS(item);

  if (contribution === "CONTACTS") {
    return {
      contribution,
      totalRunningDistanceM: knownZero("m"),
      plannedHighSpeedExposureM: knownZero("m"),
      nearMaxSprintVolumeM: knownZero("m"),
      plyometricContacts: legacyContacts(item),
      mandatoryRestS,
    };
  }

  if (contribution === "NOT_RUNNING") {
    return {
      contribution,
      totalRunningDistanceM: knownZero("m"),
      plannedHighSpeedExposureM: knownZero("m"),
      nearMaxSprintVolumeM: knownZero("m"),
      plyometricContacts: knownZero("contacts"),
      mandatoryRestS,
    };
  }

  if (contribution === "UNKNOWN") {
    // 距離が入っていない項目は集計対象になる量が無い（既知の 0）。距離があるのに category の意味が
    // 確定しない場合だけ unknown を伝播する（勝手に走／走でないを決めない）。
    const hasDistance = item.distanceMeters !== null;
    return {
      contribution,
      totalRunningDistanceM: hasDistance ? unknownInterval("m") : knownZero("m"),
      plannedHighSpeedExposureM: hasDistance ? unknownInterval("m") : knownZero("m"),
      nearMaxSprintVolumeM: hasDistance ? unknownInterval("m") : knownZero("m"),
      plyometricContacts: knownZero("contacts"),
      mandatoryRestS,
    };
  }

  // RUNNING_DISTANCE
  return {
    contribution,
    totalRunningDistanceM: legacyDistanceInterval(item),
    // 強度が分からないので「高速で走った距離」は不明（0 と決めつけない）。
    plannedHighSpeedExposureM: unknownInterval("m"),
    nearMaxSprintVolumeM: unknownInterval("m"),
    plyometricContacts: knownZero("contacts"),
    mandatoryRestS,
  };
}
