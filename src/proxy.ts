import { NextResponse, type NextRequest } from "next/server";
import { APP_SESSION_COOKIE, appAuthRequired, appSessionIdFromToken } from "@/infra/auth/app-session";
import { appAuthGate } from "@/infra/auth/app-auth-gate";
import { findValidAppSession } from "@/infra/repositories/app-user-repository";

/**
 * 公開URL（本番）では、画面・保存・AI提案のすべてにログインを求める。
 * ログイン状態は毎回 DB と照合するので、削除した利用者やパスワード変更前の端末はすぐ入れなくなる。
 * 種目の登録・編集や動画解析など管理者だけの場所には、メンバーは入れない。
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const sessionId = appSessionIdFromToken(request.cookies.get(APP_SESSION_COOKIE)?.value);
  const decision = await appAuthGate({
    required: appAuthRequired(), pathname, search, method: request.method,
    session: async () => sessionId === null ? null : (await findValidAppSession(sessionId, new Date()))?.user ?? null,
  });
  if (decision.kind === "ALLOW") return NextResponse.next();
  if (decision.kind === "REDIRECT") {
    // Fly.io は https を受けてから http でアプリへ渡すので、元が https なら案内先も https にする。
    const location = new URL(decision.location, request.url);
    if (request.headers.get("x-forwarded-proto") === "https") location.protocol = "https:";
    return NextResponse.redirect(location, 307);
  }
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (decision.kind === "FORBIDDEN") return new NextResponse("この操作は管理者だけができます。", { status: 403, headers });
  return new NextResponse("ログインが必要です。", { status: 401, headers });
}
