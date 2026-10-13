"use client";

import { extractYouTubeVideoId } from "@/lib/youtube";

/**
 * 一覧ではサムネイル画像だけを読み込み、押した種目だけ動画を読み込む（10本以上並んでも重くならない）。
 * YouTube 以外の URL や壊れた URL では何も出さない。
 */
export function VideoThumbnail({ url, title, playing, onToggle }: { url: string | null | undefined; title: string; playing: boolean; onToggle: () => void }) {
  const id = extractYouTubeVideoId(url);
  if (!id) return null;
  return <button type="button" onClick={onToggle} aria-label={playing ? `${title}の動画を閉じる` : `${title}の動画を再生`} aria-pressed={playing}
    className="group relative block aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-slate-900 sm:w-36">
    {/* eslint-disable-next-line @next/next/no-img-element -- YouTube のサムネイルをそのまま表示する（画像変換サーバーを経由しない） */}
    <img src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100" />
    <span aria-hidden="true" className="absolute inset-0 grid place-items-center">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-black/70 text-sm text-white">{playing ? "■" : "▶"}</span>
    </span>
  </button>;
}

/** 押したらすぐ動くよう、音を消して自動再生する（スマホは音ありの自動再生を止めるため）。音はプレーヤーで出せる。 */
export function VideoPlayer({ url, title }: { url: string | null | undefined; title: string }) {
  const id = extractYouTubeVideoId(url);
  if (!id) return null;
  return <div className="aspect-video w-full overflow-hidden rounded-md bg-black">
    <iframe src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1&rel=0`} title={`${title}の動画`}
      className="h-full w-full border-0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
  </div>;
}
