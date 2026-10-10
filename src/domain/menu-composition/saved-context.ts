import { z } from "zod";
import { durationPlanSchema } from "./duration";

// A discriminated extension of the existing JSON column, never a legacy Running context.
export const confirmedCompositionContextSchema = z.object({
  kind: z.literal("MENU_COMPOSITION"), schemaVersion: z.literal(1),
  requestedTimeSeconds: z.number().int().positive().nullable().optional(),
  durationPlan: durationPlanSchema.optional(),
  confirmedPlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
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
