/**
 * Running Prescription Engine v2 — プリミティブ型（§2.1）。
 *
 * このファイルは `src/domain/running/**` の最下層。他の types/*.ts から
 * import されるが、このファイル自身は他のファイルに依存しない。
 *
 * 方針（正式仕様 §2 冒頭）: Zod スキーマを正とし、TS 型は `z.infer` で導出する。
 * ただし `Brand` と、`Unit` でパラメータ化される汎用型（`Range` / `SoftRange` /
 * `QuantityInterval`）は、Zod の型システムが TypeScript のジェネリクスを
 * そのまま表現できないため、最小限の TS 補助型として手書きする
 * （詳細は各型のコメントと R1 報告の Deviations を参照）。
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] TS-only ジェネリックユーティリティ型。
 * Zod では「任意の T を任意のブランド名でラップする」ジェネリック型そのものを
 * 汎用的に表現できない（`.brand()` は個々の schema にしか付けられない）ため、
 * 型レベルのユーティリティとして手書きする。値の生成は各ドメイン型側で
 * 専用の factory 関数 / Zod schema を用意し、そこだけで brand を付与する。
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

// ---------------------------------------------------------------------------
// IsoDate / IsoDateTime
// ---------------------------------------------------------------------------

/** YYYY-MM-DD のみ。時刻を持たない「日」。 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "IsoDate は YYYY-MM-DD 形式で入力してください")
  .brand<"IsoDate">();
export type IsoDate = z.infer<typeof isoDateSchema>;

/** ISO 8601 の日時文字列（タイムゾーンオフセット必須）。 */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .brand<"IsoDateTime">();
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

export const UNITS = ["m", "cm", "s", "reps", "sets", "percent", "mps", "contacts", "h"] as const;
export const unitSchema = z.enum(UNITS);
export type Unit = z.infer<typeof unitSchema>;

// ---------------------------------------------------------------------------
// Range / SoftRange
// ---------------------------------------------------------------------------

/**
 * 閉区間。null は「上限/下限なし」ではなく「値が定義されていない」を意味する
 * （§2.1 コメントのとおり。Range 自体は min/max とも必須の number なので、
 * 「未定義」を表したい場合は Range を持たせないこと。null 許容は
 * QuantityInterval の役割）。
 *
 * [DEVIATION] `Range<U extends Unit>` は Unit でパラメータ化されたジェネリック
 * 型のため、`z.infer` だけからは導出できない。`rangeSchema(unitSchema)` という
 * schema ファクトリを用意し、呼び出し側で具体的な unit を渡したときだけ
 * Zod の検証対象になる。TS 側のジェネリック型はファクトリの戻り値の型
 * （`z.infer<ReturnType<typeof rangeSchema<U>>>`）と構造的に一致するよう
 * 手書きしている。
 */
export type Range<U extends Unit = Unit> = { min: number; max: number; unit: U };

export function rangeSchema<U extends Unit>(unitLiteral: z.ZodType<U>) {
  return z
    .object({
      min: z.number(),
      max: z.number(),
      unit: unitLiteral,
    })
    .refine((r) => r.min <= r.max, { message: "Range.min は Range.max 以下である必要があります" });
}
/** 任意の Unit を許す Range（Finding.limit など、unit を固定できない場所で使う）。 */
export const anyUnitRangeSchema = rangeSchema(unitSchema);

/** L-1: "約7–15秒" "おおよそ48h" を型で表す。SOFT の場合のみ hysteresis を持てる。 */
export type SoftRange<U extends Unit = Unit> = Range<U> & {
  softness: "HARD" | "SOFT";
  hysteresis?: Range<U>;
};

export const SOFTNESS_VALUES = ["HARD", "SOFT"] as const;
export const softnessSchema = z.enum(SOFTNESS_VALUES);
export type Softness = z.infer<typeof softnessSchema>;

/** [DEVIATION] Range と同様の理由でジェネリック。schema ファクトリで対応する。 */
export function softRangeSchema<U extends Unit>(unitLiteral: z.ZodType<U>) {
  return rangeSchema(unitLiteral).and(
    z.object({
      softness: softnessSchema,
      hysteresis: rangeSchema(unitLiteral).optional(),
    }),
  );
}
export const anyUnitSoftRangeSchema = softRangeSchema(unitSchema);

// ---------------------------------------------------------------------------
// DataSource / Confidence
// ---------------------------------------------------------------------------

export const DATA_SOURCES = [
  "MEASURED",
  "PLANNED",
  "ESTIMATED",
  "RULE_DEFINITION",
  "COACH_ENTERED",
  "UNKNOWN",
] as const;
export const dataSourceSchema = z.enum(DATA_SOURCES);
export type DataSource = z.infer<typeof dataSourceSchema>;

export const CONFIDENCES = ["HIGH", "MEDIUM", "LOW", "NONE"] as const;
export const confidenceSchema = z.enum(CONFIDENCES);
export type Confidence = z.infer<typeof confidenceSchema>;

