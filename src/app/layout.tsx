import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "SACHIZU｜トレーニングメニュー作成",
  description:
    "陸上競技コーチのための、ドリル・種目の管理と練習メニュー作成アプリ",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-full">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur no-print">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-6 sm:py-3">
            <Link href="/" className="flex shrink-0 items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-xs font-bold text-white">
                SZ
              </span>
              <span className="text-sm font-bold tracking-tight text-slate-900">
                SACHIZU メニュー作成
              </span>
            </Link>
            <Nav />
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>

        <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-slate-400 no-print">
          Phase 1 — 種目カタログ / メニュー作成 / 練習記録
        </footer>
      </body>
    </html>
  );
}
