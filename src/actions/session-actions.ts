"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  CONFIRMED_FINDING_CODES_KEY,
  sessionConfirmationInputSchema,
  sessionFromMenuSchema,
  sessionInputSchema,
  sessionItemResultSchema,
} from "@/domain/session/schema";
import { actionError, actionOk, type ActionResult, type FieldErrors } from "@/domain/shared/result";
import { parseForm } from "@/lib/form";
import {
  CompetitionSessionMutationError,
  addSessionItem,
  createSession,
  createSessionFromMenu,
  deleteSession,
  deleteSessionItem,
  setSessionStatus,
  toggleSessionItemDone,
  updateSession,
  updateSessionItemResult,
} from "@/infra/repositories/session-repository";
import { prisma } from "@/infra/db/prisma";
import { LoadHistoryResolutionError } from "@/infra/repositories/load-history-repository";
import { PlanningEvaluationStaleError } from "@/domain/running/persistence/sessionSnapshot";
import type { FindingPresentationDto } from "@/presentation/running/dto";
import { presentFindings } from "@/presentation/running/findings";
import {
  SESSION_CONFIRMATION_MESSAGE_JA,
  SESSION_CONFIRMATION_STALE_MESSAGE_JA,
  SESSION_PLANNING_STALE_MESSAGE_JA,
} from "@/presentation/running/session-confirmation";
import { buildSessionPlanningEvaluation, type SessionPlanningDecision } from "./_session-planning-service";
import { evaluateSessionReadiness, SessionReadinessError, type SessionReadinessEvaluation, type SessionReadinessRejectionCode } from "./_session-readiness-service";
import { recordSessionRep, SessionExecutionError, type SessionExecutionRejectionCode, type SessionRepRecord } from "./_session-execution-service";
import {
  acknowledgeRuntimeCoachReview,
  RuntimeCoachReviewAckError,
  type RuntimeCoachReviewAckRecord,
  type RuntimeCoachReviewAckRejectionCode,
} from "./_runtime-coach-review-ack-service";
import { evaluateSessionConfirmation, findingConfirmationRecords, type SessionConfirmationRequirement } from "./_session-confirmation";

// ---------------------------------------------------------------------------
// [R11-B1] セッション作成の結果（既存 ActionResult の形を壊さず kind を足した union）
// ---------------------------------------------------------------------------

export type SessionCreationFailure =
  /** 入力の形式が正しくない。 */
  | { ok: false; kind: "INVALID_INPUT"; message: string; fieldErrors?: FieldErrors }
  /** 作成できない（BLOCK・メニュー未検出など）。確認では解除できない。 */
  | { ok: false; kind: "REJECTED"; message: string }
  /** 明示確認が必要（1回目、またはチェック漏れ）。Session は作らない。 */
  | {
      ok: false;
      kind: "CONFIRMATION_REQUIRED";
      message: string;
      requiredFindingCodes: string[];
      findings: FindingPresentationDto[];
      confirmationChallenge: string;
    }
  /** 以前の評価に対する確認が送られてきた。最新の内容で確認をやり直す。 */
  | {
      ok: false;
      kind: "CONFIRMATION_STATE_STALE";
      message: string;
      requiredFindingCodes: string[];
      findings: FindingPresentationDto[];
      confirmationChallenge: string;
    }
  /** 評価とコピー直前でメニュー内容がズレた（repository の fingerprint 検証）。 */
  | { ok: false; kind: "PLANNING_EVALUATION_STALE"; message: string };

export type SessionCreationResult = { ok: true; data: { id: string }; message?: string } | SessionCreationFailure;

function confirmationFailure(
  kind: "CONFIRMATION_REQUIRED" | "CONFIRMATION_STATE_STALE",
  requirement: SessionConfirmationRequirement,
): SessionCreationFailure {
  return {
    ok: false,
    kind,
    message: kind === "CONFIRMATION_REQUIRED" ? SESSION_CONFIRMATION_MESSAGE_JA : SESSION_CONFIRMATION_STALE_MESSAGE_JA,
    requiredFindingCodes: [...requirement.requiredFindingCodes],
    findings: presentFindings(requirement.findings),
    confirmationChallenge: requirement.challenge,
  };
}

