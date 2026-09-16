/**
 * Running Prescription Engine v2 — 1 本の構造と出力（§2.4〜§2.5, §9.4）。
 *
 * R1 では「実際の recommended range 値」は一切入れない。ここにあるのは
 * 型と Zod schema だけであり、Envelope の実データ（rules/）は R2、
 * 実際に値を計算する `planRunningPrescription()` は R4 の責務。
 */
import { z } from "zod";
import {
  evidenceIdSchema,
  quantityIntervalSchema,
  rangeSchema,
  stopPolicyIdSchema,
  unitSchema,
  type Range,
} from "./primitives";
import { runningTrainingMethodSchema } from "./method";
import { timingMethodSchema } from "./intensity";
import {
  TEMPLATE_ID_SCHEMA_BY_METHOD,
  recoveryStructureSchema,
  type TemplateIdByMethod,
} from "./template";
import { intensityReferenceSchema } from "./intensity";
import { envelopeTierSchema } from "./subject";
import { findingSchema, rationaleLineSchema } from "./findings";
import { readinessActionCodeSchema } from "./readiness";
import { generationRecordSchema } from "./actor";

// ---------------------------------------------------------------------------
// Directness / PrescriptionConfidence（§2.2, §5.3, §5.4）
// ---------------------------------------------------------------------------

/**
 * Fable C-8 対応: Evidence には保存しない。ここに置くのは
 * 「値としてどんな種類があるか」という型だけであり、実際に導出する関数
 * （`deriveDirectness`）は `evidence/directness.ts` に置く
 * （evidence/ が types/ を参照する。逆方向の依存は作らない）。
 */
export const DIRECTNESS_VALUES = ["DIRECT", "PARTIAL", "INDIRECT", "NOT_APPLICABLE"] as const;
export const directnessSchema = z.enum(DIRECTNESS_VALUES);
export type Directness = z.infer<typeof directnessSchema>;

export const PRESCRIPTION_CONFIDENCE_VALUES = ["HIGH", "MODERATE", "LOW", "POLICY_ONLY"] as const;
export const prescriptionConfidenceSchema = z.enum(PRESCRIPTION_CONFIDENCE_VALUES);
export type PrescriptionConfidence = z.infer<typeof prescriptionConfidenceSchema>;

/**
 * [R4 errata] 入力データの confidence（§4.6 / §5.4）。`NOT_REQUIRED` = その参照は設計上 performance
 * データを必要としない（ACCELERATION の MAX_INTENT、STRIDE の RELAXED_SUBMAX 等）。「高品質なデータがある」
 * を意味する HIGH と区別する。confidence 導出では中立（LOW に落とさず、HIGH にも押し上げない）。
 */
export const INPUT_DATA_CONFIDENCES = ["HIGH", "MEDIUM", "LOW", "NONE", "NOT_REQUIRED"] as const;
export const inputDataConfidenceSchema = z.enum(INPUT_DATA_CONFIDENCES);
export type InputDataConfidence = z.infer<typeof inputDataConfidenceSchema>;

// ---------------------------------------------------------------------------
// FieldValue（§2.4）— 数値フィールドは必ず3層 + 根拠を持つ
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] `Unit` でパラメータ化されたジェネリック型。primitives.ts の
 * `Range<U>` / `QuantityInterval<U>` と同じ理由で、schema ファクトリ
 * （`fieldValueSchema`）と手書きの TS ジェネリック型を対にして提供する。
 */
export type FieldValue<U extends z.infer<typeof unitSchema> = z.infer<typeof unitSchema>> = {
  value: number;
  unit: U;
  /** [R4 errata] null = エンジンは値を置かない手動専用セル（ASSISTED / TI_COACH_DEFINED 等）。 */
  recommended: Range<U> | null;
  coachEditable: Range<U>;
  hardSafety: Range<U> | null;
  /** [R4 errata] recommended 範囲の中のどこへ置いたか（§7.3）。エンジンが位置で置いた値だけが持つ。 */
  position: RangePosition | null;
  /** [R4 errata] 値の由来。位置（position）とは別の概念として分離する。 */
  origin: ValueOrigin;
  evidenceIds: z.infer<typeof evidenceIdSchema>[];
};

