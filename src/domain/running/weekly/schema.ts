/**
 * Running Prescription Engine v2 — Weekly context の入出力型（§12）。
 *
 * [R7 helper file] §22 R7 の新規ファイル一覧には無いが、events / windows / guards / index が
 * 同じ型を参照するため、循環 import を避ける目的でここに集約する。しきい値・window 時間などの
 * **データは一切持たない**（すべて `RuleSet.weeklyRules`）。
 */
import type { RuleSet } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { HistoryCoverageLevel, LoadEvent } from "../types/load";
import type { RunningTrainingMethod } from "../types/method";
import type { IsoDateTime } from "../types/primitives";
import type { ResolvedAgeBand } from "../context/ageBand";

/**
 * §9.2 step 5 の入力。`evaluatedAt` が null のときは §12.3 の window 評価をしない
 * （`plannedAt` が無いメニューでは 48h/72h を厳密に計算できない。日付だけの近接判定は
 * §14 の Competition window 側で別途行う）。
 */
export type WeeklyEvaluationContext = {
  ruleSet: RuleSet;
  evaluatedAt: IsoDateTime | null;
  method: RunningTrainingMethod;
  loadClass: RuleSet["methods"][number]["loadClass"];
  ageBand: ResolvedAgeBand;
  /** true = §13 の ReadinessDecision が既にある（weekly 側で LOWER_BOUND を重ねて偽装しない）。 */
  hasExistingReadinessDecision: boolean;
};

/** §12.5 の出力。 */
export type WeeklyContextResult = {
  /** null = 未評価（plannedAt が無い）。 */
  evaluatedAt: IsoDateTime | null;
  coverage72h: HistoryCoverageLevel | "NOT_EVALUATED";
  events48h: LoadEvent[];
  events72h: LoadEvent[];
  highSessions7d: number;
  /** readiness の確認が必須（§12.3 の UNKNOWN / 48–72h HIGH）。 */
  readinessRequired: boolean;
  /** readiness が無い場合に weekly 側が代わりに課す位置上限（health data を偽造しない）。 */
  weeklyPositionCap: "LOWER_BOUND" | null;
  autogenBlockedMethods: RunningTrainingMethod[];
  findings: Finding[];
};
