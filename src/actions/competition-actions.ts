"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { competitionInputSchema } from "@/domain/running/persistence/competition";
import { competitionParticipationInputSchema } from "@/domain/running/persistence/competitionParticipation";
import type { FieldErrors } from "@/domain/shared/result";
import { formToObject } from "@/lib/form";
import { todayInputValue } from "@/lib/format";
import {
  createCompetition,
  deleteCompetition,
  updateCompetition,
} from "@/infra/repositories/competition-repository";
import { recordCompetitionParticipation } from "@/infra/repositories/competition-session-repository";

export type CompetitionActionResult =
  | { ok: true; kind: "CREATED" | "UPDATED" | "DELETED"; data: { id: string }; message: string }
  | {
      ok: false;
      kind: "INVALID_INPUT" | "NOT_FOUND" | "SAVE_FAILED";
      message: string;
      fieldErrors?: FieldErrors;
    };

export type CompetitionParticipationActionResult =
  | { ok: true; kind: "RECORDED" | "ALREADY_RECORDED"; data: { sessionId: string }; message: string }
  | {
      ok: false;
      kind:
        | "INVALID_INPUT"
        | "COMPETITION_NOT_FOUND"
        | "DATE_OUTSIDE_COMPETITION"
        | "FUTURE_ACTUAL_RECORD"
        | "CONFLICT_EXISTING_RECORD"
        | "SAVE_FAILED";
      message: string;
      fieldErrors?: FieldErrors;
    };

const competitionIdSchema = z.string().min(1).max(128);

const COMPETITION_VALIDATION_MESSAGE_JA = {
  name: "大会名を確認してください。",
  date: "開催日を確認してください。",
  endDate: "終了日を確認してください。",
  priority: "大会の優先度を選び直してください。",
  note: "メモの内容を確認してください。",
  competitionId: "大会情報を確認してください。",
  loadCategories: "出場した種別を選択してください。",
} as const;

function safeFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const candidate = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
    const key = candidate in COMPETITION_VALIDATION_MESSAGE_JA ? candidate : "_form";
    const message = key === "_form"
      ? "入力内容を確認してください。"
      : COMPETITION_VALIDATION_MESSAGE_JA[key as keyof typeof COMPETITION_VALIDATION_MESSAGE_JA];
    const messages = (out[key] ??= []);
    if (!messages.includes(message)) messages.push(message);
  }
  return out;
}

function parseInput(formData: FormData) {
  const raw = formToObject(formData);
  if (raw.endDate === "") raw.endDate = null;
  if (raw.note === "") raw.note = null;
  return competitionInputSchema.safeParse(raw);
}

function invalid(error: z.ZodError): CompetitionActionResult {
  return {
    ok: false,
    kind: "INVALID_INPUT",
    message: "入力内容を確認してください。",
    fieldErrors: safeFieldErrors(error),
  };
}

export async function createCompetitionAction(
  _previous: CompetitionActionResult | null,
  formData: FormData,
): Promise<CompetitionActionResult> {
  const parsed = parseInput(formData);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const created = await createCompetition(parsed.data);
    revalidatePath("/competitions");
    return { ok: true, kind: "CREATED", data: { id: created.id }, message: "大会予定を登録しました。" };
  } catch {
    return { ok: false, kind: "SAVE_FAILED", message: "大会予定を登録できませんでした。" };
  }
}

export async function updateCompetitionAction(
  competitionId: string,
  _previous: CompetitionActionResult | null,
  formData: FormData,
): Promise<CompetitionActionResult> {
  const id = competitionIdSchema.safeParse(competitionId);
  const parsed = parseInput(formData);
  if (!id.success || !parsed.success) {
    return parsed.success
      ? { ok: false, kind: "INVALID_INPUT", message: "入力内容を確認してください。" }
      : invalid(parsed.error);
  }
  try {
    const updated = await updateCompetition(id.data, parsed.data);
    if (updated === null) return { ok: false, kind: "NOT_FOUND", message: "大会予定を確認できません。" };
    revalidatePath("/competitions");
    revalidatePath(`/competitions/${id.data}`);
    return { ok: true, kind: "UPDATED", data: { id: id.data }, message: "大会予定を保存しました。" };
  } catch {
    return { ok: false, kind: "SAVE_FAILED", message: "大会予定を保存できませんでした。" };
  }
}

export async function deleteCompetitionAction(
  _previous: CompetitionActionResult | null,
  formData: FormData,
): Promise<CompetitionActionResult> {
  const raw = formToObject(formData);
  const parsed = z.object({ competitionId: competitionIdSchema }).strict().safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const deleted = await deleteCompetition(parsed.data.competitionId);
    if (!deleted) return { ok: false, kind: "NOT_FOUND", message: "大会予定を確認できません。" };
    revalidatePath("/competitions");
    revalidatePath(`/competitions/${parsed.data.competitionId}`);
    return { ok: true, kind: "DELETED", data: { id: parsed.data.competitionId }, message: "大会予定を削除しました。" };
  } catch {
    return { ok: false, kind: "SAVE_FAILED", message: "大会予定を削除できませんでした。" };
  }
}

/** Calendar Competition に対する、明示的な actual participation record。 */
export async function recordCompetitionParticipationAction(
  _previous: CompetitionParticipationActionResult | null,
  formData: FormData,
): Promise<CompetitionParticipationActionResult> {
  const allowed = new Set(["competitionId", "date", "loadCategories"]);
  if ([...formData.keys()].some((key) => !allowed.has(key))) {
    return { ok: false, kind: "INVALID_INPUT", message: "入力内容を確認してください。" };
  }
  const parsed = competitionParticipationInputSchema.safeParse({
    competitionId: formData.get("competitionId"),
    date: formData.get("date"),
    loadCategories: formData.getAll("loadCategories"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      kind: "INVALID_INPUT",
      message: "開催日と参加種別を確認してください。",
      fieldErrors: safeFieldErrors(parsed.error),
    };
  }

  const result = await recordCompetitionParticipation(parsed.data, { today: todayInputValue() });
  if (result.kind === "RECORDED") {
    revalidatePath("/competitions");
    revalidatePath(`/competitions/${parsed.data.competitionId}`);
    revalidatePath("/sessions");
    revalidatePath(`/sessions/${result.sessionId}`);
    return { ok: true, kind: result.kind, data: { sessionId: result.sessionId }, message: "大会実績を記録しました。" };
  }
  if (result.kind === "ALREADY_RECORDED") {
    return { ok: true, kind: result.kind, data: { sessionId: result.sessionId }, message: "この日の大会実績はすでに記録されています。" };
  }
  const messages = {
    COMPETITION_NOT_FOUND: "大会予定を確認できません。",
    DATE_OUTSIDE_COMPETITION: "開催期間内の日付を選択してください。",
    FUTURE_ACTUAL_RECORD: "未来日の大会実績は記録できません。",
    CONFLICT_EXISTING_RECORD: "既にこの日の大会実績があります。内容を変更する場合は既存記録を削除してから再登録してください。",
    SAVE_FAILED: "大会実績を保存できませんでした。時間をおいてもう一度お試しください。",
  } as const;
  return { ok: false, kind: result.kind, message: messages[result.kind] };
}
