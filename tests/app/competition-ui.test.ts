import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("R11-B5 competition UI static contract", () => {
  it("一覧・新規・詳細編集とnavigationを接続する", () => {
    expect(read("src/components/nav.tsx")).toContain('{ href: "/competitions", label: "大会" }');
    expect(read("src/app/competitions/page.tsx")).toContain("listCompetitions()");
    expect(read("src/app/competitions/new/page.tsx")).toContain("createCompetitionAction");
    expect(read("src/app/competitions/[id]/page.tsx")).toContain("updateCompetitionAction.bind");
    expect(read("src/app/competitions/[id]/page.tsx")).toContain("CompetitionDeleteForm");
  });

  it("モバイル操作・ラベル・確認付き削除を持つ", () => {
    const form = read("src/components/competition/competition-form.tsx");
    const remove = read("src/components/competition/competition-delete-form.tsx");
    expect(form).toContain("min-h-11");
    expect(form).toContain('type="date"');
    expect(form).toContain("<Field label=");
    expect(form).toContain('aria-live="polite"');
    expect(remove).toContain("ConfirmSubmitButton");
    expect(remove).toContain("大会を削除");
  });

  it("内部enum・HTML挿入・browser persistence・B6責務を持ち込まない", () => {
    const files = [
      "src/components/competition/competition-form.tsx",
      "src/components/competition/competition-delete-form.tsx",
      "src/app/competitions/page.tsx",
      "src/app/competitions/new/page.tsx",
      "src/app/competitions/[id]/page.tsx",
    ];
    const source = files.map(read).join("\n");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|indexedDB|console\.log/);
    expect(source).not.toMatch(/>\s*(TRAINING_MEET|NORMAL|IMPORTANT|PEAK)\s*</);
    expect(source).not.toMatch(/sessionKind|competitionLoadCategory|LoadCategory\.RACE|LoadCategory\.RELAY/);
  });

  it("CRUDはflag・planning・weekly・monitor・Readinessに依存しない", () => {
    const source = read("src/actions/competition-actions.ts");
    expect(source).not.toMatch(/RUNNING_V2_UI_ENABLED|feature-flags/);
    expect(source).not.toMatch(/planRunningPrescription|evaluateWeeklyContext|monitorRunningPrescription|resolveReadinessAction/);
    expect(source).not.toMatch(/TrainingSession|sessionKind|competitionLoadCategory/);
  });
});
