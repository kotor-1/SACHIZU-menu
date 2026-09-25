import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import {
  SESSION_PAGE_SIZE,
  type SessionFromMenuInput,
  type SessionInput,
  type SessionItemResultInput,
  type SessionSearch,
} from "@/domain/session/schema";
import {
  buildPlanningSnapshot,
  PlanningEvaluationStaleError,
  snapshotLoadCategory,
  type SessionPlanningEvaluationInput,
} from "@/domain/running/persistence/sessionSnapshot";
import { actualRepLogJsonByteLimitIssue, findForbiddenHealthKeys } from "@/domain/running/persistence/limits";
import { readinessPersistedStateSchema, readinessJsonSizeIssue } from "@/domain/running/readiness/execution";
import { actualRepLogStateV1Schema, readRepLogStartState, serializeActualRepLogStateV1 } from "@/domain/running/persistence/repLog";
import { quantityIntervalSchema } from "@/domain/running/types/primitives";
import { safetyOutcomeSchema } from "@/domain/running/types/readiness";
import { terminalMonitorActionSchema } from "@/domain/running/persistence/executionState";
import { buildReviewMenuContextFingerprint, buildSourceMenuFingerprint, type FingerprintMenuItemInput } from "./session-fingerprint";

const sessionDetailInclude = {
  items: {
    orderBy: { sortOrder: "asc" },
    include: {
      exercise: { select: { id: true, name: true, category: true, status: true } },
    },
  },
  sourceMenuTemplate: { select: { id: true, name: true } },
} satisfies Prisma.TrainingSessionInclude;

export type SessionDetail = Prisma.TrainingSessionGetPayload<{
  include: typeof sessionDetailInclude;
}>;
export type SessionItemDetail = SessionDetail["items"][number];

export class CompetitionSessionMutationError extends Error {
  constructor() {
    super("大会実績は通常の練習編集では変更できません");
    this.name = "CompetitionSessionMutationError";
  }
}

function buildWhere(search: SessionSearch): Prisma.TrainingSessionWhereInput {
  const and: Prisma.TrainingSessionWhereInput[] = [{ ownerId: DEFAULT_OWNER_ID }];

  if (search.q) {
    and.push({
      OR: [
        { title: { contains: search.q } },
        { groupName: { contains: search.q } },
        { location: { contains: search.q } },
        { coachNote: { contains: search.q } },
      ],
    });
  }
  if (search.status) and.push({ status: search.status });
  if (search.from && !Number.isNaN(Date.parse(search.from))) {
    and.push({ date: { gte: new Date(search.from) } });
  }
  if (search.to && !Number.isNaN(Date.parse(search.to))) {
    // 終端は「その日いっぱい」を含めたいので翌日 0 時未満で比較する
    const to = new Date(search.to);
    to.setHours(23, 59, 59, 999);
    and.push({ date: { lte: to } });
  }

  return { AND: and };
}

export async function searchSessions(search: SessionSearch) {
  const where = buildWhere(search);
  const skip = (search.page - 1) * SESSION_PAGE_SIZE;

  const [items, total] = await Promise.all([
    prisma.trainingSession.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take: SESSION_PAGE_SIZE,
      include: {
        sourceMenuTemplate: { select: { id: true, name: true } },
        _count: { select: { items: true } },
        items: { select: { done: true } },
      },
    }),
    prisma.trainingSession.count({ where }),
  ]);

  return {
    items,
    total,
    page: search.page,
    pageSize: SESSION_PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE)),
  };
}

export type SessionListItem = Awaited<
  ReturnType<typeof searchSessions>
>["items"][number];

export async function findSession(id: string): Promise<SessionDetail | null> {
  return prisma.trainingSession.findFirst({
    where: { id, ownerId: DEFAULT_OWNER_ID },
    include: sessionDetailInclude,
  });
}

