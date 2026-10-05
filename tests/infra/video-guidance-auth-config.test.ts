import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuidanceAuth } from "@/infra/auth/better-auth-server";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Offline guidance authentication configuration", () => {
  it.each(["true", "1", "yes"])("rejects inherited telemetry opt-in %s before any initialization or outbound request", (enabled) => {
    vi.stubEnv("BETTER_AUTH_TELEMETRY", enabled);
    vi.stubEnv("BETTER_AUTH_TELEMETRY_ENDPOINT", "https://telemetry.example.test/collect");
    const fetch = vi.fn(() => { throw new Error("Unexpected outbound request"); });
    vi.stubGlobal("fetch", fetch);
    const db = new Proxy({} as PrismaClient, { get() { throw new Error("Unexpected database access"); } });
    expect(() => createGuidanceAuth(db, {
      secret: "offline-config-test-secret-at-least-thirty-two-characters", baseURL: "http://guidance-auth.test",
    })).toThrow("EXTERNAL_AUTH_TELEMETRY_DISABLED");
    expect(fetch).not.toHaveBeenCalled();
  });
});
