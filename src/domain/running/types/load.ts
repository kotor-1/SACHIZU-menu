/**
 * Running Prescription Engine v2 — LoadEvent / LoadCategory / 週次履歴の入力型（§12.1）。
 *
 * R1 では入力の型だけを定義していた。R7 で `.strict()` 化し、48h/72h ウィンドウ判定・
 * 週次ガード（§12.2〜§12.4）に必要なフィールドを完成させる。
 *
 * [R7 errata]（§12 に記載）:
 *   - `templateId`: v2 由来の event は exact template を持つ（method と templateId が対応していること
 *     を要求）。legacy / race / 外部入力は null 可。「新規刺激」判定（§14.3）は exact templateId の
 *     一致でしか行わない（Method 名や表示名だけでは「使用済み」と判定しない）。
 *   - `sessionKey`: 週次「セッション数」（highSessions7d、§12.4）は **item 数ではなく session 数**。
 *     現行 LoadEvent には session identity が無いため追加する。同じ sessionKey の event は同一
 *     session として数える（大会 session も1つの sessionKey）。domain の呼び出し側が安定した
 *     key を発行する責務を持つ（ここでは生成しない）。
 */
import { z } from "zod";
import { isoDateSchema, isoDateTimeSchema, quantityIntervalSchema } from "./primitives";
import { runningTrainingMethodSchema, RUNNING_TRAINING_METHODS } from "./method";
import { TEMPLATE_ID_SCHEMA_BY_METHOD } from "./template";

export const LOAD_CATEGORIES = [
  "RUNNING_HIGH_INTENSITY",
  "RUNNING_LOW_INTENSITY",
  "RACE",
  "RELAY",
  "PLYOMETRIC",
  "STRENGTH",
  "JUMPS",
  "HURDLES",
  "OTHER",
] as const;
export const loadCategorySchema = z.enum(LOAD_CATEGORIES);
export type LoadCategory = z.infer<typeof loadCategorySchema>;

const distanceIntervalSchema = quantityIntervalSchema(z.literal("m"));
const contactsIntervalSchema = quantityIntervalSchema(z.literal("contacts"));

/** 全 Method の template id をまとめた集合（method との対応は superRefine で検証する）。 */
const anySessionTemplateIdSchema = z.union(
  RUNNING_TRAINING_METHODS.map((m) => TEMPLATE_ID_SCHEMA_BY_METHOD[m]) as unknown as readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
);

export const loadEventSchema = z
  .object({
    at: isoDateTimeSchema,
    category: loadCategorySchema,
    method: runningTrainingMethodSchema.nullable(),
    /** [R7] v2 event は exact template を持つ。legacy / race / 外部入力は null。 */
    templateId: anySessionTemplateIdSchema.nullable(),
    /** [R7] §12.4 highSessions7d は item 数ではなく session 数（同じ key は1 session）。 */
    sessionKey: z.string().min(1),
    intensityTag: z.enum(["HIGH", "MODERATE", "LOW", "UNKNOWN"]),
    magnitude: z
      .object({
        distanceM: distanceIntervalSchema.optional(),
        highSpeedExposureM: distanceIntervalSchema.optional(),
        contacts: contactsIntervalSchema.optional(),
        attempts: z.number().int().nonnegative().optional(),
      })
      .strict(),
    source: z.enum(["SESSION_RECORD", "COMPETITION_RECORD", "COACH_ENTRY"]),
    completion: z.enum(["DONE", "PARTIAL", "PLANNED_NOT_CONFIRMED"]),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.templateId !== null) {
      if (event.method === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "templateId を持つ event は method も必須です", path: ["method"] });
        return;
      }
      const schema = TEMPLATE_ID_SCHEMA_BY_METHOD[event.method];
      if (!schema.safeParse(event.templateId).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `templateId "${event.templateId}" は method=${event.method} の template ではありません`,
          path: ["templateId"],
        });
      }
    }
  });
export type LoadEvent = z.infer<typeof loadEventSchema>;

// ---------------------------------------------------------------------------
// DailyActivitySummary（§12 R7 errata）— 7日 guard 用の日別要約
// ---------------------------------------------------------------------------

/**
 * [R7 errata] LoadEvent だけでは「活動なしの日」を表せない（event が無いことは休養日の証拠にならない）。
 * 呼び出し側が明示的に「この日は確認済みで活動が無かった」と申告するための別 contract。
 */
export const dailyActivitySummarySchema = z
  .object({
    date: isoDateSchema,
    hadActivity: z.boolean(),
    /** hadActivity=false のときは 0 のみ。true で時間不明なら null（0 だと推測しない）。 */
    trainingMinutes: z.number().finite().nonnegative().nullable(),
  })
  .strict()
  .superRefine((day, ctx) => {
    if (!day.hadActivity && day.trainingMinutes !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hadActivity=false の日の trainingMinutes は 0 である必要があります",
        path: ["trainingMinutes"],
      });
    }
  });
export type DailyActivitySummary = z.infer<typeof dailyActivitySummarySchema>;

// ---------------------------------------------------------------------------
// WeeklyHistoryInput（§12 R7 errata）— history の正式 contract
// ---------------------------------------------------------------------------

export const HISTORY_COVERAGE_LEVELS = ["COMPLETE", "PARTIAL", "NONE"] as const;
export const historyCoverageLevelSchema = z.enum(HISTORY_COVERAGE_LEVELS);
export type HistoryCoverageLevel = z.infer<typeof historyCoverageLevelSchema>;

/**
 * [R7 errata] `history: LoadEvent[] | null` では「記録外の活動が無いことまで確認済みか」を表せない
 * （§12.2）。coverage を明示させることで、`NONE`（履歴未提供）を `COMPLETE`（記録外の活動なしまで確認済み）
 * と取り違えない。呼び出し側が入力した coverage をそのまま信じるが、`dailyActivity7d` との整合は
 * `evaluateWeeklyContext` 側で検証する（§20 「不足日があるのに COMPLETE」は reject 相当に downgrade する）。
 */
export const weeklyHistoryInputSchema = z
  .object({
    events: z.array(loadEventSchema),
    coverage72h: historyCoverageLevelSchema,
    coverage7d: historyCoverageLevelSchema,
    coverage28d: historyCoverageLevelSchema,
    dailyActivity7d: z.array(dailyActivitySummarySchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    const dates = input.dailyActivity7d.map((d) => d.date);
    if (new Set(dates).size !== dates.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dailyActivity7d.date に重複があります", path: ["dailyActivity7d"] });
    }
  });
export type WeeklyHistoryInput = z.infer<typeof weeklyHistoryInputSchema>;
