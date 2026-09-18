/**
 * R10-B4A.1 — AI 経路から Coach 専用 Server Action（running-actions.ts）への迂回を閉じる。
 *
 * running-actions.ts / _running-plan-service.ts は内部で CoachActor を生成し、coachEdits・overrides・
 * allowAdvancedMethods（updateRunningMenuContextAction）を扱う Coach の信頼境界。AI モジュールからは
 * **モジュールごと** import できないことを、実際に ESLint を実行して確認する（alias / 相対パス / 拡張子付き /
 * re-export / namespace / 型 import）。dynamic import() は ESLint の対象外なのでソース監査で補う。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PROBE_TAG = "__r10b4a1_boundary_probe";

type ProbeCase = { name: string; file: string; source: string; restricted: boolean };

/** probe ファイル（テスト後に必ず削除する）。 */
const CASES: ProbeCase[] = [
  // ---- AI → Coach 専用 Action（alias）----
  {
    name: "infra/ai: alias で overrideRunningItemAction",
    file: `src/infra/ai/${PROBE_TAG}_override.ts`,
    source: 'import { overrideRunningItemAction } from "@/actions/running-actions";\nexport const probe = overrideRunningItemAction;\n',
    restricted: true,
  },
  {
    name: "domain/ai: alias で updateRunningMenuContextAction（allowAdvancedMethods を変更できる Action）",
    file: `src/domain/ai/${PROBE_TAG}_context.ts`,
    source: 'import { updateRunningMenuContextAction } from "@/actions/running-actions";\nexport const probe = updateRunningMenuContextAction;\n',
    restricted: true,
  },
  {
    name: "app/ai: alias で planRunningItemAction（tsx）",
    file: `src/app/ai/${PROBE_TAG}_plan.tsx`,
    source: 'import { planRunningItemAction } from "@/actions/running-actions";\nexport const probe = planRunningItemAction;\n',
    restricted: true,
  },
  {
    name: "infra/ai: namespace import（将来追加される export も含めてモジュールごと禁止）",
    file: `src/infra/ai/${PROBE_TAG}_namespace.ts`,
    source: 'import * as coachActions from "@/actions/running-actions";\nexport const probe = coachActions;\n',
    restricted: true,
  },
  {
    name: "infra/ai: 型だけの import もモジュールごと禁止",
    file: `src/infra/ai/${PROBE_TAG}_type.ts`,
    source: 'import type { RunningActionResult } from "@/actions/running-actions";\nexport type Probe = RunningActionResult<null>;\n',
    restricted: true,
  },
  {
    name: "domain/ai: re-export（export ... from）",
    file: `src/domain/ai/${PROBE_TAG}_reexport.ts`,
    source: 'export { recalculateWithActiveRuleSetAction } from "@/actions/running-actions";\n',
    restricted: true,
  },
  // ---- AI → Coach 専用 Action（相対パス・拡張子付き）----
  {
    name: "infra/ai: 相対パス ../../actions/running-actions",
    file: `src/infra/ai/${PROBE_TAG}_relative.ts`,
    source: 'import { editRunningItemAction } from "../../actions/running-actions";\nexport const probe = editRunningItemAction;\n',
    restricted: true,
  },
  {
    name: "domain/ai: 相対パス + 拡張子 ../../actions/running-actions.ts",
    file: `src/domain/ai/${PROBE_TAG}_relative_ext.ts`,
    source: 'import { planRunningItemAction } from "../../actions/running-actions.ts";\nexport const probe = planRunningItemAction;\n',
    restricted: true,
  },
  {
    name: "actions/ai-*.ts: 同じディレクトリからの相対パス ./running-actions",
    file: `src/actions/ai-${PROBE_TAG}.ts`,
    source: 'import { overrideRunningItemAction } from "./running-actions";\nexport const probe = overrideRunningItemAction;\n',
    restricted: true,
  },
  {
    name: "actions/ai/**: 親ディレクトリからの相対パス ../running-actions",
    file: `src/actions/ai/${PROBE_TAG}.ts`,
    source: 'import { updateRunningMenuContextAction } from "../running-actions";\nexport const probe = updateRunningMenuContextAction;\n',
    restricted: true,
  },
  // ---- AI → CoachActor を生成する service / _actor（相対パスの迂回も）----
  {
    name: "infra/ai: _running-plan-service（alias）",
    file: `src/infra/ai/${PROBE_TAG}_service.ts`,
    source: 'import { planNewRunningItem } from "@/actions/_running-plan-service";\nexport const probe = planNewRunningItem;\n',
    restricted: true,
  },
  {
    name: "actions/ai-*.ts: _running-plan-service（相対パス）",
    file: `src/actions/ai-${PROBE_TAG}_service.ts`,
    source: 'import { overrideRunningItem } from "./_running-plan-service";\nexport const probe = overrideRunningItem;\n',
    restricted: true,
  },
  {
    name: "infra/ai: _actor（相対パス ../../actions/_actor）",
    file: `src/infra/ai/${PROBE_TAG}_actor_relative.ts`,
    source: 'import { getCoachActorForServer } from "../../actions/_actor";\nexport const probe = getCoachActorForServer;\n',
    restricted: true,
  },
  {
    name: "domain/ai: createCoachActor（相対パス ../running/types/actor）",
    file: `src/domain/ai/${PROBE_TAG}_factory_relative.ts`,
    source: 'import { createCoachActor } from "../running/types/actor";\nexport const probe = createCoachActor;\n',
    restricted: true,
  },
  {
    name: "domain/ai: CoachActor 型（root re-export・相対パス ../running）",
    file: `src/domain/ai/${PROBE_TAG}_type_root.ts`,
    source: 'import type { CoachActor } from "../running";\nexport type Probe = CoachActor;\n',
    restricted: true,
  },
  {
    name: "infra/ai: CoachActor 型（alias @/domain/running/types/actor）",
    file: `src/infra/ai/${PROBE_TAG}_type_alias.ts`,
    source: 'import type { CoachActor } from "@/domain/running/types/actor";\nexport type Probe = CoachActor;\n',
    restricted: true,
  },
  // ---- 対照: AI でも許可されるもの（ルールが広すぎない）----
  {
    name: "対照 infra/ai: AI actor の schema・安全な template 候補 port・presentation・zod は使える",
    file: `src/infra/ai/${PROBE_TAG}_allowed.ts`,
    source: [
      'import { z } from "zod";',
      'import { aiPlannerActorSchema, type AiPlannerActor } from "@/domain/running/types/actor";',
      'import { templatePickerForPlannedDate } from "@/actions/_running-template-options";',
      'import { presentFindings } from "@/presentation/running/findings";',
      "export const probe = { z, aiPlannerActorSchema, templatePickerForPlannedDate, presentFindings };",
      "export type Probe = AiPlannerActor;",
      "",
    ].join("\n"),
    restricted: false,
  },
  // ---- positive path: Coach 側（AI 以外）は running-actions / _actor を使える ----
  {
    name: "Coach 側 components/running: running-actions を import できる（B4B の Menu UI 経路）",
    file: `src/components/running/${PROBE_TAG}_coach.tsx`,
    source:
      'import { planRunningItemAction, updateRunningMenuContextAction } from "@/actions/running-actions";\nexport const probe = { planRunningItemAction, updateRunningMenuContextAction };\n',
    restricted: false,
  },
  {
    name: "Coach 側 src/actions（AI 以外の名前）: ./running-actions と ./_actor を import できる",
    file: `src/actions/${PROBE_TAG}_coach.ts`,
    source:
      'import { getCoachActorForServer } from "./_actor";\nimport { planRunningItemAction } from "./running-actions";\nexport const probe = { getCoachActorForServer, planRunningItemAction };\n',
    restricted: false,
  },
];

