import { prisma, type PrismaDbClient } from "@/infra/db/prisma";
import type { AppRole } from "@/domain/app-auth/credentials";

/** ログインに使う利用者。パスワードのハッシュはこの層の外へ必要なときだけ渡す。 */
export type AppUserRecord = { id: string; loginId: string; role: AppRole; passwordHash: string; failedLoginCount: number; lockedUntil: Date | null };
export type AppUserSummary = { id: string; loginId: string; role: AppRole; createdAt: Date };

const toRecord = (row: { id: string; loginId: string; role: string; passwordHash: string; failedLoginCount: number; lockedUntil: Date | null }): AppUserRecord =>
  ({ ...row, role: row.role === "ADMIN" ? "ADMIN" : "MEMBER" });

export async function countAppUsers(db: PrismaDbClient = prisma): Promise<number> {
  return db.appUser.count();
}

export async function findAppUserByLoginId(loginId: string, db: PrismaDbClient = prisma): Promise<AppUserRecord | null> {
  const row = await db.appUser.findUnique({ where: { loginId } });
  return row ? toRecord(row) : null;
}

export async function findAppUserById(id: string, db: PrismaDbClient = prisma): Promise<AppUserRecord | null> {
  const row = await db.appUser.findUnique({ where: { id } });
  return row ? toRecord(row) : null;
}

/** 利用者が1人もいないときだけ、最初の管理者を作る（同時に2人目が作られないよう1つの transaction で確かめる）。 */
export async function createFirstAppAdmin(input: { loginId: string; passwordHash: string }): Promise<AppUserRecord | null> {
  return prisma.$transaction(async tx => {
    if (await tx.appUser.count() > 0) return null;
    return toRecord(await tx.appUser.create({ data: { ...input, role: "ADMIN" } }));
  });
}

/** 管理者が利用者を追加する。同じログインIDがあれば作らない。 */
export async function createAppUser(input: { loginId: string; passwordHash: string; role: AppRole }, db: PrismaDbClient = prisma): Promise<AppUserRecord | "DUPLICATE"> {
  if (await db.appUser.findUnique({ where: { loginId: input.loginId }, select: { id: true } })) return "DUPLICATE";
  return toRecord(await db.appUser.create({ data: input }));
}

export async function listAppUsers(db: PrismaDbClient = prisma): Promise<AppUserSummary[]> {
  const rows = await db.appUser.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, loginId: true, role: true, createdAt: true } });
  return rows.map(row => ({ ...row, role: row.role === "ADMIN" ? "ADMIN" : "MEMBER" }));
}

/** 利用者を消すと、その人のログイン状態も消える（cascade）。 */
export async function deleteAppUser(id: string, db: PrismaDbClient = prisma): Promise<void> {
  await db.appUser.deleteMany({ where: { id } });
}

export async function recordAppLoginFailure(id: string, lockedUntil: Date | null, db: PrismaDbClient = prisma): Promise<void> {
  await db.appUser.update({ where: { id }, data: lockedUntil ? { failedLoginCount: 0, lockedUntil } : { failedLoginCount: { increment: 1 } } });
}

export async function resetAppLoginFailures(id: string, db: PrismaDbClient = prisma): Promise<void> {
  await db.appUser.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
}

/** パスワードを変えたら、いま使っている端末以外のログイン状態を消す。 */
export async function updateAppUserPassword(id: string, passwordHash: string, keepSessionId: string | null, db: PrismaDbClient = prisma): Promise<void> {
  await db.appUser.update({ where: { id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
  await db.appSession.deleteMany({ where: { userId: id, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) } });
}

export async function createAppSession(input: { id: string; userId: string; expiresAt: Date }, db: PrismaDbClient = prisma): Promise<void> {
  await db.appSession.create({ data: input });
}

/** 期限内のログイン状態と、その利用者。期限切れは見つからないのと同じ扱い。 */
export async function findValidAppSession(id: string, now: Date, db: PrismaDbClient = prisma): Promise<{ sessionId: string; user: AppUserSummary } | null> {
  const row = await db.appSession.findUnique({ where: { id }, select: { id: true, expiresAt: true, user: { select: { id: true, loginId: true, role: true, createdAt: true } } } });
  if (!row || row.expiresAt <= now) return null;
  return { sessionId: row.id, user: { ...row.user, role: row.user.role === "ADMIN" ? "ADMIN" : "MEMBER" } };
}

export async function deleteAppSession(id: string, db: PrismaDbClient = prisma): Promise<void> {
  await db.appSession.deleteMany({ where: { id } });
}
