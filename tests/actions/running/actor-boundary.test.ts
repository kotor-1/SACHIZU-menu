/**
 * R10-B1 §7/§8 — CoachActor 生成の server boundary と AI 経路からの隔離。
 *
 * 静的 import graph の走査（R9 の import graph 監査と同じ手法）と、実際に ESLint を実行して
 * `no-restricted-imports` ルールが機能していることの両方を確認する（現在の AI ファイルが
 * たまたま違反していないだけ、ではなくルール自体が効いていることを保証するため）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getCoachActorForServer } from "@/actions/_actor";
import { coachActorSchema } from "@/domain/running/types/actor";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // npm package / node builtin
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`import を解決できません: ${spec}（${path.relative(ROOT, fromFile)}）`);
}

function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [path.join(ROOT, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const rel = path.relative(ROOT, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.tsx?$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?\s*$/gm)) {
      const resolved = resolveImport(file, m[1]);
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}

describe("CoachActor: server boundary の唯一の生成経路", () => {
  it("getCoachActorForServer() は既存 domain の createCoachActor / coachActorSchema をそのまま使い、branding logic を複製しない", () => {
    const actor = getCoachActorForServer();
    expect(actor.kind).toBe("COACH");
    expect(actor.ownerId).toBe("default-coach");
    // ブランド型として domain の schema をそのまま通る
    expect(coachActorSchema.safeParse(actor).success).toBe(true);
  });

  it("plain object リテラルは CoachActor 型に代入できない（コンパイル時の防波堤。createCoachActor を通さないと作れない）", () => {
    // @ts-expect-error - { kind: "COACH", ownerId } は CoachActor（branded）に構造的に代入できない
    const fake: ReturnType<typeof getCoachActorForServer> = { kind: "COACH", ownerId: "default-coach" };
    void fake;
  });
});

describe("import graph: running-actions は _actor に到達できる", () => {
  it("src/actions/running-actions.ts → src/actions/_actor.ts", () => {
    const graph = importGraph("src/actions/running-actions.ts");
    expect(graph.has("src/actions/_actor.ts")).toBe(true);
  });
});

describe("import graph: AI モジュールは _actor / createCoachActor / coachActorSchema に到達できない", () => {
  const AI_ENTRIES = ["src/domain/ai/ports.ts", "src/domain/ai/analyzer.ts", "src/domain/ai/draft-schema.ts", "src/actions/ai-actions.ts"];

  it.each(AI_ENTRIES)("%s は _actor.ts を import していない（現状のソース）", (entry) => {
    const graph = importGraph(entry);
    expect(graph.has("src/actions/_actor.ts")).toBe(false);
  });
});

describe("eslint boundary: no-restricted-imports が AI モジュールへの CoachActor import を実際に拒否する", () => {
  const PROBE_DIR = path.join(SRC, "infra", "ai");
  const PROBE_FILE = path.join(PROBE_DIR, "__r10b1_actor_boundary_probe.ts");

  function runEslint(source: string): { exitCode: number; output: string } {
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.writeFileSync(PROBE_FILE, source, "utf8");
    try {
      const output = execFileSync("npx", ["eslint", PROBE_FILE], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { exitCode: 0, output };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { exitCode: err.status ?? 1, output: err.stdout ?? "" };
    } finally {
      fs.rmSync(PROBE_FILE, { force: true });
    }
  }

  it("AI モジュールから _actor.ts を import すると eslint が拒否する", () => {
    const { exitCode, output } = runEslint('import { getCoachActorForServer } from "@/actions/_actor";\nexport const x = getCoachActorForServer();\n');
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/no-restricted-imports/);
  });

  it("AI モジュールから createCoachActor / coachActorSchema を直接 import すると eslint が拒否する（root re-export 経由も含む）", () => {
    const direct = runEslint('import { createCoachActor } from "@/domain/running/types/actor";\nexport const x = createCoachActor("t");\n');
    expect(direct.exitCode).not.toBe(0);
    expect(direct.output).toMatch(/no-restricted-imports/);

    const viaRoot = runEslint('import { coachActorSchema } from "@/domain/running";\nexport const y = coachActorSchema;\n');
    expect(viaRoot.exitCode).not.toBe(0);
    expect(viaRoot.output).toMatch(/no-restricted-imports/);
  });

  it("対照: AI モジュールが CoachActor と無関係な import をするのは許可される（ルールが広すぎて壊れていない）", () => {
    const { exitCode } = runEslint('import { z } from "zod";\nexport const schema = z.object({});\n');
    expect(exitCode).toBe(0);
  });

  it("probe ファイルは残らない（テスト後にリポジトリへ痕跡を残さない）", () => {
    expect(fs.existsSync(PROBE_FILE)).toBe(false);
  });
});

