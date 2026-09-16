/**
 * Running Prescription Engine v2 — RuleSet loader（§6.2）。
 *
 * import boundary（§1.6, R1 の eslint no-restricted-imports）を守るため、
 * `node:fs` 等は使わない。RuleSet JSON は静的 import で読み込む
 * （`resolveJsonModule` が有効。新しい版を追加する場合はこのファイルの
 * `RAW_RULE_SETS` に1行足す）。
 *
 * このファイルが**しないこと**（§22 R2 のスコープ外）:
 *   - Finding の生成（DRAFT fallback を使ったかどうかは `isDraftFallback`
 *     という真偽値で返すだけ。`RULESET_DRAFT` Finding を実際に付けるのは
 *     planning 側＝R4 の責務）
 *   - ruleSetContentHash の計算（`scripts/running-ruleset-hash.ts` の責務。
 *     `node:crypto` は import boundary 違反になるため domain 層には置けない）
 *
 * [R4] `getActiveRuleSet()` は、検証済み `manifest.json` に記録された
 * `contentHash` を一緒に返す（planning が `RunningPrescription.ruleSet` に
 * 埋め込むため）。ここでは hash を**再計算しない**。manifest と RuleSet JSON の
 * version/status/validFrom が一致しない場合は読み込み時に例外にする。
 * 実ファイルと manifest の hash 一致は `scripts/running-ruleset-hash.ts --check`
 * と `tests/domain/running/rules-manifest.test.ts` が保証する。
 */
import rs202609 from "./sets/rs-2026.09.0.json";
import manifestJson from "./manifest.json";
import { ruleSetSchema, checkRuleSetCompleteness, manifestSchema, type RuleSet, type ManifestEntry } from "./schema";

/** 新しい版を追加したら、ここに import 文と配列要素を追加する。 */
const RAW_RULE_SETS: readonly unknown[] = [rs202609];

/**
 * `getRuleSet` / `getActiveRuleSet`（実運用向け公開API）が返す RuleSet は、
 * 形だけでなく §22 R2 の完了条件（全 canonical Method / 全 template /
 * 全 TimingMethod の網羅性）も満たしていることを保証する。
 * `ruleSetSchema` 単体は意図的にこの網羅性を要求しない
 * （`tests/fixtures/running/rs-test-*.json` のような最小 fixture も
 * 同じ schema で検証できるようにするため）ので、ここで明示的に両方を通す。
 *
 * `tests/domain/running/ruleset.test.ts` はこの関数を直接呼び出し、
 * 「production RuleSet から Method/Template/参照される Evidence を
 * 1件欠かすと拒否される」ことを検証する（実ファイルは書き換えない）。
 */
export function parseProductionRuleSet(raw: unknown): RuleSet {
  const result = ruleSetSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `RuleSet failed schema validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const problems = checkRuleSetCompleteness(result.data);
  if (problems.length > 0) {
    throw new Error(`RuleSet failed completeness check: ${problems.join("; ")}`);
  }
  return result.data;
}

let parsedCache: RuleSet[] | null = null;
let manifestCache: readonly ManifestEntry[] | null = null;

function allRuleSets(): RuleSet[] {
  if (parsedCache) return parsedCache;
  parsedCache = RAW_RULE_SETS.map((raw, i) => {
    try {
      return parseProductionRuleSet(raw);
    } catch (e) {
      throw new Error(`RuleSet at RAW_RULE_SETS[${i}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return parsedCache;
}

/**
 * manifest.json を schema 検証し、ロード済み RuleSet と version/status/validFrom が
 * 1対1で一致することを確認する（hash の再計算はしない）。
 */
function validatedManifest(): readonly ManifestEntry[] {
  if (manifestCache) return manifestCache;
  const parsed = manifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new Error(
      `RuleSet manifest failed schema validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  for (const rs of allRuleSets()) {
    const entry = parsed.data.find((e) => e.version === rs.ruleSetVersion);
    if (!entry) {
      throw new Error(`RuleSet manifest has no entry for loaded RuleSet ${rs.ruleSetVersion}`);
    }
    if (entry.status !== rs.status || entry.validFrom !== rs.validFrom) {
      throw new Error(
        `RuleSet manifest entry for ${rs.ruleSetVersion} does not match the RuleSet JSON (status/validFrom)`,
      );
    }
  }
  manifestCache = parsed.data;
  return manifestCache;
}

/** バージョン文字列（例 "rs-2026.09.0"）から RuleSet を取得する。見つからなければ null。 */
export function getRuleSet(version: string): RuleSet | null {
  return allRuleSets().find((rs) => rs.ruleSetVersion === version) ?? null;
}

export type SelectedRuleSet = {
  ruleSet: RuleSet;
  /** true = ACTIVE 版が無く最新 DRAFT を代わりに返した（§6.2）。 */
  isDraftFallback: boolean;
};

export type ActiveRuleSetResult = SelectedRuleSet & {
  /** [R4] 検証済み manifest.json に記録された canonical SHA-256（domain では再計算しない）。 */
  contentHash: string;
};

/**
 * `status=ACTIVE` かつ `validFrom <= at` の最新版を返す。
 * ACTIVE が無い場合は最新 DRAFT を返す（`isDraftFallback: true`）。
 * IsoDate は YYYY-MM-DD 形式で文字列比較がそのまま時系列比較になる。
 *
 * 純粋関数として切り出してある（`ruleSets` を引数で受け取る）ため、
 * `tests/domain/running/ruleset.test.ts`（T-RV-03）は本番の
 * `rs-2026.09.0` を差し替えずに `tests/fixtures/running/rs-test-{a,b}.json`
 * だけでバージョン選択ロジックを検証できる。
 */
export function selectActiveRuleSet(ruleSets: readonly RuleSet[], at: string): SelectedRuleSet {
  const activeCandidates = ruleSets
    .filter((rs) => rs.status === "ACTIVE" && rs.validFrom <= at)
    .slice()
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0));
  if (activeCandidates.length > 0) {
    return { ruleSet: activeCandidates[0], isDraftFallback: false };
  }

  const draftCandidates = ruleSets
    .filter((rs) => rs.status === "DRAFT")
    .slice()
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0));
  if (draftCandidates.length > 0) {
    return { ruleSet: draftCandidates[0], isDraftFallback: true };
  }

  throw new Error("No ACTIVE or DRAFT RuleSet is available");
}

export function getActiveRuleSet(at: string): ActiveRuleSetResult {
  const selected = selectActiveRuleSet(allRuleSets(), at);
  const entry = validatedManifest().find((e) => e.version === selected.ruleSet.ruleSetVersion);
  if (!entry) {
    throw new Error(`RuleSet manifest has no entry for ${selected.ruleSet.ruleSetVersion}`);
  }
  return { ...selected, contentHash: entry.contentHash };
}

/** テスト・監査用: 現在ロードされている全 RuleSet のバージョン一覧。 */
export function listRuleSetVersions(): string[] {
  return allRuleSets().map((rs) => rs.ruleSetVersion);
}