/** Execution reads only the owned Session snapshot, never its source Menu. */
export async function findSessionForReadiness(id: string) {
  return prisma.trainingSession.findFirst({
    where: { id, ownerId: DEFAULT_OWNER_ID },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function listUpcomingSessions(limit = 5) {
  return prisma.trainingSession.findMany({
    where: { ownerId: DEFAULT_OWNER_ID, status: { in: ["PLANNED", "IN_PROGRESS"] } },
    orderBy: { date: "asc" },
    take: limit,
    include: { _count: { select: { items: true } } },
  });
}

export async function createSession(input: SessionInput) {
  return prisma.trainingSession.create({
    data: { ...input, date: new Date(input.date), ownerId: DEFAULT_OWNER_ID },
  });
}

export async function updateSession(id: string, input: SessionInput) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.trainingSession.findFirst({ where: { id, ownerId: DEFAULT_OWNER_ID } });
    if (!session) throw new Error("セッションが見つかりません");
    if (session.sessionKind === "COMPETITION") throw new CompetitionSessionMutationError();
    return tx.trainingSession.update({
      where: { id },
      data: { ...input, date: new Date(input.date) },
    });
  });
}

export async function deleteSession(id: string) {
  const deleted = await prisma.trainingSession.deleteMany({ where: { id, ownerId: DEFAULT_OWNER_ID } });
  return deleted.count === 1;
}

export async function setSessionStatus(id: string, status: string) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.trainingSession.findFirst({ where: { id, ownerId: DEFAULT_OWNER_ID } });
    if (!session) throw new Error("セッションが見つかりません");
    if (session.sessionKind === "COMPETITION") throw new CompetitionSessionMutationError();
    return tx.trainingSession.update({ where: { id }, data: { status } });
  });
}

/**
 * ============================================================================
 * メニューテンプレート → セッション の展開（この層の中核）
 * ============================================================================
 *
 * ここが Menu と Session の責務分離を実際に成立させている処理。
 *
 * ブロック/アイテムを「参照」ではなく「コピー」して SessionItem を作る。
 * その結果:
 *   - 後からテンプレートを編集しても、過去のセッション記録は一切変わらない
 *   - 種目名が変わっても・種目が消えても、記録には当時の名前が残る
 *   - セッション側の順序変更や項目追加がテンプレートに逆流しない
 *
 * exerciseId は「後から辿れると便利」なので残すが、
 * 記録の正しさはこの参照に依存しない（onDelete: SetNull で切れても平気）。
 *
 * Running v2（§17）:
 *   - v2 の計画列もコピーするだけ。prescriptionJson / provenanceJson / rationale は
 *     文字列をそのまま渡す（JSON.parse / stringify / 再レンダリングをしない）
 *   - ここではルールセットを読まない・plan() を呼ばない・値を再計算しない。
 *     集計・週次評価もしない（RuleSet が必要な domain policy は R10 の application layer が行い、
 *     結果を `planningEvaluation` として渡す。渡されなければ NOT_EVALUATED として保存する）
 *   - コピーする前に、RuleSet に依存しない検証結果（壊れた JSON など）を planningSnapshotJson に残す。
 *     検証に失敗してもコピーは止めない
 *
 * [R10-B2] stale evaluation protection（§30〜§37）:
 *   - application layer が評価した時点の menu と、ここが実際にコピーする直前の menu がズレていたら
 *     古い評価を保存しない。読み込み〜書込みを1つの transaction にして、その間の書換えからも守る。
 *   - 指紋は DB の生値だけで計算する（RuleSet loader を持ち込まない。`buildSourceMenuFingerprint`）。
 */
