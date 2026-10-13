/** Fly.io のヘルスチェック用。認証なしで "ok" だけを返す（データは読まない）。 */
export function GET() {
  return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