/**
 * テンプレートを展開して 1 回分の練習を作る（最も使われる導線）。
 *
 * [R10-B2] RUNNING_V2 項目を含むメニューは、実際にコピーする前に `_session-planning-service.ts` が
 * メニュー全体の集計（R6）・週次文脈（R7）を評価する。集計に BLOCK があればここで拒否し、
 * `createSessionFromMenu()` を一切呼ばない（Session row を作らない）。
 * legacy-only のメニューは評価をスキップし、これまでどおりの挙動のまま `createSessionFromMenu()` を呼ぶ。
 *
 * [R11-B1] 集計に REQUIRE_CONFIRMATION があるときは、2段階の明示確認で作成できる:
 *   1回目（確認入力なし）… 評価を実行し、`CONFIRMATION_REQUIRED` + 確認が必要な Finding + challenge を返す
 *   2回目（確認入力あり）… **以前の評価は使わず**メニューを読み直して評価を再実行し、現在の required code
 *                          との完全一致と challenge の一致を確認してから作成する
 * 確認は Menu 作成時の確認（`Provenance.findingConfirmations`）とは別物で、流用しない（§6）。
 * `BLOCK` は確認では解除できない（§5）。`REQUIRE_COACH_REVIEW` / `BLOCK_AUTOGEN` は確認不要（§41/§42）。
 */
export async function createSessionFromMenuAction(
  _prev: SessionCreationResult | null,
  formData: FormData,
): Promise<SessionCreationResult> {
  const parsed = parseForm(sessionFromMenuSchema, formData);
  if (!parsed.ok) {
    const failure = parsed.result as { message: string; fieldErrors?: FieldErrors };
    return { ok: false, kind: "INVALID_INPUT", message: failure.message, fieldErrors: failure.fieldErrors };
  }
  const confirmationInput = parseForm(sessionConfirmationInputSchema, formData, [CONFIRMED_FINDING_CODES_KEY]);
  if (!confirmationInput.ok) {
    const failure = confirmationInput.result as { message: string; fieldErrors?: FieldErrors };
    return { ok: false, kind: "INVALID_INPUT", message: failure.message, fieldErrors: failure.fieldErrors };
  }
  const input = parsed.data;
  const { confirmedFindingCodes, confirmationChallenge } = confirmationInput.data;

  let decision: SessionPlanningDecision;
  try {
    decision = await buildSessionPlanningEvaluation(input);
  } catch (error) {
    if (error instanceof LoadHistoryResolutionError) {
      return { ok: false, kind: "REJECTED", message: "大会実績の履歴を確認できないため、セッションを作成できません。大会実績を確認してください。" };
    }
    return { ok: false, kind: "REJECTED", message: "セッションの計画評価を完了できませんでした。" };
  }
  if (decision.kind === "REJECT") return { ok: false, kind: "REJECTED", message: decision.message };

  let evaluation = decision.kind === "EVALUATED" ? decision.evaluation : undefined;
  const submitted = { confirmedFindingCodes, confirmationChallenge };
  const hasSubmittedConfirmation = confirmedFindingCodes.length > 0 || confirmationChallenge !== null;

  if (decision.kind === "EVALUATED" && evaluation !== undefined) {
    const outcome = evaluateSessionConfirmation({
      menuTemplateId: input.menuTemplateId,
      sessionDate: input.date,
      // [R11-B1.1] challenge は「現在の planning evaluation 全体」の digest を含む
      evaluation,
      confirmationFindings: decision.confirmationRequired?.findings ?? [],
      submitted,
    });

    if (outcome.status === "CONFIRMATION_REQUIRED" || outcome.status === "CONFIRMATION_STATE_STALE") {
      return confirmationFailure(outcome.status === "CONFIRMATION_REQUIRED" ? "CONFIRMATION_REQUIRED" : "CONFIRMATION_STATE_STALE", outcome.requirement);
    }
    if (outcome.status === "NOT_REQUIRED" && hasSubmittedConfirmation) {
      // [§18] 確認が要らない評価に、以前の確認が送られてきた。黙って作らずに1度やり直させる。
      return {
        ok: false,
        kind: "CONFIRMATION_STATE_STALE",
        message: SESSION_CONFIRMATION_STALE_MESSAGE_JA,
        requiredFindingCodes: [],
        findings: [],
        confirmationChallenge: "",
      };
    }
    if (outcome.status === "CONFIRMED") {
      // [§22] 保存するのは「現在の評価に実在した code」だけ。時刻は server clock（§19）。
      evaluation = { ...evaluation, findingConfirmations: findingConfirmationRecords(outcome.confirmedCodes) };
    }
  } else if (hasSubmittedConfirmation) {
    // 評価そのものが無い（legacy-only 等）のに確認が送られてきたときも silent create しない。
    return {
      ok: false,
      kind: "CONFIRMATION_STATE_STALE",
      message: SESSION_CONFIRMATION_STALE_MESSAGE_JA,
      requiredFindingCodes: [],
      findings: [],
      confirmationChallenge: "",
    };
  }

  let id: string;
  try {
    // [§25] confirmation は fingerprint 検証を迂回しない。repository が transaction 内で再計算する。
    const created = await createSessionFromMenu(input, evaluation);
    id = created.id;
  } catch (e) {
    if (e instanceof PlanningEvaluationStaleError) {
      return { ok: false, kind: "PLANNING_EVALUATION_STALE", message: SESSION_PLANNING_STALE_MESSAGE_JA };
    }
    // Repository / database details are not part of the client contract.
    return { ok: false, kind: "REJECTED", message: "セッションを作成できませんでした。もう一度お試しください。" };
  }

  revalidatePath("/sessions");
  redirect(`/sessions/${id}`);
}

