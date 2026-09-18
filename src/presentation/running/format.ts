/**
 * Running Prescription Engine v2 — R10-B3 表示用の数値フォーマット（純粋関数）。
 *
 * 守ること:
 *   - null / 不明を 0 として表示しない（片側が不明な区間は「不明」と書く）
 *   - 範囲（min〜max / lower〜upper）を勝手に中央値へ丸めない
 *   - 数値の意味（安全判定・上限判定）はここで判断しない。見た目の整形だけ
 */
import { UNIT_LABEL_JA, type FieldUnitKind } from "./labels";

const UNKNOWN_JA = "不明";

/** 整数はそのまま、小数は最大2桁（末尾の0は付けない）。 */
export function formatNumberJa(n: number): string {
  if (!Number.isFinite(n)) return UNKNOWN_JA;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** 秒を「45秒」「4分」「4分30秒」にする。 */
export function formatSecondsJa(seconds: number): string {
  if (!Number.isFinite(seconds)) return UNKNOWN_JA;
  if (seconds < 60) return `${formatNumberJa(seconds)}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round((seconds - minutes * 60) * 100) / 100;
  return rest === 0 ? `${minutes}分` : `${minutes}分${formatNumberJa(rest)}秒`;
}

/** 単位付きの1つの値。 */
export function formatValueJa(value: number, unit: FieldUnitKind): string {
  if (unit === "s") return formatSecondsJa(value);
  return `${formatNumberJa(value)}${UNIT_LABEL_JA[unit]}`;
}

/** 閉区間（両端とも数値）。min === max のときだけ1つの値として書く。 */
export function formatRangeJa(range: { min: number; max: number }, unit: FieldUnitKind): string {
  if (range.min === range.max) return formatValueJa(range.min, unit);
  if (unit === "s") return `${formatSecondsJa(range.min)}〜${formatSecondsJa(range.max)}`;
  return `${formatNumberJa(range.min)}〜${formatNumberJa(range.max)}${UNIT_LABEL_JA[unit]}`;
}

/**
 * QuantityInterval（lower / upper が null になりうる）。両側 null なら null（呼び出し側で「表示しない」）。
 * 片側だけ null の場合は、その側を「不明」と書く（0 にしない・中央値にしない）。
 */
export function formatIntervalJa(interval: { lower: number | null; upper: number | null }, unit: FieldUnitKind): string | null {
  const { lower, upper } = interval;
  if (lower === null && upper === null) return null;
  if (lower !== null && upper !== null) return formatRangeJa({ min: lower, max: upper }, unit);
  const unitSuffix = unit === "s" ? "" : UNIT_LABEL_JA[unit];
  const side = (v: number) => (unit === "s" ? formatSecondsJa(v) : formatNumberJa(v));
  return lower === null ? `${UNKNOWN_JA}〜${side(upper as number)}${unitSuffix}` : `${side(lower)}〜${UNKNOWN_JA}${unitSuffix}`;
}

/** domain の Unit（Finding.value / limit）を表示用の単位へ。表示に対応していない単位は null。 */
export function fieldUnitOf(unit: string): FieldUnitKind | null {
  return unit === "m" || unit === "s" || unit === "reps" || unit === "sets" || unit === "percent" ? unit : null;
}

const DATE_FMT = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" });

/** ISO 日時を「2026/9/15」形式（日本時間）にする。読めない値は null。 */
export function formatIsoDateJa(iso: string | null): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : DATE_FMT.format(new Date(t));
}
