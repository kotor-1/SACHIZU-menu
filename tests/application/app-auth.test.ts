import { describe, expect, it } from "vitest";
import {
  APP_LOGIN_LOCK_MINUTES, APP_LOGIN_MAX_FAILURES, changeAppPassword, createAppMember, deleteAppMember, registerFirstAppAdmin, signInAppUser,
  type AppAuthDeps,
} from "@/application/app-auth/sign-in";
import type { AppUserRecord, AppUserSummary } from "@/infra/repositories/app-user-repository";

// In-memory doubles with offline test values only. Hashes are fakes, not scrypt.
function fakeDeps(setupCode: string | null = "TEST-SETUP-CODE") {
  const users: AppUserRecord[] = [];
  let clock = new Date("2026-10-13T00:00:00Z");
  const calls = { updated: [] as { id: string; keep: string | null }[], deleted: [] as string[], dummyVerifies: 0 };
  const deps: AppAuthDeps = {
    now: () => clock,
    setupCode,
    setupCodeMatches: (input, expected) => input.replace(/-/gu, "").toUpperCase() === expected.replace(/-/gu, "").toUpperCase(),
    hash: async password => `fake:${password}`,
    verify: async (password, hash) => { if (hash === "fake-dummy") calls.dummyVerifies += 1; return hash === `fake:${password}`; },
    dummyHash: async () => "fake-dummy",
    countUsers: async () => users.length,
    findUserByLoginId: async loginId => users.find(user => user.loginId === loginId) ?? null,
    findUserById: async id => users.find(user => user.id === id) ?? null,
    createFirstAdmin: async input => {
      if (users.length) return null;
      const user = { id: "u1", ...input, role: "ADMIN" as const, failedLoginCount: 0, lockedUntil: null };
      users.push(user); return user;
    },
    createUser: async input => {
      if (users.some(user => user.loginId === input.loginId)) return "DUPLICATE";
      const user = { id: `u${users.length + 1}`, ...input, failedLoginCount: 0, lockedUntil: null };
      users.push(user); return user;
    },
    recordFailure: async (id, lockedUntil) => {
      const user = users.find(entry => entry.id === id)!;
      if (lockedUntil) { user.failedLoginCount = 0; user.lockedUntil = lockedUntil; } else user.failedLoginCount += 1;
    },
    resetFailures: async id => { const user = users.find(entry => entry.id === id)!; user.failedLoginCount = 0; user.lockedUntil = null; },
    updatePassword: async (id, passwordHash, keep) => { users.find(entry => entry.id === id)!.passwordHash = passwordHash; calls.updated.push({ id, keep }); },
    deleteUser: async id => { calls.deleted.push(id); users.splice(users.findIndex(entry => entry.id === id), 1); },
  };
  return { deps, users, calls, advance: (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); } };
}
const summary = (user: AppUserRecord): AppUserSummary => ({ id: user.id, loginId: user.loginId, role: user.role, createdAt: new Date(0) });
const first = { setupCode: "test-setup-code", loginId: "Coach", password: "offline-pass-1", passwordConfirm: "offline-pass-1" };

describe("first administrator registration", () => {
  it("needs the setup code, stores the ID in lower case and makes an administrator", async () => {
    const { deps, users } = fakeDeps();
    expect(await registerFirstAppAdmin({ ...first, setupCode: "WRONG-CODE" }, deps)).toEqual({ ok: false, message: "初回登録コードが違います。" });
    expect(await registerFirstAppAdmin(first, deps)).toEqual({ ok: true, userId: "u1" });
    expect(users[0]).toMatchObject({ loginId: "coach", role: "ADMIN", passwordHash: "fake:offline-pass-1" });
  });

  it("closes once anyone is registered, and stays closed without a configured code", async () => {
    const open = fakeDeps();
    await registerFirstAppAdmin(first, open.deps);
    expect(await registerFirstAppAdmin({ ...first, loginId: "other" }, open.deps)).toMatchObject({ ok: false, message: expect.stringContaining("すでに完了") });
    expect(await registerFirstAppAdmin(first, fakeDeps(null).deps)).toMatchObject({ ok: false, message: expect.stringContaining("設定されていない") });
  });

  it("checks the ID format, password length and confirmation", async () => {
    const { deps } = fakeDeps();
    expect((await registerFirstAppAdmin({ ...first, loginId: "a" }, deps)).ok).toBe(false);
    expect((await registerFirstAppAdmin({ ...first, loginId: "コーチ" }, deps)).ok).toBe(false);
    expect((await registerFirstAppAdmin({ ...first, password: "short", passwordConfirm: "short" }, deps)).ok).toBe(false);
    expect(await registerFirstAppAdmin({ ...first, passwordConfirm: "different-pass" }, deps)).toEqual({ ok: false, message: "確認用のパスワードが一致しません。" });
  });
});

