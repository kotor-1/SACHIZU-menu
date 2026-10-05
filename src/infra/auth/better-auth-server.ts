import type { PrismaClient } from "@prisma/client";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

/** Dependencies are explicit so isolated tests never import the runtime DB. */
export function createGuidanceAuth(
  db: PrismaClient,
  config: { secret: string; baseURL: string },
) {
  // Better Auth's environment opt-in overrides telemetry.enabled=false.
  // Reject that configuration before library initialization; this path is local-only.
  const telemetry = process.env.BETTER_AUTH_TELEMETRY;
  if (telemetry && telemetry !== "0" && telemetry !== "false") {
    throw new Error("EXTERNAL_AUTH_TELEMETRY_DISABLED");
  }
  if (typeof config.secret !== "string" || config.secret.trim().length < 32) {
    throw new Error("Guidance authentication requires a secret of at least 32 characters.");
  }

  const baseURL = new URL(config.baseURL);
  if (
    !["http:", "https:"].includes(baseURL.protocol) ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash
  ) {
    throw new Error("Guidance authentication requires an absolute HTTP(S) base URL.");
  }

  return betterAuth({
    appName: "SACHIZU Video Guidance",
    secret: config.secret,
    baseURL: baseURL.href,
    database: prismaAdapter(db, { provider: "sqlite" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    session: {
      // Always resolve the session against the database, including revocation.
      cookieCache: { enabled: false },
      disableSessionRefresh: true,
    },
    // Keep request-origin protection enabled in isolated tests as well as runtime.
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    telemetry: { enabled: false },
  });
}

export type GuidanceAuth = ReturnType<typeof createGuidanceAuth>;
