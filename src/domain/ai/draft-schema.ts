import { z } from "zod";
import {
  EXERCISE_CATEGORIES,
  EXERCISE_PURPOSES,
  METRIC_TYPES,
  TRACK_FIELD_EVENTS,
  TRAINING_TARGETS,
} from "@/domain/exercise/constants";

/**
 * このスキーマのバージョン。
 *
 * プロンプトや接続先モデルを変えると、同じフィールドでも出力の傾向が変わりうる。
 * 保存された下書きの `schemaVersion` を見れば「どの世代のプロンプト/モデルで
 * 作られた下書きか」を後から判別できるようにするためのもの。
 *
 * 破壊的にフィールドを変える（型を変える・必須化するなど）ときはこの数値を上げる。
 * 新しいスキーマは古いバージョンの payload も引き続き読めること
 * （後方互換）を維持する前提。
 */
export const CURRENT_DRAFT_SCHEMA_VERSION = 1 as const;

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
  /**
   * 省略された場合は 1（このスキーマ導入前の下書きも読めるようにする）。
   * 数値でない値が来ても 1 に丸め、例外にはしない。
   */
  schemaVersion: z.coerce
    .number()
    .int()
    .positive()
    .catch(CURRENT_DRAFT_SCHEMA_VERSION)
    .default(CURRENT_DRAFT_SCHEMA_VERSION),

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

  /**
   * 練習目的（加速・接地・姿勢…）。キー名は依頼された Schema 例に合わせて
   * 単数形 "purpose" だが、値は targets と同じく配列（複数選択）。
   */
  purpose: z
    .array(z.string().transform((v) => v.toUpperCase()))
    .transform((arr) =>
      arr.filter((v): v is (typeof EXERCISE_PURPOSES)[number] =>
        (EXERCISE_PURPOSES as readonly string[]).includes(v),
      ),
    )
    .catch([])
    .optional(),

  /** 対象競技種目（短距離・ハードル…）。 */
  events: z
    .array(z.string().transform((v) => v.toUpperCase()))
    .transform((arr) =>
      arr.filter((v): v is (typeof TRACK_FIELD_EVENTS)[number] =>
        (TRACK_FIELD_EVENTS as readonly string[]).includes(v),
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

/** 壊れている・スキーマに合わない payload に対する既定値。 */
const EMPTY_DRAFT_PAYLOAD: ExerciseDraftPayload = {
  schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION,
};

/** DB に入っている JSON 文字列を安全に payload へ戻す。壊れていても落とさない。 */
export function parseDraftPayload(raw: string): ExerciseDraftPayload {
  try {
    const parsed = exerciseDraftPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_DRAFT_PAYLOAD;
  } catch {
    return EMPTY_DRAFT_PAYLOAD;
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
