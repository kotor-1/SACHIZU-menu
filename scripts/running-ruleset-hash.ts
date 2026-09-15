/**
 * Running Prescription Engine v2 — RuleSet manifest hash ツール（§6.2, §22 R2）。
 *
 * DRAFT 版 RuleSet JSON の canonical hash（SHA-256）を計算し、
 * `src/domain/running/rules/manifest.json` を更新する。
 *
 * このスクリプトは `scripts/` に置く（`src/domain/running/**` の
 * import boundary — node:fs/node:crypto 禁止 — の外側）。domain 層の
 * loader.ts はこのスクリプトに依存しない（静的 JSON import のみ）。
 *
 * 安全策（§22 R2 #28）:
 *   - 対象 version を明示指定する（`--version=<id>`。省略時は対象なしでエラー）
 *   - DRAFT のみ更新可能。ACTIVE / RETIRED を更新しようとしたら拒否
 *   - manifest 全体を書き換えず、対象 version のエントリだけを更新/追加
 *   - RuleSet JSON 本体（sets/*.json）は変更しない
 *   - `--check` で、実ファイルのハッシュと manifest の記載が一致するかだけを検証
 *     （書き込みなし。CI・rules-manifest.test.ts から呼べる形にしておく）
 *
 * 使い方:
 *   npx tsx scripts/running-ruleset-hash.ts --version=rs-2026.09.0          # manifest を更新
 *   npx tsx scripts/running-ruleset-hash.ts --check                        # 全件検証のみ（書き込みなし）
 *   npx tsx scripts/running-ruleset-hash.ts --check --version=rs-2026.09.0 # 指定版だけ検証
 *
 * `tests/domain/running/rules-manifest.test.ts` は、ここで export している
 * 純粋関数（`computeContentHash` 等）を一時ディレクトリ経由で呼び出し、
 * ACTIVE/RETIRED 拒否・DRAFT 更新許可・--check の整合性検証を行う
 * （実リポジトリの manifest.json / rules/sets/ には一切書き込まない）。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ManifestEntry = {
  version: string;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  contentHash: string;
  validFrom: string;
};

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeContentHash(setsDir: string, version: string): string {
  const filePath = path.join(setsDir, `${version}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`RuleSet file not found for version ${version}: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as { status?: string };
  const canonicalJson = JSON.stringify(canonicalize(data));
  return createHash("sha256").update(canonicalJson, "utf-8").digest("hex");
}

export function readManifest(manifestPath: string): ManifestEntry[] {
  if (!existsSync(manifestPath)) return [];
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestEntry[];
}

export function writeManifest(manifestPath: string, entries: ManifestEntry[]): void {
  writeFileSync(manifestPath, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

export function listRuleSetVersionsOnDisk(setsDir: string): string[] {
  if (!existsSync(setsDir)) return [];
  return readdirSync(setsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function parseArgs(argv: string[]) {
  const check = argv.includes("--check");
  const versionArg = argv.find((a) => a.startsWith("--version="));
  const version = versionArg ? versionArg.slice("--version=".length) : null;
  return { check, version };
}

export type CheckResult = { ok: boolean; messages: string[] };

export function runCheck(rulesDir: string, targetVersion: string | null): CheckResult {
  const setsDir = path.join(rulesDir, "sets");
  const manifestPath = path.join(rulesDir, "manifest.json");
  const manifest = readManifest(manifestPath);
  const versionsOnDisk = listRuleSetVersionsOnDisk(setsDir);
  const targets = targetVersion ? [targetVersion] : versionsOnDisk;

  let ok = true;
  const messages: string[] = [];

  for (const version of targets) {
    const filePath = path.join(setsDir, `${version}.json`);
    if (!existsSync(filePath)) {
      messages.push(`FAIL ${version}: RuleSet ファイルが存在しません（${filePath}）`);
      ok = false;
      continue;
    }
    const entry = manifest.find((e) => e.version === version);
    if (!entry) {
      messages.push(`FAIL ${version}: manifest にエントリがありません`);
      ok = false;
      continue;
    }
    const actualHash = computeContentHash(setsDir, version);
    if (actualHash !== entry.contentHash) {
      messages.push(`FAIL ${version}: hash 不一致（manifest=${entry.contentHash} / 実ファイル=${actualHash}）`);
      ok = false;
      continue;
    }
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as { status?: string; validFrom?: string };
    if (raw.status !== entry.status) {
      messages.push(`FAIL ${version}: status 不一致（manifest=${entry.status} / 実ファイル=${raw.status}）`);
      ok = false;
      continue;
    }
    if (raw.validFrom !== entry.validFrom) {
      messages.push(`FAIL ${version}: validFrom 不一致（manifest=${entry.validFrom} / 実ファイル=${raw.validFrom}）`);
      ok = false;
      continue;
    }
    messages.push(`OK ${version}: hash=${actualHash}`);
  }

  for (const entry of manifest) {
    if (!versionsOnDisk.includes(entry.version)) {
      messages.push(`FAIL ${entry.version}: manifest に記載があるが RuleSet ファイルが見つかりません`);
      ok = false;
    }
  }
  const seen = new Set<string>();
  for (const entry of manifest) {
    if (seen.has(entry.version)) {
      messages.push(`FAIL ${entry.version}: manifest に version の重複があります`);
      ok = false;
    }
    seen.add(entry.version);
  }

  return { ok, messages };
}

export type UpdateResult =
  | { ok: true; contentHash: string }
  | { ok: false; reason: string };

export function runUpdate(rulesDir: string, version: string): UpdateResult {
  const setsDir = path.join(rulesDir, "sets");
  const manifestPath = path.join(rulesDir, "manifest.json");
  const manifest = readManifest(manifestPath);
  const existing = manifest.find((e) => e.version === version);

  if (existing && existing.status !== "DRAFT") {
    return {
      ok: false,
      reason: `拒否: version ${version} は status=${existing.status} です。ACTIVE/RETIRED になった版のファイルは変更できません（§6.2）。`,
    };
  }

  const filePath = path.join(setsDir, `${version}.json`);
  if (!existsSync(filePath)) {
    return { ok: false, reason: `拒否: RuleSet ファイルが見つかりません（${filePath}）` };
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as { status?: string; validFrom?: string };
  if (raw.status !== "DRAFT") {
    return {
      ok: false,
      reason: `拒否: ${version} の RuleSet 本体の status が "${raw.status}" です。DRAFT 以外は hash 更新できません。`,
    };
  }

  const contentHash = computeContentHash(setsDir, version);
  const newEntry: ManifestEntry = {
    version,
    status: "DRAFT",
    contentHash,
    validFrom: raw.validFrom ?? "",
  };

  const updated = existing
    ? manifest.map((e) => (e.version === version ? newEntry : e))
    : [...manifest, newEntry];

  writeManifest(manifestPath, updated);
  return { ok: true, contentHash };
}

function main(): void {
  const RULES_DIR = path.resolve(__dirname, "../src/domain/running/rules");
  const { check, version } = parseArgs(process.argv.slice(2));

  if (check) {
    const { ok, messages } = runCheck(RULES_DIR, version);
    for (const m of messages) (m.startsWith("FAIL") ? console.error : console.log)(m);
    if (!ok) process.exit(1);
    console.log("すべて一致しています。");
    return;
  }

  if (!version) {
    console.error("使い方: npx tsx scripts/running-ruleset-hash.ts --version=<ruleSetVersion>  （または --check ）");
    process.exit(1);
  }

  const result = runUpdate(RULES_DIR, version);
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(`manifest.json を更新しました: ${version} → contentHash=${result.contentHash}`);
}

// CLI として直接実行された場合のみ動く（テストからの import 時は実行しない）。
const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
