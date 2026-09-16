import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import {
  legacyLoadCategoryOfExerciseCategory,
  loadCategoryOrNull,
  planningSnapshotSchema,
  snapshotLoadOfPrescriptionJson,
} from "@/domain/running/persistence/sessionSnapshot";
import { loadEventSchema, type LoadClass, type LoadEvent } from "@/domain/running/types/load";

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

type SessionStatusFacts = { status: string };
type ItemCompletionFacts = { done: boolean; stopReason: string | null };

/**
 * 実施状況の事実。過去日付で PLANNED のままの項目は PLANNED_NOT_CONFIRMED（実施したものとして扱う、§12.2）。
 * 実施中 / 完了のセッションでも、チェックされていない項目は「実施の確認が無い」ため同じく PLANNED_NOT_CONFIRMED。
 * 実施中止の理由（stopReason）が記録された項目は PARTIAL。
 */
function itemCompletion(session: SessionStatusFacts, item: ItemCompletionFacts): LoadEvent["completion"] {
  if (session.status === "PLANNED") return "PLANNED_NOT_CONFIRMED";
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

/**
 * 大会セッションの category。planningSnapshotJson に `competitionLoadCategory`（R11 で設定）があればそれ、
 * 無ければ RACE を generic competition running load fallback として使う（個人種目だったと推定する意味ではない）。
 */
function competitionCategoryOf(planningSnapshotJson: string | null): "RACE" | "RELAY" {
  if (planningSnapshotJson === null) return "RACE";
  try {
    const parsed = planningSnapshotSchema.safeParse(JSON.parse(planningSnapshotJson));
    return parsed.success ? (parsed.data.competitionLoadCategory ?? "RACE") : "RACE";
  } catch {
    return "RACE";
  }
}

export async function listLoadHistory(query: LoadHistoryQuery): Promise<LoadHistoryResult> {
  const { asOf, windowHours } = query;
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) throw new Error("asOf が不正です");
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error("windowHours は正の数である必要があります");
  const windowStart = new Date(asOf.getTime() - windowHours * 60 * 60 * 1000);

  const sessions = await prisma.trainingSession.findMany({
    where: {
      ownerId: DEFAULT_OWNER_ID,
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
      // 大会は1セッション = 1イベント。種別が不明でも強度は HIGH、距離・露出は推測しない（unknown 区間）
      push(
        {
          at,
          sessionKey,
          category: competitionCategoryOf(session.planningSnapshotJson),
          method: null,
          templateId: null,
          intensityTag: "HIGH",
          magnitude: { distanceM: unknownMetersInterval(), highSpeedExposureM: unknownMetersInterval() },
          source: "COMPETITION_RECORD",
          completion: sessionCompletion(session),
        },
        { sessionKey, sessionItemId: null, at },
      );
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
