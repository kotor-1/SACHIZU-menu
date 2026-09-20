import { describe, expect, it } from "vitest";
import {
  BODY_REGION_LABEL_JA,
  EXECUTION_LABEL_COVERAGE,
  EXECUTION_SAFETY_OUTCOME_LABEL_JA,
  MONITOR_ACTION_LABEL_JA,
  PAIN_STATUS_LABEL_JA,
  RED_FLAG_LABEL_JA,
  REP_QUALITY_LABEL_JA,
  STOP_REASON_LABEL_JA,
  TECHNIQUE_JUDGMENT_LABEL_JA,
} from "@/presentation/running/execution";

describe("R11-B3 execution presentation coverage", () => {
  it("labels every exported enum without leaking raw code as the label", () => {
    for (const code of EXECUTION_LABEL_COVERAGE.actions) expect(MONITOR_ACTION_LABEL_JA[code]).not.toBe(code);
    for (const code of EXECUTION_LABEL_COVERAGE.reasons) expect(STOP_REASON_LABEL_JA[code]).not.toBe(code);
    for (const code of EXECUTION_LABEL_COVERAGE.qualities) expect(REP_QUALITY_LABEL_JA[code]).not.toBe(code);
    for (const code of EXECUTION_LABEL_COVERAGE.safetyOutcomes) expect(EXECUTION_SAFETY_OUTCOME_LABEL_JA[code]).not.toBe(code);
    for (const code of EXECUTION_LABEL_COVERAGE.painStatuses) expect(PAIN_STATUS_LABEL_JA[code]).not.toBe(code);
    for (const code of EXECUTION_LABEL_COVERAGE.bodyRegions) expect(BODY_REGION_LABEL_JA[code]).not.toBe(code);
    for (const code of EXECUTION_LABEL_COVERAGE.redFlags) expect(RED_FLAG_LABEL_JA[code]).not.toBe(code);
    for (const code of EXECUTION_LABEL_COVERAGE.techniqueJudgments) expect(TECHNIQUE_JUDGMENT_LABEL_JA[code]).not.toBe(code);
  });
});
