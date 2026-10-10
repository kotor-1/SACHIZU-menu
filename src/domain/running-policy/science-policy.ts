import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "./policy";

export const SCIENCE_POLICY_VERSION = "rp-science-2026.10.0";

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Initial operating defaults, explicitly authorized for implementation on 2026-10-10.
 * They are NOT a historical coach sign-off or experimentally established optimum.
 * Historical rp/rs versions and their hashes remain immutable.
 */
export const SCIENCE_POLICY = freezeDeep({
  version: SCIENCE_POLICY_VERSION,
  authority: "SCIENCE_INFORMED_DEFAULT",
  coachApproval: "NOT_COACH_APPROVED",
  provisional: true,
  evidence: {
    HAUGEN_2019: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6872694/",
    NSCA_LTAD_2016: "https://pubmed.ncbi.nlm.nih.gov/26933920/",
    MORAN_YOUTH_2017: "https://pubmed.ncbi.nlm.nih.gov/27793062/",
  },
  safety: { minimumHighIntensitySeparationHours: 48, maximumHighIntensitySessionsPer7Days: 2,
    childAccelerationAgeRange: [10, 12], childBasicAgeRange: [6, 12],
    highIntensityRequiresHistory: true, youthSupervisionRequired: true,
    advancedMethodsRequireExperiencedPostMaturity: true,
    elementaryMaturityMustBeExplicitIncludingUnknown: true,
    speedEnduranceModeMustBeExplicit: true,
    recoveryRunningDefault: "NONE", taperDefault: "FAMILIAR_RELAXED_ONLY_DAY_MINUS_ONE" },
  loadReduction: "CEIL_HALF_REPS_MIN_ONE_KEEP_REST",
  intensity: { controlledReference: "SAME_DISTANCE_AVERAGE_SPEED", controlledPercent: [90, 95],
    sprintSpecificReference: "MAX_INTENT_NOT_MEASURED_VMAX_PERCENT" },
  // Numeric defaults are conservative ENGINE_POLICY selections within/under the
  // reviewed examples, not numerical claims from NSCA or universal age scaling.
  rules: {
    SCI_ACC_INITIAL: { distanceMeters: 20, totalReps: 4, repRestSeconds: 120, method: "ACCELERATION", evidence: ["HAUGEN_2019", "MORAN_YOUTH_2017"] },
    SCI_ACC_EXPERIENCED: { distanceMeters: 30, totalReps: 4, repRestSeconds: 180, method: "ACCELERATION", evidence: ["HAUGEN_2019"] },
    SCI_ACC_CHILD_EXPOSURE: { distanceMeters: 10, totalReps: 4, repRestSeconds: 120, method: "ACCELERATION_TECHNIQUE", evidence: ["NSCA_LTAD_2016", "MORAN_YOUTH_2017"] },
    SCI_MV_INITIAL: { distanceMeters: 50, totalReps: 2, repRestSeconds: 240, method: "MAX_VELOCITY", evidence: ["HAUGEN_2019"] },
    SCI_SES_INITIAL: { distanceMeters: 100, totalReps: 2, repRestSeconds: 600, method: "SPRINT_SPECIFIC_ENDURANCE", evidence: ["HAUGEN_2019"] },
    SCI_SE_CONTROLLED: { distanceMeters: 60, totalReps: 4, repRestSeconds: 240, method: "SPEED_ENDURANCE_CONTROLLED", evidence: ["HAUGEN_2019"] },
    SCI_BASIC_INITIAL: { distanceMeters: 30, totalReps: 4, repRestSeconds: 90, method: "RELAXED_RUNNING_SKILL", evidence: ["NSCA_LTAD_2016"] },
    SCI_BASIC_CHILD: { distanceMeters: 10, totalReps: 4, repRestSeconds: 90, method: "RELAXED_RUNNING_SKILL", evidence: ["NSCA_LTAD_2016"] },
    SCI_PRECOMP_FAMILIAR: { distanceMeters: 80, totalReps: 2, repRestSeconds: 180, method: "FAMILIAR_RELAXED_STRIDE", evidence: ["HAUGEN_2019", "NSCA_LTAD_2016"] },
  },
} as const);
export type ScienceRuleId = keyof typeof SCIENCE_POLICY.rules;
export const SCIENCE_POLICY_HASH = sha256Utf8Hex(canonicalStringify(SCIENCE_POLICY));
export function isCurrentRunningPolicy(version: string, hash: string): boolean {
  return (version === RUNNING_POLICY_VERSION && hash === RUNNING_POLICY_HASH)
    || (version === SCIENCE_POLICY_VERSION && hash === SCIENCE_POLICY_HASH);
}
