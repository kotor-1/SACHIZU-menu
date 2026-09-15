/**
 * Running Prescription Engine v2 — ageBand の解決（§4.2）。
 *
 * R3 は「今日の日付」を内部で読まない。呼び出し側が必ず `asOf: IsoDate`
 * （処方対象日）を渡し、この値だけを基準に年齢を計算する。`Date.now()` や
 * `new Date()`（引数なし）は使わない。日付計算は `Date` オブジェクトも
 * 使わず、YYYY-MM-DD の数値成分だけを比較する date-only 実装にすることで、
 * タイムゾーンによって band が変わることを避ける。
 */
import type { AgeBand } from "../types/subject";
import type { IsoDate } from "../types/primitives";

/**
 * [DEVIATION] `AgeBand`（R1, U12/U15/U18/ADULT の4値）に "UNKNOWN" を
 * 追加しない。正式仕様は GROUP の members が空の場合などに
 * 「ageBand = UNKNOWN」という**観測状態**を要求するが、これは
 * Evidence の population 定義や DB へ保存する canonical な年齢帯とは
 * 別の、R3 context layer だけで使う一時的な状態。そのため R1 の enum を
 * 汚染せず、ここで `ResolvedAgeBand = AgeBand | "UNKNOWN"` として別に定義する。
 */
export type ResolvedAgeBand = AgeBand | "UNKNOWN";

export type AgeBandResolutionInput = {
  birthDate: IsoDate | null;
  ageBandOverride?: AgeBand;
};

/**
 * YYYY-MM-DD の数値成分だけを比較して、asOf 時点の満年齢を返す。
 * `Date` オブジェクトを一切使わないため、タイムゾーンに依存しない。
 * 誕生日当日に加齢する（誕生日は新しい年齢に「入った」日として扱う）。
 */
function ageInYears(birthDate: IsoDate, asOf: IsoDate): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ay, am, ad] = asOf.split("-").map(Number);
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) {
    age -= 1;
  }
  return age;
}

function ageBandForYears(age: number): AgeBand {
  if (age < 12) return "U12";
  if (age <= 14) return "U15";
  if (age <= 17) return "U18";
  return "ADULT";
}

/**
 * §4.2 の境界（<12→U12 / 12–14→U15 / 15–17→U18 / ≥18→ADULT）で ageBand を
 * 解決する。
 *
 * - birthDate がある場合は必ず birthDate を正とする。`ageBandOverride` は
 *   birthDate が無い場合にしか使わない（R1 の定義どおり。実年齢の上書きは
 *   しない）。
 * - birthDate も override も無ければ `"UNKNOWN"`（観測状態。特定の年齢帯を
 *   推測しない）。
 * - birthDate が asOf より未来の場合は入力エラーとして例外を投げる
 *   （validation error。呼び出し側でキャッチして Finding 化する想定）。
 */
export function resolveAgeBand(input: AgeBandResolutionInput, asOf: IsoDate): ResolvedAgeBand {
  if (input.birthDate !== null) {
    if (input.birthDate > asOf) {
      throw new Error(
        `AgeBand resolution error: birthDate (${input.birthDate}) is in the future relative to asOf (${asOf})`,
      );
    }
    return ageBandForYears(ageInYears(input.birthDate, asOf));
  }
  if (input.ageBandOverride !== undefined) {
    return input.ageBandOverride;
  }
  return "UNKNOWN";
}