/** §7.3 の位置。recommended の範囲内での位置指定であり、量への乗数ではない。 */
export const RANGE_POSITIONS = ["LOWER_BOUND", "LOWER_HALF", "MIDDLE", "UPPER_HALF"] as const;
export const rangePositionSchema = z.enum(RANGE_POSITIONS);
export type RangePosition = z.infer<typeof rangePositionSchema>;

/**
 * [R4 errata] FieldValue.origin（値の由来）:
 *   - ENGINE_POSITIONED: エンジンが recommended 内の position に置いた値（position 必須・recommended 内）
 *   - SOLVER_DERIVED: §7.3 ②③ の解決順（総本数最大化 → sets 最小化 → repsPerSet）で決まった回数（recommended 内）
 *   - TEMPLATE_FIXED: template の `fixedDistanceField` が固定する値（ACC_BLOCK_20 の 20m 等）。clamp しないため
 *     recommended 外になりうる（Finding `TEMPLATE_FIXED_OUTSIDE_RECOMMENDED`）
 *   - STRUCTURAL_FIXED: RunningPrescription schemaVersion=1 の構造正規化規則による値（Envelope に sets セルが無い
 *     template の sets=1 等）。training dose の推奨ではなく、sets / repsPerSet 非 null の不変条件を満たすための表現
 *   - COACH: コーチ入力（coachEditable 内）
 *   - COACH_OVERRIDE: CoachOverride による値（coachEditable / hardSafety の外もありうる。override の記録は step 13 で照合）
 */
export const VALUE_ORIGINS = [
  "ENGINE_POSITIONED",
  "SOLVER_DERIVED",
  "TEMPLATE_FIXED",
  "STRUCTURAL_FIXED",
  "COACH",
  "COACH_OVERRIDE",
] as const;
export const valueOriginSchema = z.enum(VALUE_ORIGINS);
export type ValueOrigin = z.infer<typeof valueOriginSchema>;

function within(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max;
}

export function fieldValueSchema<U extends z.infer<typeof unitSchema>>(unitLiteral: z.ZodType<U>) {
  return z
    .object({
      value: z.number().finite(),
      unit: unitLiteral,
      recommended: rangeSchema(unitLiteral).nullable(),
      coachEditable: rangeSchema(unitLiteral),
      hardSafety: rangeSchema(unitLiteral).nullable(),
      position: rangePositionSchema.nullable(),
      origin: valueOriginSchema,
      evidenceIds: z.array(evidenceIdSchema),
    })
    .refine(
      // `coachEditable` は上記 z.object で必須フィールドとして定義されている
      // （オプショナルではない）。TypeScript は `unitLiteral: z.ZodType<U>` の
      // ように U がジェネリックのまま渡された場合、Zod の内部型計算の都合で
      // このフィールドを `T | undefined` として解決してしまう既知の制約が
      // あるため、非 null アサーションで対応する（実体は常に存在する）。
      // [R4] coachEditable の外は CoachOverride（origin=COACH_OVERRIDE）でのみ許される。
      (f) => f.origin === "COACH_OVERRIDE" || within(f.value, f.coachEditable!),
      {
        message: "FieldValue.value は coachEditable の範囲内である必要があります（CoachOverride を除く）",
        path: ["value"],
      },
    )
    .refine(
      (f) => f.hardSafety == null || f.origin === "COACH_OVERRIDE" || within(f.value, f.hardSafety),
      { message: "FieldValue.value は hardSafety の範囲内である必要があります（設定されている場合）", path: ["value"] },
    )
    .refine((f) => (f.origin === "ENGINE_POSITIONED") === (f.position != null), {
      message: "position はエンジンが recommended 内の位置で置いた値（origin=ENGINE_POSITIONED）だけが持ちます",
      path: ["position"],
    })
    .refine((f) => f.recommended != null || f.origin === "COACH" || f.origin === "COACH_OVERRIDE", {
      message: "recommended=null（手動専用セル）の値はコーチ入力（origin=COACH / COACH_OVERRIDE）でなければなりません",
      path: ["origin"],
    })
    .refine(
      (f) =>
        !(f.origin === "ENGINE_POSITIONED" || f.origin === "SOLVER_DERIVED") ||
        (f.recommended != null && within(f.value, f.recommended)),
      { message: "エンジンが置いた値（ENGINE_POSITIONED / SOLVER_DERIVED）は recommended の範囲内でなければなりません", path: ["value"] },
    );
}

