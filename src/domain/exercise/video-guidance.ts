import { z } from "zod";

export const VIDEO_COUNTING_UNIT_LABEL = {
  TOTAL_REPS: "合計の回数", PER_SIDE: "片側ごとの回数", ALTERNATING_TOTAL: "左右交互・合計の回数",
  ROUND_TRIP: "往復", SECONDS: "秒", METERS: "距離（m）", CUSTOM: "種目の指示に合わせる",
} as const;

const shortText = z.string().trim().min(1).max(400);
export const videoGuidanceObservationSchema = z.object({
  executionSummary: shortText, movementPattern: shortText,
  countingUnit: z.enum(["TOTAL_REPS", "PER_SIDE", "ALTERNATING_TOTAL", "ROUND_TRIP", "SECONDS", "METERS", "CUSTOM"]),
  bilateralCounting: shortText.nullable(), typicalStructure: shortText.nullable(),
  equipment: z.array(shortText).max(12), setup: shortText.nullable(),
  keyCues: z.array(shortText).max(12), commonErrors: z.array(shortText).max(12),
  // Observations, never automatic plan values.
  doseObservations: z.array(shortText).max(12),
}).strict();
export const exerciseVideoGuidanceSchema = videoGuidanceObservationSchema.extend({
  videoAnalysisStatus: z.enum(["AI_ANALYZED", "COACH_REVIEWED"]),
  sourceVideoId: z.string().min(1).max(64), analysisVersion: z.string().min(1).max(64),
  analyzedAt: z.string().datetime(), coachReviewedAt: z.string().datetime().nullable(),
}).strict().refine((v) => (v.videoAnalysisStatus === "COACH_REVIEWED") === (v.coachReviewedAt !== null));
export type VideoGuidanceObservation = z.infer<typeof videoGuidanceObservationSchema>;
export type ExerciseVideoGuidance = z.infer<typeof exerciseVideoGuidanceSchema>;
export function videoAnalysisStatus(guidance: ExerciseVideoGuidance | null) {
  return guidance?.videoAnalysisStatus ?? "NOT_ANALYZED";
}
