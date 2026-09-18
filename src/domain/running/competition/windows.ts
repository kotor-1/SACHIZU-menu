/**
 * Running Prescription Engine v2 — §14.3 大会ウィンドウの評価。
 *
 * `n = D - d`（calendar day）を計算し、RuleSet の `competitionRules` から該当する全行を集めて
 * 「最も制約の強い結果」に合成する generic resolver。priority 文字列の巨大 switch は持たない。
 * 複数の大会ウィンドウが重なる場合も、弱い方の制限を強い方で消さない（§14.3・§52）。
 */
import type { CompetitionRule, RuleSet, RuleSetSessionTemplate } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { RangePosition } from "../types/prescription";
import type { RunningTrainingMethod } from "../types/method";
import type { IsoDate } from "../types/primitives";
import type { EnvelopeTier } from "../types/subject";
import { calendarDayDiff } from "../weekly/windows";
import type { CompetitionRef } from "./schema";

const POSITION_ORDER: Record<RangePosition, number> = { LOWER_BOUND: 0, LOWER_HALF: 1, MIDDLE: 2, UPPER_HALF: 3 };

function lowestOf(candidates: readonly (RangePosition | null)[]): RangePosition | null {
  const present = candidates.filter((c): c is RangePosition => c !== null);
  if (present.length === 0) return null;
  return present.reduce((lowest, c) => (POSITION_ORDER[c] < POSITION_ORDER[lowest] ? c : lowest));
}

/**
 * n = D − d（暦日差）。D は登録された大会開催期間 [date, endDate]（両端 inclusive）:
 *   - 開催前: date − d（正）
 *   - 開催期間中: 0（2日目以降を「開始日から見て大会後」の負値にしない）
 *   - 終了後: endDate − d（負。大会ウィンドウ対象外）
 * endDate 無し（null / 省略）は date の1日開催で、R7 の `date − d` と完全に一致する。
 * endDate < date は swap せず例外にする（schema 経由なら到達しない）。
 */
export function daysUntilCompetition(plannedDate: string, competition: CompetitionRef): number {
  const endDate = competition.endDate ?? competition.date;
  if (calendarDayDiff(competition.date, endDate) < 0) {
    throw new Error(`CompetitionRef.endDate は date 以降である必要があります: ${competition.id}`);
  }
  const untilStart = calendarDayDiff(plannedDate as IsoDate, competition.date);
  if (untilStart >= 0) return untilStart;
  return Math.min(0, calendarDayDiff(plannedDate as IsoDate, endDate));
}

/**
 * plannedDate が登録された大会開催期間 [date, endDate] 内か（両端 inclusive）。
 * 「その日に実際に出場種目がある」とは推測しない、保守的な calendar context。
 */
export function isWithinCompetitionPeriod(plannedDate: IsoDate, competition: CompetitionRef): boolean {
  return daysUntilCompetition(plannedDate, competition) === 0;
}

/**
 * R6 `AggregationContext.competitionDay`（§14.3 n=0）の唯一の定義: いずれかの大会の開催期間中なら true。
 * 不正な range の検出が大会の並び順に依存しないよう、全件を評価してから判定する。
 */
export function resolveCompetitionDay(plannedDate: IsoDate, competitions: readonly CompetitionRef[]): boolean {
  return competitions.map((c) => isWithinCompetitionPeriod(plannedDate, c)).includes(true);
}

function matchesRule(rule: CompetitionRule, priority: string, tier: EnvelopeTier, n: number): boolean {
  return (rule.priority === null || rule.priority === priority) && (rule.tier === null || rule.tier === tier) && n >= rule.dayMin && n <= rule.dayMax;
}

export type MatchedWindow = { rule: CompetitionRule; competition: CompetitionRef; n: number };

/** plannedDate が無ければ大会近接は評価できない（[] を返す。false と推測しない）。 */
export function matchedCompetitionWindows(args: { ruleSet: RuleSet; competitions: readonly CompetitionRef[]; plannedDate: string | null; tier: EnvelopeTier }): MatchedWindow[] {
  const { ruleSet, competitions, plannedDate, tier } = args;
  if (plannedDate === null) return [];
  const out: MatchedWindow[] = [];
  for (const competition of competitions) {
    const n = daysUntilCompetition(plannedDate, competition);
    if (n < 0) continue; // 大会後は対象外。上限は RuleSet 各行の dayMax がそれぞれ持つ（TS 側に複製しない）。
    for (const rule of ruleSet.competitionRules) {
      if (matchesRule(rule, competition.priority, tier, n)) out.push({ rule, competition, n });
    }
  }
  return out;
}

