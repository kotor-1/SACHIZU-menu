"use client";

import { Button, EmptyState } from "@/components/ui";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="py-16">
      <EmptyState
        title="エラーが発生しました"
        description={error.message || "しばらくしてからもう一度お試しください。"}
        action={<Button onClick={reset}>再読み込み</Button>}
      />
    </div>
  );
}