/**
 * [R11-B7A.2] Client へ返してよい message は、明示的に safe と定義した typed error のものだけ。
 * 未知の例外は Prisma の invocation 文・絶対 file path・SQL・stack を含み得るため、
 * そのまま返さず固定文言へ落とす（`instanceof Error` だけでは許可しない）。
 */
function sessionMutationError(error: unknown, fallback: string): ActionResult<never> {
  return actionError(error instanceof CompetitionSessionMutationError ? error.message : fallback);
}

/** テンプレートを使わず、空のセッションを作る。 */
export async function createSessionAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const parsed = parseForm(sessionInputSchema, formData);
  if (!parsed.ok) return parsed.result;

  let id: string;
  try {
    const created = await createSession(parsed.data);
    id = created.id;
  } catch (e) {
    return sessionMutationError(e, "セッションを作成できませんでした。もう一度お試しください。");
  }

  revalidatePath("/sessions");
  redirect(`/sessions/${id}`);
}

export async function updateSessionAction(
  id: string,
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const parsed = parseForm(sessionInputSchema, formData);
  if (!parsed.ok) return parsed.result;

  try {
    await updateSession(id, parsed.data);
  } catch (e) {
    return sessionMutationError(e, "セッションを更新できませんでした。もう一度お試しください。");
  }

  revalidatePath("/sessions");
  revalidatePath(`/sessions/${id}`);
  return actionOk({ id }, "保存しました");
}

export async function deleteSessionAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await deleteSession(id);
  revalidatePath("/sessions");
  redirect("/sessions");
}

export async function setSessionStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !status) return;
  await setSessionStatus(id, status);
  revalidatePath(`/sessions/${id}`);
  revalidatePath("/sessions");
}

// --- 実施記録 ---------------------------------------------------------------

