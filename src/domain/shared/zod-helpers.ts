import { z } from "zod";

/**
 * HTML フォームから来る値は常に文字列（空欄は ""）。
 * それを number | null に落とすための共通ヘルパ。
 */
export const optionalNumber = (opts?: { min?: number; max?: number; int?: boolean }) =>
  z
    .preprocess((v) => {
      if (v === "" || v === null || v === undefined) return null;
      if (typeof v === "number") return v;
      const n = Number(String(v).trim());
      return Number.isFinite(n) ? n : null;
    }, z.number().nullable())
    .superRefine((v, ctx) => {
      if (v === null) return;
      if (opts?.int && !Number.isInteger(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "整数で入力してください" });
      }
      if (opts?.min !== undefined && v < opts.min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${opts.min} 以上で入力してください` });
      }
      if (opts?.max !== undefined && v > opts.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${opts.max} 以下で入力してください` });
      }
    });

/** 空文字を null にする任意テキスト。 */
export const optionalText = (max = 2000) =>
  z.preprocess(
    (v) => {
      if (typeof v !== "string") return v ?? null;
      const t = v.trim();
      return t === "" ? null : t;
    },
    z.string().max(max, `${max} 文字以内で入力してください`).nullable(),
  );

/** 必須テキスト。 */
export const requiredText = (label: string, max = 200) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1, `${label}は必須です`).max(max, `${label}は ${max} 文字以内で入力してください`));

/**
 * チェックボックス。
 * 未チェックだと値そのものが送られないため、
 * フォーム側では前に hidden("") を置き、"true" が含まれるかで判定する。
 * （z.coerce.boolean() は "false" という文字列を true にしてしまうため使わない）
 */
export const checkbox = () =>
  z.preprocess((v) => {
    if (Array.isArray(v)) return v.map(String).includes("true");
    return v === true || v === "true" || v === "on" || v === "1";
  }, z.boolean());

/** "スパイク, ハードル" のようなカンマ区切り入力を配列にする。 */
export function parseCsvInput(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      value
        .split(/[,、\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 40),
    ),
  ];
}
