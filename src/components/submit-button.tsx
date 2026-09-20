"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonSize, type ButtonVariant } from "./ui";

/**
 * 送信中は自動で disabled になるボタン。
 * Server Action を使うフォームでは毎回必要になるので共通化する。
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  className,
  disabled = false,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  /** [R11-B1] 送信中以外にも押させたくない場合（確認が揃っていない等）。 */
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} className={className} disabled={pending || disabled}>
      {pending ? (pendingLabel ?? "処理中…") : children}
    </Button>
  );
}