describe("sign-in", () => {
  it("accepts the ID in any case and gives the same message for an unknown ID or a wrong password", async () => {
    const { deps, calls } = fakeDeps();
    await registerFirstAppAdmin(first, deps);
    expect(await signInAppUser({ loginId: "COACH", password: "offline-pass-1" }, deps)).toEqual({ ok: true, userId: "u1" });
    const wrong = await signInAppUser({ loginId: "coach", password: "nope-nope-1" }, deps);
    const unknown = await signInAppUser({ loginId: "nobody", password: "offline-pass-1" }, deps);
    expect(wrong).toEqual(unknown);
    expect(calls.dummyVerifies).toBe(1);
  });

  it("locks the ID after repeated failures and opens it again after the wait", async () => {
    const { deps, users, advance } = fakeDeps();
    await registerFirstAppAdmin(first, deps);
    for (let attempt = 1; attempt < APP_LOGIN_MAX_FAILURES; attempt++) expect((await signInAppUser({ loginId: "coach", password: "wrong-pass-1" }, deps)).ok).toBe(false);
    expect(await signInAppUser({ loginId: "coach", password: "wrong-pass-1" }, deps)).toMatchObject({ ok: false, message: expect.stringContaining(`${APP_LOGIN_LOCK_MINUTES}分間`) });
    expect(await signInAppUser({ loginId: "coach", password: "offline-pass-1" }, deps)).toMatchObject({ ok: false, message: expect.stringContaining("しばらくログインできません") });
    advance(APP_LOGIN_LOCK_MINUTES + 1);
    expect(await signInAppUser({ loginId: "coach", password: "offline-pass-1" }, deps)).toEqual({ ok: true, userId: "u1" });
    expect(users[0]).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });
});

describe("members and passwords", () => {
  it("lets only an administrator add members, and refuses a taken ID", async () => {
    const { deps, users } = fakeDeps();
    await registerFirstAppAdmin(first, deps);
    const admin = summary(users[0]);
    const member = { loginId: "assistant", password: "member-pass-1", passwordConfirm: "member-pass-1" };
    expect(await createAppMember(admin, member, deps)).toEqual({ ok: true, userId: "u2" });
    expect(users[1]).toMatchObject({ loginId: "assistant", role: "MEMBER" });
    expect(await createAppMember(admin, member, deps)).toEqual({ ok: false, message: "そのログインIDはすでに使われています。" });
    expect((await createAppMember(summary(users[1]), { ...member, loginId: "third" }, deps)).ok).toBe(false);
  });

  it("changes a password only with the current one, keeping the current device signed in", async () => {
    const { deps, users, calls } = fakeDeps();
    await registerFirstAppAdmin(first, deps);
    const admin = summary(users[0]);
    expect(await changeAppPassword(admin, "session-1", { currentPassword: "wrong", password: "new-pass-123", passwordConfirm: "new-pass-123" }, deps)).toEqual({ ok: false, message: "今のパスワードが違います。" });
    expect(await changeAppPassword(admin, "session-1", { currentPassword: "offline-pass-1", password: "new-pass-123", passwordConfirm: "new-pass-123" }, deps)).toEqual({ ok: true, userId: "u1" });
    expect(calls.updated).toEqual([{ id: "u1", keep: "session-1" }]);
    expect((await signInAppUser({ loginId: "coach", password: "new-pass-123" }, deps)).ok).toBe(true);
  });

  it("never deletes yourself or the last administrator", async () => {
    const { deps, users, calls } = fakeDeps();
    await registerFirstAppAdmin(first, deps);
    await createAppMember(summary(users[0]), { loginId: "assistant", password: "member-pass-1", passwordConfirm: "member-pass-1" }, deps);
    const all = users.map(summary);
    expect((await deleteAppMember(all[0], "u1", all, deps)).ok).toBe(false);
    expect((await deleteAppMember(all[1], "u1", all, deps)).ok).toBe(false);
    expect(await deleteAppMember(all[0], "u2", all, deps)).toEqual({ ok: true, userId: "u2" });
    expect(calls.deleted).toEqual(["u2"]);
  });
});
