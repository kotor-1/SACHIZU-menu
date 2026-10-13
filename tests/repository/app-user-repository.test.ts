import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/infra/db/prisma";
import {
  countAppUsers, createAppSession, createAppUser, createFirstAppAdmin, deleteAppUser, findValidAppSession, updateAppUserPassword,
} from "@/infra/repositories/app-user-repository";

// Isolated test DB only (tests/global-setup.ts). Hash strings are placeholders, not real hashes.
beforeEach(async () => {
  await prisma.appSession.deleteMany();
  await prisma.appUser.deleteMany();
});

describe("app user repository", () => {
  it("creates the first administrator only while nobody is registered", async () => {
    const admin = await createFirstAppAdmin({ loginId: "coach", passwordHash: "placeholder-hash" });
    expect(admin).toMatchObject({ loginId: "coach", role: "ADMIN" });
    expect(await createFirstAppAdmin({ loginId: "second", passwordHash: "placeholder-hash" })).toBeNull();
    expect(await countAppUsers()).toBe(1);
    expect(await createAppUser({ loginId: "coach", passwordHash: "placeholder-hash", role: "MEMBER" })).toBe("DUPLICATE");
  });

  it("finds only unexpired sessions and drops them with the user", async () => {
    const user = await createAppUser({ loginId: "assistant", passwordHash: "placeholder-hash", role: "MEMBER" });
    if (user === "DUPLICATE") throw new Error("unexpected duplicate");
    const now = new Date("2026-10-13T00:00:00Z");
    await createAppSession({ id: "a".repeat(64), userId: user.id, expiresAt: new Date(now.getTime() + 60_000) });
    await createAppSession({ id: "b".repeat(64), userId: user.id, expiresAt: new Date(now.getTime() - 60_000) });
    expect(await findValidAppSession("a".repeat(64), now)).toMatchObject({ user: { loginId: "assistant", role: "MEMBER" } });
    expect(await findValidAppSession("b".repeat(64), now)).toBeNull();
    await deleteAppUser(user.id);
    expect(await prisma.appSession.count()).toBe(0);
  });

  it("keeps only the current session when the password changes", async () => {
    const user = await createAppUser({ loginId: "coach2", passwordHash: "placeholder-hash", role: "ADMIN" });
    if (user === "DUPLICATE") throw new Error("unexpected duplicate");
    const later = new Date(Date.now() + 86_400_000);
    for (const id of ["c", "d", "e"]) await createAppSession({ id: id.repeat(64), userId: user.id, expiresAt: later });
    await updateAppUserPassword(user.id, "new-placeholder-hash", "d".repeat(64));
    expect((await prisma.appSession.findMany()).map(row => row.id)).toEqual(["d".repeat(64)]);
    expect((await prisma.appUser.findUnique({ where: { id: user.id } }))?.passwordHash).toBe("new-placeholder-hash");
  });
});
