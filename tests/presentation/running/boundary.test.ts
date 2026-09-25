/**
 * R10-B3 — presentation / component の依存境界（静的検査）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dtoRawKeyLeaks, rawKeyLeaks } from "./helpers";

const ROOT = process.cwd();
const COMPONENT_DIR = "src/components/running";
const PRESENTATION_DIR = "src/presentation/running";

function filesIn(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `${dir}/${f}`);
}

function source(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** コメント行を除いたコード（説明文中の名前に反応しないため）。 */
function codeOnly(rel: string): string {
  return source(rel)
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
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

/** import / export from の推移的な依存（type import も含む保守的なグラフ）。 */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.tsx?$/.test(rel)) continue;
    for (const m of source(rel).matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?\s*$/gm)) {
      const resolved = resolveImport(rel, m[1]!);
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}

describe("R10-B3: 内部キー検出ヘルパー自体の健全性", () => {
  it("内部キーを検出できる（検査が空振りしていない）", () => {
    expect(rawKeyLeaks("<p>ACCELERATION</p>")).toContain("ACCELERATION");
    expect(rawKeyLeaks("<p>確認: REQUIRE_COACH_REVIEW</p>")).toContain("REQUIRE_COACH_REVIEW");
    expect(rawKeyLeaks("<p>INFO</p>")).toContain("INFO");
    expect(rawKeyLeaks('<div data-x="AGG_NEW_CODE"></div>')).toContain("AGG_NEW_CODE");
    expect(rawKeyLeaks("<p>確信度 中・フライ20m・Relaxed Stride・SES 100m</p>")).toEqual([]);
    expect(dtoRawKeyLeaks({ message: "POLICY_ONLY", developerCode: "AGG_X" })).toEqual(["message: POLICY_ONLY"]);
  });
});

/**
 * B3 の表示・編集 component（Server Action も server presenter も知らない純粋な部品）。
 */
const PURE_COMPONENTS = [
  "confidence-badge.tsx",
  "findings-list.tsx",
  "method-template-picker.tsx",
  "monitor-banner.tsx",
  "plausibility-review-form.tsx",
  "provenance-panel.tsx",
  "running-item-editor.tsx",
  "target-split-editor.tsx",
];

/**
 * [R10-B4B] 既存 Menu 画面へつなぐ統合 component。Server Action を**呼ぶ**ことだけが追加で許され、
 * repository / RuleSet loader / server presenter / feature flag は（型としてしか）触れない。
 */
const INTEGRATION_COMPONENTS = [
  "readiness-form.tsx",
  "rep-logger.tsx",
  "runtime-coach-review-panel.tsx",
  "session-execution-panel.tsx",
  "running-context-editor.tsx",
  "running-item-create-form.tsx",
  "running-item-panel.tsx",
  "running-menu-panel.tsx",
];

