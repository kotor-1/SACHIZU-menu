import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");

describe("R11-B6 Competition Session UI/server boundary", () => {
  it("Competition detailだけが明示的な大会実績formを接続する", () => {
    const page = read("src/app/competitions/[id]/page.tsx");
    expect(page).toContain("CompetitionParticipationForm");
    expect(page).toContain("recordCompetitionParticipationAction");
    expect(page).toContain("大会実績を記録");
  });

  it("参加formはfieldset/legend、44px controls、actual wordingを持ちraw enumを画面文言へ出さない", () => {
    const source = read("src/components/competition/competition-participation-form.tsx");
    expect(source).toMatch(/<fieldset/);
    expect(source).toMatch(/<legend/);
    expect(source).toContain("min-h-11");
    expect(source).toContain("実際に出場した日の記録");
    expect(source).not.toMatch(/>RACE<|>RELAY</);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML|console\./);
  });

  it("Competition Session detailは通常編集/status/item追加/execution UIより先に専用branchへ入る", () => {
    const source = read("src/app/sessions/[id]/page.tsx");
    const branch = source.indexOf('session.sessionKind === "COMPETITION"');
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(source.indexOf("listExercisesForPicker()"));
    expect(source.slice(branch, source.indexOf("const exercises"))).not.toContain("AddSessionItemForm");
    expect(source.slice(branch, source.indexOf("const exercises"))).not.toContain("SessionItemRow");
  });

  it("Competition writerはRuleSet/planner/monitor/readiness policyをimportしない", () => {
    const source = read("src/infra/repositories/competition-session-repository.ts") + read("src/actions/competition-actions.ts");
    expect(source).not.toMatch(/getActiveRuleSet|getRuleSetByIdentity|planRunningPrescription|evaluateSessionAggregation|evaluateWeeklyContext|resolveReadinessAction|monitorRunningPrescription/);
  });

  it("Prisma schemaとpackage filesをB6 UI/contract目的で変更しない", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).not.toContain("competitionLoadCategories");
    expect(read("package.json")).not.toContain("playwright");
  });
});
