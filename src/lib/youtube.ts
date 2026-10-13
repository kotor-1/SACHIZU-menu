/**
 * YouTube の各種 URL 形式から動画 ID（11桁）を安全に抽出する。
 *
 * 対応形式:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/shorts/VIDEO_ID
 * - https://www.youtube.com/embed/VIDEO_ID
 * - 各種クエリパラメータ付き (例: ?t=10s, ?si=xxx)
 */
export function extractYouTubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const trimmed = url.trim();
    if (!trimmed) return null;

    const parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");

    // 1. youtu.be/VIDEO_ID
    if (host === "youtu.be") {
      const id = parsed.pathname.slice(1).split("/")[0]?.split("?")[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    // 2. youtube.com or youtube-nocookie.com
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      // /watch?v=VIDEO_ID
      if (parsed.pathname === "/watch") {
        const id = parsed.searchParams.get("v");
        return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }

      // /shorts/VIDEO_ID or /embed/VIDEO_ID
      const segments = parsed.pathname.split("/").filter(Boolean);
      if ((segments[0] === "shorts" || segments[0] === "embed") && segments[1]) {
        const id = segments[1].split("?")[0];
        return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }
    }

    return null;
  } catch {
    return null;
  }
}
