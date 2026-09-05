import { z } from "zod";
import { TRAINING_PHASES } from "./constants";
import { REVIEW_STATUSES } from "@/domain/shared/constants";
import {
  optionalNumber,
  optionalText,
  requiredText,
} from "@/domain/shared/zod-helpers";

/** メニュー本体（ヘッダ情報）の入力。ブロック / アイテムは別アクションで編集する。 */
export const menuInputSchema = z.object({
  name: requiredText("メニュー名", 120),
  description: optionalText(4000),
  purpose: optionalText(2000),
  phase: z
    .union([z.enum(TRAINING_PHASES), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  estimatedMinutes: optionalNumber({ min: 1, max: 600, int: true }),
  status: z.enum(REVIEW_STATUSES).default("DRAFT"),
  tags: z.array(z.string().min(1).max(40)).default([]),
});

export type MenuInput = z.infer<typeof menuInputSchema>;

export const menuBlockInputSchema = z.object({
  name: requiredText("ブロック名", 80),
  note: optionalText(1000),
});

export type MenuBlockInput = z.infer<typeof menuBlockInputSchema>;

/**
 * メニュー内の 1 項目 = 処方。
 * exerciseId（カタログ参照）か displayName（自由記述）のどちらかが必須。
 */
export const menuItemInputSchema = z
  .object({
    exerciseId: optionalText(64),
    displayName: optionalText(160),
    sets: optionalNumber({ min: 1, max: 99, int: true }),
    reps: optionalNumber({ min: 1, max: 999, int: true }),
    distanceMeters: optionalNumber({ min: 1, max: 100000 }),
    durationSeconds: optionalNumber({ min: 1, max: 86400, int: true }),
    restSeconds: optionalNumber({ min: 0, max: 86400, int: true }),
    intensityPercent: optionalNumber({ min: 1, max: 200, int: true }),
    loadKg: optionalNumber({ min: 0, max: 1000 }),
    note: optionalText(1000),
  })
  .refine((v) => Boolean(v.exerciseId) || Boolean(v.displayName), {
    message: "種目を選ぶか、項目名を入力してください",
    path: ["displayName"],
  });

export type MenuItemInput = z.infer<typeof menuItemInputSchema>;

/** メニュー一覧の検索条件。 */
export const menuSearchSchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  phase: z
    .union([z.enum(TRAINING_PHASES), z.literal("")])
    .optional()
    .default(""),
  status: z
    .union([z.enum(REVIEW_STATUSES), z.literal("")])
    .optional()
    .default(""),
  tag: z.array(z.string()).optional().default([]),
  sort: z.enum(["updatedDesc", "nameAsc", "createdDesc"]).optional().default("updatedDesc"),
  page: z.coerce.number().int().min(1).optional().default(1),
});

export type MenuSearch = z.infer<typeof menuSearchSchema>;

export const MENU_PAGE_SIZE = 20;
