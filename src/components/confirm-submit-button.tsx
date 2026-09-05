"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonSize, type ButtonVariant } from "./ui";

/**
 * 破壊的操作用。押した瞬間に confirm を出し、
 * キャンセルされたら送信そのものを止める。
 */
export function ConfirmSubmitButton({
  children,
  message,
  variant = "danger",
  size = "sm",
  className,
}: {
  children: React.ReactNode;
  message: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </Button>
  );
}
