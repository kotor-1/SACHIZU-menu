import { z } from "zod";

// A discriminated extension of the existing JSON column, never a legacy Running context.
export const confirmedCompositionContextSchema = z.object({
  kind: z.literal("MENU_COMPOSITION"), schemaVersion: z.literal(1),
  confirmedPlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export function isComposedMenuContext(json: string | null): boolean {
  try { return confirmedCompositionContextSchema.safeParse(JSON.parse(json ?? "null")).success; } catch { return false; }
}