export async function createSessionFromMenu(
  input: SessionFromMenuInput,
  planningEvaluation?: SessionPlanningEvaluationInput,
) {
  return prisma.$transaction(async (tx) => {
    const menu = await tx.menuTemplate.findUnique({
      where: { id: input.menuTemplateId },
      include: {
        blocks: {
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              orderBy: { sortOrder: "asc" },
              include: { exercise: { select: { name: true, category: true } } },
            },
          },
        },
      },
    });
    if (!menu) throw new Error("メニューが見つかりません");

    for (const item of menu.blocks.flatMap((block) => block.items)) {
      if (item.prescriptionKind !== "RUNNING_V2") continue;
      let raw: unknown;
      try { raw = JSON.parse(item.provenanceJson ?? "null"); } catch { raw = null; }
      if (raw && typeof raw === "object" && "plausibilityReviews" in raw &&
          (!Array.isArray(raw.plausibilityReviews) || raw.plausibilityReviews.length > 0) &&
          !planningEvaluation?.reviewedItemIds?.includes(item.id)) throw new PlanningEvaluationStaleError();
    }
    if (planningEvaluation !== undefined) {
      if (planningEvaluation.sourceMenuContextFingerprint !== undefined &&
          buildReviewMenuContextFingerprint(menu, input.date) !== planningEvaluation.sourceMenuContextFingerprint) throw new PlanningEvaluationStaleError();
      const fingerprintItems: FingerprintMenuItemInput[] = menu.blocks.flatMap((block) =>
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
      if (buildSourceMenuFingerprint(fingerprintItems) !== planningEvaluation.sourceMenuFingerprint) {
        throw new PlanningEvaluationStaleError();
      }
    }

    // ブロックをまたいで通し番号を振り直す（セッションは 1 本のリストとして扱う）
    let sortOrder = 0;
    const items = menu.blocks.flatMap((block) =>
      block.items.map((item) => ({
        exerciseId: item.exerciseId,
        exerciseNameSnapshot:
          item.exercise?.name ?? item.displayName ?? "（名称未設定）",
        blockNameSnapshot: block.name,
        sortOrder: sortOrder++,
        plannedSets: item.sets,
        plannedReps: item.reps,
        plannedDistanceMeters: item.distanceMeters,
        plannedDurationSeconds: item.durationSeconds,
        plannedRestSeconds: item.restSeconds,
        plannedIntensityPercent: item.intensityPercent,
        plannedLoadKg: item.loadKg,
        plannedNote: item.note,
        // --- Running v2 の計画スナップショット（§17.2。値をそのままコピー） ---
        prescriptionKind: item.prescriptionKind,
        runningMethod: item.runningMethod,
        sessionTemplateId: item.sessionTemplateId,
        recoveryStructure: item.recoveryStructure,
        plannedBuildUpDistanceMeters: item.buildUpDistanceMeters,
        plannedFlyZoneDistanceMeters: item.flyZoneDistanceMeters,
        plannedSetRestSeconds: item.setRestSeconds,
        plannedIntraRepRestSeconds: item.intraRepRestSeconds,
        plannedIntensityReferenceKind: item.intensityReferenceKind,
        plannedPrescriptionConfidence: item.prescriptionConfidence,
        ruleSetVersion: item.ruleSetVersion,
        ruleSetContentHash: item.ruleSetContentHash,
        plannedPrescriptionJson: item.prescriptionJson,
        plannedProvenanceJson: item.provenanceJson,
        plannedRationale: item.rationale,
        // v2 は plan 時点の loadSnapshot（処方 JSON 内）から。RuleSet には問い合わせない
        loadCategory: snapshotLoadCategory({
          prescriptionKind: item.prescriptionKind,
          prescriptionJson: item.prescriptionJson,
          exerciseCategory: item.exercise?.category ?? null,
        }),
      })),
    );
    const sourceMenuItemIds = menu.blocks.flatMap((block) => block.items.map((item) => item.id));

    // 作成前の読み取り専用の検証（書込みはこの後の 1 回の nested create だけ）
    const planningSnapshot = buildPlanningSnapshot({
      sessionDateInput: input.date,
      evaluation: planningEvaluation,
      items: items.map((i, index) => ({
        menuItemId: sourceMenuItemIds[index],
        sortOrder: i.sortOrder,
        prescriptionKind: i.prescriptionKind,
        prescriptionJson: i.plannedPrescriptionJson,
        provenanceJson: i.plannedProvenanceJson,
        ruleSetVersion: i.ruleSetVersion,
        ruleSetContentHash: i.ruleSetContentHash,
        loadCategory: i.loadCategory,
      })),
    });

    return tx.trainingSession.create({
      data: {
        ownerId: DEFAULT_OWNER_ID,
        title: input.title ?? menu.name,
        date: new Date(input.date),
        sourceMenuTemplateId: menu.id,
        sourceMenuNameSnapshot: menu.name,
        groupName: input.groupName,
        location: input.location,
        status: "PLANNED",
        planningSnapshotJson: JSON.stringify(planningSnapshot),
        items: { create: items },
      },
    });
  });
}