/**
 * [R4 errata] EVENT_APPROACH_SPEED の approachDistanceM は EnvelopeCell ではない（§7.4 R2 errata）。
 * 存在しない「推奨助走距離」を捏造しないため、recommended/coachEditable を持たない
 * コーチ手入力専用のスカラーで表す。
 */
export const coachEnteredDistanceSchema = z
  .object({
    value: z.number().positive().finite(),
    unit: z.literal("m"),
    source: z.literal("COACH_ENTERED"),
  })
  .strict();
export type CoachEnteredDistance = z.infer<typeof coachEnteredDistanceSchema>;

// ---------------------------------------------------------------------------
// FlyRep / SplitSegment / RepSpecByMethod（§2.4, §10 の必須分離）
// ---------------------------------------------------------------------------

const distanceFieldValueSchema = fieldValueSchema(z.literal("m"));
const durationFieldValueSchema = fieldValueSchema(z.literal("s"));
const distanceQuantityIntervalSchema = quantityIntervalSchema(z.literal("m"));

/**
 * build-up と fly zone を絶対に混同しないための必須分離（§10, §11.2）。
 * `totalRunningDistanceM` は build + fly + deceleration の導出値であることを
 * `.refine()` で検証する（§19.1 に明記された refine の1つ）。
 */
export const flyRepSchema = z
  .object({
    kind: z.literal("FLY"),
    buildUpDistanceM: distanceFieldValueSchema,
    flyZoneDistanceM: distanceFieldValueSchema,
    /**
     * [R4 errata] RuleSet に decelerationM セルが無い Method（ASSISTED_SPRINT）では null。
     * 0 を入れて「減速距離なし」と偽装しない。null のとき totalRunningDistanceM も null。
     */
    decelerationDistanceM: z.number().nonnegative().nullable(),
    totalRunningDistanceM: z.number().nonnegative().nullable(),
    plannedHighSpeedExposureM: distanceQuantityIntervalSchema,
  })
  .refine(
    (r) =>
      r.decelerationDistanceM === null
        ? r.totalRunningDistanceM === null
        : r.totalRunningDistanceM !== null &&
          Math.abs(
            r.totalRunningDistanceM -
              (r.buildUpDistanceM.value + r.flyZoneDistanceM.value + r.decelerationDistanceM),
          ) < 1e-9,
    {
      message:
        "FlyRep.totalRunningDistanceM は buildUpDistanceM + flyZoneDistanceM + decelerationDistanceM と一致する必要があります（deceleration が null なら total も null）",
      path: ["totalRunningDistanceM"],
    },
  );
export type FlyRep = z.infer<typeof flyRepSchema>;

export const splitSegmentSchema = z.object({
  distanceM: z.number().positive(),
  restAfterS: durationFieldValueSchema.nullable(),
});
export type SplitSegment = z.infer<typeof splitSegmentSchema>;

const distanceRepSchema = z.object({ kind: z.literal("DISTANCE"), distanceM: distanceFieldValueSchema });
const durationRepSchema = z.object({
  kind: z.literal("DURATION"),
  durationS: durationFieldValueSchema,
  displayDistanceM: distanceQuantityIntervalSchema,
});
const splitRepSchema = z.object({
  kind: z.literal("SPLIT"),
  segments: z.array(splitSegmentSchema).min(1),
});
const attemptsRepSchema = z.object({
  kind: z.literal("ATTEMPTS"),
  approach: z.enum(["SHORT", "FULL"]),
  approachDistanceM: coachEnteredDistanceSchema.nullable(),
});

