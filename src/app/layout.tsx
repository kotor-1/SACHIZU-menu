import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { appAuthRequired } from "@/infra/auth/app-session";
import { currentAppSession } from "@/infra/auth/current-app-user";
import "./globals.css";

export const metadata: Metadata = {
  title: "SACHIZU｜トレーニングメニュー作成",
  description:
    "陸上競技コーチのための、ドリル・種目の管理と練習メニュー作成アプリ",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // 公開URLでは、ログインするまでメニューを出さない（ログイン画面だけを見せる）。
  const showNav = !appAuthRequired() || (await currentAppSession()) !== null;
  return (
    <html lang="ja">
      <body className="min-h-full">
        <header className="sticky top-0 z-20 bg-slate-900 text-white no-print">
          <div className="mx-auto flex max-w-6xl flex-col px-4 sm:flex-row sm:items-stretch sm:gap-8">
            <Link href="/" className="flex shrink-0 items-center gap-2.5 pt-3 pb-1 sm:py-0">
              {/* レーンの区切り線を模した目印 */}
              <span aria-hidden="true" className="h-5 w-1.5 bg-indigo-500" />
              <span className="text-[15px] font-extrabold tracking-[0.14em]">SACHIZU</span>
              <span className="text-xs text-slate-300">練習メニュー</span>
            </Link>
            {showNav && <Nav />}
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6 pb-16 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
