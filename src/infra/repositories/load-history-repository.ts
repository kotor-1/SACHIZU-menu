import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import {
  legacyLoadCategoryOfExerciseCategory,
  loadCategoryOrNull,
  readCompetitionLoadCategories,
  snapshotLoadOfPrescriptionJson,
} from "@/domain/running/persistence/sessionSnapshot";
import { loadEventSchema, type LoadClass, type LoadEvent } from "@/domain/running/types/load";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { readRepLog } from "@/domain/running/persistence/repLog";
import { monitorStateSchema } from "@/domain/running/monitoring/schema";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";

/**
 * ============================================================================
 * TrainingSession / SessionItem → LoadEvent（§12.1・§12.2）
 * ============================================================================
 *
 * 記録の**事実の変換だけ**を行う。窓ごとの判定・taper・phase・readiness・閾値などは持たない（R7 domain の責務）。
 * 時間窓は呼び出し側が `asOf` と `windowHours` で指定する（72h / 7日 / 28日 を同じ関数で取得する）。
 *
 * 窓の契約: `asOf - windowHours <= session.date < asOf`。`asOf` 以降のセッション（未来の予定）は履歴に混ぜない。
 * OS 時刻は読まない。RuleSet にも問い合わせない（v2 の分類は plan 時点の snapshot だけを使う）。
 *
 * LoadEvent の契約を満たせない行（method と template の不整合など）は推測で埋めず `unresolved` に返す。
 */

export type LoadHistoryQuery = {
  /** 評価の基準時刻（通常は計画日時）。この時刻以降のセッションは返さない。 */
  asOf: Date;
  /** 遡る時間（例: 7日 = 168）。 */
  windowHours: number;
  /** owner scope。省略時は Phase 1 の既定 owner を使う。 */
  ownerId?: string;
};

export type UnresolvedLoadRecord = {
  sessionKey: string;
  sessionItemId: string | null;
  at: string;
  reason: "LOAD_EVENT_CONTRACT_INVALID";
};

export type LoadHistoryResult = {
  windowStart: string;
  asOf: string;
  events: LoadEvent[];
  unresolved: UnresolvedLoadRecord[];
};

/**
 * 新形式の大会 snapshot が読めないときの typed failure。
 * HIGH 履歴を消して計画を続ける方が危険なので、該当行を skip せず全体を fail closed にする。
 */
export class LoadHistoryResolutionError extends Error {
  readonly code = "COMPETITION_SNAPSHOT_UNREADABLE" as const;

  constructor(readonly sessionKey: string) {
    super("大会実績の負荷情報を確認できません");
    this.name = "LoadHistoryResolutionError";
  }
}

type SessionStatusFacts = { status: string };
type ItemCompletionFacts = {
  done: boolean;
  stopReason: string | null;
  prescriptionKind: string;
  plannedPrescriptionJson: string | null;
  actualRepLogJson: string | null;
};

