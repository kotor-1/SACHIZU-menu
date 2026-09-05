import { z } from "zod";
import { SESSION_STATUSES } from "./constants";
import {
  checkbox,
  optionalNumber,
  optionalText,
  requiredText,
} from "@/domain/shared/zod-helpers";

/** セッションのヘッダ情報。 */
export const sessionInputSchema = z.object({
  title: requiredText("練習名", 120),
  date: z
    .string()
    .min(1, "実施日は必須です")
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: "日付の形式が不正です" }),
  groupName: optionalText(120),
  location: optionalText(120),
  weather: optionalText(60),
  condition: optionalText(500),
  status: z.enum(SESSION_STATUSES).default("PLANNED"),
  coachNote: optionalText(4000),
});

export type SessionInput = z.infer<typeof sessionInputSchema>;

/** テンプレートからセッションを起こすときの入力。 */
export const sessionFromMenuSchema = z.object({
  menuTemplateId: z.string().min(1, "メニューを選んでください"),
  date: z
    .string()
    .min(1, "実施日は必須です")
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: "日付の形式が不正です" }),
  title: optionalText(120),
  groupName: optionalText(120),
  location: optionalText(120),
});

export type SessionFromMenuInput = z.infer<typeof sessionFromMenuSchema>;

/** 実施記録（1 項目分の実績入力）。 */
export const sessionItemResultSchema = z.object({
  done: checkbox(),
  actualSets: optionalNumber({ min: 0, max: 99, int: true }),
  actualReps: optionalNumber({ min: 0, max: 999, int: true }),
  actualDistanceMeters: optionalNumber({ min: 0, max: 100000 }),
  actualDurationSeconds: optionalNumber({ min: 0, max: 86400, int: true }),
  actualLoadKg: optionalNumber({ min: 0, max: 1000 }),
  actualNote: optionalText(1000),
});

export type SessionItemResultInput = z.infer<typeof sessionItemResultSchema>;

export const sessionSearchSchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  status: z
    .union([z.enum(SESSION_STATUSES), z.literal("")])
    .optional()
    .default(""),
  from: z.string().optional().default(""),
  to: z.string().optional().default(""),
  page: z.coerce.number().int().min(1).optional().default(1),
});

export type SessionSearch = z.infer<typeof sessionSearchSchema>;

export const SESSION_PAGE_SIZE = 20;
