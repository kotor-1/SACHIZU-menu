import { z } from "zod";

/** Explicit athlete/coach inputs. School grade is never a maturity assessment. */
export const runningScienceContextSchema = z.object({
  ageYears: z.number().int().min(6).max(100).optional(),
  experience: z.enum(["BEGINNER", "EXPERIENCED"]).optional(),
  maturity: z.enum(["PRE", "CIRCA", "POST", "UNKNOWN"]).optional(),
  supervised: z.boolean().optional(),
  symptomFree: z.boolean().optional(),
  familiarWithSprint: z.boolean().optional(),
  hoursSinceHighIntensity: z.number().finite().nonnegative().max(10000).optional(),
  hoursUntilNextHighIntensity: z.number().finite().nonnegative().max(10000).optional(),
  highIntensitySessionsLast7Days: z.number().int().nonnegative().max(30).optional(),
  speedEnduranceMode: z.enum(["SPRINT_SPECIFIC", "CONTROLLED_90_95"]).optional(),
  referenceDistanceMeters: z.number().int().positive().max(400).optional(),
  referenceTimeSeconds: z.number().finite().positive().max(300).optional(),
}).strict();
export type RunningScienceContext = z.infer<typeof runningScienceContextSchema>;

/** New design authority; it must never masquerade as historical coach approval. */
export const runningSciencePrescriptionSchema = z.object({
  source: z.literal("SCIENCE_INFORMED_DEFAULT"),
  coachApproval: z.literal("NOT_COACH_APPROVED"),
  provisional: z.literal(true),
  ruleId: z.string().min(1).max(100),
  purpose: z.string().min(1).max(40),
  method: z.string().min(1).max(60),
  evidenceIds: z.array(z.string().min(1).max(100)).min(1).max(10),
  intensityReference: z.enum(["MAX_INTENT", "RELAXED_SUBMAX", "SAME_DISTANCE_AVERAGE_SPEED"]),
  intensityPercent: z.object({ min: z.number().min(1).max(100), max: z.number().min(1).max(100) }).strict().nullable(),
  targetTimeRangeSeconds: z.object({ min: z.number().positive(), max: z.number().positive() }).strict().nullable(),
  buildupMeters: z.number().int().nonnegative(),
  flyMeters: z.number().int().nonnegative(),
  decelerationMeters: z.number().int().nonnegative(),
  minHighIntensitySeparationHours: z.number().int().nonnegative(),
  maxHighIntensitySessionsPer7Days: z.number().int().positive().nullable(),
  rationale: z.string().min(1).max(600),
  stopInstruction: z.string().min(1).max(300),
}).strict();
export type RunningSciencePrescription = z.infer<typeof runningSciencePrescriptionSchema>;
