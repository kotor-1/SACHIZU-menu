import { z } from "zod";
import { RUNNING_INTENSITY_PREFERENCES, RUNNING_PURPOSES } from "./purpose";
import { runningScienceContextSchema, type RunningSciencePrescription } from "./science-contracts";

export const runningPolicyInputSchema = z.object({
  science: runningScienceContextSchema.optional(),
  event: z.string().trim().min(1).max(32).optional(),
  ageGroup: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT", "UNKNOWN"]).optional(),
  /** Already extracted and verified as a human request by the future adapter. */
  humanExplicitDistances: z.array(z.number().int().positive()).max(20).default([]),
  distancePreference: z.enum(["NONE", "SHORT", "LONG"]).default("NONE"),
  loadReductionRequested: z.boolean().default(false),
  fatigueState: z.enum(["NONE", "REPORTED", "STRONG_OR_UNWELL"]).default("NONE"),
  /** Sourced user intent. Values are understood but currently have no approved purpose dose. */
  purpose: z.enum(RUNNING_PURPOSES).optional(),
  /** Explicit low-intensity preference; never aliases volume reduction. */
  intensityPreference: z.enum(RUNNING_INTENSITY_PREFERENCES).optional(),
  /** Context only. The active policy does not change a dose from competition date alone. */
  competitionDays: z.number().int().nonnegative().optional(),
  similarDistanceHistoryStatus: z.enum(["CONFIRMED", "UNKNOWN"]).default("UNKNOWN"),
  coachAgeGateApproval: z.boolean().default(false),
  availableTimeSeconds: z.number().int().positive().optional(),
  executionInstructionText: z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f-\u009f<>]*$/u).optional(),
  /** Coach-authenticated values. No value is inferred from a PB or another distance. */
  coachTargetTimeSeconds: z.number().finite().positive().optional(),
  coachTargetTimeRange: z.object({
    minSeconds: z.number().finite().positive(),
    maxSeconds: z.number().finite().positive(),
  }).strict().optional(),
  /** Set rest is the whole interval at the boundary, not rep rest plus set rest. */
  coachSetSplit: z.object({
    setReps: z.array(z.number().int().positive()).min(2).max(20),
    setRestSeconds: z.number().int().positive().optional(),
  }).strict().optional(),
  /** Explicit non-distance numbers are preserved for review, never silently replaced. */
  humanExplicitNumbers: z.object({
    totalReps: z.number().int().positive().optional(),
    repRestSeconds: z.number().int().positive().optional(),
  }).strict().optional(),
  standardPolicyConflict: z.boolean().default(false),
}).strict();

export type RunningPolicyInput = z.input<typeof runningPolicyInputSchema>;
export type ParsedRunningPolicyInput = z.output<typeof runningPolicyInputSchema>;

export const RUNNING_DECISION_STATUSES = [
  "READY", "NEEDS_INPUT", "NEEDS_POLICY", "NEEDS_TIME_ADJUSTMENT", "COACH_REVIEW_REQUIRED", "BLOCKED",
] as const;
export type RunningDecisionStatus = (typeof RUNNING_DECISION_STATUSES)[number];

