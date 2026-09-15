import type { MetricType } from "@/domain/exercise/constants";
import type { TrainingPhase } from "@/domain/menu/constants";
import type { Prescription } from "@/domain/shared/prescription";
import { classify, type ClassifiableExercise } from "./classify";
import {
  BASELINE_LEVEL,
  HIGH_INTENSITY_RUN_KINDS,
  PRESCRIPTION_KIND_LABEL,
  type AthleteLevel,
  type PrescriptionKind,
} from "./constants";
import {
  completeRestSeconds,
  LEVEL_VOLUME_FACTOR,
  NEUTRAL_PHASE_ADJUSTMENT,
  PHASE_ADJUSTMENT,
  PRESCRIPTION_RULES,
} from "./rules";

/** 処方の計算に必要な種目の情報。Prisma の行をそのまま渡せる。 */
export type SuggestibleExercise = ClassifiableExercise & {
  name?: string;
  metricType?: string | null;
  defaultSets?: number | null;
  defaultReps?: number | null;
  defaultDistanceMeters?: number | null;
  defaultDurationSeconds?: number | null;
  defaultRestSeconds?: number | null;
};

export type SuggestionContext = {
  phase?: TrainingPhase | null;
  level?: AthleteLevel | null;
};

export type PrescriptionSuggestion = {
  kind: PrescriptionKind;
  prescription: Prescription;
  /** なぜこの数字になったか。UI に必ず出す。 */
  rationale: string[];
  /** 原理原則から見て危ないところ。処方は返しつつ警告だけ出す。 */
  warnings: string[];
  /** セット間レスト（秒）。MenuItem に置き場所がないので別で返す。 */
  setRestSeconds: number | null;
  /** この種目 1 つ分の高強度走行距離（m）。総量集計に使う。 */
  highIntensityMeters: number;
  /** この種目 1 つ分の接地数。プライオの総量集計に使う。 */
  contactCount: number;
};

/** 距離が処方の主軸になる（＝距離を必ず出す）処方タイプ。 */
const DISTANCE_DRIVEN_KINDS: readonly PrescriptionKind[] = [
  "SPEED_ACCELERATION",
  "SPEED_MAX_VELOCITY",
  "SPEED_ENDURANCE",
  "TEMPO_AEROBIC",
];

/**
 * 期分け・レベルの量係数を掛けない処方タイプ。
 * 準備運動と整理運動は「その日のトレーニング量」ではないので、
 * 試合期だからストレッチを減らす、という調整はしない。
 */
const VOLUME_FACTOR_EXEMPT_KINDS: readonly PrescriptionKind[] = [
  "MOBILITY_WARMUP",
  "COOLDOWN",
];

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
}

/**
 * 種目 1 つ分の推奨処方を計算する。
 *
 * 方針:
 *  - **種目に登録された既定値（Exercise.default*）があれば必ずそれを優先する。**
 *    コーチが種目単位で決めた値を、汎用ルールで上書きしない（個別性・特異性の原則）。
 *  - ルールは「既定値が無い項目だけ」を埋める。
 *  - 数字を出したら必ず理由も返す。理由が言えない数字は現場で使えない。
 */
