import { z } from "zod";
import { actionError, type ActionResult, type FieldErrors } from "@/domain/shared/result";

/**
 * FormData を素の object に変換する。
 * arrayKeys に挙げたキーは getAll() で配列として取り出す
 * （チェックボックス群や複数選択のため）。
 */
export function formToObject(
  formData: FormData,
  arrayKeys: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const arraySet = new Set(arrayKeys);

  for (const key of new Set(formData.keys())) {
    if (arraySet.has(key)) {
      out[key] = formData.getAll(key).map(String);
    } else {
      const v = formData.get(key);
      out[key] = v instanceof File ? v : (v ?? "");
    }
  }
  // チェックが 1 つも入らなかった配列キーは空配列にしておく
  for (const key of arraySet) {
    if (!(key in out)) out[key] = [];
  }
  return out;
}

/** zod のエラーを、フォームが描画しやすい形に平坦化する。 */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * FormData を検証して、成功なら data、失敗なら ActionResult を返す。
 * 各アクションの先頭 2 行を共通化するためのユーティリティ。
 */
export function parseForm<S extends z.ZodTypeAny>(
  schema: S,
  formData: FormData,
  arrayKeys: string[] = [],
): { ok: true; data: z.infer<S> } | { ok: false; result: ActionResult<never> } {
  const parsed = schema.safeParse(formToObject(formData, arrayKeys));
  if (!parsed.success) {
    return {
      ok: false,
      result: actionError("入力内容を確認してください", toFieldErrors(parsed.error)),
    };
  }
  return { ok: true, data: parsed.data };
}

/** 想定外の例外をユーザー向けメッセージに落とす。 */
export function toActionError(e: unknown): ActionResult<never> {
  const message = e instanceof Error ? e.message : "保存に失敗しました";
  return actionError(message);
}
