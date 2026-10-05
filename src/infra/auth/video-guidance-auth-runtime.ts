import { headers } from "next/headers";
import { prisma } from "@/infra/db/prisma";
import { createGuidanceAuth, type GuidanceAuth } from "./better-auth-server";
import { createVideoGuidanceIdentity } from "./video-guidance-identity";

let configuredAuth: GuidanceAuth | undefined;

/** Opt-in only; adding auth code does not migrate or enable it on the original database. */
export function getVideoGuidanceAuth(): GuidanceAuth | null {
  const mode = process.env.GUIDANCE_AUTH_ENABLED;
  if (mode === undefined || mode === "0") return null;
  if (mode !== "1") throw new Error("INVALID_GUIDANCE_AUTH_CONFIG");
  if (!configuredAuth) {
    const secret = process.env.BETTER_AUTH_SECRET;
    const baseURL = process.env.BETTER_AUTH_URL;
    if (!secret || !baseURL) throw new Error("MISSING_GUIDANCE_AUTH_CONFIG");
    configuredAuth = createGuidanceAuth(prisma, { secret, baseURL });
  }
  return configuredAuth;
}

export function getVideoGuidanceRuntimeIdentity() {
  const auth = getVideoGuidanceAuth();
  return auth ? createVideoGuidanceIdentity({ auth, db: prisma, headers: async () => new Headers(await headers()) }) : null;
}
