/**
 * R10-B1 — `getRuleSetByIdentity()`（§9・§10・§44）。
 * 保存済み version + contentHash の完全一致でだけ RuleSet を返す。current/active へのフォールバックはしない。
 */
import { describe, expect, it } from "vitest";
import { getActiveRuleSet, getRuleSetByIdentity } from "@/domain/running";

const PLANNING_DATE = "2026-09-15";
const PRODUCTION_VERSION = "rs-2026.09.0";
const PRODUCTION_HASH = "bade42b0180b4731937db9d0b0acb7f1cd1fb0ea42c2c5f8e99f3f4f030ee92d";

describe("getRuleSetByIdentity", () => {
  it("version + hash が完全一致すれば OK（manifest 検証済みの contentHash と一致する）", () => {
    const result = getRuleSetByIdentity({ version: PRODUCTION_VERSION, contentHash: PRODUCTION_HASH });
    expect(result).toMatchObject({ status: "OK", contentHash: PRODUCTION_HASH });
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.ruleSet.ruleSetVersion).toBe(PRODUCTION_VERSION);
    // getActiveRuleSet と同じ RuleSet オブジェクト（内容）を返す
    expect(result.ruleSet).toEqual(getActiveRuleSet(PLANNING_DATE).ruleSet);
  });

  it("version は存在するが hash が一致しない → REJECTED / RULESET_IDENTITY_MISMATCH（current 版へフォールバックしない）", () => {
    const result = getRuleSetByIdentity({ version: PRODUCTION_VERSION, contentHash: "0".repeat(64) });
    expect(result).toEqual({ status: "REJECTED", issue: "RULESET_IDENTITY_MISMATCH" });
  });

  it("version が存在しない → REJECTED / VERSION_NOT_FOUND", () => {
    const result = getRuleSetByIdentity({ version: "rs-1999.01.0", contentHash: PRODUCTION_HASH });
    expect(result).toEqual({ status: "REJECTED", issue: "VERSION_NOT_FOUND" });
  });

  it("hash が空文字・大文字小文字違いでも一致しない（曖昧な一致をしない）", () => {
    expect(getRuleSetByIdentity({ version: PRODUCTION_VERSION, contentHash: "" }).status).toBe("REJECTED");
    expect(getRuleSetByIdentity({ version: PRODUCTION_VERSION, contentHash: PRODUCTION_HASH.toUpperCase() }).status).toBe("REJECTED");
  });
});
