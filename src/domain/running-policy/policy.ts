import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";

/** Independent of the legacy running RuleSet and its method/template catalog. */
export const RUNNING_POLICY_VERSION = "rp-2026.09.0" as const;

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Only decisions confirmed by the coach are stored here. Array order is policy data. */
export const RUNNING_POLICY = freezeDeep({
  schemaVersion: 1,
  policyVersion: RUNNING_POLICY_VERSION,
  policySource: "COACH_DEFINED",
  coachStatus: "CONFIRMED",
  standardDistances: [30, 50, 60, 100, 120, 150, 200, 250, 300],
  rejectedDistances: [40, 80],
  rejectedDistanceAutomation: "DISABLED",
  applicability: {
    mode: "DEFAULT_APPLY_UNLESS_CONFLICT",
    explicitQualityLanguageRequired: false,
    humanExplicitNumbers: "PRESERVE_AND_REVIEW",
    explicitConflict: "COACH_REVIEW_REQUIRED",
  },
  phaseA: [
    { distanceMeters: 30, minReps: 3, defaultReps: 5, maxReps: 7, repRestMinSeconds: 120, defaultRepRestSeconds: 180, repRestMaxSeconds: 300 },
    { distanceMeters: 50, minReps: 3, defaultReps: 4, maxReps: 5, repRestMinSeconds: 180, defaultRepRestSeconds: 240, repRestMaxSeconds: 420 },
    { distanceMeters: 60, minReps: 3, defaultReps: 4, maxReps: 5, repRestMinSeconds: 180, defaultRepRestSeconds: 240, repRestMaxSeconds: 300 },
    { distanceMeters: 100, minReps: 2, defaultReps: 3, maxReps: 4, repRestMinSeconds: 480, defaultRepRestSeconds: 720, repRestMaxSeconds: 1080 },
    { distanceMeters: 120, minReps: 2, defaultReps: 3, maxReps: 4, repRestMinSeconds: 600, defaultRepRestSeconds: 900, repRestMaxSeconds: 1200 },
    { distanceMeters: 150, minReps: 2, defaultReps: 3, maxReps: 4, repRestMinSeconds: 720, defaultRepRestSeconds: 1080, repRestMaxSeconds: 1500 },
    { distanceMeters: 200, minReps: 1, defaultReps: 2, maxReps: 3, repRestMinSeconds: 720, defaultRepRestSeconds: 900, repRestMaxSeconds: 1800 },
    { distanceMeters: 250, minReps: 1, defaultReps: 1, maxReps: 2, repRestMinSeconds: 900, defaultRepRestSeconds: 1200, repRestMaxSeconds: 2100 },
    { distanceMeters: 300, minReps: 1, defaultReps: 1, maxReps: 2, repRestMinSeconds: 1200, defaultRepRestSeconds: 1200, repRestMaxSeconds: 2400 },
  ],
  phaseB: {
    defaultSets: 1,
    totalRepsAuthoritative: true,
    automaticSetSplit: "DISABLED",
    setSplitAuthority: "COACH_EXPLICIT_ONLY",
    setRestAutoDefault: "NONE",
    setRestMeaning: "TOTAL_INTERVAL_ACROSS_SET_BOUNDARY",
  },
  phaseC: {
    defaultIntensityPresentation: "PLAIN_LANGUAGE",
    executionInstructionOptional: true,
    internalIntensityBand: "NOT_ADOPTED",
    percentageIntensityDefault: "DISABLED",
    targetTimeAuthority: "COACH_EXPLICIT_ONLY",
    targetTimeAutoGeneration: "DISABLED",
    crossDistancePbConversion: "DISABLED",
  },
  phaseD: {
    ageCoefficient: "NONE",
    juniorHighAutomaticDistances: [30, 50, 60, 100, 120, 150],
    juniorHighHistoryOrCoachApprovalDistances: [200, 250, 300],
    highSchoolAndAdultBaseline: "ALL_STANDARD_DISTANCES",
    elementaryAutomaticApplication: "NOT_APPROVED",
    unknownHistoryIsInexperience: false,
  },
  phaseE: {
    normalRepsPosition: "DEFAULT",
    competitionDateAloneChangesReps: false,
    explicitLoadReductionRepsPosition: "MIN",
    fatigueReportOnlyRepsPosition: "DEFAULT",
    strongFatigueAction: "COACH_REVIEW_REQUIRED",
    automaticDistanceChange: "DISABLED",
    automaticRestChange: "DISABLED",
    maxRepsPositionUsed: false,
  },
  distanceSelection: {
    supportedEvents: ["100m", "200m"],
    explicitDistanceFirst: true,
    explicitSupportedDistanceOutsidePoolAllowed: true,
    historyAutoRotation: "NOT_ADOPTED",
    multipleAutomaticDistances: "DISABLED",
    events: [
      { event: "100m", normalPool: [30, 50, 60, 100, 120], defaultDistanceMeters: 60, shortOrder: [50, 30], longOrder: [100, 120] },
      { event: "200m", normalPool: [60, 100, 120, 150, 200], defaultDistanceMeters: 120, shortOrder: [100, 60], longOrder: [150, 200] },
    ],
  },
  timeGate: {
    optional: true,
    knownRestFormula: "SUM_INTER_REP_INTERVALS_PLUS_SET_BOUNDARY_INTERVALS",
    rejectWhenAvailableAtMostKnownRest: true,
    fullSessionTimeGuaranteed: false,
    automaticRestShortening: "DISABLED",
    automaticDistanceChange: "DISABLED",
  },
  aiNumericAuthority: 0,
} as const);

/** Canonical JSON + SHA-256, shared with existing domain integrity contracts. */
export function computeRunningPolicyHash(policy: unknown): string {
  return sha256Utf8Hex(canonicalStringify(policy));
}

export const RUNNING_POLICY_HASH = computeRunningPolicyHash(RUNNING_POLICY);

export type PhaseADistancePolicy = (typeof RUNNING_POLICY.phaseA)[number];
export type SupportedRunningEvent = (typeof RUNNING_POLICY.distanceSelection.supportedEvents)[number];

export function phaseAPolicyFor(distanceMeters: number): PhaseADistancePolicy | null {
  return RUNNING_POLICY.phaseA.find((entry) => entry.distanceMeters === distanceMeters) ?? null;
}

export function eventDistancePolicyFor(event: string) {
  return RUNNING_POLICY.distanceSelection.events.find((entry) => entry.event === event) ?? null;
}