// ---------------------------------------------------------------------------
// QuantityInterval
// ---------------------------------------------------------------------------

/**
 * 値の区間表現。**null を 0 として扱わないための型**（§2.1 の最重要コメント）。
 * R1 では「null を 0 に正規化するユーティリティ」を意図的に作らない
 * （aggregation は R6 の責務。§11 の UNKNOWN 伝播規則に従う）。
 *
 * [DEVIATION] Range と同じ理由でジェネリック。schema ファクトリで対応する。
 */
export type QuantityInterval<U extends Unit = Unit> = {
  lower: number | null;
  upper: number | null;
  unit: U;
  source: DataSource;
  confidence: Confidence;
};

export function quantityIntervalSchema<U extends Unit>(unitLiteral: z.ZodType<U>) {
  return z
    .object({
      lower: z.number().nullable(),
      upper: z.number().nullable(),
      unit: unitLiteral,
      source: dataSourceSchema,
      confidence: confidenceSchema,
    })
    .refine(
      (v) => v.lower === null || v.upper === null || v.lower <= v.upper,
      { message: "QuantityInterval.lower は upper 以下である必要があります（両方 non-null のとき）" },
    );
}
/** 任意の Unit を許す QuantityInterval（Finding.value など）。 */
export const anyUnitQuantityIntervalSchema = quantityIntervalSchema(unitSchema);

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

export const evidenceIdSchema = z
  .string()
  .min(1, "EvidenceId は空文字にできません")
  .brand<"EvidenceId">();
export type EvidenceId = z.infer<typeof evidenceIdSchema>;

/**
 * stop policy の識別子。R1 では実際の StopPolicy（§10）を定義しない
 * （planning/monitoring は R4・R8）。RunningPrescription 型が参照できるよう、
 * ID のブランド型だけを用意する。
 */
export const stopPolicyIdSchema = z
  .string()
  .min(1, "StopPolicyId は空文字にできません")
  .brand<"StopPolicyId">();
export type StopPolicyId = z.infer<typeof stopPolicyIdSchema>;

// ---------------------------------------------------------------------------
// RaceEvent
// ---------------------------------------------------------------------------

/**
 * [DEVIATION] 正式仕様のコードスニペットは `RaceEvent` という型名を
 * `IntensityReference`（RACE_PACE 分岐）や `AthleteProfile.primaryEvent`、
 * `SessionTemplate.primaryEvents` から参照しているが、`RaceEvent` 自体の
 * 具体的な値一覧は仕様書のどこにも列挙されていない。
 *
 * R1 監査時に既存リポジトリを確認した結果、`src/domain/exercise/constants.ts`
 * の `TRACK_FIELD_EVENTS`（`SPRINT` / `HURDLE` / `LONG_JUMP` / ... の8値）が
 * 唯一の既存「種目」定数だったが、これは Exercise（種目カタログ）を
 * どの競技カテゴリ向けかで分類するための粗い軸であり、"100m" vs "200m" の
 * ような具体的な競走距離を区別できない別概念である。そのため流用・派生はせず、
 * Running v2 専用に `RaceEvent` を定義する（＝ここでの独自定義は「既存の
 * canonical 定義を無視した重複」ではなく、既存に存在しない概念を新規に
 * 定義したもの）。
 *
 * 値は §4.5 の「primaryEvent ∈ {200m, 400m, 400mH}」という記述例と、
 * ユーザー監査指示で明示された最低限（100m/200m/400m/400mH）に厳密に限定した:
 *   - `300m` は含めない。`TimedMark`（計時記録として実際に計測しうる距離）と
 *     `RaceEvent`（選手の主種目・RACE_PACE の対象となる公式競走種目）は別概念であり、
 *     300m は前者（`TIMED_MARK_EVENTS`）にのみ残す。300m を RaceEvent として
 *     残すべき明確な仕様上の要件は無い。
 *   - `100mH`/`110mH` のような短いハードルは追加しない。
 *     `AthleteProfile.primaryEvent` 側に既にある `"HURDLES"` という汎用値が
 *     この用途を担い、R1 で仕様に無いハードル種目の細分化を推測で行わない。
 *   - `400mH` は距離的に `LONG_SPRINT_RACE_SPECIFIC` の主要種目として明示的に
 *     名指しされているため RaceEvent 側に残す。
 */
export const RACE_EVENTS = ["100m", "200m", "400m", "400mH"] as const;
export const raceEventSchema = z.enum(RACE_EVENTS);
export type RaceEvent = z.infer<typeof raceEventSchema>;

// ---------------------------------------------------------------------------
// CompetitionPriority（§2.2。実際の大会ウィンドウ規則は §14 = R7）
// ---------------------------------------------------------------------------

export const COMPETITION_PRIORITIES = ["TRAINING_MEET", "NORMAL", "IMPORTANT", "PEAK"] as const;
export const competitionPrioritySchema = z.enum(COMPETITION_PRIORITIES);
export type CompetitionPriority = z.infer<typeof competitionPrioritySchema>;