// --- 実施記録 ---------------------------------------------------------------

/**
 * [R11-B2] 当日 Readiness の導出結果を RUNNING_V2 項目へ保存する primitive。
 *
 * ここでやること: `readinessActionsJson` と `safetyOutcome` の **2列だけ** を1 transaction で更新する。
 * ここでやらないこと（application の責務）:
 *   - `resolveReadinessAction` / RuleSet loader / load history の呼び出し（policy 再評価をしない §46）
 *   - raw な ReadinessReport の受け取り（渡されるのは検証済みの enum だけ §43）
 * planned 系の列・legacy の実績列・rep ログ列は1つも触らない（§21・§39・§40）。
 */
export class SessionReadinessStaleError extends Error {
  constructor(readonly code: "SESSION_ITEMS_CHANGED" | "SESSION_NOT_EXECUTABLE" | "SESSION_CLOSED" | "SESSION_ALREADY_IN_PROGRESS" | "SNAPSHOT_UNREADABLE" = "SESSION_ITEMS_CHANGED") {
    super("セッションの内容が変わったため、当日の体調確認をやり直してください");
    this.name = "SessionReadinessStaleError";
  }
}

const readinessResultSchema = z
  .object({
    sessionItemId: z.string().min(1),
    state: readinessPersistedStateSchema,
  })
  .strict();

export type SessionReadinessResultInput = z.infer<typeof readinessResultSchema>;

export async function applySessionReadinessResults(
  trainingSessionId: string,
  results: readonly SessionReadinessResultInput[],
  expectedSession: { status: string; date: Date },
) {
  const parsed = results.map((result) => readinessResultSchema.parse(result));
  if (parsed.length === 0) throw new SessionReadinessStaleError();

  return prisma.$transaction(async (tx) => {
    const session = await tx.trainingSession.findFirst({ where: { id: trainingSessionId, ownerId: DEFAULT_OWNER_ID } });
    if (!session) throw new SessionReadinessStaleError();
    if (session.sessionKind !== "TRAINING") throw new SessionReadinessStaleError("SESSION_NOT_EXECUTABLE");
    if (session.status === "COMPLETED" || session.status === "CANCELLED") throw new SessionReadinessStaleError("SESSION_CLOSED");
    if (session.status !== expectedSession.status || session.date.getTime() !== expectedSession.date.getTime()) throw new SessionReadinessStaleError();
    // [§44/§45] 対象は「このセッションに属する RUNNING_V2 項目」だけ。評価後に構成が変わっていたら中止する。
    const items = await tx.sessionItem.findMany({
      where: { trainingSessionId },
      select: { id: true, prescriptionKind: true, actualRepLogJson: true },
    });
    const v2Ids = items.filter((item) => item.prescriptionKind === "RUNNING_V2").map((item) => item.id);
    const targetIds = parsed.map((result) => result.sessionItemId);
    const targets = new Set(targetIds);
    const sameSet = targets.size === targetIds.length && v2Ids.length === targets.size && v2Ids.every((id) => targets.has(id));
    if (!sameSet) throw new SessionReadinessStaleError();
    for (const item of items.filter((item) => item.prescriptionKind === "RUNNING_V2")) {
      const start = readRepLogStartState(item.actualRepLogJson);
      if (start === "STARTED") throw new SessionReadinessStaleError("SESSION_ALREADY_IN_PROGRESS");
      if (start === "UNREADABLE") throw new SessionReadinessStaleError("SNAPSHOT_UNREADABLE");
    }

    for (const result of parsed) {
      const value = result.state.readinessExecutionStateV1;
      const raw = JSON.stringify(value);
      if (findForbiddenHealthKeys(value).length > 0 || readinessJsonSizeIssue(raw)) throw new Error("Readiness state is invalid");
      const updated = await tx.sessionItem.updateMany({
        where: {
          id: result.sessionItemId,
          trainingSessionId,
          prescriptionKind: "RUNNING_V2",
          trainingSession: { ownerId: DEFAULT_OWNER_ID, sessionKind: "TRAINING" },
        },
        data: { readinessActionsJson: raw, safetyOutcome: result.state.safetyOutcome },
      });
      if (updated.count !== 1) throw new SessionReadinessStaleError("SESSION_NOT_EXECUTABLE");
    }
    return { updated: parsed.length };
  });
}

