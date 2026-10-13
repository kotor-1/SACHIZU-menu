import { z } from "zod";

/** アプリへのログイン（公開URL用）。動画解説の認証とは別のもの。 */
export const APP_ROLES = ["ADMIN", "MEMBER"] as const;
export type AppRole = (typeof APP_ROLES)[number];
export const APP_ROLE_LABELS: Record<AppRole, string> = { ADMIN: "管理者", MEMBER: "メンバー" };

export const APP_PASSWORD_MIN_LENGTH = 8;
export const APP_PASSWORD_MAX_LENGTH = 128;

/** ログインIDは大文字小文字を区別しない（小文字で保存・照合する）。 */
export const appLoginIdSchema = z.string().trim()
  .regex(/^[A-Za-z0-9._-]{3,32}$/u, "ログインIDは3〜32文字の英数字と . _ - で入力してください。")
  .transform(value => value.toLowerCase());

export const appPasswordSchema = z.string()
  .min(APP_PASSWORD_MIN_LENGTH, `パスワードは${APP_PASSWORD_MIN_LENGTH}文字以上にしてください。`)
  .max(APP_PASSWORD_MAX_LENGTH, `パスワードは${APP_PASSWORD_MAX_LENGTH}文字以内にしてください。`);

/** 新しく決めるパスワード（確認入力つき）。 */
export const newAppPasswordSchema = z.object({ password: appPasswordSchema, passwordConfirm: z.string() })
  .refine(value => value.password === value.passwordConfirm, { message: "確認用のパスワードが一致しません。", path: ["passwordConfirm"] });
