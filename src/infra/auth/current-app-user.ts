import { cookies } from "next/headers";
import { APP_SESSION_COOKIE, appAuthRequired, appSessionIdFromToken } from "./app-session";
import { findValidAppSession } from "@/infra/repositories/app-user-repository";

/**
 * いまログインしている利用者（cookie を DB と照合する）。
 * ログインを使わない環境（手元の開発）では DB を読まずに null を返す。
 */
export async function currentAppSession() {
  if (!appAuthRequired()) return null;
  const id = appSessionIdFromToken((await cookies()).get(APP_SESSION_COOKIE)?.value);
  return id ? findValidAppSession(id, new Date()) : null;
}

/** 画面の出し分け用。ログインを使わない環境（手元の開発）では、管理者と同じにすべて見せる。 */
export async function currentAppViewer(): Promise<{ signedIn: boolean; isAdmin: boolean }> {
  if (!appAuthRequired()) return { signedIn: true, isAdmin: true };
  const session = await currentAppSession();
  return { signedIn: session !== null, isAdmin: session?.user.role === "ADMIN" };
}
