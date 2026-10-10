import { describe, expect, it } from "vitest";
import { planRunningPrescription } from "@/domain/running-policy";
import { historicalIntensityFromGroundedText, historicalPurposeFromGroundedText, RUNNING_PURPOSES } from "@/domain/running-policy/purpose";

describe("purpose context and historical coach gates", () => {
  it.each([
    ["ACCEL", "SCIENCE_CONTEXT_REQUIRED"],
    ["MAX_SPEED", "SCIENCE_CONTEXT_REQUIRED"],
    ["SPEED_ENDURANCE", "SCIENCE_CONTEXT_REQUIRED"],
    ["BASIC", "SCIENCE_CONTEXT_REQUIRED"],
    ["PRECOMP", "SCIENCE_CONTEXT_REQUIRED"],
    ["RECOVERY", "SCIENCE_CONTEXT_REQUIRED"],
  ] as const)("requires explicit scientific context for %s before prescribing", (purpose, reason) => {
    expect(planRunningPrescription({ purpose, ageGroup: "HIGH_SCHOOL" })).toMatchObject({ status: "NEEDS_INPUT", reason });
  });

  it("recognizes elementary safety gate without requiring an event", () => {
    expect(planRunningPrescription({ ageGroup: "ELEMENTARY" })).toMatchObject({ status: "NEEDS_POLICY", reason: "ELEMENTARY_POLICY_NOT_APPROVED" });
  });

  it("does not alias low intensity to load reduction", () => {
    expect(planRunningPrescription({ ageGroup: "HIGH_SCHOOL", intensityPreference: "LOW" })).toMatchObject({ status: "NEEDS_INPUT", reason: "SCIENCE_CONTEXT_REQUIRED" });
    expect(planRunningPrescription({ ageGroup: "HIGH_SCHOOL", event: "100m", loadReductionRequested: true })).toMatchObject({ status: "READY" });
  });

  it("maps only explicit grounded purposes and rejects a negated goal", () => {
    expect(RUNNING_PURPOSES).toHaveLength(6);
    expect(historicalPurposeFromGroundedText("加速力向上を目的にしたい" )).toBe("ACCEL");
    expect(historicalPurposeFromGroundedText("最高速度向上を目指したい" )).toBe("MAX_SPEED");
    expect(historicalPurposeFromGroundedText("スピード持久力向上を目的に" )).toBe("SPEED_ENDURANCE");
    expect(historicalPurposeFromGroundedText("基礎的な走能力向上を目的に" )).toBe("BASIC");
    expect(historicalPurposeFromGroundedText("大会前日なので疲労を残さない調整をしたい" )).toBe("PRECOMP");
    expect(historicalPurposeFromGroundedText("回復を目的にしたい" )).toBe("RECOVERY");
    expect(historicalPurposeFromGroundedText("加速力向上ではなく基礎的な練習がしたい" )).toBeNull();
    expect(historicalIntensityFromGroundedText("低強度の練習を希望" )).toBe("LOW");
    expect(historicalIntensityFromGroundedText("低強度ではなく" )).toBeNull();
  });
});
