import {
  runningPolicyInputSchema,
  type ParsedRunningPolicyInput,
  type RunningDecisionReason,
  type RunningFailureReason,
  type RunningPolicyResult,
  type RunningPrescription,
} from "./contracts";
import {
  eventDistancePolicyFor,
  phaseAPolicyFor,
  RUNNING_POLICY,
  RUNNING_POLICY_HASH,
  RUNNING_POLICY_VERSION,
} from "./policy";
import { unsupportedPurposeReason } from "./purpose";
import { planScienceRunning } from "./science-plan";

type StopStatus = "NEEDS_INPUT" | "NEEDS_POLICY" | "COACH_REVIEW_REQUIRED" | "BLOCKED";
type StopReason = Exclude<RunningFailureReason, "AVAILABLE_TIME_TOO_SHORT">;

function stop(
  status: StopStatus,
  reason: StopReason,
  input: ParsedRunningPolicyInput | null,
  selectedDistanceMeters: number | null = null,
): RunningPolicyResult {
  return {
    status,
    reason,
    policyVersion: RUNNING_POLICY_VERSION,
    policyHash: RUNNING_POLICY_HASH,
    humanExplicitDistances: input?.humanExplicitDistances.slice() ?? [],
    selectedDistanceMeters,
    humanExplicitNumbers: input?.humanExplicitNumbers ?? null,
  };
}

function knownRestSeconds(
  totalReps: number,
  repRestSeconds: number,
  setReps: readonly number[] | null,
  setRestSeconds: number | null,
): number {
  if (setReps === null) return Math.max(0, totalReps - 1) * repRestSeconds;
  // A set boundary replaces the ordinary inter-rep interval. It does not add to it.
  return setReps.reduce((sum, reps) => sum + Math.max(0, reps - 1) * repRestSeconds, 0)
    + (setReps.length - 1) * (setRestSeconds ?? 0);
}

/**
 * Pure, deterministic first-phase engine. Callers must attest that human- and
 * coach-explicit inputs came from their respective authenticated sources.
 */
