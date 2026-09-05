"use client";

import { useRef } from "react";

/**
 * select / checkbox を変えた瞬間に GET 送信するフォーム。
 * 検索条件はすべて URL に載るので、
 * リロード・共有・戻るボタンがそのまま効く。
 */
export function AutoSubmitForm({
  children,
  className,
  action,
}: {
  children: React.ReactNode;
  className?: string;
  action?: string;
}) {
  const ref = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={ref}
      method="get"
      action={action}
      className={className}
      onChange={(e) => {
        const target = e.target as HTMLElement;
        // テキスト入力は Enter or 検索ボタンで送る（1 文字ごとに飛ばさない）
        if (target instanceof HTMLInputElement && (target.type === "text" || target.type === "search")) {
          return;
        }
        // ページ番号は条件変更でリセットする
        const pageInput = ref.current?.querySelector<HTMLInputElement>('input[name="page"]');
        if (pageInput) pageInput.value = "1";
        ref.current?.requestSubmit();
      }}
    >
      {children}
    </form>
  );
}
