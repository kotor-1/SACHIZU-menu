/**
 * Running Prescription Engine v2 — Session aggregation の入出力型（§11.1）。
 *
 * [R6 helper file] §22 R6 の新規ファイル一覧には無いが、metrics / exposure / rules / legacyAdapter と
 * planning が同じ型を参照するため、循環 import を避ける目的でここに集約する。しきい値・上限・
 * 加速区間などの**データは一切持たない**（すべて RuleSet）。
 *
 * [R6 representation errata]（§11 に記載）:
 *   - `AggregationItem` は **完成した処方のスナップショット**（RUNNING_V2）か、legacy 項目の
 *     **最小限の要約**（LEGACY）だけを受け取る。生の PlanRequest や Prisma の Exercise 行は渡さない。
 *   - `competitionDay` は `boolean | "NOT_EVALUATED"`。plannedDate が無ければ NOT_EVALUATED
 *     （false と推測しない。§14 の `resolveCompetitionAndPhase` が渡す）。
 */
import { z } from "zod";
import { anyUnitQuantityIntervalSchema, quantityIntervalSchema } from "../types/primitives";
import { findingSchema } from "../types/findings";
import { runningPrescriptionSchema } from "../types/prescription";
import { runningTrainingMethodSchema } from "../types/method";
import { envelopeTierSchema } from "../types/subject";
import type { RuleSet } from "../rules/schema";

// ---------------------------------------------------------------------------
// AggregationItem
// ---------------------------------------------------------------------------

const positiveIntOrNull = z.number().int().positive().finite().nullable();
const positiveNumberOrNull = z.number().positive().finite().nullable();

/**
 * legacy（v2 ではない）項目から集計に必要な最小限だけ。巨大な Exercise 行を domain へ渡さない。
 * `category` の意味（走行距離か接地数か）は RuleSet の LEGACY_CATEGORY が決める（TS に表を持たない）。
 */
export const legacyItemSummarySchema = z
  .object({
    /** 既存 `Exercise.category`（SPRINT / ENDURANCE / JUMP …）。 */
    category: z.string().min(1),
    sets: positiveIntOrNull,
    reps: positiveIntOrNull,
    distanceMeters: positiveNumberOrNull,
    durationSeconds: positiveNumberOrNull,
    restSeconds: positiveNumberOrNull,
  })
  .strict();
export type LegacyItemSummary = z.infer<typeof legacyItemSummarySchema>;

export const aggregationItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RUNNING_V2"), prescription: runningPrescriptionSchema }).strict(),
  z.object({ kind: z.literal("LEGACY"), item: legacyItemSummarySchema }).strict(),
]);
export type AggregationItem = z.infer<typeof aggregationItemSchema>;

// ---------------------------------------------------------------------------
// AggregationContext
// ---------------------------------------------------------------------------

/**
 * [R7] plannedDate が無ければ大会当日かどうか評価できない（"NOT_EVALUATED"。false と推測しない）。
 * R7 で `resolveCompetitionAndPhase` が実際の true/false を渡せるようになった。
 */
export const competitionDayStateSchema = z.union([z.boolean(), z.literal("NOT_EVALUATED")]);
export type CompetitionDayState = z.infer<typeof competitionDayStateSchema>;

export const aggregationContextInputSchema = z
  .object({
    tier: envelopeTierSchema,
    /** null = 練習時間が未入力（AGG_REST_INFEASIBLE を評価しない）。 */
    availableMinutes: z.number().positive().finite().nullable(),
    /** [R7] 大会当日かどうか（§14.3 n=0）。評価できないときだけ NOT_EVALUATED。 */
    competitionDay: competitionDayStateSchema,
    /** PLANNING = 計画時（実測なし）。ACTUAL は R8/R9 の実測評価用（R6 では planned を使う）。 */
    mode: z.enum(["PLANNING", "ACTUAL"]),
  })
  .strict();
export type AggregationContextInput = z.infer<typeof aggregationContextInputSchema>;

/**
 * RuleSet は解決済みのオブジェクトとして受け取る（version 文字列を request 側から指定させない。§18.1）。
 */
export type AggregationContext = AggregationContextInput & { ruleSet: RuleSet };

// ---------------------------------------------------------------------------
// SessionAggregate（§11.1）
// ---------------------------------------------------------------------------

const metersInterval = quantityIntervalSchema(z.literal("m"));
const contactsInterval = quantityIntervalSchema(z.literal("contacts"));

export const sessionAggregateSchema = z
  .object({
    totalRunningDistanceM: metersInterval,
    plannedHighSpeedExposureM: metersInterval,
    /** 実測（R8/R9）。R6 の計画時は null。「未実測だから 0」にはしない。 */
    actualHighSpeedExposureM: metersInterval.nullable(),
    nearMaxSprintVolumeM: metersInterval,
    longSprintVolumeM: metersInterval,
    tempoVolumeM: metersInterval,
    strideVolumeM: metersInterval,
    plyometricContacts: contactsInterval,
    /** v2 では未定義（OPEN-16）。筋トン数を発明しない。 */
    strengthLoad: z.null(),
    raceExposure: z.object({ count: z.number().int().nonnegative(), distanceM: metersInterval }).strict(),
    relayExposure: z.object({ count: z.number().int().nonnegative(), legDistanceM: metersInterval }).strict(),
    /** §11.4 の按分結果（量への乗数ではない）。 */
    highIntensityBudgetUse: z.object({ recommended: z.number().nonnegative(), coachEditable: z.number().nonnegative() }).strict(),
    highIntensityMethods: z.array(runningTrainingMethodSchema),
    completeness: z.enum(["COMPLETE", "PARTIAL"]),
    findings: z.array(findingSchema),
  })
  .strict();
export type SessionAggregate = z.infer<typeof sessionAggregateSchema>;

/** Finding の値欄に区間を入れるための型（scope=SESSION 固定のヘルパは rules.ts）。 */
export type AnyQuantityInterval = z.infer<typeof anyUnitQuantityIntervalSchema>;
