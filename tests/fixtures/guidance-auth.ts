import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import { createGuidanceAuth } from "@/infra/auth/better-auth-server";
import { createVideoGuidanceIdentity } from "@/infra/auth/video-guidance-identity";

export const fixtureAuthUser = {
  id: "real-session-coach", name: "Isolated review coach", email: "review-coach@example.test",
};
export const fixtureAuthPassword = "isolated-fixture-password-2026";
export const fixtureAuthBaseURL = "http://guidance-auth.test";
export const fixtureGuidancePermissions = [
  "VIEW_VIDEO_GUIDANCE", "REVIEW_VIDEO_GUIDANCE", "PUBLISH_VIDEO_GUIDANCE",
] as const;
let passwordHash: Promise<string> | undefined;

/** Call only with an explicitly supplied isolated database. No public signup or session-row fabrication. */
export function createGuidanceAuthFixture(db: PrismaClient) {
  const auth = createGuidanceAuth(db, {
    secret: "isolated-guidance-auth-fixture-secret-at-least-32-characters", baseURL: fixtureAuthBaseURL,
  });
  let cookie = "";
  const headers = () => new Headers(cookie ? { cookie } : {});
  const identity = createVideoGuidanceIdentity({ auth, db, headers: async () => headers() });
  async function request(path: string, body?: unknown, useCookie = true) {
    const requestHeaders = useCookie ? headers() : new Headers();
    requestHeaders.set("origin", fixtureAuthBaseURL);
    if (body !== undefined) requestHeaders.set("content-type", "application/json");
    return auth.handler(new Request(`${fixtureAuthBaseURL}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST", headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }
  return {
    auth, identity, headers, request,
    cookie: () => cookie,
    setCookie(value: string) { cookie = value; },
    async bootstrapUser(user = fixtureAuthUser) {
      // User/account creation is an explicit fixture bootstrap. The session is
      // always issued by Better Auth's actual password-login HTTP endpoint.
      const created = await db.user.create({ data: { ...user, emailVerified: true } });
      passwordHash ??= hashPassword(fixtureAuthPassword);
      await db.account.create({ data: {
        id: `${user.id}-credential`, accountId: user.id, providerId: "credential",
        userId: user.id, password: await passwordHash,
      } });
      return created;
    },
    async grant(userId: string, ownerId: string, permissions: readonly string[] = fixtureGuidancePermissions) {
      await db.guidanceOwnerAccess.createMany({ data: permissions.map((permission) => ({ userId, ownerId, permission })) });
    },
    async signIn(email = fixtureAuthUser.email) {
      const response = await request("/sign-in/email", { email, password: fixtureAuthPassword }, false);
      if (!response.ok) throw new Error(`Isolated Better Auth sign-in failed: ${response.status} ${await response.text()}`);
      cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
      if (!cookie) throw new Error("Better Auth did not issue a session cookie");
      return response;
    },
    async signOut() {
      const response = await request("/sign-out", {});
      if (!response.ok) throw new Error(`Isolated Better Auth sign-out failed: ${response.status}`);
      cookie = "";
      return response;
    },
  };
}