export const RUNNING_FAILURE_REASONS = [
  "INVALID_INPUT",
  "EVENT_REQUIRED",
  "AGE_REQUIRED",
  "EVENT_POLICY_NOT_SUPPORTED",
  "ELEMENTARY_POLICY_NOT_APPROVED",
  "ACCEL_PURPOSE_NOT_APPROVED",
  "MAX_SPEED_PURPOSE_NOT_APPROVED",
  "SPEED_ENDURANCE_PURPOSE_NOT_APPROVED",
  "BASIC_PURPOSE_NOT_APPROVED",
  "PRECOMP_PURPOSE_NOT_APPROVED",
  "RECOVERY_PURPOSE_NOT_APPROVED",
  "LOW_INTENSITY_NOT_APPROVED",
  "MULTIPLE_EXPLICIT_DISTANCES",
  "HUMAN_EXPLICIT_UNSUPPORTED_DISTANCE",
  "JUNIOR_HIGH_LONG_DISTANCE_HISTORY_REQUIRED",
  "STRONG_FATIGUE_OR_UNWELL",
  "PHASE_A_CONFLICT",
  "HUMAN_EXPLICIT_NUMBERS_REQUIRE_REVIEW",
  "COACH_SET_SPLIT_INCOMPLETE",
  "COACH_SET_REPS_MISMATCH",
  "COACH_TARGET_TIME_CONFLICT",
  "AVAILABLE_TIME_TOO_SHORT",
  "POLICY_INTEGRITY_FAILURE",
  "SCIENCE_CONTEXT_REQUIRED", "AGE_CONTEXT_CONFLICT", "SCIENCE_POPULATION_NOT_SUPPORTED",
  "SCIENCE_HEALTH_CONFIRMATION_REQUIRED", "SCIENCE_EXPERIENCE_REQUIRED", "SCIENCE_SUPERVISION_REQUIRED",
  "SCIENCE_FAMILIARITY_REQUIRED", "SCIENCE_RECOVERY_INTERVAL_REQUIRED", "SCIENCE_RECOVERY_INTERVAL_VIOLATION",
  "SCIENCE_FREQUENCY_LIMIT", "SCIENCE_MATURITY_REQUIRED", "SCIENCE_REFERENCE_REQUIRED", "SCIENCE_ENDURANCE_MODE_REQUIRED",
  "SCIENCE_EXPLICIT_INPUT_REVIEW", "RECOVERY_REST_PREFERRED", "SCIENCE_COMPETITION_CONTEXT_REQUIRED",
  "SCIENCE_TAPER_WINDOW_REVIEW",
] as const;
export type RunningFailureReason = (typeof RUNNING_FAILURE_REASONS)[number];

export const RUNNING_DECISION_REASONS = [
  "HUMAN_EXPLICIT_DISTANCE_SELECTED",
  "SHORT_PREFERENCE_SELECTED",
  "LONG_PREFERENCE_SELECTED",
  "EVENT_DEFAULT_DISTANCE_SELECTED",
  "LOAD_REDUCTION_APPLIED",
  "LOAD_REDUCTION_NO_REP_CHANGE",
  "FATIGUE_REPORT_PRESERVED",
  "COACH_SET_SPLIT_APPLIED",
  "COACH_AGE_GATE_APPROVED",
  "SIMILAR_DISTANCE_HISTORY_CONFIRMED",
  "SCIENCE_DEFAULT_SELECTED", "COMPETITION_CONTEXT_APPLIED", "LOW_INTENSITY_CONTEXT_APPLIED",
] as const;
export type RunningDecisionReason = (typeof RUNNING_DECISION_REASONS)[number];

export type RunningPrescription = {
  policyVersion: string;
  policyHash: string;
  event: "100m" | "200m" | "GENERAL";
  science?: RunningSciencePrescription;
  distanceMeters: number;
  totalReps: number;
  totalDistanceMeters: number;
  repsPosition: "DEFAULT" | "MIN";
  /** Null when there is only one run: no interval exists to execute or display. */
  repRestSeconds: number | null;
  sets: number;
  setReps: number[] | null;
  setRestSeconds: number | null;
  intensityPresentation: "PLAIN_LANGUAGE";
  executionInstructionText: string | null;
  coachTargetTimeSeconds: number | null;
  coachTargetTimeRange: { minSeconds: number; maxSeconds: number } | null;
  loadReductionRequested: boolean;
  repsReductionApplied: boolean;
  minimumKnownRestSeconds: number;
  fullSessionTimeGuaranteed: false;
  decisionReasons: RunningDecisionReason[];
};

type DecisionBase = {
  policyVersion: string;
  policyHash: string;
  humanExplicitDistances: number[];
  selectedDistanceMeters: number | null;
};

export type RunningPolicyResult =
  | (DecisionBase & { status: "READY"; prescription: RunningPrescription })
  | (DecisionBase & {
      status: "NEEDS_TIME_ADJUSTMENT";
      reason: "AVAILABLE_TIME_TOO_SHORT";
      /** Rejected candidate is retained for inspection; it is not an executable prescription. */
      candidate: RunningPrescription;
    })
  | (DecisionBase & {
      status: "NEEDS_INPUT" | "NEEDS_POLICY" | "COACH_REVIEW_REQUIRED" | "BLOCKED";
      reason: Exclude<RunningFailureReason, "AVAILABLE_TIME_TOO_SHORT">;
      humanExplicitNumbers: ParsedRunningPolicyInput["humanExplicitNumbers"] | null;
    });
