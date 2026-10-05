import Link from "next/link";
import { listAccessibleGuidanceReviews } from "@/actions/_video-guidance-review-runtime";
import { VideoGuidanceSignOut } from "@/components/exercise/video-guidance-sign-out";
import { videoGuidanceIdentity } from "@/infra/auth/video-guidance-identity";

export const dynamic = "force-dynamic";

export default async function VideoGuidanceReviewIndex() {
  const identity = await videoGuidanceIdentity.currentIdentity();
  if (!identity) return <div className="rounded-xl border bg-white p-6">
    <h1 className="text-xl font-semibold">動画ガイダンスのレビュー</h1>
    <p className="mt-3">内容の表示とレビュー操作にはログインが必要です。</p>
    <Link className="mt-4 inline-block text-indigo-700 underline" href="/video-guidance/sign-in">ログインする</Link>
  </div>;

  const reviews = await listAccessibleGuidanceReviews(identity);
  return <div className="rounded-xl border bg-white p-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-xl font-semibold">動画ガイダンスのレビュー</h1>
      <VideoGuidanceSignOut />
    </div>
    {reviews.length === 0 ? <p className="mt-4">閲覧できる動画ガイダンスはありません。</p> : <>
      <p className="mt-3 text-sm text-slate-600">閲覧権限のある動画ガイダンスを表示しています。</p>
      <ul className="mt-4 divide-y divide-slate-200">
        {reviews.map((review) => <li key={`${review.ownerId}/${review.exerciseId}`} className="py-3">
          <Link className="text-indigo-700 underline" href={`/video-guidance/${encodeURIComponent(review.ownerId)}/${encodeURIComponent(review.exerciseId)}`}>
            {review.exerciseName}
          </Link>
          <p className="mt-1 text-sm text-slate-600">所有者: {review.ownerId}</p>
        </li>)}
      </ul>
    </>}
  </div>;
}
