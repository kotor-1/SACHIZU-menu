/**
 * Running Prescription Engine v2 — [R10-B4B] メニューの対象グループ・計画日（RunningMenuContext）の入力モデル。
 *
 * 純粋関数だけ（DOM も DB も触らない）。画面の入力値（すべて文字列）→ 保存 Action に渡す JSON 1本、が責務。
 *
 * 守ること:
 *   - **受け付ける形は `runningMenuContextSchema` そのもの**。ここで新しい field を作らない
 *     （痛み・睡眠・性別・生年月日などの健康 / 個人情報の入力欄は作らない ―― schema にも無い）。
 *   - **計画日を今日で補わない。** 未入力ならエラーにして、コーチに入力してもらう。
 *   - 開始予定時刻の暦日が計画日と違うときは**黙って直さない**（エラーとして返す）。
 *   - タイムゾーンは入力欄のある端末の offset を明示的に受け取る（`Date.now()` をこの層で呼ばない）。
 */
import { runningMenuContextSchema, type RunningMenuContext } from "@/domain/running/persistence/menuContext";

export type RunningContextMemberDraft = {
  /** "" = 指定なし（生年月日からの年齢帯は使わない）。 */
  ageBandOverride: string;
  maturityStatus: string;
  maturityConfidence: string;
  maturityMethod: string;
  /** "" = 記録なし。 */
  maturityAssessedAt: string;
  /** "" = 未入力（0 にしない）。 */
  structuredSprintYears: string;
  /** "" = 指定なし。 */
  coachAssignedTier: string;
  primaryEvent: string;
};

export type RunningContextDraft = {
  label: string;
  /** "yyyy-mm-dd"。"" = 未設定（今日では補わない）。 */
  plannedDate: string;
  /** `<input type="datetime-local">` の値。"" = 未設定。 */
  plannedAtLocal: string;
  /** `plannedAtLocal` を入力した端末の UTC offset（分。`Date.prototype.getTimezoneOffset()` と同符号）。 */
  plannedAtOffsetMinutes: number | null;
  /** "" = 未入力（練習時間の上限を見ない）。 */
  availableMinutes: string;
  /** "" = 未入力。 */
  memberCountHint: string;
  allowAdvancedMethods: boolean;
  members: RunningContextMemberDraft[];
};

export type RunningContextBuildResult =
  | { ok: true; value: RunningMenuContext; json: string }
  | { ok: false; message: string };

export function emptyMemberDraft(): RunningContextMemberDraft {
  return {
    ageBandOverride: "",
    maturityStatus: "UNKNOWN",
    maturityConfidence: "LOW",
    maturityMethod: "NONE",
    maturityAssessedAt: "",
    structuredSprintYears: "",
    coachAssignedTier: "",
    primaryEvent: "OTHER",
  };
}

export function emptyContextDraft(): RunningContextDraft {
  return {
    label: "",
    plannedDate: "",
    plannedAtLocal: "",
    plannedAtOffsetMinutes: null,
    availableMinutes: "",
    memberCountHint: "",
    allowAdvancedMethods: false,
    members: [],
  };
}

/** 保存済みの設定を入力欄の値へ戻す（保存が無ければ空。日付を今日で埋めない）。 */
export function contextDraftFrom(context: RunningMenuContext | null): RunningContextDraft {
  if (context === null) return emptyContextDraft();
  return {
    label: context.subject.label,
    plannedDate: context.plannedDate ?? "",
    plannedAtLocal: context.plannedAt === null ? "" : context.plannedAt.slice(0, 16),
    plannedAtOffsetMinutes: context.plannedAt === null ? null : offsetMinutesOf(context.plannedAt),
    availableMinutes: context.availableMinutes === null ? "" : String(context.availableMinutes),
    memberCountHint: context.subject.memberCountHint === undefined ? "" : String(context.subject.memberCountHint),
    allowAdvancedMethods: context.subject.allowAdvancedMethods,
    members: context.subject.members.map((m) => ({
      ageBandOverride: m.ageBandOverride ?? "",
      maturityStatus: m.maturity.status,
      maturityConfidence: m.maturity.confidence,
      maturityMethod: m.maturity.method,
      maturityAssessedAt: m.maturity.assessedAt ?? "",
      structuredSprintYears: m.trainingAge.structuredSprintYears === null ? "" : String(m.trainingAge.structuredSprintYears),
      coachAssignedTier: m.trainingAge.coachAssignedTier ?? "",
      primaryEvent: m.primaryEvent,
    })),
  };
}

/** 保存済み ISO 日時（+09:00 / Z）から offset 分を読む。読めなければ null。 */
function offsetMinutesOf(isoDateTime: string): number | null {
  const tail = isoDateTime.slice(16);
  if (tail.endsWith("Z")) return 0;
  const m = /([+-])(\d{2}):(\d{2})$/.exec(tail);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "+" ? -minutes : minutes;
}

