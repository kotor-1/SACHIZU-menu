/**
 * Running Prescription Engine v2 — R10-B2 の application service（§9.2 step 4/5 相当を session-creation 時に行う）。
 *
 * `session-actions.ts` から呼ばれる、"use server" を付けない通常の server module。
 * 責務（正式仕様 §16.3 追記・R10-B2 指示）:
 *   1. Menu / MenuItem / RunningMenuContext / Competition / load-history を repository から読む
 *   2. RUNNING_V2 項目が無ければ B2 評価をしない（legacy-only は R9 の fallback のまま）
 *   3. 全 RUNNING_V2 項目の ruleSetVersion + contentHash を集めて exact identity で group する
 *      （`getRuleSetByIdentity` のみ使用。`getActiveRuleSet` は呼ばない。current 版へ silent upgrade しない）
 *   4. RuleSet が単一で解決できたときだけ `evaluateSessionAggregation` / `checkSessionPlausibility` /
 *      `checkLegacyItemPlausibility` / `evaluateWeeklyContext`（R6/R7 domain）でメニュー全体を評価する
 *   5. `SessionPlanningEvaluationInput`（§17.1 の R10 seam）として `createSessionFromMenu()` へ渡す
 *
 * ここでは plan() を一切呼ばない（B2 は「計画済み」項目の評価だけ。再計画ではない）。
 * `createSessionFromMenu()` 自身は今後も RuleSet を読まない・plan() を呼ばない・値を再計算しない
 * （このファイルが評価を完了した **data** を渡すだけ）。
 *
 * domain（`src/domain/running/**`）は Prisma を import できないため、repository 呼び出しは
 * すべてここに置く（このファイル自身も Prisma を直接叩かない。repository を経由する）。
 */
import { evaluateLegacySessionReviews } from "@/application/legacy-session-plausibility-review";
import type { PlausibilityIssue, PlausibilityReviewRequest } from "@/domain/running/types/plausibilityReview";
import { checkOutputPlausibility, checkSessionPlausibility } from "@/domain/running/plausibility/output";
import { provenanceSchema } from "@/domain/running/persistence/provenance";
import { validateRunningMenuItemRecord } from "@/domain/running/persistence/runningItem";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import { runningMenuContextSchema } from "@/domain/running/persistence/menuContext";
import { getCoachActorForServer } from "./_actor";
import { revalidateSavedPlausibilityReviews } from "./_running-plan-service";
import { getActiveRuleSet, resolveSubjectProfile, type Finding, type Subject } from "@/domain/running";
import { resolveCompetitionDay } from "@/domain/running/competition";
import { requiredConfirmationCodes } from "@/domain/running/planning/confirmation";
import { evaluateWeeklyContext } from "@/domain/running/weekly";
import type { WeeklyHistoryInput } from "@/domain/running/types/load";
import {
  plannedDateTimeOf,
  PLANNING_NOT_EVALUATED_REASONS,
  type SessionPlanningEvaluationInput,
} from "@/domain/running/persistence/sessionSnapshot";
import type { RunningMenuContext } from "@/domain/running/persistence/menuContext";
import type { IsoDate, IsoDateTime } from "@/domain/running/types/primitives";
import { findMenu, type MenuDetail } from "@/infra/repositories/menu-repository";
import { listCompetitionRefs } from "@/infra/repositories/competition-repository";
import { listLoadHistory } from "@/infra/repositories/load-history-repository";
import { buildReviewMenuContextFingerprint, buildSourceMenuFingerprint, type FingerprintMenuItemInput } from "@/infra/repositories/session-fingerprint";
import { evaluateStoredRunningMenu, legacyAggregationSummary } from "./_running-menu-evaluation";

/**
 * [R11-B1] 現在の評価で明示確認が必要な内容（severity = REQUIRE_CONFIRMATION）。
 * `BLOCK` はここに入らない（BLOCK は確認で解除できないため REJECT のまま）。
 */
export type SessionConfirmationRequired = { requiredFindingCodes: string[]; findings: Finding[] };

