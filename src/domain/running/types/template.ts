/**
 * Running Prescription Engine v2 — SessionTemplate の型分離（§3.3）。
 *
 * 目的: Method と Template ID の組み合わせを**コンパイルエラーで**防ぐ。
 * 例えば `{ method: "MAX_VELOCITY", templateId: "ACC_BLOCK_20" }` は
 * TypeScript レベルで成立しない。
 *
 * R1 ではこの型構造だけを作る。各 Method の Envelope・実際の推奨値・
 * SessionTemplate の実データ（labelJa 等の中身）は R2 の責務
 * （`src/domain/running/rules/` は今回作らない）。
 */
import { z } from "zod";
import { RUNNING_TRAINING_METHODS, type RunningTrainingMethod } from "./method";
import type { RaceEvent } from "./primitives";

// ---------------------------------------------------------------------------
// Method ごとの Template ID（§3.3 の表と完全一致）
// ---------------------------------------------------------------------------

const ACC_TEMPLATE_IDS = [
  "ACC_BLOCK_10",
  "ACC_BLOCK_20",
  "ACC_BLOCK_30",
  "ACC_BLOCK_40",
  "ACC_CROUCH_20",
  "ACC_STANDING_20",
  "ACC_FALLING_10",
] as const;

const MV_TEMPLATE_IDS = ["MV_FLY10", "MV_FLY20", "MV_FLY30"] as const;

const SES_TEMPLATE_IDS = ["SES_80", "SES_100", "SES_120", "SES_150"] as const;

const LSR_TEMPLATE_IDS = [
  // FULL（完全回復）
  "LSR_SPECIAL_ENDURANCE_I",
  "LSR_SPECIAL_ENDURANCE_II",
  "LSR_RACE_MODEL",
  // INCOMPLETE（不完全回復・分割走）
  "LSR_300_PLUS_100",
  "LSR_200_PLUS_200",
  "LSR_BROKEN_400",
] as const;

const TE_TEMPLATE_IDS = ["TE_100", "TE_200", "TE_300"] as const;

const TI_TEMPLATE_IDS = ["TI_VITTORI_SE", "TI_COACH_DEFINED"] as const;

const RS_TEMPLATE_IDS = [
  "RS_SLED_LIGHT",
  "RS_SLED_MODERATE",
  "RS_SLED_HEAVY",
  "RS_HILL_SHORT",
] as const;

const AS_TEMPLATE_IDS = ["AS_TOWING", "AS_DOWNHILL"] as const;

const EA_TEMPLATE_IDS = [
  "EA_HURDLE_START_TO_H1",
  "EA_HURDLE_RHYTHM",
  "EA_JUMP_SHORT_APPROACH",
  "EA_JUMP_FULL_APPROACH",
] as const;

const ST_TEMPLATE_IDS = ["ST_WARMUP", "ST_RELAXED", "ST_BETWEEN_SETS"] as const;

const accelerationTemplateIdSchema = z.enum(ACC_TEMPLATE_IDS);
const maxVelocityTemplateIdSchema = z.enum(MV_TEMPLATE_IDS);
const sprintEnduranceShortTemplateIdSchema = z.enum(SES_TEMPLATE_IDS);
const longSprintRaceSpecificTemplateIdSchema = z.enum(LSR_TEMPLATE_IDS);
const tempoExtensiveTemplateIdSchema = z.enum(TE_TEMPLATE_IDS);
const tempoIntensiveTemplateIdSchema = z.enum(TI_TEMPLATE_IDS);
const resistedSprintTemplateIdSchema = z.enum(RS_TEMPLATE_IDS);
const assistedSprintTemplateIdSchema = z.enum(AS_TEMPLATE_IDS);
const eventApproachSpeedTemplateIdSchema = z.enum(EA_TEMPLATE_IDS);
const strideTemplateIdSchema = z.enum(ST_TEMPLATE_IDS);

/**
 * Method 名 → その Method の template id Zod schema、という**名前引き**の
 * lookup。discriminated union の `.options` を配列インデックスで参照すると
 * 並び順に依存してしまい壊れやすいため、他ファイル（prescription.ts 等）は
 * 必ずこちらを使う。
 */