/**
 * [DEVIATION] `RepSpecByMethod` は `RunningTrainingMethod` をキーとした
 * マップ型（spec §2.4 の型定義そのまま）。各「kind」ごとの具体的な形は
 * 上記の Zod schema がすべて正であり、このマップ型は `z.infer` した結果を
 * Method ごとに再配線するだけの薄いラッパー。
 */
export type RepSpecByMethod = {
  ACCELERATION: z.infer<typeof distanceRepSchema>;
  MAX_VELOCITY: FlyRep;
  SPRINT_ENDURANCE_SHORT: z.infer<typeof durationRepSchema>;
  LONG_SPRINT_RACE_SPECIFIC: z.infer<typeof durationRepSchema> | z.infer<typeof splitRepSchema>;
  TEMPO_EXTENSIVE: z.infer<typeof distanceRepSchema>;
  TEMPO_INTENSIVE: z.infer<typeof distanceRepSchema>;
  RESISTED_SPRINT: z.infer<typeof distanceRepSchema>;
  ASSISTED_SPRINT: FlyRep;
  EVENT_APPROACH_SPEED: z.infer<typeof attemptsRepSchema>;
  STRIDE: z.infer<typeof distanceRepSchema>;
};

// ---------------------------------------------------------------------------
// RestPlan（§9.4）
// ---------------------------------------------------------------------------

export const restPlanSchema = z.object({
  repRestS: durationFieldValueSchema,
  setRestS: durationFieldValueSchema.nullable(),
  intraRepRestS: durationFieldValueSchema.nullable(),
  displayAsFloor: z.literal(true),
  feasibility: z.enum(["OK", "EXCEEDS_AVAILABLE_TIME", "UNKNOWN"]),
});
export type RestPlan = z.infer<typeof restPlanSchema>;

// ---------------------------------------------------------------------------
// RunningPrescription（§2.5）
// ---------------------------------------------------------------------------

const percentQuantityIntervalSchema = quantityIntervalSchema(z.literal("percent"));
const secondsQuantityIntervalSchema = quantityIntervalSchema(z.literal("s"));
const setsFieldValueSchema = fieldValueSchema(z.literal("sets"));
const repsFieldValueSchema = fieldValueSchema(z.literal("reps"));

const ruleSetRefSchema = z.object({
  version: z.string().min(1),
  contentHash: z.string().min(1),
  status: z.enum(["DRAFT", "ACTIVE", "RETIRED"]),
});

const confidenceBlockSchema = z.object({
  prescription: prescriptionConfidenceSchema,
  directness: directnessSchema,
  inputData: inputDataConfidenceSchema,
});

// ---------------------------------------------------------------------------
// Monitoring snapshot（§17.1 / [R4 errata]）
// ---------------------------------------------------------------------------

/**
 * plan 時点の StopPolicy / TimingTolerance の**データのコピー**。R8 の monitor は RuleSet を再読込せず、
 * 処方に埋め込まれたこの snapshot だけで判定条件を復元する。RuleSet の型への参照ではなく、
 * RunningPrescription schemaVersion=1 の一部として独立に定義する（`.strict()`。RuleSet 側に項目が
 * 増えたら snapshot の schema を明示的に更新する）。
 */
export const stopPolicySnapshotSchema = z
  .object({
    id: stopPolicyIdSchema,
    method: runningTrainingMethodSchema,
    appliesToRecoveryStructure: recoveryStructureSchema.nullable(),
    appliesToEligibilityPath: z.enum(["ANY", "AUTO_CONDITIONS_MET", "MANUAL_OR_OVERRIDE"]),
    referenceDescription: z.string().min(1),
    ruleDescriptionJa: z.string().min(1),
    consecutiveFailuresToStop: z.number().int().positive().nullable(),
    numericStopAvailable: z.boolean(),
  })
  .strict();
export type StopPolicySnapshot = z.infer<typeof stopPolicySnapshotSchema>;

export const timingToleranceSnapshotSchema = z
  .object({
    timing: timingMethodSchema,
    toleranceS: z.number().nonnegative().nullable(),
    toleranceSPerFps: z.number().positive().nullable(),
    numericStopAllowed: z.boolean(),
    coachOnlyRatioThreshold: z.number().positive().nullable(),
    evidenceIds: z.array(evidenceIdSchema),
    judgement: z.enum(["SOURCE_BACKED", "ENGINE_POLICY", "OPEN"]),
    provisional: z.literal(true),
  })
  .strict();
