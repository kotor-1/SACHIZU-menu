import { toNextJsHandler } from "better-auth/next-js";
import { getVideoGuidanceAuth } from "@/infra/auth/video-guidance-auth-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailable() {
  return Response.json(
    { message: "現在ログインを利用できません。" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function handle(request: Request, method: "GET" | "POST") {
  try {
    const auth = getVideoGuidanceAuth();
    if (!auth) return unavailable();
    const response = await toNextJsHandler(auth)[method](request);
    if (response.status >= 500) return unavailable();
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return unavailable();
  }
}

export async function GET(request: Request) {
  return handle(request, "GET");
}

export async function POST(request: Request) {
  return handle(request, "POST");
}