export function suggestPrescription(
  exercise: SuggestibleExercise,
  context: SuggestionContext = {},
): PrescriptionSuggestion {
  const kind = classify(exercise);
  const rule = PRESCRIPTION_RULES[kind];
  const metric = (exercise.metricType ?? "REPS") as MetricType;

  const level = context.level ?? BASELINE_LEVEL;
  const levelFactor = LEVEL_VOLUME_FACTOR[level];
  const phaseAdj = context.phase
    ? PHASE_ADJUSTMENT[context.phase]
    : NEUTRAL_PHASE_ADJUSTMENT;
  const exemptFromVolumeFactor = VOLUME_FACTOR_EXEMPT_KINDS.includes(kind);
  const volumeFactor = exemptFromVolumeFactor
    ? 1
    : levelFactor * phaseAdj.volumeFactor;

  const rationale: string[] = [];
  const warnings: string[] = [];
  const overridden: string[] = [];

  rationale.push(
    `${PRESCRIPTION_KIND_LABEL[kind]}として処方。${rule.rationale}`,
  );

  // --- 1 本の量（距離 / 時間 / 回数）------------------------------------------
  let distanceMeters: number | null = null;
  if (exercise.defaultDistanceMeters != null) {
    distanceMeters = exercise.defaultDistanceMeters;
    overridden.push("距離");
  } else if (DISTANCE_DRIVEN_KINDS.includes(kind) || metric === "DISTANCE") {
    distanceMeters = rule.distanceMeters;
  }

  let durationSeconds: number | null = null;
  if (exercise.defaultDurationSeconds != null) {
    durationSeconds = exercise.defaultDurationSeconds;
    overridden.push("時間");
  } else if (metric === "TIME" || kind === "COOLDOWN") {
    durationSeconds = rule.durationSeconds;
  }

  // --- 本数・セット数 ---------------------------------------------------------
  const baseReps =
    metric === "REPS" && distanceMeters == null
      ? (rule.repsWhenCounted ?? rule.reps)
      : rule.reps;

  // 1 本の単位が「時間」なら、回数は書かない（「3set × 15回 40秒」のような
  // 二重表記になるため）。本数を明示したい種目はコーチが既定値で入れる。
  const durationIsTheUnit = durationSeconds != null && distanceMeters == null;

  let reps: number | null = null;
  if (exercise.defaultReps != null) {
    reps = exercise.defaultReps;
    overridden.push("本数");
  } else if (durationIsTheUnit) {
    reps = null;
  } else if (baseReps != null) {
    // 総量係数は本数にだけ掛ける。セット数を動かすとメニューの形が大きく変わり、
    // コーチが手で微調整しにくくなるため。
    reps = Math.max(1, Math.round(baseReps * volumeFactor));
  }

  let sets: number | null = rule.sets;
  if (exercise.defaultSets != null) {
    sets = exercise.defaultSets;
    overridden.push("セット数");
  }

  // --- レスト -----------------------------------------------------------------
  let restSeconds: number | null;
  if (exercise.defaultRestSeconds != null) {
    restSeconds = exercise.defaultRestSeconds;
    overridden.push("レスト");
  } else if (rule.restPolicy === "COMPLETE_BY_DISTANCE") {
    if (distanceMeters != null) {
      restSeconds = completeRestSeconds(distanceMeters);
      rationale.push(
        `レスト${formatSeconds(restSeconds)}は${distanceMeters}mに対する完全回復（10mあたり60秒）。` +
          "短くすると狙いがスピード持久にすり替わるため詰めない。",
      );
    } else {
      restSeconds = completeRestSeconds(0);
      warnings.push(
        "距離が決まっていないため、完全回復レストを最短の2分で置いています。距離を入れると正しく計算されます。",
      );
    }
  } else {
    restSeconds = rule.restSeconds;
    if (restSeconds != null) {
      rationale.push(`レストは${formatSeconds(restSeconds)}。`);
    }
  }

  if (rule.setRestSeconds != null) {
    rationale.push(`セット間は${formatSeconds(rule.setRestSeconds)}。`);
  }

  // --- 強度 -------------------------------------------------------------------
  let intensityPercent: number | null = null;
  if (rule.intensityPercent != null) {
    intensityPercent = Math.min(
      100,
      Math.max(50, rule.intensityPercent + phaseAdj.intensityDelta),
    );
  }

  // --- 期分け・レベルの説明 ---------------------------------------------------
  if (context.phase && phaseAdj.volumeFactor !== 1) {
    rationale.push(
      `${phaseAdj.label}のため量を${phaseAdj.volumeFactor}倍` +
        (phaseAdj.intensityDelta !== 0
          ? `、強度を${phaseAdj.intensityDelta > 0 ? "+" : ""}${phaseAdj.intensityDelta}%`
          : "") +
        "調整。",
    );
  }
  if (levelFactor !== 1) {
    rationale.push(
      `レベル（${level}）に合わせて量を${levelFactor}倍。強度は下げない（下げると狙うエネルギー系が変わるため）。`,
    );
  }
  if (overridden.length > 0) {
    rationale.push(
      `${overridden.join("・")}は種目に登録された既定値を優先しました。`,
    );
  }

  // --- 総量チェック -----------------------------------------------------------
  const totalReps = (sets ?? 1) * (reps ?? 1);
  const highIntensityMeters = HIGH_INTENSITY_RUN_KINDS.includes(kind)
    ? totalReps * (distanceMeters ?? 0)
    : 0;
  const contactCount = kind === "PLYOMETRIC" ? totalReps : 0;

  if (rule.volumeCapMeters != null && highIntensityMeters > 0) {
    const cap = Math.round(rule.volumeCapMeters * volumeFactor);
    if (highIntensityMeters > cap) {
      warnings.push(
        `この種目だけで${highIntensityMeters}m。1回の練習の目安${cap}mを超えています。`,
      );
    }
  }
  if (rule.volumeCapContacts != null && contactCount > 0) {
    const cap = Math.round(rule.volumeCapContacts * volumeFactor);
    if (contactCount > cap) {
      warnings.push(
        `接地数${contactCount}回。1回の練習の目安${cap}回を超えています。`,
      );
    }
  }

  const prescription: Prescription = {
    sets,
    reps,
    distanceMeters,
    durationSeconds,
    restSeconds,
    intensityPercent,
    loadKg: null,
  };

  return {
    kind,
    prescription,
    rationale,
    warnings,
    setRestSeconds: rule.setRestSeconds,
    highIntensityMeters,
    contactCount,
  };
}

/**
 * 提案を MenuItem.note に書ける 1 まとまりのテキストにする。
 * 根拠が残らないと、後から見たときに数字を直してよいのか判断できない。
 */
export function buildPrescriptionNote(
  suggestion: PrescriptionSuggestion,
): string {
  const lines = [...suggestion.rationale];
  for (const w of suggestion.warnings) lines.push(`⚠ ${w}`);
  return lines.join("\n").slice(0, 1000);
}
