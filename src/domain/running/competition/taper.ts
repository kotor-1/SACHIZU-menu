/**
 * Running Prescription Engine v2 — §14.4 Taper ガイダンス。
 *
 * ADVANCED tier × PEAK × n=8–14 だけで使う（呼び出し側で絞り込み済みであることを前提にする）。
 * 41–60% は RuleSet の `taperGuidance`（§14.4）からそのまま読み、TS に数値を複製しない。
 *
 * **量への自動倍率は一切適用しない。** ここが計算するのは Finding に載せる基準週の目安（INFO
 * guidance）だけで、`RunningPrescription` の sets/reps/distance を書き換えない。
 *
 * [R7 errata] §14 は一貫して暦日（`plannedDate`）ベースで動く（`n = D − d` も calendar day）。
 * taper の4週 baseline も `plannedAt`（時刻）を要求せず `plannedDate` だけで計算できるようにする
 * （plannedAt が無いメニューでも taper ガイダンスの数値を出せる。48h/72h の weekly window だけが
 * 時刻を必須にする）。
 */
import type { IsoDate } from "../types/primitives";
import type { LoadEvent } from "../types/load";
import { calendarDateOf, calendarDayDiff } from "../weekly/windows";
import { isCompletedEnough } from "../weekly/events";

/** §11.2 と同じ4カテゴリだけを「走行距離」として数える。 */
const RUNNING_DISTANCE_CATEGORIES = new Set(["RUNNING_HIGH_INTENSITY", "RUNNING_LOW_INTENSITY", "RACE", "RELAY"]);

export type WeeklyBaseline = { averageLowerM: number; averageUpperM: number };

/**
 * 直近28日（`plannedDate` を含む）を4つの7日 window に分け、各 window の走行距離合計
 * （対象4カテゴリだけ）を求めて平均する。`coverage28d != COMPLETE`、または対象 event に
 * 距離不明（bound=null）のものが1件でもあれば **数値を出さない**（null を0にしない）。
 */
export function computeTaperBaseline(args: { events: readonly LoadEvent[]; plannedDate: IsoDate; coverage28d: "COMPLETE" | "PARTIAL" | "NONE" }): WeeklyBaseline | null {
  const { events, plannedDate, coverage28d } = args;
  if (coverage28d !== "COMPLETE") return null;

  const relevant = events.filter((e) => isCompletedEnough(e) && RUNNING_DISTANCE_CATEGORIES.has(e.category));

  const weeks: { lower: number; upper: number }[] = [];
  for (let w = 0; w < 4; w++) {
    const minDaysAgo = w * 7;
    const maxDaysAgo = (w + 1) * 7 - 1;
    const inWeek = relevant.filter((e) => {
      const daysAgo = calendarDayDiff(calendarDateOf(e.at), plannedDate);
      return daysAgo >= minDaysAgo && daysAgo <= maxDaysAgo;
    });
    let lowerSum = 0;
    let upperSum = 0;
    for (const e of inWeek) {
      const d = e.magnitude.distanceM;
      if (!d || d.lower === null || d.upper === null) return null; // 不明な距離を 0 にしない
      lowerSum += d.lower;
      upperSum += d.upper;
    }
    weeks.push({ lower: lowerSum, upper: upperSum });
  }

  const averageLowerM = weeks.reduce((s, w) => s + w.lower, 0) / weeks.length;
  const averageUpperM = weeks.reduce((s, w) => s + w.upper, 0) / weeks.length;
  return { averageLowerM, averageUpperM };
}