function runningExecutionCompletion(item: ItemCompletionFacts): "DONE" | "PARTIAL" | null {
  if (item.prescriptionKind !== "RUNNING_V2") return null;
  const prescription = parseJsonColumn(item.plannedPrescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
  const logs = readRepLog(item.actualRepLogJson);
  if (!prescription.ok || logs.kind === "UNREADABLE" || logs.state.reps.length === 0) return null;
  const reps = logs.state.reps;
  if (!monitorStateSchema.safeParse({ prescription: prescription.value, priorLogs: reps }).success) return null;
  const terminalIndexes = reps
    .map((log, index) => log.action === "END_SESSION_QUALITY" || log.action === "STOP_SAFETY" ? index : -1)
    .filter((index) => index >= 0);
  if (terminalIndexes.length === 0) return null;
  const lastIndex = reps.length - 1;
  if (terminalIndexes.length !== 1 || terminalIndexes[0] !== lastIndex) return "PARTIAL";
  const last = reps[lastIndex];
  if (last.action === "STOP_SAFETY") return "PARTIAL";
  if (item.stopReason !== null && item.stopReason !== "END_SESSION_QUALITY") return "PARTIAL";
  const plannedCount = prescription.value.sets.value * prescription.value.repsPerSet.value;
  const completionReason = prescription.value.monitoringSnapshot.stopPolicy.runtime.plannedCountUnit === "ATTEMPTS"
    ? "ATTEMPTS_COMPLETE" : "PLANNED_REPS_COMPLETE";
  return reps.length === plannedCount && last.reasons.includes(completionReason) ? "DONE" : "PARTIAL";
}

/**
 * 実施状況の事実。過去日付で PLANNED のままの項目は PLANNED_NOT_CONFIRMED（実施したものとして扱う、§12.2）。
 * 実施中 / 完了のセッションでも、チェックされていない項目は「実施の確認が無い」ため同じく PLANNED_NOT_CONFIRMED。
 * 実施中止の理由（stopReason）が記録された項目は PARTIAL。
 */
function itemCompletion(session: SessionStatusFacts, item: ItemCompletionFacts): LoadEvent["completion"] {
  if (session.status === "PLANNED") return "PLANNED_NOT_CONFIRMED";
  const runningCompletion = runningExecutionCompletion(item);
  if (runningCompletion !== null) return runningCompletion;
  if (item.stopReason !== null) return "PARTIAL";
  return item.done ? "DONE" : "PLANNED_NOT_CONFIRMED";
}

function sessionCompletion(session: SessionStatusFacts): LoadEvent["completion"] {
  return session.status === "PLANNED" ? "PLANNED_NOT_CONFIRMED" : "DONE";
}

/** §12.2 の v2 行: plan 時点の MethodMeta.loadClass（loadSnapshot）から強度を決める。category からは推定しない。 */
const INTENSITY_TAG_BY_LOAD_CLASS: Record<LoadClass, LoadEvent["intensityTag"]> = {
  HIGH_NEURAL: "HIGH",
  HIGH_METABOLIC: "HIGH",
  MODERATE: "MODERATE",
  LOW: "LOW",
};

/** 距離・露出が記録されていないことを表す区間（0 にしない）。 */
const unknownMetersInterval = () => ({ lower: null, upper: null, unit: "m" as const, source: "UNKNOWN" as const, confidence: "NONE" as const });

export async function listLoadHistory(query: LoadHistoryQuery): Promise<LoadHistoryResult> {
  const { asOf, windowHours } = query;
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) throw new Error("asOf が不正です");
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error("windowHours は正の数である必要があります");
  const windowStart = new Date(asOf.getTime() - windowHours * 60 * 60 * 1000);

  const sessions = await prisma.trainingSession.findMany({
    where: {
      ownerId: query.ownerId ?? DEFAULT_OWNER_ID,
      date: { gte: windowStart, lt: asOf },
      status: { not: "CANCELLED" },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: {
      items: {
        orderBy: { sortOrder: "asc" },
        include: { exercise: { select: { category: true } } },
      },
    },
  });

  const events: LoadEvent[] = [];
  const unresolved: UnresolvedLoadRecord[] = [];
  const push = (candidate: unknown, facts: Omit<UnresolvedLoadRecord, "reason">) => {
    const parsed = loadEventSchema.safeParse(candidate);
    if (parsed.success) events.push(parsed.data);
    else unresolved.push({ ...facts, reason: "LOAD_EVENT_CONTRACT_INVALID" });
  };

  for (const session of sessions) {
    const at = session.date.toISOString();
    const sessionKey = session.id;

    if (session.sessionKind === "COMPETITION") {
      const categories = readCompetitionLoadCategories(session.planningSnapshotJson);
      if (categories.kind === "UNREADABLE") throw new LoadHistoryResolutionError(sessionKey);
      // 1大会・1開催日 = 1 Session。mixed は同じ sessionKey の RACE → RELAY 2 event に投影する。
      for (const category of categories.categories) {
        push(
          {
            at,
            sessionKey,
            category,
            method: null,
            templateId: null,
            intensityTag: "HIGH",
            magnitude: { distanceM: unknownMetersInterval(), highSpeedExposureM: unknownMetersInterval() },
            source: "COMPETITION_RECORD",
            completion: sessionCompletion(session),
          },
          { sessionKey, sessionItemId: null, at },
        );
      }
      continue;
    }

    for (const item of session.items) {
      const base = { at, sessionKey, source: "SESSION_RECORD" as const, completion: itemCompletion(session, item), magnitude: {} };

      if (item.prescriptionKind === "RUNNING_V2") {
        // category は SessionItem のスナップショット、強度は plan 時点の loadClass。
        // JSON が無い / 壊れている / loadSnapshot の無い旧 snapshot なら強度は UNKNOWN（捏造しない）
        const loadSnapshot = snapshotLoadOfPrescriptionJson(item.plannedPrescriptionJson);
        push(
          {
            ...base,
            category: loadCategoryOrNull(item.loadCategory) ?? "OTHER",
            method: item.runningMethod,
            templateId: item.sessionTemplateId,
            intensityTag: loadSnapshot === null ? "UNKNOWN" : INTENSITY_TAG_BY_LOAD_CLASS[loadSnapshot.loadClass],
          },
          { sessionKey, sessionItemId: item.id, at },
        );
        continue;
      }

      // legacy: Exercise があればその category、削除済み / 自由入力ならスナップショット、それも無ければ OTHER
      const category = item.exercise
        ? legacyLoadCategoryOfExerciseCategory(item.exercise.category)
        : (loadCategoryOrNull(item.loadCategory) ?? "OTHER");
      push({ ...base, category, method: null, templateId: null, intensityTag: "UNKNOWN" }, { sessionKey, sessionItemId: item.id, at });
    }
  }

  return { windowStart: windowStart.toISOString(), asOf: asOf.toISOString(), events, unresolved };
}
