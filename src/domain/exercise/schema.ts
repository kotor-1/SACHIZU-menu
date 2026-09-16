import { z } from "zod";
import {
  ENERGY_SYSTEMS,
  EXERCISE_CATEGORIES,
  EXERCISE_PURPOSES,
  METRIC_TYPES,
  TRACK_FIELD_EVENTS,
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
  /**
   * 主として使うエネルギー供給系。未設定（""）は null に落とす。
   * 既存種目には値が入っていないため、処方ロジック側は null を許容して
   * category / targets から推定する。
   */
  energySystem: z
    .union([z.enum(ENERGY_SYSTEMS), z.literal("")])
    .optional()
    .default("")
    .transform((v) => (v === "" ? null : v)),

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
  /** 練習目的（加速・接地・姿勢…）。対象能力（targets）とは別軸。 */
  purposes: z.array(z.enum(EXERCISE_PURPOSES)).default([]),
  /** 対象競技種目（短距離・ハードル…）。 */
  events: z.array(z.enum(TRACK_FIELD_EVENTS)).default([]),
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
  purpose: z
    .union([z.enum(EXERCISE_PURPOSES), z.literal("")])
    .optional()
    .default(""),
  event: z
    .union([z.enum(TRACK_FIELD_EVENTS), z.literal("")])
    .optional()
    .default(""),
  energySystem: z
    .union([z.enum(ENERGY_SYSTEMS), z.literal("")])
    .optional()
    .default(""),
  /** タグ ID。複数指定は AND 条件。 */
  tag: z.array(z.string()).optional().default([]),
  /** "1" ならお気に入りのみ。チェックボックス 1 個の単純な絞り込みなので専用の型は持たない。 */
  favorite: z.union([z.literal("1"), z.literal("")]).optional().default(""),
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