describe("R10-B3: component の境界", () => {
  const components = filesIn(COMPONENT_DIR);

  it("B3 の表示・編集 component と [R10-B4B] の統合 component だけがある", () => {
    expect(components.map((f) => path.basename(f)).sort()).toEqual([...PURE_COMPONENTS, ...INTEGRATION_COMPONENTS].sort());
  });

  it('"use client" は操作を持つものだけ。表示専用 component と presentation module には付けない', () => {
    const clientFiles = [...components, ...filesIn(PRESENTATION_DIR)].filter((f) => /^\s*["']use client["'];?/.test(source(f)));
    expect(clientFiles.sort()).toEqual(
      [
        `${COMPONENT_DIR}/method-template-picker.tsx`,
        `${COMPONENT_DIR}/plausibility-review-form.tsx`,
        `${COMPONENT_DIR}/readiness-form.tsx`,
        `${COMPONENT_DIR}/rep-logger.tsx`,
        `${COMPONENT_DIR}/runtime-coach-review-panel.tsx`,
        `${COMPONENT_DIR}/session-execution-panel.tsx`,
        `${COMPONENT_DIR}/running-item-editor.tsx`,
        `${COMPONENT_DIR}/target-split-editor.tsx`,
        `${COMPONENT_DIR}/running-context-editor.tsx`,
        `${COMPONENT_DIR}/running-item-create-form.tsx`,
        `${COMPONENT_DIR}/running-item-panel.tsx`,
      ].sort(),
    );
  });

  it("B3 の component は Server Action / repository / RuleSet loader / server presenter / feature flag を import しない", () => {
    for (const file of PURE_COMPONENTS.map((f) => `${COMPONENT_DIR}/${f}`)) {
      const text = codeOnly(file);
      expect(text, file).not.toMatch(/from\s+["']@\/actions/);
      expect(text, file).not.toMatch(/from\s+["']@\/infra/);
      expect(text, file).not.toMatch(/rules\/loader/);
      expect(text, file).not.toMatch(/presentation\/running\/(server|item|editor|provenance|template)["']/);
      expect(text, file).not.toMatch(/feature-flags|RUNNING_V2_UI_ENABLED/);
    }
  });

  it("[R10-B4B] 統合 component は、server 側へは Server Action か型経由でしか触らない", () => {
    for (const file of INTEGRATION_COMPONENTS.map((f) => `${COMPONENT_DIR}/${f}`)) {
      const text = codeOnly(file);
      // repository / Prisma / RuleSet loader / feature flag は型としても値としても import しない
      expect(text, file).not.toMatch(/from\s+["']@\/infra/);
      expect(text, file).not.toMatch(/rules\/loader|@prisma\/client/);
      expect(text, file).not.toMatch(/feature-flags|RUNNING_V2_UI_ENABLED/);

      for (const m of text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["'](@\/actions\/[^"']+)["'];?$/gm)) {
        const isTypeOnly = m[1] !== undefined;
        const target = resolveImport(file, m[2]!);
        const isServerAction = target !== null && /^\s*["']use server["']/.test(source(target));
        expect(isTypeOnly || isServerAction, `${file} -> ${m[2]} は型 import か "use server" のみ`).toBe(true);
      }
      // server presenter は型としてだけ（値を import すると RuleSet loader が client へ入る）
      for (const m of text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']@\/presentation\/running\/(server|item|editor|provenance)["'];?$/gm)) {
        expect(m[1], `${file} -> ${m[2]} は型 import のみ`).toBeDefined();
      }
    }
  });

  it("client component の推移的な依存に RuleSet JSON / loader / planner / Action / server presenter が入らない", () => {
    const forbidden = [
      "src/domain/running/rules/loader.ts",
      "src/domain/running/rules/manifest.json",
      "src/domain/running/planning/index.ts",
      "src/domain/running/planning/build.ts",
      "src/presentation/running/server.ts",
      "src/presentation/running/item.ts",
      "src/presentation/running/editor.ts",
      "src/lib/feature-flags.ts",
    ];
    for (const entry of [`${COMPONENT_DIR}/method-template-picker.tsx`, `${COMPONENT_DIR}/running-item-editor.tsx`, `${COMPONENT_DIR}/target-split-editor.tsx`]) {
      const graph = importGraph(entry);
      for (const f of forbidden) expect(graph.has(f), `${entry} -> ${f}`).toBe(false);
      expect([...graph].filter((f) => f.startsWith("src/actions/") || f.startsWith("src/infra/") || f.endsWith(".json")), entry).toEqual([]);
    }
  });
});

describe("R10-B3: presentation module の境界", () => {
  const modules = filesIn(PRESENTATION_DIR);

  it("保存済み理由文のレンダラ・feature flag・Prisma / repository・active RuleSet selector を使わない", () => {
    for (const file of modules) {
      const text = codeOnly(file);
      expect(text, file).not.toMatch(/rationale\/render-ja/);
      expect(text, file).not.toMatch(/feature-flags|RUNNING_V2_UI_ENABLED/);
      expect(text, file).not.toMatch(/@prisma\/client|@\/infra\//);
      expect(text, file).not.toMatch(/getActiveRuleSet|selectActiveRuleSet/);
      expect(text, file).not.toMatch(/from\s+["']react|from\s+["']next/);
    }
  });

  it("RuleSet を読むのは server.ts の exact identity loader だけ", () => {
    const readers = modules.filter((f) => /rules\/loader/.test(codeOnly(f)));
    expect(readers).toEqual([`${PRESENTATION_DIR}/server.ts`]);
    expect(source(`${PRESENTATION_DIR}/server.ts`)).toMatch(/getRuleSetByIdentity/);
  });

  it("数値ポリシー（係数・量の上限・rest の式）を持たない", () => {
    for (const file of modules) {
      const code = codeOnly(file);
      expect(code, file).not.toMatch(/\*\s*0\.\d|\*=\s*\d|Factor|Multiplier|maxAutoTotalReps|highIntensityBudget|dayMin|dayMax/);
    }
  });
});
