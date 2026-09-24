import { describe, expect, it } from "vitest";
import { eligibilityOverrideOptions, groupCreateMethodPolicy, presentEligibilityReasons } from "@/presentation/running/eligibility";

describe("new-create override controls", () => {
  it("offers only actual blocking Rule IDs explicitly marked overrideAllowed by domain", () => {
    const reasons = presentEligibilityReasons([
      { code: "ELIGIBILITY_CONDITIONS_UNMET", ruleId: "ELIG_SES_PRE", overrideAllowed: true },
      { code: "ELIGIBILITY_CONDITIONS_UNMET", ruleId: "CONSTRAINT_U12_HARD", overrideAllowed: false },
      { code: "OVERRIDE_REQUIRED", ruleId: null, overrideAllowed: true },
    ]);
    expect(eligibilityOverrideOptions(reasons)).toEqual([expect.objectContaining({ ruleIdInternal: "ELIG_SES_PRE", overrideAllowed: true })]);
  });

  it("shows no override option for non-overridable blockers", () => {
    const reasons = presentEligibilityReasons([
      { code: "ELIGIBILITY_CONDITIONS_UNMET", ruleId: "ELIG_LONG_FULL_PRE", overrideAllowed: false },
      { code: "ELIGIBILITY_CONDITIONS_UNMET", ruleId: "CONSTRAINT_U12_HARD", overrideAllowed: false },
    ]);
    expect(eligibilityOverrideOptions(reasons)).toEqual([]);
  });

  it("does not offer a TI create override in the group flow without an authorized measured reference", () => {
    const reasons = presentEligibilityReasons([
      { code: "ELIGIBILITY_CONDITIONS_UNMET", ruleId: "ELIG_TI_ALL_PRE", overrideAllowed: true },
    ]);
    const policy = groupCreateMethodPolicy("TEMPO_INTENSIVE");

    expect(eligibilityOverrideOptions(reasons, "TEMPO_INTENSIVE")).toEqual([]);
    expect(policy).toMatchObject({ available: false, eligibilityOverrideAvailable: false });
    expect(policy.message).toContain("測定済み基準値を利用できません");
    expect(policy.message).toContain("適格性の例外設定で測定値を代替できない");
  });

  it("keeps the group create and formal override path available for other methods", () => {
    expect(groupCreateMethodPolicy("SPRINT_ENDURANCE_SHORT")).toMatchObject({ available: true, eligibilityOverrideAvailable: true, message: null });
  });
});
