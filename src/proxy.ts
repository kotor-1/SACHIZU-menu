import { NextResponse, type NextRequest } from "next/server";
import { basicAuthDecision } from "@/infra/security/basic-auth";

const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

/**
 * 公開URL全体をパスワードで守る（画面・保存・AI提案・静的ファイルのすべて）。
 * Fly.io のヘルスチェック（/healthz）だけは認証なしで通す。データは読まない。
 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/healthz") return NextResponse.next();
  const decision = basicAuthDecision(request.headers.get("authorization"), {
    user: process.env.APP_BASIC_AUTH_USER,
    password: process.env.APP_BASIC_AUTH_PASSWORD,
    production: process.env.NODE_ENV === "production",
  });
  if (decision === "ALLOW") return NextResponse.next();
  if (decision === "NOT_CONFIGURED") {
    return new NextResponse("パスワードが設定されていないため、公開を止めています。", { status: 503, headers: TEXT_HEADERS });
  }
  return new NextResponse("ユーザー名とパスワードを入力してください。", {
    status: 401, headers: { ...TEXT_HEADERS, "www-authenticate": 'Basic realm="SACHIZU", charset="UTF-8"' },
  });
}