export type AutogenBlockResolution =
  | { blocked: false }
  | { blocked: false; exceptionPositionCap: RangePosition }
  | { blocked: true; ruleIds: string[] };

/**
 * 現在の item（method・loadClass・template）が、集まった matched window の
 * blockedAutogenLoadClasses に該当するかを判定する。STRIDE / ACC≤距離 の例外は
 * **その行を丸ごと免除**にできたときだけ通す（一部の行だけ免除では block のまま）。
 */
export function resolveAutogenBlock(args: {
  matched: readonly MatchedWindow[];
  method: RunningTrainingMethod;
  loadClass: string;
  template: RuleSetSessionTemplate | null;
}): AutogenBlockResolution {
  const { matched, method, loadClass, template } = args;
  const blockingRows = matched.filter((m) => (m.rule.blockedAutogenLoadClasses as readonly string[]).includes(loadClass));
  if (blockingRows.length === 0) return { blocked: false };

  const exceptionCaps: RangePosition[] = [];
  let allExempted = true;
  for (const { rule } of blockingRows) {
    const methodExempt = (rule.autogenExceptionMethods as readonly string[]).includes(method);
    const accExempt =
      method === "ACCELERATION" &&
      rule.autogenExceptionAccMaxDistanceM !== null &&
      template !== null &&
      template.fixedDistanceField === "repDistanceM" &&
      template.displayDistanceM !== undefined &&
      template.displayDistanceM <= rule.autogenExceptionAccMaxDistanceM;
    if (methodExempt || accExempt) {
      if (rule.autogenExceptionPositionCap !== null) exceptionCaps.push(rule.autogenExceptionPositionCap);
    } else {
      allExempted = false;
    }
  }
  if (allExempted) {
    const cap = lowestOf(exceptionCaps);
    return cap === null ? { blocked: false } : { blocked: false, exceptionPositionCap: cap };
  }
  return { blocked: true, ruleIds: blockingRows.map((m) => m.rule.id) };
}

export type NewStimulusVerdict = "NOT_NEW" | "NEW" | "NOT_DETERMINABLE";

/**
 * §14.3/§41-44 新規刺激判定。matched window のいずれかが `REVIEW_BLOCK_AUTOGEN` を要求していて
 * 初めて意味を持つ。coverage28d が不完全なら「新規ではない」と断定しない。
 */
export function resolveNewStimulus(args: { matched: readonly MatchedWindow[]; coverage28d: "COMPLETE" | "PARTIAL" | "NONE"; templateUsedWithin28d: boolean }): NewStimulusVerdict {
  const { matched, coverage28d, templateUsedWithin28d } = args;
  const applies = matched.some((m) => m.rule.newStimulusPolicy === "REVIEW_BLOCK_AUTOGEN");
  if (!applies) return "NOT_NEW";
  if (coverage28d !== "COMPLETE") return "NOT_DETERMINABLE";
  return templateUsedWithin28d ? "NOT_NEW" : "NEW";
}

/** §14.3 PEAK ADV n5-7: LONG の recoveryStructure=INCOMPLETE を不適格にする行があるか。 */
export function longIncompleteBlockedBy(matched: readonly MatchedWindow[]): { ruleId: string } | null {
  const row = matched.find((m) => !m.rule.longIncompleteAllowed);
  return row ? { ruleId: row.rule.id } : null;
}

export function combinedDosePositionCap(matched: readonly MatchedWindow[]): RangePosition | null {
  return lowestOf(matched.map((m) => m.rule.dosePositionCap));
}

export function isCompetitionDay(matched: readonly MatchedWindow[]): boolean {
  return matched.some((m) => m.n === 0 && m.rule.raceIsLoadEvent);
}

export function nonRaceHighReviewFindings(matched: readonly MatchedWindow[], loadClass: string): Finding[] {
  const dayZero = matched.find((m) => m.n === 0 && m.rule.nonRaceHighReviewOnRaceDay);
  if (!dayZero) return [];
  const isHigh = loadClass === "HIGH_NEURAL" || loadClass === "HIGH_METABOLIC";
  if (!isHigh) return [];
  return [{ code: "COMPETITION_DAY_NON_RACE_HIGH", severity: "REQUIRE_COACH_REVIEW", scope: "ITEM", evidenceIds: [] }];
}

export function taperGuidanceOf(matched: readonly MatchedWindow[]): CompetitionRule["taperGuidance"] | null {
  const withGuidance = matched.find((m) => m.rule.taperGuidance !== null);
  return withGuidance?.rule.taperGuidance ?? null;
}