export type TimingToleranceSnapshot = z.infer<typeof timingToleranceSnapshotSchema>;

export const monitoringSnapshotSchema = z
  .object({
    stopPolicy: stopPolicySnapshotSchema,
    timingTolerances: z.array(timingToleranceSnapshotSchema).min(1),
  })
  .strict()
  .refine((m) => new Set(m.timingTolerances.map((t) => t.timing)).size === m.timingTolerances.length, {
    message: "monitoringSnapshot.timingTolerances の timing が重複しています",
    path: ["timingTolerances"],
  });
export type MonitoringSnapshot = z.infer<typeof monitoringSnapshotSchema>;

const exposureBlockSchema = z.object({
  totalRunningDistanceM: distanceQuantityIntervalSchema,
  plannedHighSpeedExposureM: distanceQuantityIntervalSchema,
  nearMaxSprintVolumeM: distanceQuantityIntervalSchema,
});

/** RunningPrescription 共通部分（method / templateId / recoveryStructure / rep 以外）。 */
const runningPrescriptionCommonFields = {
  schemaVersion: z.literal(1),
  tier: envelopeTierSchema,
  sets: setsFieldValueSchema,
  repsPerSet: repsFieldValueSchema,
  rest: restPlanSchema,
  intensity: z.object({
    reference: intensityReferenceSchema,
    target: z.union([percentQuantityIntervalSchema, secondsQuantityIntervalSchema, z.null()]),
  }),
  exposure: exposureBlockSchema,
  stopPolicyId: stopPolicyIdSchema,
  monitoringSnapshot: monitoringSnapshotSchema,
  confidence: confidenceBlockSchema,
  readinessApplied: z.array(readinessActionCodeSchema),
  findings: z.array(findingSchema),
  rationale: z.array(rationaleLineSchema),
  ruleSet: ruleSetRefSchema,
  generatedBy: generationRecordSchema,
};

const noRecoveryStructure = z.null();

/**
 * Zod が正。10 branch の discriminated union として、
 *   - recoveryStructure は LONG_SPRINT_RACE_SPECIFIC のときだけ必須・他は null
 *   - rep の形は Method ごとに固定
 * を **型レベルでもランタイムでも** 強制する（§19.1 の refine 要件）。
 */
export const runningPrescriptionSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("ACCELERATION"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.ACCELERATION,
    recoveryStructure: noRecoveryStructure,
    rep: distanceRepSchema,
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("MAX_VELOCITY"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.MAX_VELOCITY,
    recoveryStructure: noRecoveryStructure,
    rep: flyRepSchema,
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("SPRINT_ENDURANCE_SHORT"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.SPRINT_ENDURANCE_SHORT,
    recoveryStructure: noRecoveryStructure,
    rep: durationRepSchema,
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("LONG_SPRINT_RACE_SPECIFIC"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.LONG_SPRINT_RACE_SPECIFIC,
    recoveryStructure: recoveryStructureSchema, // ★ LONG だけ必須
    rep: z.union([durationRepSchema, splitRepSchema]),
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("TEMPO_EXTENSIVE"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.TEMPO_EXTENSIVE,
    recoveryStructure: noRecoveryStructure,
    rep: distanceRepSchema,
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("TEMPO_INTENSIVE"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.TEMPO_INTENSIVE,
    recoveryStructure: noRecoveryStructure,
    rep: distanceRepSchema,
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("RESISTED_SPRINT"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.RESISTED_SPRINT,
    recoveryStructure: noRecoveryStructure,
    rep: distanceRepSchema,
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("ASSISTED_SPRINT"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.ASSISTED_SPRINT,
    recoveryStructure: noRecoveryStructure,
    rep: flyRepSchema,
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("EVENT_APPROACH_SPEED"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.EVENT_APPROACH_SPEED,
    recoveryStructure: noRecoveryStructure,
    rep: attemptsRepSchema,
    ...runningPrescriptionCommonFields,
  }),
  z.object({
    method: z.literal("STRIDE"),
    templateId: TEMPLATE_ID_SCHEMA_BY_METHOD.STRIDE,
    recoveryStructure: noRecoveryStructure,
    rep: distanceRepSchema,
    ...runningPrescriptionCommonFields,
  }),
]).superRefine((p, ctx) => {
  // [R4] RuleSet を見なくても決まる構造的な整合（§9.5 / §19.1）。RuleSet に依存する
  // 検証（reference kind が MethodMeta で許可されているか、Envelope の範囲と一致するか等）は
  // `planning/validatePrescription.ts` が担当する（fake な refine をここに置かない）。
  const refKind = p.intensity.reference.kind;
  if ((refKind === "MAX_INTENT" || refKind === "RELAXED_SUBMAX" || refKind === "FLY_SPLIT") && p.intensity.target !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `intensity.reference=${refKind} のとき数値目標（target）は持てません（§9.5）`,
      path: ["intensity", "target"],
    });
  }
  if (p.monitoringSnapshot.stopPolicy.id !== p.stopPolicyId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "monitoringSnapshot.stopPolicy.id は stopPolicyId と一致する必要があります",
      path: ["monitoringSnapshot", "stopPolicy", "id"],
    });
  }
  if (p.method === "MAX_VELOCITY" && p.intensity.target !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "MAX_VELOCITY の目標は「全力」であり、数値目標（target）は持てません（§9.5）",
      path: ["intensity", "target"],
    });
  }
});

