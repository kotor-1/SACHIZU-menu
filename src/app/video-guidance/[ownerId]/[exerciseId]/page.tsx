import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getVideoGuidanceReviewDependencies } from "@/actions/_video-guidance-review-runtime";
import { loadVideoGuidanceReview } from "@/application/menu-composition/video-guidance-review";
import { VideoGuidanceReviewPanel } from "@/components/exercise/video-guidance-review";
import { VideoGuidanceSignOut } from "@/components/exercise/video-guidance-sign-out";
import { GuidanceReviewAccessError } from "@/domain/exercise/video-guidance-review";
import { VideoGuidancePersistenceError } from "@/domain/exercise/video-guidance-persistence";
import { guidanceHash } from "@/infra/repositories/video-guidance-repository";

export const dynamic = "force-dynamic";
export default async function VideoGuidanceReviewPage({ params }: { params: Promise<{ ownerId: string; exerciseId: string }> }) {
  let data;
  try {
    data = await loadVideoGuidanceReview(await params, getVideoGuidanceReviewDependencies());
  } catch (error) {
    if (error instanceof GuidanceReviewAccessError && error.code === "UNAUTHENTICATED") {
      return <div className="rounded-xl border bg-white p-6">
        <h1 className="text-xl font-semibold">動画ガイダンスのレビュー</h1>
        <p className="mt-3">内容の表示とレビュー操作にはログインが必要です。</p>
        <Link className="mt-4 inline-block text-indigo-700 underline" href="/video-guidance/sign-in">ログインする</Link>
      </div>;
    }
    if ((error instanceof GuidanceReviewAccessError && error.code === "FORBIDDEN") || (error instanceof VideoGuidancePersistenceError && error.code === "NOT_FOUND")) notFound();
    throw error;
  }
  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <Link className="text-indigo-700 underline" href="/video-guidance">レビュー一覧へ戻る</Link>
      <VideoGuidanceSignOut />
    </div>
    <VideoGuidanceReviewPanel data={data} operationKey={randomUUID()} sourceBindingHash={data.review.candidate ? guidanceHash(data.review.candidate.sourceBinding) : null} />
  </div>;
}
