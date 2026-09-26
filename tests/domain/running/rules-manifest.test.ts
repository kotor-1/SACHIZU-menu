import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runCheck,
  runUpdate,
  computeContentHash,
  readManifest,
} from "../../../scripts/running-ruleset-hash";

const REAL_RULES_DIR = path.resolve(__dirname, "../../../src/domain/running/rules");
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures/running");

const tmpDirs: string[] = [];
function makeTmpRulesDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "running-ruleset-hash-test-"));
  fs.mkdirSync(path.join(dir, "sets"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyRuleSet(rulesDir: string, fixtureName: string, asVersion?: string) {
  const src = path.join(FIXTURES_DIR, `${fixtureName}.json`);
  const data = JSON.parse(fs.readFileSync(src, "utf-8"));
  const version = asVersion ?? data.ruleSetVersion;
  fs.writeFileSync(path.join(rulesDir, "sets", `${version}.json`), JSON.stringify({ ...data, ruleSetVersion: version }, null, 2));
  return { version, data };
}

function writeManifestFile(rulesDir: string, entries: unknown[]) {
  fs.writeFileSync(path.join(rulesDir, "manifest.json"), JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// T-RV-01: 実際の rs-2026.09.0 / manifest.json の整合（1文字変更で検出できること）
// ---------------------------------------------------------------------------

describe("T-RV-01: manifest hash integrity", () => {
  it("real repo: rs-2026.09.0.json の内容と manifest.json の contentHash が一致する", () => {
    const { ok, messages } = runCheck(REAL_RULES_DIR, "rs-2026.09.0");
    expect(ok, messages.join("\n")).toBe(true);
  });

  it("RuleSet JSON を1文字変更すると manifest との hash が不一致になり検出される", () => {
    const dir = makeTmpRulesDir();
    const { version } = copyRuleSet(dir, "rs-test-a");
    const correctHash = computeContentHash(path.join(dir, "sets"), version);
    writeManifestFile(dir, [{ version, status: "ACTIVE", contentHash: correctHash, validFrom: "2020-01-01" }]);

    // 整合している状態ではPASS。
    expect(runCheck(dir, version).ok).toBe(true);

    // ファイルを1文字だけ書き換える（changelog 文中の句点を書き換える）。
    const filePath = path.join(dir, "sets", `${version}.json`);
    const original = fs.readFileSync(filePath, "utf-8");
    const mutated = original.replace("Not a real ruleset.", "Not a real ruleset!");
    expect(mutated).not.toBe(original);
    fs.writeFileSync(filePath, mutated);

    const { ok, messages } = runCheck(dir, version);
    expect(ok).toBe(false);
    expect(messages.some((m) => m.includes("hash 不一致"))).toBe(true);
  });

  it("manifest に記載があるが RuleSet ファイルが存在しない場合を検出する", () => {
    const dir = makeTmpRulesDir();
    writeManifestFile(dir, [{ version: "rs-missing", status: "DRAFT", contentHash: "0".repeat(64), validFrom: "2020-01-01" }]);
    const { ok, messages } = runCheck(dir, null);
    expect(ok).toBe(false);
    expect(messages.some((m) => m.includes("見つかりません"))).toBe(true);
  });

  it("manifest 内の version 重複を検出する", () => {
    const dir = makeTmpRulesDir();
    const { version } = copyRuleSet(dir, "rs-test-a");
    const hash = computeContentHash(path.join(dir, "sets"), version);
    writeManifestFile(dir, [
      { version, status: "ACTIVE", contentHash: hash, validFrom: "2020-01-01" },
      { version, status: "ACTIVE", contentHash: hash, validFrom: "2020-01-01" },
    ]);
    const { ok, messages } = runCheck(dir, null);
    expect(ok).toBe(false);
    expect(messages.some((m) => m.includes("重複"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-RV-04: ACTIVE / RETIRED 不変性 + DRAFT の更新可能性（rs-test-a / rs-test-b 使用）
// ---------------------------------------------------------------------------

describe("T-RV-04: ACTIVE/RETIRED immutability, DRAFT is updatable", () => {
  it("DRAFT の RuleSet は runUpdate で manifest の hash を更新できる", () => {
    const dir = makeTmpRulesDir();
    const { version } = copyRuleSet(dir, "rs-test-b"); // status=DRAFT
    writeManifestFile(dir, []);

    const result = runUpdate(dir, version);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expectedHash = computeContentHash(path.join(dir, "sets"), version);
      expect(result.contentHash).toBe(expectedHash);
    }
    const manifest = readManifest(path.join(dir, "manifest.json"));
    expect(manifest.find((e) => e.version === version)?.status).toBe("DRAFT");
  });

  it("manifest 側で既に status=ACTIVE のエントリは runUpdate を拒否する（RuleSet本体がACTIVEでなくても）", () => {
    const dir = makeTmpRulesDir();
    const { version } = copyRuleSet(dir, "rs-test-a"); // ファイル本体は status=ACTIVE
    const hash = computeContentHash(path.join(dir, "sets"), version);
    writeManifestFile(dir, [{ version, status: "ACTIVE", contentHash: hash, validFrom: "2020-01-01" }]);

    const result = runUpdate(dir, version);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ACTIVE/RETIRED");
    }
    // manifest が変更されていないこと。
    const manifestAfter = readManifest(path.join(dir, "manifest.json"));
    expect(manifestAfter).toEqual([{ version, status: "ACTIVE", contentHash: hash, validFrom: "2020-01-01" }]);
  });

  it("RuleSet 本体の status が RETIRED の場合も runUpdate を拒否する", () => {
    const dir = makeTmpRulesDir();
    const src = path.join(FIXTURES_DIR, "rs-test-a.json");
    const data = JSON.parse(fs.readFileSync(src, "utf-8"));
    const retired = { ...data, status: "RETIRED" };
    fs.writeFileSync(path.join(dir, "sets", `${retired.ruleSetVersion}.json`), JSON.stringify(retired, null, 2));
    writeManifestFile(dir, []); // manifest 未登録の新規追加ケースでも本体側の RETIRED は拒否する

    const result = runUpdate(dir, retired.ruleSetVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("DRAFT 以外");
    }
  });

  it("存在しない version の runUpdate は拒否する", () => {
    const dir = makeTmpRulesDir();
    writeManifestFile(dir, []);
    const result = runUpdate(dir, "rs-does-not-exist");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// manifest schema そのものの検証（src/domain/running/rules/schema.ts の manifestSchema）
// ---------------------------------------------------------------------------

describe("manifestSchema", () => {
  it("実際の manifest.json が manifestSchema を満たす", async () => {
    const { manifestSchema } = await import("../../../src/domain/running/rules/schema");
    const raw = JSON.parse(fs.readFileSync(path.join(REAL_RULES_DIR, "manifest.json"), "utf-8"));
    const parsed = manifestSchema.safeParse(raw);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("manifest.json に記載の version は rules/sets/ に実ファイルが存在する", () => {
    const manifest = readManifest(path.join(REAL_RULES_DIR, "manifest.json"));
    for (const entry of manifest) {
      const filePath = path.join(REAL_RULES_DIR, "sets", `${entry.version}.json`);
      expect(fs.existsSync(filePath), `missing file for ${entry.version}`).toBe(true);
    }
  });

  it("manifest.json の rs-2026.09.0 は status=ACTIVE である（OPEN20 activation 済み）", () => {
    const manifest = readManifest(path.join(REAL_RULES_DIR, "manifest.json"));
    const entry = manifest.find((e) => e.version === "rs-2026.09.0");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("ACTIVE");
  });
});