export type SessionPlanningDecision =
  /** RUNNING_V2 項目が無い（legacy-only）。B2 前と同じ挙動を維持し、評価を渡さない（§6/§7）。 */
  | { kind: "SKIP" }
  /** aggregate に BLOCK がある。Session row を1件も作らせない（§20/§21。確認では解除できない） */
  | { kind: "REJECT"; message: string; reviewIssues?: PlausibilityIssue[] }
  | {
      kind: "EVALUATED";
      evaluation: SessionPlanningEvaluationInput;
      /**
       * [R11-B1] null = そのまま作成してよい。非 null = コーチの明示確認が揃うまで作成しない
       * （確認の照合は `_session-confirmation.ts`、判定は R10-B4A の domain helper）。
       */
      confirmationRequired: SessionConfirmationRequired | null;
    };

/** 合計負荷が上限を超えている（BLOCK）。確認では解除できない（§5/§43）。 */
export const SESSION_BLOCK_MESSAGE_JA =
  "このメニューは合計負荷が上限を超えているため、セッションを作成できません。メニュー内容を見直してください。";

// ---------------------------------------------------------------------------
// 小さな helper（[R10-B1] `_running-plan-service.ts` と同じ考え方。B1 を壊さないため、
// ここでは独立に持つ小さな複製。ロジックは「保存済み値をそのまま読むだけ」で新しい policy は無い）
// ---------------------------------------------------------------------------

/** [R9] 週次 48h/72h/7d を満たす最小窓として 28 日分を一括取得する（B1 の `weeklyHistoryAsOf` と同じ窓）。 */
const HISTORY_WINDOW_HOURS = 24 * 28;

async function weeklyHistoryAsOf(asOf: Date): Promise<WeeklyHistoryInput> {
  const { events } = await listLoadHistory({ asOf, windowHours: HISTORY_WINDOW_HOURS });
  return {
    events,
    // [R11 前] 「記録外の活動が無い」ことを確認する Coach confirmation UI が無いため、常に PARTIAL
    // （COMPLETE を捏造しない。B1 の `weeklyHistoryAsOf` と同じ方針）。
    coverage72h: "PARTIAL",
    coverage7d: "PARTIAL",
    coverage28d: "PARTIAL",
    dailyActivity7d: [],
  };
}

/** RunningMenuContext.subject（GROUP のみ）を domain の Subject に変換する。availableMinutes は二重に持たない。 */
function subjectFromContext(context: RunningMenuContext): Subject {
  return {
    kind: "GROUP",
    profile: {
      label: context.subject.label,
      members: context.subject.members.map((m) => ({
        birthDate: null,
        ageBandOverride: m.ageBandOverride,
        maturity: { status: m.maturity.status, confidence: m.maturity.confidence, method: m.maturity.method, assessedAt: m.maturity.assessedAt },
        trainingAge: m.trainingAge,
        primaryEvent: m.primaryEvent,
      })),
      memberCountHint: context.subject.memberCountHint,
      availableMinutes: null,
      allowAdvancedMethods: context.subject.allowAdvancedMethods,
    },
  } as Subject;
}

function coachReviewFinding(code: string): Finding {
  return { code, severity: "REQUIRE_COACH_REVIEW", scope: "SESSION", evidenceIds: [] };
}