/**
 * Zod から導出した「実際に valid な値」の型（閉じた union）。
 * ランタイム検証・保存前チェック・テストのフィクスチャにはこちらを使う。
 */
export type RunningPrescriptionValue = z.infer<typeof runningPrescriptionSchema>;

/**
 * [DEVIATION] 正式仕様 §2.5 の `RunningPrescription<M>` は
 * `RunningTrainingMethod` でパラメータ化された**真のジェネリック型**であり、
 * 将来 `planRunningPrescription<M extends RunningTrainingMethod>(...): RunningPrescription<M>`
 * のようにメソッドを固定した関数シグネチャを書けることを想定している
 * （R4 で使う）。Zod の discriminated union から `z.infer` で得られる
 * `RunningPrescriptionValue` は「実際に valid な値の閉じた union」であり、
 * 構造的には同じだが、TypeScript の意味での generic type ではない。
 * そのため、仕様のジェネリックな使い勝手を保つために `RunningPrescription<M>`
 * を手書きの条件型として別途定義し、両者が構造的に一致することを
 * `tests/domain/running/types.test.ts` で `expectTypeOf` により確認している。
 */
export type RunningPrescription<M extends z.infer<typeof runningTrainingMethodSchema> = z.infer<typeof runningTrainingMethodSchema>> = {
  schemaVersion: 1;
  method: M;
  templateId: TemplateIdByMethod[M];
  recoveryStructure: M extends "LONG_SPRINT_RACE_SPECIFIC"
    ? z.infer<typeof recoveryStructureSchema>
    : null;
  tier: z.infer<typeof envelopeTierSchema>;
  sets: FieldValue<"sets">;
  repsPerSet: FieldValue<"reps">;
  rep: RepSpecByMethod[M];
  rest: RestPlan;
  intensity: {
    reference: z.infer<typeof intensityReferenceSchema>;
    target: z.infer<typeof percentQuantityIntervalSchema> | z.infer<typeof secondsQuantityIntervalSchema> | null;
  };
  exposure: z.infer<typeof exposureBlockSchema>;
  stopPolicyId: z.infer<typeof stopPolicyIdSchema>;
  monitoringSnapshot: MonitoringSnapshot;
  confidence: z.infer<typeof confidenceBlockSchema>;
  readinessApplied: z.infer<typeof readinessActionCodeSchema>[];
  findings: z.infer<typeof findingSchema>[];
  rationale: z.infer<typeof rationaleLineSchema>[];
  ruleSet: z.infer<typeof ruleSetRefSchema>;
  generatedBy: z.infer<typeof generationRecordSchema>;
};
