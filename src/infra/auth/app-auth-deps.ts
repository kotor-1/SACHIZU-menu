import { randomBytes } from "node:crypto";
import type { AppAuthDeps } from "@/application/app-auth/sign-in";
import { hashAppPassword, verifyAppPassword } from "./app-password";
import { configuredSetupCode, setupCodeMatches } from "./app-session";
import {
  countAppUsers, createAppUser, createFirstAppAdmin, deleteAppUser, findAppUserById, findAppUserByLoginId,
  recordAppLoginFailure, resetAppLoginFailures, updateAppUserPassword,
} from "@/infra/repositories/app-user-repository";

let dummyHash: Promise<string> | null = null;

/** 本番の依存（DB・scrypt・環境変数）。テストでは同じ形の偽物を渡す。 */
export function appAuthDeps(): AppAuthDeps {
  return {
    now: () => new Date(),
    setupCode: configuredSetupCode(),
    setupCodeMatches,
    hash: hashAppPassword,
    verify: verifyAppPassword,
    dummyHash: () => (dummyHash ??= hashAppPassword(randomBytes(16).toString("hex"))),
    countUsers: () => countAppUsers(),
    findUserByLoginId: loginId => findAppUserByLoginId(loginId),
    findUserById: id => findAppUserById(id),
    createFirstAdmin: input => createFirstAppAdmin(input),
    createUser: input => createAppUser(input),
    recordFailure: (id, lockedUntil) => recordAppLoginFailure(id, lockedUntil),
    resetFailures: id => resetAppLoginFailures(id),
    updatePassword: (id, passwordHash, keepSessionId) => updateAppUserPassword(id, passwordHash, keepSessionId),
    deleteUser: id => deleteAppUser(id),
  };
}
