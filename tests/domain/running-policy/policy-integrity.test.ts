import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import { RUNNING_POLICY, RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION, computeRunningPolicyHash } from "@/domain/running-policy";

describe("new policy identity and isolation", () => {
  it("uses a canonical, deterministic SHA-256 hash of the complete confirmed policy", () => {
    const canonical = canonicalStringify(RUNNING_POLICY);
    expect(RUNNING_POLICY_VERSION).toBe("rp-2026.09.0");
    expect(RUNNING_POLICY_HASH).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
    expect(computeRunningPolicyHash(RUNNING_POLICY)).toBe(RUNNING_POLICY_HASH);
    expect(computeRunningPolicyHash(JSON.parse(JSON.stringify(RUNNING_POLICY)))).toBe(RUNNING_POLICY_HASH);
  });

  it("changes hash when confirmed policy content changes", () => {
    const modified = JSON.parse(JSON.stringify(RUNNING_POLICY)) as { phaseA: { defaultReps: number }[] };
    modified.phaseA[0]!.defaultReps += 1;
    expect(computeRunningPolicyHash(modified)).not.toBe(RUNNING_POLICY_HASH);
  });

  it("never includes rejected distances in any automatic selection candidate", () => {
    const rejected = new Set<number>(RUNNING_POLICY.rejectedDistances);
    expect([...rejected]).toEqual([40, 80]);
    expect(RUNNING_POLICY.standardDistances.every((distance) => !rejected.has(distance))).toBe(true);
    for (const event of RUNNING_POLICY.distanceSelection.events) {
      const pool = new Set<number>(event.normalPool);
      expect([...event.normalPool, event.defaultDistanceMeters, ...event.shortOrder, ...event.longOrder].every((distance) => !rejected.has(distance))).toBe(true);
      expect(pool.has(event.defaultDistanceMeters)).toBe(true);
      expect(event.shortOrder.every((distance) => pool.has(distance))).toBe(true);
      expect(event.longOrder.every((distance) => pool.has(distance))).toBe(true);
    }
  });

  it("does not import the legacy running domain, catalog, RuleSet loader, AI or DB", () => {
    const files = ["policy.ts", "contracts.ts", "engine.ts", "index.ts"];
    for (const filename of files) {
      const source = readFileSync(resolve(process.cwd(), "src/domain/running-policy", filename), "utf8");
      const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gu)]
        .map((match) => match[1] ?? match[2]);
      for (const specifier of imports) {
        expect(specifier, filename).not.toMatch(/(?:^|\/)domain\/running(?:\/|$)|(?:^|\/)running\/rules(?:\/|$)|@prisma\/client|openai|next(?:\/|$)/u);
      }
    }
  });
});
