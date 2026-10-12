import { z } from "zod";
import { durationPlanSchema } from "./duration";
import { menuOverviewSchema } from "./contracts";
import { trainingProposalSavedStateSchema } from "@/domain/training-proposal/contracts";

// A discriminated extension of the existing JSON column, never a legacy Running context.
export const confirmedCompositionContextSchema = z.object({
  kind: z.literal("MENU_COMPOSITION"), schemaVersion: z.literal(1),
  requestedTimeSeconds: z.number().int().positive().nullable().optional(),
  durationPlan: durationPlanSchema.optional(),
  overview: menuOverviewSchema.optional(), athleteLabel: z.string().max(80).optional(),
  confirmedPlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  trainingProposal: trainingProposalSavedStateSchema.optional(),
}).strict();
export function parseConfirmedCompositionContext(json: string | null) {
  try {
    const parsed = confirmedCompositionContextSchema.safeParse(JSON.parse(json ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export function isComposedMenuContext(json: string | null): boolean {
  return parseConfirmedCompositionContext(json) !== null;
}