function fingerprintItemsOf(menu: MenuDetail): FingerprintMenuItemInput[] {
  return menu.blocks.flatMap((block) =>
    block.items.map((item) => ({
      id: item.id,
      sortOrder: item.sortOrder,
      prescriptionKind: item.prescriptionKind,
      ruleSetVersion: item.ruleSetVersion,
      ruleSetContentHash: item.ruleSetContentHash,
      prescriptionJson: item.prescriptionJson,
          provenanceJson: item.provenanceJson,
      sets: item.sets,
      reps: item.reps,
      distanceMeters: item.distanceMeters,
      durationSeconds: item.durationSeconds,
      restSeconds: item.restSeconds,
      intensityPercent: item.intensityPercent,
      loadKg: item.loadKg,
      exerciseCategory: item.exercise?.category ?? null,
    })),
  );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export async function buildSessionPlanningEvaluation(input: { menuTemplateId: string; date: string; plausibilityReviewRequests?: readonly PlausibilityReviewRequest[] }): Promise<SessionPlanningDecision> {
  const menu = await findMenu(input.menuTemplateId);
  if (!menu) return { kind: "SKIP" }; // メニュー未検出は repository 側で最終的にエラーになる。ここでは評価しない。

  const allRows = menu.blocks.flatMap((block) => block.items);
  const v2Rows = allRows.filter((item) => item.prescriptionKind === "RUNNING_V2");
  if (v2Rows.length === 0) return input.plausibilityReviewRequests?.length ? { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA } : { kind: "SKIP" }; // §6/§7: legacy-only は R9 の fallback を維持する

  const { plannedDate: sessionDate } = plannedDateTimeOf(input.date);
  if (sessionDate === null) return { kind: "SKIP" }; // Action 側の schema 検証を通っていれば通常起きない

  const sourceMenuFingerprint = buildSourceMenuFingerprint(fingerprintItemsOf(menu));
  const findings: Finding[] = [];
  const hasStoredReview = v2Rows.some((item) => {
    try { return (JSON.parse(item.provenanceJson ?? "null")?.plausibilityReviews?.length ?? 0) > 0; }
    catch { return item.provenanceJson?.includes("plausibilityReviews") ?? false; }
  });

  type NotEvaluatedReason = (typeof PLANNING_NOT_EVALUATED_REASONS)[number];
  const notEvaluatedBoth = (reason: NotEvaluatedReason) =>
    ({
      kind: "EVALUATED",
      evaluation: {
        aggregation: { status: "NOT_EVALUATED", reasons: [reason] },
        weeklyContext: { status: "NOT_EVALUATED", reasons: [reason] },
        findings,
        sourceMenuFingerprint,
      },
      // [R11-B1] 評価できていない（§39/§40）ときは確認を要求しない。coach review で作成できる。
      confirmationRequired: null,
    }) satisfies SessionPlanningDecision;

  // ---- §8〜§18: 保存済みメニューの R6 評価は [R10-B4B] の application helper と共有する ----
  // （identity group → RunningMenuContext → prescriptionJson parse → R6 aggregation + plausibility）
  // [§13] 大会近接は「実際にセッションを作成する日」で判定する（menuContext.plannedDate ではない）。
  // [R10-B2.1] 「大会開催期間中か」（endDate による複数日開催を含む）は competition domain の policy。
  // ここでは日付比較を書かず、domain helper を呼ぶだけにする。
  const evaluated = await evaluateStoredRunningMenu({
    menu,
    competitionDayFor: async () => resolveCompetitionDay(sessionDate, await listCompetitionRefs()),
  });
  if (evaluated.status === "SKIP") return { kind: "SKIP" };
  if (evaluated.status === "NOT_EVALUATED") {
    if (hasStoredReview || input.plausibilityReviewRequests?.length) return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA };
    // 個々の SNAPSHOT_JSON_INVALID + REQUIRE_COACH_REVIEW finding は repository 側の
    // `snapshotItemFindings`（sessionSnapshot.ts）が item ごとに必ず付ける。ここで重複させない。
    if (evaluated.reason !== "SNAPSHOT_JSON_INVALID") findings.push(coachReviewFinding(evaluated.reason));
    return notEvaluatedBoth(evaluated.reason);
  }
  const { ruleSet, ruleSetRef, context, parsedV2, aggregate } = evaluated;

  // The separately loaded context must still be the context in the evaluated menu snapshot.
  const capturedContext = parseJsonColumn(menu.runningContextJson, runningMenuContextSchema, { rejectHealthKeys: true });
  if (!capturedContext.ok || canonicalStringify(capturedContext.value) !== canonicalStringify(context)) return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA };
  const reviewedItemIds: string[] = [];
  for (const { itemId, prescription } of parsedV2) {
    const row = v2Rows.find((item) => item.id === itemId)!;
    const provenance = parseJsonColumn(row.provenanceJson, provenanceSchema, { rejectHealthKeys: true });
    const output = checkOutputPlausibility(prescription, ruleSet);
    if (hasStoredReview || output.blocked || prescription.findings.some((finding) => finding.severity === "BLOCK" && finding.plausibility)) {
      if (!provenance.ok) return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA };
      if (provenance.value.plausibilityReviews?.length || output.blocked || prescription.findings.some((finding) => finding.severity === "BLOCK" && finding.plausibility)) {
        try {
          validateRunningMenuItemRecord(row, "READ");
          if (context.plannedDate !== sessionDate) return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA };
          const checked = await revalidateSavedPlausibilityReviews(menu, row);
          if (!checked.valid) return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA, reviewIssues: checked.issues };
          reviewedItemIds.push(itemId);
        } catch { return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA }; }
      }
    }
  }
  const legacy = evaluateLegacySessionReviews({
    menuId: menu.id, sessionDate: input.date, context, sourceMenuFingerprint,
    items: allRows.filter((item) => item.prescriptionKind !== "RUNNING_V2").map((item) => ({ id: item.id, summary: legacyAggregationSummary(item) })),
    resolved: { ruleSet, contentHash: ruleSetRef.contentHash }, requests: input.plausibilityReviewRequests, actor: getCoachActorForServer(),
  });
  if (!legacy.valid) return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA, reviewIssues: legacy.issues };
  if (legacy.reviews.length > 0) {
    const active = getActiveRuleSet(sessionDate);
    if (active.contentHash !== ruleSetRef.contentHash || active.ruleSet.ruleSetVersion !== ruleSetRef.version) return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA, reviewIssues: legacy.issues };
  }
  const aggregationGateFindings = [...aggregate.findings, ...checkSessionPlausibility(aggregate.totalRunningDistanceM, ruleSet).findings, ...(legacy.gateFindings ?? legacy.findings)];
  if (aggregationGateFindings.some((f) => f.severity === "BLOCK")) {
    return { kind: "REJECT", message: SESSION_BLOCK_MESSAGE_JA };
  }
  // [R11-B1] REQUIRE_CONFIRMATION は「作成不可」ではなく「明示確認が必要」。評価はそのまま完成させ、
  // 確認が必要な内容を呼び出し側（Action）へ渡す。BLOCK_AUTOGEN / REQUIRE_COACH_REVIEW は確認不要（§41/§42）。
  const confirmationFindings = aggregationGateFindings.filter((f) => f.severity === "REQUIRE_CONFIRMATION");
  const confirmationRequired: SessionConfirmationRequired | null =
    confirmationFindings.length === 0
      ? null
      : { requiredFindingCodes: requiredConfirmationCodes(confirmationFindings), findings: confirmationFindings };
  findings.push(...evaluated.plausibilityFindings);

  // ---- §15/§16/§23〜§29: R7 weekly context ----
  let weeklyContext: SessionPlanningEvaluationInput["weeklyContext"];
  if (context.plannedAt === null) {
    weeklyContext = { status: "NOT_EVALUATED", reasons: ["PLANNED_AT_UNAVAILABLE"] };
  } else if (context.plannedAt.slice(0, 10) !== sessionDate) {
    findings.push(coachReviewFinding("SESSION_DATE_CONTEXT_MISMATCH"));
    weeklyContext = { status: "NOT_EVALUATED", reasons: ["SESSION_DATE_CONTEXT_MISMATCH"] };
  } else {
    const evaluatedAt: IsoDateTime = context.plannedAt;
    const profile = resolveSubjectProfile({ subject: subjectFromContext(context), asOf: sessionDate as IsoDate, ruleSet });
    const history = await weeklyHistoryAsOf(new Date(evaluatedAt));
    const weeklyItems = parsedV2.map(({ itemId, prescription }) => {
      const loadClass = prescription.loadSnapshot?.loadClass ?? ruleSet.methods.find((m) => m.method === prescription.method)!.loadClass;
      const result = evaluateWeeklyContext(history, {
        ruleSet,
        evaluatedAt,
        method: prescription.method,
        loadClass,
        ageBand: profile.ageBand,
        // [R10-B2 §26] R11 前は readiness を持ち込まない。
        hasExistingReadinessDecision: false,
      });
      return { menuItemId: itemId, result };
    });
    weeklyContext = { status: "EVALUATED", ruleSet: ruleSetRef, items: weeklyItems };
  }

  return {
    kind: "EVALUATED",
    evaluation: {
      aggregation: { status: "EVALUATED", ruleSet: ruleSetRef, result: aggregate },
      weeklyContext,
      findings,
      sourceMenuFingerprint,
      ...(reviewedItemIds.length ? { reviewedItemIds } : {}),
      ...(legacy.reviews.length ? { legacyPlausibilityReviews: legacy.reviews } : {}),
      sourceMenuContextFingerprint: buildReviewMenuContextFingerprint(menu, input.date),
    },
    confirmationRequired,
  };
}
