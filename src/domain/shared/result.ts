/**
 * Server Action の戻り値を統一する型。
 * フォームは常に { ok, fieldErrors, message } を受け取り、
 * useActionState でそのまま描画できる。
 */
export type FieldErrors = Record<string, string[]>;

export type ActionResult<T = void> =
  | { ok: true; data: T; message?: string }
  | { ok: false; message: string; fieldErrors?: FieldErrors };

export const actionOk = <T>(data: T, message?: string): ActionResult<T> => ({
  ok: true,
  data,
  message,
});

export const actionError = (message: string, fieldErrors?: FieldErrors): ActionResult<never> => ({
  ok: false,
  message,
  fieldErrors,
});

/** useActionState の初期値。 */
export const IDLE_RESULT: ActionResult<null> | null = null;