// --- R11-B3 runtime execution ---------------------------------------------

/** Snapshot-only execution read. Source Menu and RuleSet are intentionally absent. */
export async function findSessionItemForExecution(id: string) {
  return prisma.sessionItem.findFirst({
    where: { id, trainingSession: { ownerId: DEFAULT_OWNER_ID } },
    include: { trainingSession: true },
  });
}

const executionWriteSchema = z.object({
  sessionItemId: z.string().min(1),
  trainingSessionId: z.string().min(1),
  expected: z.object({
    sessionStatus: z.string(),
    prescriptionKind: z.string(),
    plannedPrescriptionJson: z.string().nullable(),
    actualRepLogJson: z.string().nullable(),
    readinessActionsJson: z.string().nullable(),
    safetyOutcome: z.string().nullable(),
    stopReason: z.string().nullable(),
  }).strict(),
  next: z.object({
    executionLogState: actualRepLogStateV1Schema,
    cumulativeHighSpeedExposureM: quantityIntervalSchema(z.literal("m")),
    stopReason: terminalMonitorActionSchema.nullable(),
    safetyOutcome: safetyOutcomeSchema,
  }).strict(),
}).strict();

export type SessionExecutionWriteInput = z.infer<typeof executionWriteSchema>;
export type SessionExecutionWriteResult =
  | { kind: "APPLIED" }
  | { kind: "STALE" }
  | { kind: "SESSION_NOT_EXECUTABLE" }
  | { kind: "SESSION_CLOSED" };

/**
 * Policy-free guarded write. All four execution columns and PLANNED -> IN_PROGRESS
 * are committed together; the raw strings read by the service form the CAS guard.
 */
