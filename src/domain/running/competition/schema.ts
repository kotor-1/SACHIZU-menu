/**
 * Running Prescription Engine v2 — CompetitionRef と Phase/Competition 評価の入出力型（§14）。
 *
 * [R7 helper file] §22 R7 の新規ファイル一覧には無いが、phase / windows / taper / index が
 * 同じ型を参照するため、循環 import を避ける目的でここに集約する。日数バケット・% 削減幅などの
 * **データは一切持たない**（すべて `RuleSet.phaseRules` / `RuleSet.competitionRules`）。
 */
import { z } from "zod";
import { isoDateSchema } from "../types/primitives";
import { competitionPrioritySchema, type CompetitionPriority, type RuleSet } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { RangePosition } from "../types/prescription";
import type { EnvelopeTier } from "../types/subject";
import type { TrainingPhase } from "../../menu/constants";

/** §14: DB モデルは R9。ここでは domain 型として受け取るだけ。 */
export const competitionRefSchema = z
  .object({
    id: z.string().min(1),
    date: isoDateSchema,
    priority: competitionPrioritySchema,
  })
  .strict();
export type CompetitionRef = z.infer<typeof competitionRefSchema>;

export function assertNoDuplicateCompetitionIds(refs: readonly CompetitionRef[]): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.id)) throw new Error(`CompetitionRef.id が重複しています: ${ref.id}`);
    seen.add(ref.id);
  }
}

/** §9.2 step 4 の評価コンテキスト。 */
export type PhaseCompetitionContext = {
  ruleSet: RuleSet;
  phase: TrainingPhase | null;
  competitions: readonly CompetitionRef[];
  /** plannedDate が無ければ大会近接も評価できない（null）。 */
  plannedDate: string | null;
  tier: EnvelopeTier;
  /** §14.3 の new stimulus 判定用（28日カバレッジ + このセッションの templateId 使用歴）。 */
  coverage28d: "COMPLETE" | "PARTIAL" | "NONE";
  templateUsedWithin28d: boolean;
};

/** §9.2 step 4 の出力。dose の位置上限は §9.3 の他の候補と一緒に `lowestPosition` で合成する。 */
export type PhaseCompetitionResult = {
  dosePositionCap: RangePosition | null;
  /** この window では自動生成できない loadClass（COACH は手動 + REVIEW で継続可）。 */
  autogenBlockedLoadClasses: RuleSet["methods"][number]["loadClass"][];
  /** ACCELERATION ≤20m・STRIDE 等の例外に該当した item への位置上限（block の代わり）。 */
  autogenException: { positionCap: RangePosition } | null;
  /** true = 大会当日（R6 AggregationContext.competitionDay に渡す）。plannedDate 無しは null。 */
  competitionDay: boolean | null;
  /** LONG の recoveryStructure=INCOMPLETE をこの window では選べない。 */
  longIncompleteBlocked: { ruleId: string } | null;
  findings: Finding[];
};

export type { CompetitionPriority, TrainingPhase };
