import type { ComposerCatalogExercise, ComposeMenuInput } from "@/domain/menu-composition/contracts";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import type { VerifiedRunningIntent } from "@/application/running-menu/intent";
import { composerCatalogRoles } from "./catalog";

/** Retrieval and planning context only. No new training doses, fatigue classes or competition dates. */
export function buildSessionBrief(input: ComposeMenuInput, intent: VerifiedRunningIntent,
  catalog: readonly ComposerCatalogExercise[], running: RunningPrescription | null) {
  const roles = ["INTRO", "MOBILITY", "TECHNIQUE", "SUPPORT", "CLOSING"] as const;
  return {
    requestedTimeSeconds: input.context.availableTimeSeconds ?? null,
    target: { event: input.context.event ?? null, ageGroup: input.context.ageGroup ?? null },
    explicitAthleteContext: input.context.science ?? null,
    verifiedIntent: { purpose: intent.purpose, fatigueState: intent.fatigueState,
      competitionDays: intent.competitionDays, loadReductionRequested: intent.loadReductionRequested },
    // Unsupported wishes and subjective scales remain in requestText. They are
    // neither discarded nor translated into an unapproved Running policy.
    requestHandling: "目的・本人の疲労報告・大会予定はrequestTextの原文も使う。未検証の大会日数や疲労区分を作らない。",
    rolesToConsider: roles.map(role => ({ role,
      candidateIds: catalog.filter(row => composerCatalogRoles(row).includes(role)).map(row => row.id) })),
    running: running ? { state: "FIXED_PRESCRIPTION" as const,
      minimumKnownRestSeconds: running.minimumKnownRestSeconds,
      instruction: "走の位置を確保する。処方・休息は固定。残り時間を走量へ変換しない。" }
      : { state: intent.runningRequested ? "UNPRESCRIBED" as const : "NOT_REQUESTED" as const },
    planningOrder: "先に必要な役割・順序・計画配分をsessionPlanへ示し、次に登録種目と実施量を配置する。内容に無理があれば計画を短縮し、不足理由をoverview.approachにも示す。",
  };
}
export type SessionBrief = ReturnType<typeof buildSessionBrief>;