export async function applySessionExecutionResult(rawInput: SessionExecutionWriteInput): Promise<SessionExecutionWriteResult> {
  const input = executionWriteSchema.parse(rawInput);
  const actualRepLogJson = serializeActualRepLogStateV1(input.next.executionLogState);
  const actualHighSpeedExposureJson = JSON.stringify(input.next.cumulativeHighSpeedExposureM);
  if (actualRepLogJsonByteLimitIssue(actualRepLogJson) || findForbiddenHealthKeys(input.next.executionLogState).length > 0) {
    throw new Error("Execution log is invalid");
  }
  if (findForbiddenHealthKeys(input.next.cumulativeHighSpeedExposureM).length > 0) throw new Error("Execution exposure is invalid");

  return prisma.$transaction(async (tx) => {
    const current = await tx.sessionItem.findFirst({
      where: { id: input.sessionItemId, trainingSession: { ownerId: DEFAULT_OWNER_ID } },
      include: { trainingSession: { select: { id: true, status: true, sessionKind: true } } },
    });
    if (!current) return { kind: "STALE" };
    if (current.trainingSession.sessionKind !== "TRAINING") return { kind: "SESSION_NOT_EXECUTABLE" };
    if (current.trainingSession.status === "COMPLETED" || current.trainingSession.status === "CANCELLED") return { kind: "SESSION_CLOSED" };
    const expected = input.expected;
    const matches = current.trainingSession.id === input.trainingSessionId
      && current.trainingSession.status === expected.sessionStatus
      && current.prescriptionKind === expected.prescriptionKind
      && current.plannedPrescriptionJson === expected.plannedPrescriptionJson
      && current.actualRepLogJson === expected.actualRepLogJson
      && current.readinessActionsJson === expected.readinessActionsJson
      && current.safetyOutcome === expected.safetyOutcome
      && current.stopReason === expected.stopReason;
    if (!matches) return { kind: "STALE" };

    const updated = await tx.sessionItem.updateMany({
      where: {
        id: input.sessionItemId,
        trainingSessionId: input.trainingSessionId,
        prescriptionKind: expected.prescriptionKind,
        plannedPrescriptionJson: expected.plannedPrescriptionJson,
        actualRepLogJson: expected.actualRepLogJson,
        readinessActionsJson: expected.readinessActionsJson,
        safetyOutcome: expected.safetyOutcome,
        stopReason: expected.stopReason,
        trainingSession: { ownerId: DEFAULT_OWNER_ID, sessionKind: "TRAINING" },
      },
      data: {
        actualRepLogJson,
        actualHighSpeedExposureJson,
        stopReason: input.next.stopReason,
        safetyOutcome: input.next.safetyOutcome,
      },
    });
    if (updated.count !== 1) return { kind: "STALE" };
    if (expected.sessionStatus === "PLANNED") {
      const status = await tx.trainingSession.updateMany({
        where: { id: input.trainingSessionId, ownerId: DEFAULT_OWNER_ID, status: "PLANNED", sessionKind: "TRAINING" },
        data: { status: "IN_PROGRESS" },
      });
      if (status.count !== 1) throw new Error("Execution session status changed");
    }
    return { kind: "APPLIED" };
  });
}

const runtimeCoachReviewAckWriteSchema = z.object({
  sessionItemId: z.string().min(1),
  trainingSessionId: z.string().min(1),
  expected: z.object({
    sessionStatus: z.literal("IN_PROGRESS"),
    prescriptionKind: z.literal("RUNNING_V2"),
    plannedPrescriptionJson: z.string(),
    actualRepLogJson: z.string(),
    safetyOutcome: z.string().nullable(),
    stopReason: z.string().nullable(),
  }).strict(),
  nextExecutionLogState: actualRepLogStateV1Schema,
}).strict();

export type RuntimeCoachReviewAckWriteInput = z.infer<typeof runtimeCoachReviewAckWriteSchema>;

