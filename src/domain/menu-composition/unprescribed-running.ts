import { z } from "zod";

export const UNPRESCRIBED_RUNNING_KIND = "RUNNING_UNPRESCRIBED" as const;
export const unprescribedRunningContextSchema = z.object({
  reasonCode: z.string().min(1).max(100), reasonMessage: z.string().min(1).max(500),
}).strict();
export type UnprescribedRunningContext = z.infer<typeof unprescribedRunningContextSchema>;

/** Storage bounds only. These values can be entered by a person, never by the composer. */
export const unprescribedRunningItemSchema = unprescribedRunningContextSchema.extend({
  type: z.literal("UNPRESCRIBED_RUNNING"), id: z.string().min(1).max(80), plannedNote: z.string().max(1000),
  plannedSets: z.number().int().min(1).max(99).nullable(),
  plannedReps: z.number().int().min(1).max(999).nullable(),
  plannedDistanceMeters: z.number().finite().min(1).max(100000).nullable(),
  plannedRestSeconds: z.number().int().min(0).max(86400).nullable(),
  plannedIntensityPercent: z.number().int().min(1).max(100).nullable(),
  plannedDurationSeconds: z.number().int().min(1).max(86400).nullable().default(null),
}).strict();
export type UnprescribedRunningItem = z.infer<typeof unprescribedRunningItemSchema>;
export const EMPTY_UNPRESCRIBED_RUNNING_DOSE = {
  plannedSets: null, plannedReps: null, plannedDistanceMeters: null, plannedRestSeconds: null,
  plannedIntensityPercent: null, plannedDurationSeconds: null,
} as const;
const savedSchema = unprescribedRunningContextSchema.extend({ kind: z.literal("UNPRESCRIBED_RUNNING"), schemaVersion: z.literal(1) }).strict();
export function parseUnprescribedRunning(kind: string, json: string | null): UnprescribedRunningContext | null {
  if (kind !== UNPRESCRIBED_RUNNING_KIND || !json) return null;
  try {
    const result = savedSchema.safeParse(JSON.parse(json));
    return result.success ? { reasonCode: result.data.reasonCode, reasonMessage: result.data.reasonMessage } : null;
  } catch { return null; }
}
