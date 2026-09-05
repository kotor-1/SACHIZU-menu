import { z } from "zod";
import {
  EXERCISE_CATEGORIES,
  METRIC_TYPES,
  TRAINING_TARGETS,
} from "@/domain/exercise/constants";

/**
 * 動画解析 AI が返す「種目の下書き」の形。
 *
 * Phase 2 で Qwen 等のモデル出力をここで検証してから DB に入れる。
 * モデルは自由な文字列を返しうるので、
 *   - 未知のカテゴリ / 対象能力は捨てる（throw しない）
 *   - すべてのフィールドを任意にする
 * ことで、部分的にしか埋まらない出力でも下書きとして受け入れられるようにしている。
 * ここが「AI 出力が確定カタログを汚さない」ための境界。
 */
export const exerciseDraftPayloadSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  nameKana: z.string().trim().max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  coachingPoint: z.string().trim().max(2000).optional(),
  commonMistake: z.string().trim().max(2000).optional(),

  category: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(EXERCISE_CATEGORIES))
    .catch("OTHER" as const)
    .optional(),

  metricType: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(METRIC_TYPES))
    .catch("REPS" as const)
    .optional(),

  difficulty: z.coerce.number().int().min(1).max(5).catch(3).optional(),

  targets: z
    .array(z.string().transform((v) => v.toUpperCase()))
    .transform((arr) =>
      arr.filter((v): v is (typeof TRAINING_TARGETS)[number] =>
        (TRAINING_TARGETS as readonly string[]).includes(v),
      ),
    )
    .catch([])
    .optional(),

  equipmentTags: z.array(z.string().trim().min(1).max(40)).catch([]).optional(),
  generalTags: z.array(z.string().trim().min(1).max(40)).catch([]).optional(),
  bodyPartTags: z.array(z.string().trim().min(1).max(40)).catch([]).optional(),

  defaultSets: z.coerce.number().int().min(1).max(99).nullish(),
  defaultReps: z.coerce.number().int().min(1).max(999).nullish(),
  defaultDistanceMeters: z.coerce.number().min(1).max(100000).nullish(),
  defaultDurationSeconds: z.coerce.number().int().min(1).max(86400).nullish(),
  defaultRestSeconds: z.coerce.number().int().min(0).max(86400).nullish(),

  /** モデルが「動画で何が起きていたか」を言語化した文章。監査用に残す。 */
  observation: z.string().trim().max(8000).optional(),
});

export type ExerciseDraftPayload = z.infer<typeof exerciseDraftPayloadSchema>;

/** DB に入っている JSON 文字列を安全に payload へ戻す。壊れていても落とさない。 */
export function parseDraftPayload(raw: string): ExerciseDraftPayload {
  try {
    const parsed = exerciseDraftPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export const DRAFT_STATUSES = ["PENDING_REVIEW", "APPLIED", "REJECTED"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  PENDING_REVIEW: "確認待ち",
  APPLIED: "登録済み",
  REJECTED: "却下",
};

export const ANALYSIS_JOB_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
] as const;
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUSES)[number];
