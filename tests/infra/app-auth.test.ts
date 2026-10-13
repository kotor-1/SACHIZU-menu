import { describe, expect, it } from "vitest";
import { hashAppPassword, verifyAppPassword } from "@/infra/auth/app-password";
import { appSessionIdFromToken, newAppSessionToken, safeNextPath, setupCodeMatches } from "@/infra/auth/app-session";
import { appAuthGate, isPublicAppPath } from "@/infra/auth/app-auth-gate";

// Offline test values only. They are not credentials for any deployment.
describe("app password hashing", () => {
  it("stores no plain text and verifies only the same password", async () => {
    const stored = await hashAppPassword("offline-test-pass");
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/u);
    expect(stored).not.toContain("offline-test-pass");
    expect(await verifyAppPassword("offline-test-pass", stored)).toBe(true);
    expect(await verifyAppPassword("offline-test-pasS", stored)).toBe(false);
    expect(await hashAppPassword("offline-test-pass")).not.toBe(stored);
  });

  it("treats tampered or foreign formats as a mismatch without throwing", async () => {
    const stored = await hashAppPassword("offline-test-pass");
    for (const value of ["", "plain", stored.replace("scrypt$", "bcrypt$"), stored.replace("$16384$", "$1024$"), `${stored}x`, stored.slice(0, -4)]) {
      expect(await verifyAppPassword("offline-test-pass", value)).toBe(false);
    }
  });
});

describe("app session values", () => {
  it("keeps only a hash of the cookie value, and rejects malformed cookies", () => {
    const token = newAppSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const id = appSessionIdFromToken(token);
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
    expect(id).not.toContain(token);
    for (const value of [undefined, null, "", "short", `${token}=`, token.replace(/.$/u, "!")]) expect(appSessionIdFromToken(value)).toBeNull();
  });

  it("accepts the setup code regardless of hyphens, spaces and case", () => {
    expect(setupCodeMatches("abcd efgh-jkmn", "ABCD-EFGH-JKMN")).toBe(true);
    expect(setupCodeMatches("ABCD-EFGH-JKMP", "ABCD-EFGH-JKMN")).toBe(false);
    expect(setupCodeMatches("", "ABCD-EFGH-JKMN")).toBe(false);
  });

  it("returns only to paths inside the app after sign-in", () => {
    expect(safeNextPath("/menus/new?x=1")).toBe("/menus/new?x=1");
    for (const value of [null, "", "https://example.com", "//example.com", "/\\example.com", "menus", "/login", "/login?next=/x", "/a\nb"]) expect(safeNextPath(value)).toBe("/");
  });
});

describe("app sign-in gate", () => {
  const gate = (pathname: string, method = "GET", signedIn = false, required = true, search = "") =>
    appAuthGate({ required, pathname, search, method, signedIn: async () => signedIn });

  it("leaves local development open and lets the sign-in page, health check and assets through", async () => {
    expect(await gate("/menus", "GET", false, false)).toEqual({ kind: "ALLOW" });
    for (const path of ["/login", "/healthz", "/favicon.ico", "/_next/static/chunks/app.js", "/_next/image"]) {
      expect(isPublicAppPath(path)).toBe(true);
      expect(await gate(path, "POST")).toEqual({ kind: "ALLOW" });
    }
    expect(isPublicAppPath("/login-help")).toBe(false);
    expect(isPublicAppPath("/settings")).toBe(false);
  });

  it("sends pages to the sign-in screen with a safe return path, and refuses other requests", async () => {
    expect(await gate("/menus/new", "GET", false, true, "?a=1")).toEqual({ kind: "REDIRECT", location: "/login?next=%2Fmenus%2Fnew%3Fa%3D1" });
    expect(await gate("/", "GET")).toEqual({ kind: "REDIRECT", location: "/login" });
    expect(await gate("/menus/new", "POST")).toEqual({ kind: "UNAUTHORIZED" });
    expect(await gate("/menus/new", "POST", true)).toEqual({ kind: "ALLOW" });
  });
});
