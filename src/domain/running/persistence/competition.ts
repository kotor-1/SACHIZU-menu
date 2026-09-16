/**
 * Running Prescription Engine v2 — CompetitionInputSchema（§16.1 Competition・§19.1）。
 *
 * [R9] Competition は大会カレンダー（計画用）であり、エンジンの第4層ではない。repository の CRUD primitive が
 * 書込み前に使う。R10 / R11 の Action・画面はまだ作らない。
 */
import { z } from "zod";
import { isValidCalendarDate } from "../planning/schema";
import { competitionPrioritySchema, isoDateSchema } from "../types/primitives";

const calendarDateSchema = isoDateSchema.refine((d) => isValidCalendarDate(d), { message: "実在する日付ではありません" });

export const competitionInputSchema = z
  .object({
    name: z.string().trim().min(1, "大会名は必須です").max(120),
    date: calendarDateSchema,
    endDate: calendarDateSchema.nullable(),
    priority: competitionPrioritySchema.default("NORMAL"),
    note: z.string().max(1000).nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.endDate !== null && c.endDate < c.date) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endDate は date 以降である必要があります", path: ["endDate"] });
    }
  });
export type CompetitionInput = z.input<typeof competitionInputSchema>;
export type ParsedCompetitionInput = z.output<typeof competitionInputSchema>;
