import type { PrismaClient } from "@prisma/client";
import { GUIDANCE_PERMISSIONS, type GuidanceIdentityPort, type GuidancePermission } from "@/domain/exercise/video-guidance-review";
import type { GuidanceAuth } from "./better-auth-server";

/** Per-invocation session + grant lookup. Never cache a page's identity for a later submit. */
export function createVideoGuidanceIdentity(deps: {
  auth: GuidanceAuth; db: PrismaClient; headers: () => Promise<Headers>;
}): GuidanceIdentityPort {
  return {
    async currentIdentity() {
      const session = await deps.auth.api.getSession({
        headers: await deps.headers(), query: { disableCookieCache: true },
      });
      if (!session) return null;
      const grants = await deps.db.guidanceOwnerAccess.findMany({
        where: { userId: session.user.id }, orderBy: [{ ownerId: "asc" }, { permission: "asc" }],
        select: { ownerId: true, permission: true },
      });
      const ownerPermissions: { ownerId: string; permissions: GuidancePermission[] }[] = [];
      for (const grant of grants) {
        if (!GUIDANCE_PERMISSIONS.includes(grant.permission as GuidancePermission)) continue;
        let scope = ownerPermissions.find((value) => value.ownerId === grant.ownerId);
        if (!scope) { scope = { ownerId: grant.ownerId, permissions: [] }; ownerPermissions.push(scope); }
        scope.permissions.push(grant.permission as GuidancePermission);
      }
      return {
        actorId: session.user.id,
        ownerIds: ownerPermissions.map((grant) => grant.ownerId),
        permissions: [...new Set(ownerPermissions.flatMap((grant) => grant.permissions))],
        ownerPermissions,
      };
    },
  };
}

/** Lazy wiring keeps an unconfigured runtime closed, including at build time. */
export const videoGuidanceIdentity: GuidanceIdentityPort = Object.freeze({
  async currentIdentity() {
    const { getVideoGuidanceRuntimeIdentity } = await import("./video-guidance-auth-runtime");
    const identity = getVideoGuidanceRuntimeIdentity();
    return identity ? identity.currentIdentity() : null;
  },
});
