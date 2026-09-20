import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("R11-B4B2 Session server wiring", () => {
  it("builds one read-only DTO from the existing Session query and passes only a safe row to the client component", () => {
    const page = source("src/app/sessions/[id]/page.tsx");
    expect(page).toContain("presentRunningSessionExecution");
    expect(page).toContain("presentSessionItemRow(item)");
    expect(page).toContain("runningExecution={executionByItemId.get(item.id) ?? null}");
    expect(page).not.toMatch(/getActiveRuleSet|getRuleSetByIdentity|resolveReadinessAction|evaluateWeeklyContext|monitorRunningPrescription/);
  });

  it("keeps the read-only presenter and row adapter free of direct domain reevaluation", () => {
    const presenter = source("src/presentation/running/session-execution.ts");
    const row = source("src/components/session/session-item-row.tsx");
    expect(presenter).not.toMatch(/@\/infra\/|rules\/loader|getActiveRuleSet|getRuleSetByIdentity|resolveReadinessAction|evaluateWeeklyContext|monitorRunningPrescription\(/);
    expect(row).not.toMatch(/acknowledgeRuntimeCoachReviewAction|recordRepAction|evaluateSessionReadinessAction/);
    expect(row).not.toMatch(/RUNNING_V2_UI_ENABLED|feature-flags/);
  });

  it("does not expose raw execution JSON fields through SessionItemRow props", () => {
    const rowDto = source("src/presentation/running/session-item.ts");
    for (const key of ["plannedPrescriptionJson", "plannedProvenanceJson", "actualRepLogJson", "readinessActionsJson"]) {
      expect(rowDto).not.toContain(key);
    }
  });
});
