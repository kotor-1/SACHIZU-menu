import { z } from "zod";
import {
  EXERCISE_CATEGORIES,
  METRIC_TYPES,
  TRAINING_TARGETS,
} from "./constants";
import { CONTENT_SOURCES, REVIEW_STATUSES } from "@/domain/shared/constants";
import {
  optionalNumber,
  optionalText,
  requiredText,
} from "@/domain/shared/zod-helpers";

/** 種目の登録・更新入力。 */
export const exerciseInputSchema = z.object({
  name: requiredText("種目名", 120),
  nameKana: optionalText(120),
  description: optionalText(4000),
  coachingPoint: optionalText(2000),
  commonMistake: optionalText(2000),

  category: z.enum(EXERCISE_CATEGORIES),
  metricType: z.enum(METRIC_TYPES),
  difficulty: z.coerce.number().int().min(1).max(5),

  defaultSets: optionalNumber({ min: 1, max: 99, int: true }),
  defaultReps: optionalNumber({ min: 1, max: 999, int: true }),
  defaultDistanceMeters: optionalNumber({ min: 1, max: 100000 }),
  defaultDurationSeconds: optionalNumber({ min: 1, max: 86400, int: true }),
  defaultRestSeconds: optionalNumber({ min: 0, max: 86400, int: true }),

  videoUrl: optionalText(1000).refine(
    (v) => v === null || /^https?:\/\//.test(v),
    { message: "http(s) から始まる URL を入力してください" },
  ),

  source: z.enum(CONTENT_SOURCES).default("MANUAL"),
  status: z.enum(REVIEW_STATUSES).default("REVIEWED"),

  targets: z.array(z.enum(TRAINING_TARGETS)).default([]),
  /** タグ名の配列（kind 別）。存在しなければ作成する。 */
  generalTags: z.array(z.string().min(1).max(40)).default([]),
  equipmentTags: z.array(z.string().min(1).max(40)).default([]),
  bodyPartTags: z.array(z.string().min(1).max(40)).default([]),
});

export type ExerciseInput = z.infer<typeof exerciseInputSchema>;

/** 一覧の検索条件。URL のクエリパラメータからそのままパースする。 */
export const exerciseSearchSchema = z.object({
  /** 名前・説明・かな へのフリーテキスト検索 */
  q: z.string().trim().max(120).optional().default(""),
  category: z
    .union([z.enum(EXERCISE_CATEGORIES), z.literal("")])
    .optional()
    .default(""),
  target: z
    .union([z.enum(TRAINING_TARGETS), z.literal("")])
    .optional()
    .default(""),
  /** タグ ID。複数指定は AND 条件。 */
  tag: z.array(z.string()).optional().default([]),
  status: z
    .union([z.enum(REVIEW_STATUSES), z.literal("")])
    .optional()
    .default(""),
  difficulty: z
    .union([z.coerce.number().int().min(1).max(5), z.literal("")])
    .optional()
    .default(""),
  sort: z
    .enum(["updatedDesc", "nameAsc", "difficultyAsc", "createdDesc"])
    .optional()
    .default("updatedDesc"),
  page: z.coerce.number().int().min(1).optional().default(1),
});

export type ExerciseSearch = z.infer<typeof exerciseSearchSchema>;

export const EXERCISE_PAGE_SIZE = 24;

export const EXERCISE_SORT_LABEL: Record<ExerciseSearch["sort"], string> = {
  updatedDesc: "更新が新しい順",
  createdDesc: "登録が新しい順",
  nameAsc: "名前順",
  difficultyAsc: "やさしい順",
};