export async function toggleSessionItemAction(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("sessionId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return;
  await toggleSessionItemDone(itemId);
  revalidatePath(`/sessions/${sessionId}`);
}

export async function updateSessionItemAction(
  sessionId: string,
  itemId: string,
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  // done は hidden("") + checkbox("true") の 2 値で届くため配列で受ける
  const parsed = parseForm(sessionItemResultSchema, formData, ["done"]);
  if (!parsed.ok) return parsed.result;
  try {
    await updateSessionItemResult(itemId, parsed.data);
  } catch (e) {
    return sessionMutationError(e, "項目を更新できませんでした。もう一度お試しください。");
  }
  revalidatePath(`/sessions/${sessionId}`);
  return actionOk(null, "記録しました");
}

export async function deleteSessionItemAction(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("sessionId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return;
  await deleteSessionItem(itemId);
  revalidatePath(`/sessions/${sessionId}`);
}

/** 当日その場で足した種目を記録に加える。 */
export async function addSessionItemAction(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("sessionId") ?? "");
  const exerciseId = String(formData.get("exerciseId") ?? "");
  const freeName = String(formData.get("name") ?? "").trim();
  const blockName = String(formData.get("blockName") ?? "").trim() || "追加";
  if (!sessionId) return;

  let name = freeName;
  if (exerciseId) {
    const ex = await prisma.exercise.findUnique({
      where: { id: exerciseId },
      select: { name: true },
    });
    name = ex?.name ?? freeName;
  }
  if (!name) return;

  await addSessionItem(sessionId, {
    exerciseId: exerciseId || null,
    exerciseNameSnapshot: name,
    blockNameSnapshot: blockName,
  });
  revalidatePath(`/sessions/${sessionId}`);
}

export type SessionReadinessActionResult =
  | { ok: true; kind: "READINESS_EVALUATED"; data: SessionReadinessEvaluation }
  | { ok: false; kind: SessionReadinessRejectionCode | "READINESS_SAVE_FAILED"; message: string };

/** Coach action. Strict input validation rejects client-supplied context, gates and identities. */
export async function evaluateSessionReadinessAction(input: unknown): Promise<SessionReadinessActionResult> {
  try {
    const data = await evaluateSessionReadiness(input);
    revalidatePath(`/sessions/${data.sessionId}`);
    return { ok: true, kind: "READINESS_EVALUATED", data };
  } catch (error) {
    // Never expose report values, JSON, Zod issues, or database error messages.
    return {
      ok: false,
      kind: error instanceof SessionReadinessError ? error.code : "READINESS_SAVE_FAILED",
      message: "当日の体調確認を保存できませんでした。セッションの状態と入力を確認してください。",
    };
  }
}

export type RecordRepActionResult =
  | { ok: true; kind: "REP_RECORDED"; data: SessionRepRecord }
  | { ok: false; kind: SessionExecutionRejectionCode | "REP_SAVE_FAILED"; message: string };

/** Coach action. Client supplies only the item id and the formal RepObservation. */
export async function recordRepAction(input: unknown): Promise<RecordRepActionResult> {
  try {
    const data = await recordSessionRep(input);
    revalidatePath(`/sessions/${data.sessionId}`);
    return { ok: true, kind: "REP_RECORDED", data };
  } catch (error) {
    return {
      ok: false,
      kind: error instanceof SessionExecutionError ? error.code : "REP_SAVE_FAILED",
      message: "実施記録を保存できませんでした。セッションの状態と入力を確認してください。",
    };
  }
}

export type AcknowledgeRuntimeCoachReviewActionResult =
  | { ok: true; kind: "ACKNOWLEDGED" | "ALREADY_ACKNOWLEDGED"; data: RuntimeCoachReviewAckRecord }
  | { ok: false; kind: RuntimeCoachReviewAckRejectionCode | "ACK_SAVE_FAILED"; message: string };

/** Coach action. The server rebinds the supplied immutable rep identity to current persisted state. */
export async function acknowledgeRuntimeCoachReviewAction(input: unknown): Promise<AcknowledgeRuntimeCoachReviewActionResult> {
  try {
    const result = await acknowledgeRuntimeCoachReview(input);
    revalidatePath(`/sessions/${result.data.sessionId}`);
    return { ok: true, kind: result.kind, data: result.data };
  } catch (error) {
    return {
      ok: false,
      kind: error instanceof RuntimeCoachReviewAckError ? error.code : "ACK_SAVE_FAILED",
      message: "コーチ確認を保存できませんでした。最新の実施状態を確認してください。",
    };
  }
}
