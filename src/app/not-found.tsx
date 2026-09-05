import { EmptyState, LinkButton } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="py-16">
      <EmptyState
        title="ページが見つかりません"
        description="削除されたか、URL が間違っている可能性があります。"
        action={<LinkButton href="/">ホームへ戻る</LinkButton>}
      />
    </div>
  );
}
