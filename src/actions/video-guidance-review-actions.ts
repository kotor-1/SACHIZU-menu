"use server";

import { revalidatePath } from "next/cache";
import { submitVideoGuidanceReview } from "@/application/menu-composition/video-guidance-review";
import { GuidanceReviewAccessError } from "@/domain/exercise/video-guidance-review";
import { VideoGuidancePersistenceError } from "@/domain/exercise/video-guidance-persistence";
import { getVideoGuidanceReviewDependencies } from "./_video-guidance-review-runtime";

export type GuidanceReviewActionResult = { ok: true; message: string } | { ok: false; code: string; message: string };
export async function videoGuidanceReviewAction(_previous: GuidanceReviewActionResult | null, form: FormData): Promise<GuidanceReviewActionResult> {
  try {
    const keys = [...form.keys()].filter((key) => !key.startsWith("$ACTION_"));
    if (keys.some((key) => key !== "payload") || form.getAll("payload").length !== 1) throw new GuidanceReviewAccessError("INVALID_REVIEW");
    const raw = form.get("payload");
    if (typeof raw !== "string" || raw.length > 32000) throw new GuidanceReviewAccessError("INVALID_REVIEW");
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new GuidanceReviewAccessError("INVALID_REVIEW"); }
    const result = await submitVideoGuidanceReview(input, getVideoGuidanceReviewDependencies());
    revalidatePath(`/video-guidance/${encodeURIComponent(result.head.ownerId)}/${encodeURIComponent(result.head.exerciseId)}`);
    return { ok: true, message: "操作を記録しました。最新の内容を読み込み直してください。" };
  } catch (error) {
    const code = error instanceof GuidanceReviewAccessError || error instanceof VideoGuidancePersistenceError ? error.code : "REVIEW_UNAVAILABLE";
    const messages: Record<string, string> = {
      UNAUTHENTICATED: "ログインを確認できません。ログインしてから内容を読み込み直してください。",
      FORBIDDEN: "この種目のレビュー権限がありません。",
      STALE_VIDEO_GUIDANCE: "表示後に候補または承認内容が変わりました。読み込み直してください。",
      SOURCE_MISMATCH: "動画の情報が変わっています。元動画を確認して読み込み直してください。",
      UNRESOLVED_FIELDS: "未確定の項目ごとに内容と確認理由を入力してください。",
      OPERATION_KEY_CONFLICT: "同じ操作番号で異なる内容が送信されました。読み込み直してください。",
      INVALID_REVIEW: "入力内容を確認してください。",
    };
    return { ok: false, code, message: messages[code] ?? "レビューを完了できませんでした。再度表示して状態を確認してください。" };
  }
}
