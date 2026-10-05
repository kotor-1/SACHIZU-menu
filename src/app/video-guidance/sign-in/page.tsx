import Link from "next/link";
import { redirect } from "next/navigation";
import { VideoGuidanceSignIn } from "@/components/exercise/video-guidance-sign-in";
import { getVideoGuidanceAuth } from "@/infra/auth/video-guidance-auth-runtime";
import { videoGuidanceIdentity } from "@/infra/auth/video-guidance-identity";

export const dynamic = "force-dynamic";

export default async function VideoGuidanceSignInPage() {
  if (await videoGuidanceIdentity.currentIdentity()) redirect("/video-guidance");
  const available = getVideoGuidanceAuth() !== null;

  return <div className="mx-auto max-w-md rounded-xl border bg-white p-6">
    <h1 className="text-xl font-semibold">動画ガイダンスのレビュー用ログイン</h1>
    {available ? <>
      <p className="mt-3 text-sm text-slate-600">管理者から案内されたアカウントでログインしてください。</p>
      <VideoGuidanceSignIn />
    </> : <p className="mt-3" role="status">現在ログインを利用できません。時間をおいて再度お試しください。</p>}
    <Link className="mt-6 inline-block text-sm text-indigo-700 underline" href="/video-guidance">レビュー一覧へ戻る</Link>
  </div>;
}
