import { z } from "zod";
import { isValidCalendarDate } from "../planning/schema";
import {
  COMPETITION_LOAD_CATEGORIES,
  competitionLoadCategoriesSchema,
  type CompetitionLoadCategories,
} from "./sessionSnapshot";
import { isoDateSchema } from "../types/primitives";

const competitionParticipationDateSchema = isoDateSchema.refine(isValidCalendarDate, {
  message: "実在する日付ではありません",
});

const submittedCategoriesSchema = z
  .array(z.enum(COMPETITION_LOAD_CATEGORIES))
  .min(1, "参加種別を1つ以上選択してください")
  .max(2)
  .superRefine((categories, ctx) => {
    if (new Set(categories).size !== categories.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "参加種別が重複しています" });
    }
  });

export const competitionParticipationInputSchema = z
  .object({
    competitionId: z.string().min(1).max(128),
    date: competitionParticipationDateSchema,
    loadCategories: submittedCategoriesSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    loadCategories: COMPETITION_LOAD_CATEGORIES.filter((category) => input.loadCategories.includes(category)) as CompetitionLoadCategories,
  }))
  .pipe(z.object({
    competitionId: z.string().min(1).max(128),
    date: competitionParticipationDateSchema,
    loadCategories: competitionLoadCategoriesSchema,
  }).strict());

export type CompetitionParticipationInput = z.input<typeof competitionParticipationInputSchema>;
export type ParsedCompetitionParticipationInput = z.output<typeof competitionParticipationInputSchema>;
