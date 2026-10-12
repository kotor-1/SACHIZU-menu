import { z } from "zod";

/** Scheduling authority only. These budgets never authorize additional exercise dose. */
export const SESSION_ROLES = ["WARM_UP", "TECHNIQUE", "MAIN", "SUPPORT", "COOL_DOWN", "FOCUSED"] as const;
export type SessionRole = typeof SESSION_ROLES[number];
export type AppSessionPlan = {
  version: "app-session-plan-v1";
  id: string;
  requestedSeconds: number | null;
  scope: "WHOLE_SESSION" | "FOCUSED";
  blocks: Array<{
    id: string; role: SessionRole; phase: "WARM_UP" | "DRILLS_STRENGTH" | "RUNNING" | "COOL_DOWN" | "OTHER";
    name: string; purpose: string; required: boolean; budgetSeconds: number | null;
    candidateIds: string[];
  }>;
  transitionBudgetSeconds: number | null;
  constraints: Array<{ code: string; message: string }>;
  rationale: string[];
  allowsLowLoadShortening: boolean;
};

const seconds = z.number().int().min(0).max(604800);
/** Work/rest remain separate from instruction and setup, including for timed holds. */
export const itemTimingEvidenceSchema = z.object({
  workSeconds: seconds,
  restSeconds: seconds,
  instructionSeconds: seconds,
  preparationSeconds: seconds,
  basis: z.object({
    kind: z.enum(["TIMED_DOSE", "REP_TEMPO", "DISTANCE_PACE", "RUNNING_ESTIMATE"]),
    units: z.number().finite().positive().max(10000000),
    secondsPerUnit: z.number().finite().positive().max(86400),
    description: z.string().trim().min(1).max(400),
    uncertainty: z.string().trim().min(1).max(240),
    source: z.literal("PLANNING_ESTIMATE"),
  }).strict(),
  intensity: z.object({ mode: z.enum(["DESCRIBED", "UNSPECIFIED"]), explanation: z.string().trim().min(1).max(240) }).strict(),
  restExplanation: z.string().trim().min(1).max(240),
  instructionDescription: z.string().trim().max(240),
  preparationDescription: z.string().trim().max(240),
}).strict();
export type ItemTimingEvidence = z.infer<typeof itemTimingEvidenceSchema>;
export const proposalPlanningSchema = z.object({
  planId: z.string().min(1).max(80),
  claimedTotalSeconds: seconds,
  shortfallReason: z.enum(["NONE", "FIXED_RUNNING_DOSE", "EXPLICIT_LOW_LOAD", "MISSING_CANDIDATES", "UNRESOLVED_DETAILS"]),
  explanation: z.string().trim().min(1).max(400),
  omittedBlocks: z.array(z.object({ planBlockId: z.string().min(1).max(80), reason: z.string().trim().min(1).max(240) }).strict()).max(12),
}).strict();

export const proposalQualitySchema = z.object({
  version: z.literal("proposal-quality-v1"),
  status: z.enum(["READY", "SHORTER_PROPOSAL", "INCOMPLETE"]),
  requestedSeconds: seconds.nullable(),
  proposedSeconds: seconds.nullable(),
  explanation: z.string().max(400),
  issues: z.array(z.object({ code: z.string().min(1).max(80), message: z.string().min(1).max(240),
    blockIndex: z.number().int().nonnegative().optional(), itemIndex: z.number().int().nonnegative().optional() }).strict()).max(300),
  basisDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type ProposalQuality = z.infer<typeof proposalQualitySchema>;
