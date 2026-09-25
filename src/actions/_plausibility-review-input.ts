import { z } from "zod";
import { plausibilityReviewRequestsSchema } from "@/application/running-review-runtime";

/** F4 may submit this JSON array; no actor, time, finding text or applied review is accepted. */
export const plausibilityReviewsJsonSchema = z.string().max(75000).optional().transform((raw, ctx) => {
  if (raw === undefined || raw.trim() === "") return [];
  try {
    const parsed = plausibilityReviewRequestsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* Report only the safe input error below. */ }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: "レビューの対象・理由・2段階の確認を見直してください" });
  return z.NEVER;
});
