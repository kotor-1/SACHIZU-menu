import { appLoginIdSchema, newAppPasswordSchema, type AppRole } from "@/domain/app-auth/credentials";
import type { AppUserRecord, AppUserSummary } from "@/infra/repositories/app-user-repository";

/** ログインに続けて失敗したら、しばらく受け付けない。 */
export const APP_LOGIN_MAX_FAILURES = 10;
export const APP_LOGIN_LOCK_MINUTES = 15;
const SIGN_IN_FAILED = "ログインIDまたはパスワードが違います。";

export type AppAuthDeps = {
  now: () => Date;
  setupCode: string | null;
  setupCodeMatches: (input: string, expected: string) => boolean;
  hash: (password: string) => Promise<string>;
  verify: (password: string, hash: string) => Promise<boolean>;
  /** 存在しないIDでも同じだけ時間をかけるための、照合用のハッシュ。 */
  dummyHash: () => Promise<string>;
  countUsers: () => Promise<number>;
  findUserByLoginId: (loginId: string) => Promise<AppUserRecord | null>;
  findUserById: (id: string) => Promise<AppUserRecord | null>;
  createFirstAdmin: (input: { loginId: string; passwordHash: string }) => Promise<AppUserRecord | null>;
  createUser: (input: { loginId: string; passwordHash: string; role: AppRole }) => Promise<AppUserRecord | "DUPLICATE">;
  recordFailure: (id: string, lockedUntil: Date | null) => Promise<void>;
  resetFailures: (id: string) => Promise<void>;
  updatePassword: (id: string, passwordHash: string, keepSessionId: string | null) => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
};
export type AppAuthResult = { ok: true; userId: string } | { ok: false; message: string };

const firstIssue = (error: { issues: { message: string }[] }) => error.issues[0]?.message ?? "入力内容を確認してください。";
function form(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

/** 最初の1人（管理者）を作る。初回登録コードが必要で、利用者が1人でもいれば作らない。 */
export async function registerFirstAppAdmin(raw: Record<string, unknown>, deps: AppAuthDeps): Promise<AppAuthResult> {
  if (!deps.setupCode) return { ok: false, message: "初回登録コードが設定されていないため、登録できません。" };
  if (await deps.countUsers() > 0) return { ok: false, message: "初回登録はすでに完了しています。ログインしてください。" };
  const loginId = appLoginIdSchema.safeParse(form(raw, "loginId"));
  if (!loginId.success) return { ok: false, message: firstIssue(loginId.error) };
  const password = newAppPasswordSchema.safeParse({ password: form(raw, "password"), passwordConfirm: form(raw, "passwordConfirm") });
  if (!password.success) return { ok: false, message: firstIssue(password.error) };
  if (!deps.setupCodeMatches(form(raw, "setupCode"), deps.setupCode)) return { ok: false, message: "初回登録コードが違います。" };
  const created = await deps.createFirstAdmin({ loginId: loginId.data, passwordHash: await deps.hash(password.data.password) });
  return created ? { ok: true, userId: created.id } : { ok: false, message: "初回登録はすでに完了しています。ログインしてください。" };
}

/** ログイン。理由（IDが無い・パスワード違い）は区別して伝えない。 */
export async function signInAppUser(raw: Record<string, unknown>, deps: AppAuthDeps): Promise<AppAuthResult> {
  const loginId = appLoginIdSchema.safeParse(form(raw, "loginId"));
  const password = form(raw, "password");
  const user = loginId.success ? await deps.findUserByLoginId(loginId.data) : null;
  if (!user) {
    await deps.verify(password, await deps.dummyHash());
    return { ok: false, message: SIGN_IN_FAILED };
  }
  const now = deps.now();
  if (user.lockedUntil && user.lockedUntil > now) {
    return { ok: false, message: `ログインに続けて失敗したため、しばらくログインできません。${APP_LOGIN_LOCK_MINUTES}分ほど待ってからやり直してください。` };
  }
  if (!await deps.verify(password, user.passwordHash)) {
    const lock = user.failedLoginCount + 1 >= APP_LOGIN_MAX_FAILURES;
    await deps.recordFailure(user.id, lock ? new Date(now.getTime() + APP_LOGIN_LOCK_MINUTES * 60_000) : null);
    return { ok: false, message: lock ? `ログインに${APP_LOGIN_MAX_FAILURES}回続けて失敗したため、${APP_LOGIN_LOCK_MINUTES}分間ログインできません。` : SIGN_IN_FAILED };
  }
  if (user.failedLoginCount > 0 || user.lockedUntil) await deps.resetFailures(user.id);
  return { ok: true, userId: user.id };
}

/** 管理者が利用者を追加する。 */
export async function createAppMember(actor: AppUserSummary, raw: Record<string, unknown>, deps: AppAuthDeps): Promise<AppAuthResult> {
  if (actor.role !== "ADMIN") return { ok: false, message: "利用者を追加できるのは管理者だけです。" };
  const loginId = appLoginIdSchema.safeParse(form(raw, "loginId"));
  if (!loginId.success) return { ok: false, message: firstIssue(loginId.error) };
  const password = newAppPasswordSchema.safeParse({ password: form(raw, "password"), passwordConfirm: form(raw, "passwordConfirm") });
  if (!password.success) return { ok: false, message: firstIssue(password.error) };
  const role: AppRole = form(raw, "role") === "ADMIN" ? "ADMIN" : "MEMBER";
  const created = await deps.createUser({ loginId: loginId.data, passwordHash: await deps.hash(password.data.password), role });
  return created === "DUPLICATE" ? { ok: false, message: "そのログインIDはすでに使われています。" } : { ok: true, userId: created.id };
}

/** 自分のパスワードを変える。今のパスワードの確認が必要。ほかの端末のログインは解除する。 */
export async function changeAppPassword(actor: AppUserSummary, currentSessionId: string | null, raw: Record<string, unknown>, deps: AppAuthDeps): Promise<AppAuthResult> {
  const user = await deps.findUserById(actor.id);
  if (!user || !await deps.verify(form(raw, "currentPassword"), user.passwordHash)) return { ok: false, message: "今のパスワードが違います。" };
  const password = newAppPasswordSchema.safeParse({ password: form(raw, "password"), passwordConfirm: form(raw, "passwordConfirm") });
  if (!password.success) return { ok: false, message: firstIssue(password.error) };
  await deps.updatePassword(user.id, await deps.hash(password.data.password), currentSessionId);
  return { ok: true, userId: user.id };
}

/** 管理者が利用者を削除する。自分自身と、最後の管理者は消さない。 */
export async function deleteAppMember(actor: AppUserSummary, targetId: string, users: readonly AppUserSummary[], deps: AppAuthDeps): Promise<AppAuthResult> {
  if (actor.role !== "ADMIN") return { ok: false, message: "利用者を削除できるのは管理者だけです。" };
  if (targetId === actor.id) return { ok: false, message: "自分自身は削除できません。" };
  const target = users.find(user => user.id === targetId);
  if (!target) return { ok: false, message: "利用者が見つかりません。" };
  if (target.role === "ADMIN" && users.filter(user => user.role === "ADMIN").length <= 1) return { ok: false, message: "最後の管理者は削除できません。" };
  await deps.deleteUser(targetId);
  return { ok: true, userId: targetId };
}