export function planRunningPrescription(input: unknown): RunningPolicyResult {
  const parsed = runningPolicyInputSchema.safeParse(input);
  if (!parsed.success) return stop("BLOCKED", "INVALID_INPUT", null);
  const request = parsed.data;

  // Distance selection is intentionally single-valued. Retain the original list
  // on review, including its order, instead of choosing one silently.
  const distinctExplicit = [...new Set(request.humanExplicitDistances)];
  if (distinctExplicit.length > 1) {
    return stop("COACH_REVIEW_REQUIRED", "MULTIPLE_EXPLICIT_DISTANCES", request);
  }

  // Safety holds precede purpose policy: an unsupported goal cannot hide an
  // explicit serious fatigue or illness concern behind an irrelevant event prompt.
  if (request.fatigueState === "STRONG_OR_UNWELL") {
    return stop("COACH_REVIEW_REQUIRED", "STRONG_FATIGUE_OR_UNWELL", request);
  }
  // Historical coach policy is unchanged. Purpose requests use a separately
  // versioned scientific default and explicit athlete context, never AI doses.
  if (request.purpose || request.intensityPreference || request.competitionDays === 1) {
    return planScienceRunning(request);
  }
  // These policy gates do not require an event to be meaningful. Keep the
  // elementary protection visible even when the athlete has not supplied one.
  if (request.ageGroup === "ELEMENTARY") {
    return stop("NEEDS_POLICY", "ELEMENTARY_POLICY_NOT_APPROVED", request);
  }
  const purposeReason = unsupportedPurposeReason(request.purpose, request.intensityPreference);
  if (purposeReason !== null) return stop("NEEDS_POLICY", purposeReason, request);

  const explicitDistance = distinctExplicit[0] ?? null;
  if (explicitDistance !== null && phaseAPolicyFor(explicitDistance) === null) {
    return stop("COACH_REVIEW_REQUIRED", "HUMAN_EXPLICIT_UNSUPPORTED_DISTANCE", request, explicitDistance);
  }

  if (request.event === undefined) return stop("NEEDS_INPUT", "EVENT_REQUIRED", request, explicitDistance);
  const eventPolicy = eventDistancePolicyFor(request.event);
  if (eventPolicy === null) return stop("NEEDS_POLICY", "EVENT_POLICY_NOT_SUPPORTED", request, explicitDistance);

  const decisionReasons: RunningDecisionReason[] = [];
  let distanceMeters: number;
  if (explicitDistance !== null) {
    distanceMeters = explicitDistance;
    decisionReasons.push("HUMAN_EXPLICIT_DISTANCE_SELECTED");
  } else if (request.distancePreference === "SHORT") {
    distanceMeters = eventPolicy.shortOrder[0];
    decisionReasons.push("SHORT_PREFERENCE_SELECTED");
  } else if (request.distancePreference === "LONG") {
    distanceMeters = eventPolicy.longOrder[0];
    decisionReasons.push("LONG_PREFERENCE_SELECTED");
  } else {
    distanceMeters = eventPolicy.defaultDistanceMeters;
    decisionReasons.push("EVENT_DEFAULT_DISTANCE_SELECTED");
  }

  const distancePolicy = phaseAPolicyFor(distanceMeters);
  if (distancePolicy === null) return stop("BLOCKED", "POLICY_INTEGRITY_FAILURE", request, distanceMeters);
  if (request.ageGroup === undefined || request.ageGroup === "UNKNOWN") {
    return stop("NEEDS_INPUT", "AGE_REQUIRED", request, distanceMeters);
  }
  if (
    request.ageGroup === "JUNIOR_HIGH"
    && RUNNING_POLICY.phaseD.juniorHighHistoryOrCoachApprovalDistances.some((distance) => distance === distanceMeters)
  ) {
    if (request.similarDistanceHistoryStatus === "CONFIRMED") {
      decisionReasons.push("SIMILAR_DISTANCE_HISTORY_CONFIRMED");
    } else if (request.coachAgeGateApproval) {
      decisionReasons.push("COACH_AGE_GATE_APPROVED");
    } else {
      return stop("COACH_REVIEW_REQUIRED", "JUNIOR_HIGH_LONG_DISTANCE_HISTORY_REQUIRED", request, distanceMeters);
    }
  }

  if (request.standardPolicyConflict) {
    return stop("COACH_REVIEW_REQUIRED", "PHASE_A_CONFLICT", request, distanceMeters);
  }
  if (request.humanExplicitNumbers?.totalReps !== undefined || request.humanExplicitNumbers?.repRestSeconds !== undefined) {
    return stop("COACH_REVIEW_REQUIRED", "HUMAN_EXPLICIT_NUMBERS_REQUIRE_REVIEW", request, distanceMeters);
  }
  if (
    (request.coachTargetTimeSeconds !== undefined && request.coachTargetTimeRange !== undefined)
    || (request.coachTargetTimeRange !== undefined
      && request.coachTargetTimeRange.minSeconds > request.coachTargetTimeRange.maxSeconds)
  ) {
    return stop("BLOCKED", "COACH_TARGET_TIME_CONFLICT", request, distanceMeters);
  }

  const repsPosition = request.loadReductionRequested
    ? RUNNING_POLICY.phaseE.explicitLoadReductionRepsPosition
    : RUNNING_POLICY.phaseE.normalRepsPosition;
  const totalReps = request.loadReductionRequested ? distancePolicy.minReps : distancePolicy.defaultReps;
  const repsReductionApplied = totalReps < distancePolicy.defaultReps;
  if (request.loadReductionRequested) {
    decisionReasons.push(repsReductionApplied ? "LOAD_REDUCTION_APPLIED" : "LOAD_REDUCTION_NO_REP_CHANGE");
  }
  if (request.fatigueState === "REPORTED") decisionReasons.push("FATIGUE_REPORT_PRESERVED");

  let setReps: number[] | null = null;
  let setRestSeconds: number | null = null;
  if (request.coachSetSplit !== undefined) {
    if (request.coachSetSplit.setRestSeconds === undefined) {
      return stop("BLOCKED", "COACH_SET_SPLIT_INCOMPLETE", request, distanceMeters);
    }
    if (request.coachSetSplit.setReps.reduce((sum, reps) => sum + reps, 0) !== totalReps) {
      return stop("BLOCKED", "COACH_SET_REPS_MISMATCH", request, distanceMeters);
    }
    setReps = request.coachSetSplit.setReps.slice();
    setRestSeconds = request.coachSetSplit.setRestSeconds;
    decisionReasons.push("COACH_SET_SPLIT_APPLIED");
  }

  const minimumKnownRestSeconds = knownRestSeconds(
    totalReps,
    distancePolicy.defaultRepRestSeconds,
    setReps,
    setRestSeconds,
  );
  const prescription: RunningPrescription = {
    policyVersion: RUNNING_POLICY_VERSION,
    policyHash: RUNNING_POLICY_HASH,
    event: eventPolicy.event,
    distanceMeters,
    totalReps,
    totalDistanceMeters: distanceMeters * totalReps,
    repsPosition,
    repRestSeconds: totalReps === 1 ? null : distancePolicy.defaultRepRestSeconds,
    sets: setReps?.length ?? RUNNING_POLICY.phaseB.defaultSets,
    setReps,
    setRestSeconds,
    intensityPresentation: RUNNING_POLICY.phaseC.defaultIntensityPresentation,
    executionInstructionText: request.executionInstructionText ?? null,
    coachTargetTimeSeconds: request.coachTargetTimeSeconds ?? null,
    coachTargetTimeRange: request.coachTargetTimeRange ?? null,
    loadReductionRequested: request.loadReductionRequested,
    repsReductionApplied,
    minimumKnownRestSeconds,
    fullSessionTimeGuaranteed: false,
    decisionReasons,
  };

  // competitionDays is deliberately retained as request context and has no
  // automatic dose effect under this policy (competitionDateAloneChangesReps=false).

  if (request.availableTimeSeconds !== undefined && request.availableTimeSeconds <= minimumKnownRestSeconds) {
    return {
      status: "NEEDS_TIME_ADJUSTMENT",
      reason: "AVAILABLE_TIME_TOO_SHORT",
      policyVersion: RUNNING_POLICY_VERSION,
      policyHash: RUNNING_POLICY_HASH,
      humanExplicitDistances: request.humanExplicitDistances.slice(),
      selectedDistanceMeters: distanceMeters,
      candidate: prescription,
    };
  }

  return {
    status: "READY",
    policyVersion: RUNNING_POLICY_VERSION,
    policyHash: RUNNING_POLICY_HASH,
    humanExplicitDistances: request.humanExplicitDistances.slice(),
    selectedDistanceMeters: distanceMeters,
    prescription,
  };
}
