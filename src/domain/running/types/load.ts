/**
 * Running Prescription Engine v2 — LoadEvent / LoadCategory（§12.1）。
 *
 * R1 では入力の型だけを定義する。履歴の導出（repository からの変換）・
 * 48h/72h ウィンドウ判定・週次ガード（§12.2〜§12.4）は R7 の責務。
 */
import { z } from "zod";
import { isoDateTimeSchema, quantityIntervalSchema } from "./primitives";
import { runningTrainingMethodSchema } from "./method";

export const LOAD_CATEGORIES = [
  "RUNNING_HIGH_INTENSITY",
  "RUNNING_LOW_INTENSITY",
  "RACE",
  "RELAY",
  "PLYOMETRIC",
  "STRENGTH",
  "JUMPS",
  "HURDLES",
  "OTHER",
] as const;
export const loadCategorySchema = z.enum(LOAD_CATEGORIES);
export type LoadCategory = z.infer<typeof loadCategorySchema>;

const distanceIntervalSchema = quantityIntervalSchema(z.literal("m"));
const contactsIntervalSchema = quantityIntervalSchema(z.literal("contacts"));

export const loadEventSchema = z.object({
  at: isoDateTimeSchema,
  category: loadCategorySchema,
  method: runningTrainingMethodSchema.nullable(),
  intensityTag: z.enum(["HIGH", "MODERATE", "LOW", "UNKNOWN"]),
  magnitude: z.object({
    distanceM: distanceIntervalSchema.optional(),
    highSpeedExposureM: distanceIntervalSchema.optional(),
    contacts: contactsIntervalSchema.optional(),
    attempts: z.number().int().nonnegative().optional(),
  }),
  source: z.enum(["SESSION_RECORD", "COMPETITION_RECORD", "COACH_ENTRY"]),
  completion: z.enum(["DONE", "PARTIAL", "PLANNED_NOT_CONFIRMED"]),
});
export type LoadEvent = z.infer<typeof loadEventSchema>;