const createdDirs: string[] = [];

function writeProbes() {
  for (const c of CASES) {
    const full = path.join(ROOT, c.file);
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDirs.push(dir);
    }
    fs.writeFileSync(full, c.source, "utf8");
  }
}

function removeProbes() {
  for (const c of CASES) fs.rmSync(path.join(ROOT, c.file), { force: true });
  for (const dir of createdDirs.reverse()) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
}

type EslintMessage = { ruleId: string | null; message: string; fatal?: boolean };
type EslintFileResult = { filePath: string; messages: EslintMessage[] };

function runEslintOnProbes(): Map<string, EslintMessage[]> {
  writeProbes();
  let stdout: string;
  try {
    stdout = execFileSync("npx", ["eslint", "--format", "json", ...CASES.map((c) => c.file)], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? "[]";
  } finally {
    removeProbes();
  }
  const results = JSON.parse(stdout) as EslintFileResult[];
  return new Map(results.map((r) => [path.relative(ROOT, r.filePath), r.messages]));
}

afterAll(removeProbes);

describe("R10-B4A.1: ESLint が AI → Coach 専用 Action / CoachActor の import を拒否する", () => {
  let results: Map<string, EslintMessage[]> | null = null;
  const lint = () => (results ??= runEslintOnProbes());

  it.each(CASES)("$name", (probe) => {
    const messages = lint().get(probe.file);
    expect(messages, `${probe.file} が ESLint の対象になっていません`).toBeDefined();
    expect(messages!.filter((m) => m.fatal), probe.file).toEqual([]);
    const restricted = messages!.filter((m) => m.ruleId === "no-restricted-imports");
    if (probe.restricted) expect(restricted.length, probe.file).toBeGreaterThan(0);
    else expect(restricted, probe.file).toEqual([]);
  }, 120_000);

  it("probe ファイルと一時ディレクトリは残らない", () => {
    lint();
    for (const c of CASES) expect(fs.existsSync(path.join(ROOT, c.file)), c.file).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src/actions/ai"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ソース監査（dynamic import() や文字列経由も含む）と import graph
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(rel);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(PROBE_TAG) ? [rel] : [];
  });
}

/** 現在の AI 境界の対象ファイル（eslint.config.mjs の AI ブロックの files と同じ範囲）。 */
function aiSourceFiles(): string[] {
  const actionsDir = path.join(ROOT, "src/actions");
  const aiActions = fs
    .readdirSync(actionsDir)
    .filter((f) => /^_?ai-.*\.(ts|tsx)$/.test(f) && !f.includes(PROBE_TAG))
    .map((f) => path.join("src/actions", f));
  return [...listSourceFiles("src/domain/ai"), ...listSourceFiles("src/infra/ai"), ...listSourceFiles("src/app/ai"), ...listSourceFiles("src/actions/ai"), ...aiActions].sort();
}

function resolveImport(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join("src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.join(path.dirname(fromRel), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    const full = path.join(ROOT, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return path.normalize(candidate);
  }
  return null;
}

function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.tsx?$/.test(rel)) continue;
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of source.matchAll(/(?:^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?|\bimport\s*\(\s*)["']([^"']+)["']/gm)) {
      const resolved = resolveImport(rel, m[1]!);
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}

const COACH_ONLY_MODULES = ["src/actions/running-actions.ts", "src/actions/_running-plan-service.ts", "src/actions/_actor.ts"];

describe("R10-B4A.1: 現在の AI ソースの監査", () => {
  it("AI 境界の対象ファイルを列挙できる（domain/ai・infra/ai・app/ai・actions/ai-*。infra/ai は存在する場合だけ）", () => {
    const files = aiSourceFiles();
    expect(files).toEqual(expect.arrayContaining(["src/actions/ai-actions.ts", "src/app/ai/page.tsx", "src/domain/ai/ports.ts"]));
    expect(files.filter((f) => f.startsWith("src/infra/ai/"))).toEqual(listSourceFiles("src/infra/ai"));
  });

  it("AI ソースに Coach 専用 module / CoachActor 生成への参照が文字列としても存在しない（dynamic import 含む）", () => {
    const forbidden = /running-actions|_running-plan-service|(^|[^A-Za-z0-9])_actor([^A-Za-z0-9]|$)|createCoachActor|coachActorSchema|\bCoachActor\b|getCoachActorForServer/;
    for (const file of aiSourceFiles()) {
      expect(fs.readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(forbidden);
    }
  });

  it("[R10-B4A.2] AI ソースがコーチ入力の強度基準（目標スプリット）を作る経路を持たない", () => {
    // 数値の権限は AI に無い（proposal schema は strict で数値 field を持たない）。
    // PlanRequest の coachReference は COACH actor でなければ domain が拒否するが、ソース上も参照しない。
    const forbidden = /coachReference|TARGET_SPLIT|toCoachReferenceInput|coachManualReferenceInputSchema|targetSplit/i;
    for (const file of aiSourceFiles()) {
      expect(fs.readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(forbidden);
    }
  });

  it("AI ソースの推移的な import graph に Coach 専用 module が入らない", () => {
    for (const file of aiSourceFiles()) {
      const graph = importGraph(file);
      for (const coachOnly of COACH_ONLY_MODULES) expect(graph.has(coachOnly), `${file} -> ${coachOnly}`).toBe(false);
    }
  });

  it("既存の AI ソースは現在の ESLint 設定で PASS する", () => {
    const files = aiSourceFiles();
    let exitCode = 0;
    let output = "";
    try {
      execFileSync("npx", ["eslint", ...files], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      exitCode = (e as { status?: number }).status ?? 1;
      output = (e as { stdout?: string }).stdout ?? "";
    }
    expect(exitCode, output).toBe(0);
  }, 120_000);
});
