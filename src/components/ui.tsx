import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

// --- カード -----------------------------------------------------------------

export function Card({
  className,
  children,
  ...rest
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-md border border-slate-200 bg-white",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("border-b border-slate-200 px-4 py-3 sm:px-5", className)}>
      {children}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-4 py-4 sm:px-5", className)}>{children}</div>;
}

// --- バッジ -----------------------------------------------------------------

export function Badge({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        className ?? "border-slate-300 bg-white text-slate-700",
      )}
    >
      {children}
    </span>
  );
}

// --- ボタン -----------------------------------------------------------------

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900";

const BUTTON_VARIANTS = {
  primary: "bg-slate-900 text-white hover:bg-black",
  // 保存など、その画面でいちばん大事な確定操作だけに使うトラックの赤
  accent: "bg-indigo-600 text-white hover:bg-indigo-700",
  secondary: "border border-slate-300 bg-white text-slate-900 hover:border-slate-900",
  ghost: "text-slate-700 hover:bg-slate-900/5 hover:text-slate-900",
  danger: "border border-rose-300 bg-white text-rose-700 hover:border-rose-600 hover:bg-rose-50",
} as const;

const BUTTON_SIZES = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-9 px-3.5",
  lg: "h-11 px-5",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClass(variant, size, className)} {...rest} />;
}

export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}

// --- フォーム部品 -----------------------------------------------------------

export const INPUT_CLASS =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:ring-1 focus:ring-slate-900 focus:outline-none disabled:bg-slate-100";

export function Field({
  label,
  hint,
  errors,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  errors?: string[];
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 flex items-baseline gap-1.5 text-sm font-semibold text-slate-800">
        {label}
        {required && <span className="text-xs font-medium text-indigo-700">必須</span>}
        {hint && <span className="text-xs font-normal text-slate-400">{hint}</span>}
      </span>
      {children}
      {errors?.map((e) => (
        <span key={e} className="mt-1 block text-xs text-rose-600">
          {e}
        </span>
      ))}
    </label>
  );
}

// --- 空状態 -----------------------------------------------------------------

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// --- ページ見出し -----------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 border-b-2 border-slate-900 pb-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-[28px]">
          {title}
        </h1>
        {description && (
          <div className="mt-1 text-sm leading-relaxed text-slate-600">{description}</div>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2 no-print">{actions}</div>}
    </div>
  );
}