export const TEMPLATE_ID_SCHEMA_BY_METHOD = {
  ACCELERATION: accelerationTemplateIdSchema,
  MAX_VELOCITY: maxVelocityTemplateIdSchema,
  SPRINT_ENDURANCE_SHORT: sprintEnduranceShortTemplateIdSchema,
  LONG_SPRINT_RACE_SPECIFIC: longSprintRaceSpecificTemplateIdSchema,
  TEMPO_EXTENSIVE: tempoExtensiveTemplateIdSchema,
  TEMPO_INTENSIVE: tempoIntensiveTemplateIdSchema,
  RESISTED_SPRINT: resistedSprintTemplateIdSchema,
  ASSISTED_SPRINT: assistedSprintTemplateIdSchema,
  EVENT_APPROACH_SPEED: eventApproachSpeedTemplateIdSchema,
  STRIDE: strideTemplateIdSchema,
} as const satisfies { [M in RunningTrainingMethod]: z.ZodTypeAny };

/**
 * [DEVIATION] `TemplateIdByMethod` は `RunningTrainingMethod` をキーとした
 * マップ型（indexed access で `TemplateIdByMethod[M]` の形で使う）であり、
 * Zod の `z.infer` は「スキーマの集合からマップ型を導出する」機能を持たない。
 * 各 Method の template id 列挙は上記のとおりすべて Zod enum が正であり、
 * このマップ型はそれらの `z.infer` 結果を参照するだけの薄いラッパー。
 */
export type TemplateIdByMethod = {
  ACCELERATION: z.infer<typeof accelerationTemplateIdSchema>;
  MAX_VELOCITY: z.infer<typeof maxVelocityTemplateIdSchema>;
  SPRINT_ENDURANCE_SHORT: z.infer<typeof sprintEnduranceShortTemplateIdSchema>;
  LONG_SPRINT_RACE_SPECIFIC: z.infer<typeof longSprintRaceSpecificTemplateIdSchema>;
  TEMPO_EXTENSIVE: z.infer<typeof tempoExtensiveTemplateIdSchema>;
  TEMPO_INTENSIVE: z.infer<typeof tempoIntensiveTemplateIdSchema>;
  RESISTED_SPRINT: z.infer<typeof resistedSprintTemplateIdSchema>;
  ASSISTED_SPRINT: z.infer<typeof assistedSprintTemplateIdSchema>;
  EVENT_APPROACH_SPEED: z.infer<typeof eventApproachSpeedTemplateIdSchema>;
  STRIDE: z.infer<typeof strideTemplateIdSchema>;
};

export type SessionTemplateId = TemplateIdByMethod[RunningTrainingMethod];

// ---------------------------------------------------------------------------
// RunningSelection — method と templateId の組み合わせを Zod でも TS でも拘束する
// ---------------------------------------------------------------------------

/**
 * Zod が正。10 branch の discriminated union として method↔templateId の
 * 整合をランタイムでも検証する。`RunningSelection`（TS 型）は
 * `z.infer` でここから導出される（マップ型ではなく union 型になるが、
 * `{ method: M; templateId: TemplateIdByMethod[M] }` の分配 union と
 * 構造的に同値）。
 */
export const runningSelectionSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("ACCELERATION"), templateId: accelerationTemplateIdSchema }),
  z.object({ method: z.literal("MAX_VELOCITY"), templateId: maxVelocityTemplateIdSchema }),
  z.object({
    method: z.literal("SPRINT_ENDURANCE_SHORT"),
    templateId: sprintEnduranceShortTemplateIdSchema,
  }),
  z.object({
    method: z.literal("LONG_SPRINT_RACE_SPECIFIC"),
    templateId: longSprintRaceSpecificTemplateIdSchema,
  }),
  z.object({ method: z.literal("TEMPO_EXTENSIVE"), templateId: tempoExtensiveTemplateIdSchema }),
  z.object({ method: z.literal("TEMPO_INTENSIVE"), templateId: tempoIntensiveTemplateIdSchema }),
  z.object({ method: z.literal("RESISTED_SPRINT"), templateId: resistedSprintTemplateIdSchema }),
  z.object({ method: z.literal("ASSISTED_SPRINT"), templateId: assistedSprintTemplateIdSchema }),
  z.object({
    method: z.literal("EVENT_APPROACH_SPEED"),
    templateId: eventApproachSpeedTemplateIdSchema,
  }),
  z.object({ method: z.literal("STRIDE"), templateId: strideTemplateIdSchema }),
]);