/**
 * `<input type="datetime-local">` の値（"2026-09-20T16:00"）を、端末の offset を付けた ISO 日時にする。
 * offset は呼び出し側が渡す（この層で現在時刻・既定のタイムゾーンを推測しない）。
 */
export function isoDateTimeFromLocal(local: string, offsetMinutes: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 14 * 60) return null;
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}:00${sign}${hh}:${mm}`;
}

const PLANNED_DATE_REQUIRED_JA = "計画日を入力してください（今日の日付では補いません）。";
const PLANNED_AT_MISMATCH_JA = "開始予定時刻の日付が計画日と違います。どちらかを直してください（自動では合わせません）。";
const PLANNED_AT_WITHOUT_DATE_JA = "開始予定時刻だけでは保存できません。先に計画日を入力してください。";
const PLANNED_AT_UNREADABLE_JA = "開始予定時刻を読み取れませんでした。入力し直してください。";
const LABEL_REQUIRED_JA = "対象グループの名前を入力してください。";
const AVAILABLE_MINUTES_JA = "練習に使える時間は、0より大きい数値で入力してください。";
const MEMBER_COUNT_JA = "人数の目安は、1以上の整数で入力してください。";
const TRAINING_YEARS_JA = "{n}人目の「専門的なスプリント練習の年数」は、0以上の数値で入力してください。";
const CONTEXT_INVALID_JA = "設定の内容を確認してください。";

function optionalPositive(text: string): number | null | "INVALID" {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : "INVALID";
}

/** 入力欄の値 → 保存する JSON。検証は domain schema に任せ、ここでは日本語のメッセージだけを作る。 */
export function buildRunningContextJson(draft: RunningContextDraft): RunningContextBuildResult {
  if (draft.label.trim() === "") return { ok: false, message: LABEL_REQUIRED_JA };
  if (draft.plannedDate.trim() === "") {
    return { ok: false, message: draft.plannedAtLocal.trim() === "" ? PLANNED_DATE_REQUIRED_JA : PLANNED_AT_WITHOUT_DATE_JA };
  }

  let plannedAt: string | null = null;
  if (draft.plannedAtLocal.trim() !== "") {
    if (draft.plannedAtOffsetMinutes === null) return { ok: false, message: PLANNED_AT_UNREADABLE_JA };
    plannedAt = isoDateTimeFromLocal(draft.plannedAtLocal, draft.plannedAtOffsetMinutes);
    if (plannedAt === null) return { ok: false, message: PLANNED_AT_UNREADABLE_JA };
    // 暦日の不一致は、ここで黙って直さずコーチへ返す（schema も同じ条件で拒否する）。
    if (plannedAt.slice(0, 10) !== draft.plannedDate) return { ok: false, message: PLANNED_AT_MISMATCH_JA };
  }

  const availableMinutes = optionalPositive(draft.availableMinutes);
  if (availableMinutes === "INVALID") return { ok: false, message: AVAILABLE_MINUTES_JA };

  const memberCountHint = optionalPositive(draft.memberCountHint);
  if (memberCountHint === "INVALID" || (memberCountHint !== null && !Number.isInteger(memberCountHint))) {
    return { ok: false, message: MEMBER_COUNT_JA };
  }

  const members: unknown[] = [];
  for (const [index, m] of draft.members.entries()) {
    let structuredSprintYears: number | null = null;
    if (m.structuredSprintYears.trim() !== "") {
      const years = Number(m.structuredSprintYears);
      if (!Number.isFinite(years) || years < 0) return { ok: false, message: TRAINING_YEARS_JA.replace("{n}", String(index + 1)) };
      structuredSprintYears = years;
    }
    members.push({
      ...(m.ageBandOverride === "" ? {} : { ageBandOverride: m.ageBandOverride }),
      maturity: {
        status: m.maturityStatus,
        confidence: m.maturityConfidence,
        method: m.maturityMethod,
        assessedAt: m.maturityAssessedAt === "" ? null : m.maturityAssessedAt,
      },
      trainingAge: { structuredSprintYears, coachAssignedTier: m.coachAssignedTier === "" ? null : m.coachAssignedTier },
      primaryEvent: m.primaryEvent,
    });
  }

  const candidate = {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: draft.label.trim(),
      members,
      ...(memberCountHint === null ? {} : { memberCountHint }),
      allowAdvancedMethods: draft.allowAdvancedMethods,
    },
    plannedDate: draft.plannedDate,
    plannedAt,
    availableMinutes,
  };

  const parsed = runningMenuContextSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, message: CONTEXT_INVALID_JA };
  return { ok: true, value: parsed.data, json: JSON.stringify(parsed.data) };
}