/** Policy-free acknowledgement CAS. It changes only the execution-log envelope. */
export async function applyRuntimeCoachReviewAcknowledgement(
  rawInput: RuntimeCoachReviewAckWriteInput,
): Promise<SessionExecutionWriteResult> {
  const input = runtimeCoachReviewAckWriteSchema.parse(rawInput);
  const actualRepLogJson = serializeActualRepLogStateV1(input.nextExecutionLogState);

  return prisma.$transaction(async (tx) => {
    const current = await tx.sessionItem.findFirst({
      where: { id: input.sessionItemId, trainingSession: { ownerId: DEFAULT_OWNER_ID } },
      include: { trainingSession: { select: { id: true, status: true, sessionKind: true } } },
    });
    if (!current) return { kind: "STALE" };
    if (current.trainingSession.sessionKind !== "TRAINING") return { kind: "SESSION_NOT_EXECUTABLE" };
    if (current.trainingSession.status === "COMPLETED" || current.trainingSession.status === "CANCELLED") return { kind: "SESSION_CLOSED" };
    const expected = input.expected;
    const matches = current.trainingSession.id === input.trainingSessionId
      && current.trainingSession.status === expected.sessionStatus
      && current.prescriptionKind === expected.prescriptionKind
      && current.plannedPrescriptionJson === expected.plannedPrescriptionJson
      && current.actualRepLogJson === expected.actualRepLogJson
      && current.safetyOutcome === expected.safetyOutcome
      && current.stopReason === expected.stopReason;
    if (!matches) return { kind: "STALE" };

    const updated = await tx.sessionItem.updateMany({
      where: {
        id: input.sessionItemId,
        trainingSessionId: input.trainingSessionId,
        prescriptionKind: expected.prescriptionKind,
        plannedPrescriptionJson: expected.plannedPrescriptionJson,
        actualRepLogJson: expected.actualRepLogJson,
        safetyOutcome: expected.safetyOutcome,
        stopReason: expected.stopReason,
        trainingSession: { ownerId: DEFAULT_OWNER_ID, status: expected.sessionStatus, sessionKind: "TRAINING" },
      },
      data: { actualRepLogJson },
    });
    return updated.count === 1 ? { kind: "APPLIED" } : { kind: "STALE" };
  });
}

export async function updateSessionItemResult(
  id: string,
  input: SessionItemResultInput,
) {
  const updated = await prisma.sessionItem.updateMany({
    where: { id, trainingSession: { ownerId: DEFAULT_OWNER_ID, sessionKind: { not: "COMPETITION" } } },
    data: input,
  });
  if (updated.count !== 1) throw new CompetitionSessionMutationError();
}

/** チェックボックスだけの高速トグル（実施中の現場で一番使う操作）。 */
export async function toggleSessionItemDone(id: string) {
  const item = await prisma.sessionItem.findFirst({
    where: { id, trainingSession: { ownerId: DEFAULT_OWNER_ID, sessionKind: { not: "COMPETITION" } } },
    select: { done: true, trainingSessionId: true },
  });
  if (!item) throw new Error("項目が見つかりません");

  const updated = await prisma.sessionItem.update({
    where: { id },
    data: { done: !item.done },
  });

  // 1 つでも実施済みになったら、セッションを「実施中」へ自動で進める
  if (updated.done) {
    await prisma.trainingSession.updateMany({
      where: { id: item.trainingSessionId, status: "PLANNED" },
      data: { status: "IN_PROGRESS" },
    });
  }
  return updated;
}

export async function deleteSessionItem(id: string) {
  const deleted = await prisma.sessionItem.deleteMany({
    where: { id, trainingSession: { ownerId: DEFAULT_OWNER_ID, sessionKind: { not: "COMPETITION" } } },
  });
  if (deleted.count !== 1) throw new CompetitionSessionMutationError();
}

/** セッションに、テンプレートに無かった項目を後から足す。 */
export async function addSessionItem(
  trainingSessionId: string,
  data: {
    exerciseId?: string | null;
    exerciseNameSnapshot: string;
    blockNameSnapshot: string;
  },
) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.trainingSession.findFirst({ where: { id: trainingSessionId, ownerId: DEFAULT_OWNER_ID } });
    if (!session) throw new Error("セッションが見つかりません");
    if (session.sessionKind === "COMPETITION") throw new CompetitionSessionMutationError();
    const max = await tx.sessionItem.aggregate({
      where: { trainingSessionId },
      _max: { sortOrder: true },
    });
    return tx.sessionItem.create({
      data: { ...data, trainingSessionId, sortOrder: (max._max.sortOrder ?? -1) + 1 },
    });
  });
}
