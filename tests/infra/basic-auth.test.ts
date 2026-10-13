import { describe, expect, it } from "vitest";
import { basicAuthDecision } from "@/infra/security/basic-auth";

// Offline test values only. They are not credentials for any deployment.
const settings = { user: "coach-test", password: "offline-test-password-01", production: true };
const header = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

describe("Basic auth for the public URL", () => {
  it("allows only the configured user name and password", () => {
    expect(basicAuthDecision(header("coach-test", "offline-test-password-01"), settings)).toBe("ALLOW");
    expect(basicAuthDecision(header("coach-test", "wrong-password-0000"), settings)).toBe("CHALLENGE");
    expect(basicAuthDecision(header("someone-else", "offline-test-password-01"), settings)).toBe("CHALLENGE");
  });

  it("asks again for a missing, malformed or oversized header", () => {
    for (const value of [null, "", "Bearer abc", "Basic", "Basic !!!", `Basic ${Buffer.from("no-separator").toString("base64")}`, `Basic ${"A".repeat(2000)}`]) {
      expect(basicAuthDecision(value, settings)).toBe("CHALLENGE");
    }
  });

  it("keeps a colon inside the password and accepts non-ASCII user names", () => {
    const withColon = { ...settings, user: "コーチ", password: "pass:with:colons-12" };
    expect(basicAuthDecision(header("コーチ", "pass:with:colons-12"), withColon)).toBe("ALLOW");
    expect(basicAuthDecision(header("コーチ", "pass"), withColon)).toBe("CHALLENGE");
  });

  it("stays closed in production until a long enough password is set, and stays open in development", () => {
    expect(basicAuthDecision(null, { user: undefined, password: undefined, production: true })).toBe("NOT_CONFIGURED");
    expect(basicAuthDecision(header("coach-test", "short"), { user: "coach-test", password: "short", production: true })).toBe("NOT_CONFIGURED");
    expect(basicAuthDecision(null, { user: undefined, password: undefined, production: false })).toBe("ALLOW");
  });
});
