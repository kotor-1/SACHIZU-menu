/**
 * Running Prescription Engine v2 — RunningMenuContext（`MenuTemplate.runningContextJson`、§15.1・§16.1・§19.1）。
 *
 * [R9] 永続化に必要な最小の versioned schema。PlanRequest（§9.1 / R7 の menuContext と GROUP subject）に既にある
 * フィールドのうち、保存してよいものだけを持つ。新しい個人情報のフィールドは作らない。
 *   - subject は GROUP のみ（OPEN-01: ATHLETE の永続化は未決定）。
 *   - member は `birthDate` を持たない（年齢帯は `ageBandOverride` で表す）。`sexForNorms` / 痛み / soreness /
 *     fatigue / sleep / readiness の生値は持てない（`.strict()` + 健康情報キー検査）。
 *   - maturity は判定に使う status / confidence / method / assessedAt だけ。身長の履歴（heightHistory）と
 *     成熟度推定式（equation）は保存しない。
 *   - `phase` は `MenuTemplate.phase` 列、大会は `Competition` テーブル、他の項目は `MenuItem` にあるため二重に持たない。
 */
import { z } from "zod";
import { isValidCalendarDate } from "../planning/schema";
import { isoDateSchema, isoDateTimeSchema } from "../types/primitives";
import {
  ageBandSchema,
  athleteProfileSchema,
  maturityAssessmentSchema,
  trainingAgeInputSchema,
} from "../types/subject";

const persistedGroupMemberSchema = z
  .object({
    ageBandOverride: ageBandSchema.optional(),
    maturity: maturityAssessmentSchema.pick({ status: true, confidence: true, method: true, assessedAt: true }).strict(),
    trainingAge: trainingAgeInputSchema.strict(),
    primaryEvent: athleteProfileSchema.shape.primaryEvent,
  })
  .strict();

export const runningMenuContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: z
      .object({
        kind: z.literal("GROUP"),
        label: z.string().trim().min(1).max(120),
        members: z.array(persistedGroupMemberSchema),
        memberCountHint: z.number().int().positive().optional(),
        allowAdvancedMethods: z.boolean(),
      })
      .strict(),
    plannedDate: isoDateSchema.nullable(),
    /** [R7] plannedDate が null なら null。非 null なら plannedDate と同じ暦日（OS 時刻で補わない）。 */
    plannedAt: isoDateTimeSchema.nullable(),
    availableMinutes: z.number().positive().finite().nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.plannedDate !== null && !isValidCalendarDate(c.plannedDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "plannedDate が実在する日付ではありません", path: ["plannedDate"] });
    }
    if (c.plannedDate === null && c.plannedAt !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "plannedDate が無い場合 plannedAt も null である必要があります", path: ["plannedAt"] });
    }
    if (c.plannedDate !== null && c.plannedAt !== null && c.plannedAt.slice(0, 10) !== c.plannedDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "plannedAt の暦日は plannedDate と一致する必要があります", path: ["plannedAt"] });
    }
  });
export type RunningMenuContext = z.infer<typeof runningMenuContextSchema>;
