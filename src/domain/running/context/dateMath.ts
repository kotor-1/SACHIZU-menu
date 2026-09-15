/**
 * Running Prescription Engine v2 — date-only 演算（context 層共通）。
 *
 * `Date` オブジェクトを一切使わない。YYYY-MM-DD の数値成分だけで計算する
 * ことで、タイムゾーンによって結果が変わることを防ぐ（§4.6, §4.3, §4.2）。
 */
import type { IsoDate } from "../types/primitives";

/** Julian Day Number（純粋な整数演算。暦月日→通日番号の標準アルゴリズム）。 */
export function toJulianDayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * m2 + 2) / 5) +
    365 * y2 +
    Math.floor(y2 / 4) -
    Math.floor(y2 / 100) +
    Math.floor(y2 / 400) -
    32045
  );
}

/** b - a を日数で返す（b が未来なら正）。 */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toJulianDayNumber(b) - toJulianDayNumber(a);
}