export type RunningSelection = z.infer<typeof runningSelectionSchema>;

// ---------------------------------------------------------------------------
// RecoveryStructure（LONG_SPRINT_RACE_SPECIFIC のみが必要とする）
// ---------------------------------------------------------------------------

export const RECOVERY_STRUCTURES = ["FULL", "INCOMPLETE"] as const;
export const recoveryStructureSchema = z.enum(RECOVERY_STRUCTURES);
export type RecoveryStructure = z.infer<typeof recoveryStructureSchema>;

// ---------------------------------------------------------------------------
// SessionTemplate<M>（型のみ。R1 では実データを持たない）
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] `RunningTrainingMethod` でパラメータ化されたジェネリック型。
 * `recoveryStructure` フィールドは `M extends "LONG_SPRINT_RACE_SPECIFIC" ?
 * RecoveryStructure : null` という条件型で、Zod の discriminated union が
 * 表現する「値ごとの分岐」とは異なる「型パラメータごとの分岐」であるため、
 * 手書きの TS 型として定義する。R1 では実際の SessionTemplate インスタンスは
 * 1 件も作らない（rules/ は R2）。
 */
export type SessionTemplate<M extends RunningTrainingMethod = RunningTrainingMethod> = {
  id: TemplateIdByMethod[M];
  method: M;
  labelJa: string;
  coachingAliases: string[];
  recoveryStructure: M extends "LONG_SPRINT_RACE_SPECIFIC" ? RecoveryStructure : null;
  startType?: "BLOCK" | "THREE_POINT" | "STANDING" | "FALLING" | "FLYING";
  displayDistanceM?: number;
  enabledByDefault: boolean;
  advancedOnly: boolean;
  primaryEvents?: RaceEvent[];
};

// ---------------------------------------------------------------------------
// 名前空間の非重複（テストで使う内部 export）
// ---------------------------------------------------------------------------

/** すべての template id を1つの配列にまとめたもの。名前空間衝突チェック等に使う。 */
export const ALL_TEMPLATE_IDS: readonly string[] = [
  ...ACC_TEMPLATE_IDS,
  ...MV_TEMPLATE_IDS,
  ...SES_TEMPLATE_IDS,
  ...LSR_TEMPLATE_IDS,
  ...TE_TEMPLATE_IDS,
  ...TI_TEMPLATE_IDS,
  ...RS_TEMPLATE_IDS,
  ...AS_TEMPLATE_IDS,
  ...EA_TEMPLATE_IDS,
  ...ST_TEMPLATE_IDS,
];

export const TEMPLATE_IDS_BY_METHOD: { [M in RunningTrainingMethod]: readonly string[] } = {
  ACCELERATION: ACC_TEMPLATE_IDS,
  MAX_VELOCITY: MV_TEMPLATE_IDS,
  SPRINT_ENDURANCE_SHORT: SES_TEMPLATE_IDS,
  LONG_SPRINT_RACE_SPECIFIC: LSR_TEMPLATE_IDS,
  TEMPO_EXTENSIVE: TE_TEMPLATE_IDS,
  TEMPO_INTENSIVE: TI_TEMPLATE_IDS,
  RESISTED_SPRINT: RS_TEMPLATE_IDS,
  ASSISTED_SPRINT: AS_TEMPLATE_IDS,
  EVENT_APPROACH_SPEED: EA_TEMPLATE_IDS,
  STRIDE: ST_TEMPLATE_IDS,
};

// 生成時の自己検証: RUNNING_TRAINING_METHODS のすべてに template id 配列があること。
// （型では保証されるが、意図を明文化するためのランタイムアサーションも兼ねる）
for (const method of RUNNING_TRAINING_METHODS) {
  if (!TEMPLATE_IDS_BY_METHOD[method] || TEMPLATE_IDS_BY_METHOD[method].length === 0) {
    throw new Error(`TEMPLATE_IDS_BY_METHOD is missing entries for method: ${method}`);
  }
}
