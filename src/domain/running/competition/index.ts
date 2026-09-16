/**
 * Running Prescription Engine v2 — §14 Phase / Competition / Taper の公開エントリ（§9.2 step 4）。
 *
 * `resolveCompetitionAndPhase` は内部 resolver（phase.ts / windows.ts / taper.ts）を束ねるだけで、
 * root からは export しない（§91: competition 内部 resolver・phase helper は非公開）。
 */
import type { RuleSet, RuleSetSessionTemplate } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { LoadEvent } from "../types/load";
import type { RunningTrainingMethod } from "../types/method";
import type { IsoDate } from "../types/primitives";
import type { RangePosition } from "../types/prescription";
import type { EnvelopeTier } from "../types/subject";
import type { TrainingPhase } from "../../menu/constants";
import { evaluatePhase } from "./phase";
import {
  combinedDosePositionCap,
  daysUntilCompetition,
  longIncompleteBlockedBy,
  matchedCompetitionWindows,
  nonRaceHighReviewFindings,
  resolveAutogenBlock,
  resolveNewStimulus,
  taperGuidanceOf,
} from "./windows";
import { computeTaperBaseline } from "./taper";
import type { CompetitionRef, PhaseCompetitionResult } from "./schema";

export type { CompetitionRef, PhaseCompetitionContext, PhaseCompetitionResult } from "./schema";
export { competitionRefSchema, assertNoDuplicateCompetitionIds } from "./schema";
export type { TaperGuidance } from "../rules/schema";

const POSITION_ORDER: Record<RangePosition, number> = { LOWER_BOUND: 0, LOWER_HALF: 1, MIDDLE: 2, UPPER_HALF: 3 };
function lower(a: RangePosition | null, b: RangePosition | null): RangePosition | null {
  if (a === null) return b;
  if (b === null) return a;
  return POSITION_ORDER[a] <= POSITION_ORDER[b] ? a : b;
}

function finding(code: string, severity: Finding["severity"], params: Record<string, string | number> = {}): Finding {
  return { code, severity, scope: "ITEM", metric: Object.entries(params).map(([k, v]) => `${k}=${v}`).join(","), evidenceIds: [] };
}

export function resolveCompetitionAndPhase(args: {
  ruleSet: RuleSet;
  phase: TrainingPhase | null;
  competitions: readonly CompetitionRef[];
  plannedDate: string | null;
  tier: EnvelopeTier;
  method: RunningTrainingMethod;
  loadClass: RuleSet["methods"][number]["loadClass"];
  template: RuleSetSessionTemplate | null;
  coverage28d: "COMPLETE" | "PARTIAL" | "NONE";
  templateUsedWithin28d: boolean;
  history: readonly LoadEvent[];
}): PhaseCompetitionResult {
  const { ruleSet, phase, competitions, plannedDate, tier, method, loadClass, template, coverage28d, templateUsedWithin28d, history } = args;

  const phaseEval = evaluatePhase(ruleSet, phase);
  const matched = matchedCompetitionWindows({ ruleSet, competitions, plannedDate, tier });
  const autogenRes = resolveAutogenBlock({ matched, method, loadClass, template });

  const findings: Finding[] = [...phaseEval.findings];
  const autogenBlockedLoadClasses = new Set<string>(phaseEval.blockedAutogenLoadClasses);
  let autogenException: { positionCap: RangePosition } | null = null;

  if ((phaseEval.blockedAutogenLoadClasses as readonly string[]).includes(loadClass)) {
    // §14.1 TRANSITION 等: phase 由来の自動生成停止。AI/SYSTEM は ineligible、COACH は手動 + REVIEW で継続可。
    findings.push(finding("PHASE_AUTOGEN_BLOCKED", "BLOCK_AUTOGEN"), finding("PHASE_AUTOGEN_BLOCKED", "REQUIRE_COACH_REVIEW"));
  }

  if (autogenRes.blocked) {
    autogenBlockedLoadClasses.add(loadClass);
    findings.push(finding("COMPETITION_AUTOGEN_BLOCKED", "BLOCK_AUTOGEN"), finding("COMPETITION_AUTOGEN_BLOCKED", "REQUIRE_COACH_REVIEW"));
  } else if ("exceptionPositionCap" in autogenRes) {
    autogenException = { positionCap: autogenRes.exceptionPositionCap };
  }

  findings.push(...nonRaceHighReviewFindings(matched, loadClass));
  if (nonRaceHighReviewFindings(matched, loadClass).length > 0) {
    autogenBlockedLoadClasses.add(loadClass);
  }

  const newStimulus = resolveNewStimulus({ matched, coverage28d, templateUsedWithin28d });
  if (newStimulus === "NEW") {
    findings.push(finding("COMPETITION_NEW_STIMULUS", "BLOCK_AUTOGEN"), finding("COMPETITION_NEW_STIMULUS", "REQUIRE_COACH_REVIEW"));
    autogenBlockedLoadClasses.add(loadClass);
  } else if (newStimulus === "NOT_DETERMINABLE") {
    findings.push(finding("COMPETITION_NEW_STIMULUS_NOT_DETERMINABLE", "BLOCK_AUTOGEN"), finding("COMPETITION_NEW_STIMULUS_NOT_DETERMINABLE", "REQUIRE_COACH_REVIEW"));
    autogenBlockedLoadClasses.add(loadClass);
  }

  const taperGuidance = taperGuidanceOf(matched);
  if (taperGuidance !== null) {
    const baseline = plannedDate === null ? null : computeTaperBaseline({ events: history, plannedDate: plannedDate as IsoDate, coverage28d });
    findings.push(
      finding("COMPETITION_TAPER_GUIDANCE", "INFO", {
        reductionPercentLower: taperGuidance.reductionPercentLower,
        reductionPercentUpper: taperGuidance.reductionPercentUpper,
        ...(baseline ? { baselineAverageLowerM: Math.round(baseline.averageLowerM), baselineAverageUpperM: Math.round(baseline.averageUpperM) } : {}),
      }),
    );
  }

  const dosePositionCap = lower(phaseEval.dosePositionCap, lower(combinedDosePositionCap(matched), autogenException?.positionCap ?? null));

  return {
    dosePositionCap,
    autogenBlockedLoadClasses: [...autogenBlockedLoadClasses] as RuleSet["methods"][number]["loadClass"][],
    autogenException,
    competitionDay: plannedDate === null ? null : competitions.some((c) => daysUntilCompetition(plannedDate, c) === 0),
    longIncompleteBlocked: longIncompleteBlockedBy(matched),
    findings,
  };
}
