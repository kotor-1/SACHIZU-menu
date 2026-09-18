/**
 * Running Prescription Engine v2 — [R10-B4A.2] 目標スプリット入力の組み立て（client でも使う純粋関数）。
 *
 * - 距離・目標タイムはコーチが入力した値だけを使う。template 名・PB・年齢・% から自動で埋めない。
 * - ここで見るのは「正の数値として読めるか」「1区間以上あるか」という入力の完成度だけ。どの Method で使えるか・
 *   値の妥当性（plausibility）は domain が plan で検証する。domain の schema は import しない（型だけ）。
 */
import type { RunningCoachReferenceEditRequest, TargetSplitSegmentDraft } from "./dto";

export type CoachTargetSplitInput = RunningCoachReferenceEditRequest["coachReference"];

export type TargetSplitBuildResult = { ok: true; value: CoachTargetSplitInput; json: string } | { ok: false; message: string };

function positiveNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const EMPTY_TARGET_SPLIT_MESSAGE_JA = "目標スプリットの区間を1つ以上入力してください。";

export function buildTargetSplitInput(drafts: readonly TargetSplitSegmentDraft[]): TargetSplitBuildResult {
  if (drafts.length === 0) return { ok: false, message: EMPTY_TARGET_SPLIT_MESSAGE_JA };
  const segments: CoachTargetSplitInput["segments"] = [];
  for (const [i, draft] of drafts.entries()) {
    const distanceM = positiveNumber(draft.distanceText);
    const targetTimeS = positiveNumber(draft.targetTimeText);
    if (distanceM === null || targetTimeS === null) {
      return { ok: false, message: `区間${i + 1}の距離と目標タイムは、0より大きい数値で入力してください。` };
    }
    segments.push({ distanceM, targetTimeS });
  }
  const value: CoachTargetSplitInput = { kind: "TARGET_SPLIT", segments };
  return { ok: true, value, json: JSON.stringify(value) };
}

/** 保存済みの exact な区間から入力欄の初期値を作る（保存値が無ければ空。自動で区間を作らない）。 */
export function targetSplitDraftsFrom(current: readonly { distanceM: number; targetTimeS: number }[] | null): TargetSplitSegmentDraft[] {
  return (current ?? []).map((s) => ({ distanceText: String(s.distanceM), targetTimeText: String(s.targetTimeS) }));
}

export function buildCoachReferenceEditRequest(
  itemId: string,
  drafts: readonly TargetSplitSegmentDraft[],
  confirmedFindingCodes: readonly string[] = [],
): { ok: true; request: RunningCoachReferenceEditRequest } | { ok: false; message: string } {
  const built = buildTargetSplitInput(drafts);
  if (!built.ok) return built;
  return { ok: true, request: { itemId, coachReference: built.value, confirmedFindingCodes: [...confirmedFindingCodes] } };
}
