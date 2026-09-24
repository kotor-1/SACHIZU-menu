/**
 * Running Prescription Engine v2 — 強度参照（§2.3）。
 *
 * `IntensityReference` は判別共用体（discriminated union）として実装する。
 * ACCELERATION が `MAX_INTENT`（数値%を持たない）で処方される、という
 * §2.3 の方針は型で強制する（Fable H-3: 「98%」のような偽精度を作らない）。
 *
 * R1 では計時誤差の実際の値（HAND=0.25秒 等）は実装しない。それは R8 の
 * policy（timingTolerance）であり、ここでは `TimingMethod` という
 * 列挙値と、`TimedMark` の構造的な整合（VIDEO なら videoFps 必須）だけを扱う。
 */
import { z } from "zod";
import { isoDateSchema, raceEventSchema, quantityIntervalSchema } from "./primitives";

// ---------------------------------------------------------------------------
// TimingMethod
// ---------------------------------------------------------------------------

export const TIMING_METHODS = ["FAT", "PHOTO_CELL", "HAND", "VIDEO", "RADAR_LASER", "UNKNOWN"] as const;
export const timingMethodSchema = z.enum(TIMING_METHODS);
export type TimingMethod = z.infer<typeof timingMethodSchema>;

// ---------------------------------------------------------------------------
// VelocityEstimate
// ---------------------------------------------------------------------------

export const VELOCITY_ESTIMATE_SOURCES = [
  "RADAR_LASER",
  "FLY_SPLIT_FAT",
  "FLY_SPLIT_PHOTO_CELL",
  "FLY_SPLIT_HAND",
  "FLY_SPLIT_VIDEO",
  "ESTIMATED_MODEL",
  "COACH_ESTIMATE",
] as const;
export const velocityEstimateSourceSchema = z.enum(VELOCITY_ESTIMATE_SOURCES);

export const velocityEstimateSchema = z
  .object({
    valueMps: z.number().positive(),
    lowerMps: z.number().nonnegative(),
    upperMps: z.number().positive(),
    source: velocityEstimateSourceSchema,
    confidence: z.enum(["HIGH", "MEDIUM", "LOW", "NONE"]),
    measuredAt: isoDateSchema,
    modelId: z.string().optional(),
  })
  .refine((v) => v.lowerMps <= v.valueMps && v.valueMps <= v.upperMps, {
    message: "VelocityEstimate.valueMps は lowerMps と upperMps の間である必要があります",
  })
  .refine((v) => v.source !== "ESTIMATED_MODEL" || v.modelId != null, {
    message: "source が ESTIMATED_MODEL のときは modelId が必須です",
    path: ["modelId"],
  });

export type VelocityEstimate = z.infer<typeof velocityEstimateSchema>;

// ---------------------------------------------------------------------------
// TimedMark
// ---------------------------------------------------------------------------

export const TIMED_MARK_EVENTS = [
  "FLY10",
  "FLY20",
  "FLY30",
  "10m",
  "20m",
  "30m",
  "60m",
  "100m",
  "150m",
  "200m",
  "300m",
  "400m",
] as const;
export const timedMarkEventSchema = z.enum(TIMED_MARK_EVENTS);

export const START_TYPES = ["BLOCK", "THREE_POINT", "STANDING", "FLYING"] as const;
export const startTypeSchema = z.enum(START_TYPES);

export const SURFACES = ["TRACK", "GRASS", "ARTIFICIAL", "ROAD", "OTHER"] as const;
export const surfaceSchema = z.enum(SURFACES);

export const timedMarkSchema = z
  .object({
    event: timedMarkEventSchema,
    timeS: z.number().positive().finite(),
    date: isoDateSchema,
    timing: timingMethodSchema,
    videoFps: z.number().positive().optional(),
    wind: z.number().nullable().optional(),
    startType: startTypeSchema.optional(),
    surface: surfaceSchema.nullable().optional(),
    spikes: z.boolean().nullable().optional(),
  })
  .refine((v) => v.timing !== "VIDEO" || v.videoFps != null, {
    message: "timing が VIDEO のときは videoFps が必須です",
    path: ["videoFps"],
  });

export type TimedMark = z.infer<typeof timedMarkSchema>;

// ---------------------------------------------------------------------------
// IntensityReference — 判別共用体（discriminated union）
// ---------------------------------------------------------------------------

const targetTimeSSchema = quantityIntervalSchema(z.literal("s"));

export const intensityReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MAX_INTENT") }),
  z.object({ kind: z.literal("MEASURED_VMAX"), vmax: velocityEstimateSchema }),
  z.object({ kind: z.literal("FLY_SPLIT"), flyZoneM: z.number().positive(), mark: timedMarkSchema }),
  z.object({
    kind: z.literal("SAME_DISTANCE_BEST"),
    distanceM: z.number().positive(),
    mark: timedMarkSchema,
  }),
  z.object({ kind: z.literal("RACE_PACE"), event: raceEventSchema, targetTimeS: targetTimeSSchema }),
  z.object({
    kind: z.literal("TARGET_SPLIT"),
    segments: z
      .array(z.object({ distanceM: z.number().positive(), targetS: targetTimeSSchema }))
      .min(1),
  }),
  z.object({
    kind: z.literal("VELOCITY_DECREMENT"),
    band: z.enum(["LIGHT", "MODERATE", "HEAVY", "VERY_HEAVY"]),
    measured: z.boolean(),
  }),
  z.object({ kind: z.literal("RELAXED_SUBMAX") }),
  z.object({ kind: z.literal("COACH_DEFINED"), label: z.string().min(1) }),
]);

export type IntensityReference = z.infer<typeof intensityReferenceSchema>;

/** テストや R2 の MethodMeta.allowedIntensityReferences で使う、全 kind の一覧。 */
export const INTENSITY_REFERENCE_KINDS = [
  "MAX_INTENT",
  "MEASURED_VMAX",
  "FLY_SPLIT",
  "SAME_DISTANCE_BEST",
  "RACE_PACE",
  "TARGET_SPLIT",
  "VELOCITY_DECREMENT",
  "RELAXED_SUBMAX",
  "COACH_DEFINED",
] as const satisfies readonly IntensityReference["kind"][];
