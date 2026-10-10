import { describe, expect, it } from "vitest";
import { planRunningPrescription } from "@/domain/running-policy";
import { historicalIntensityFromGroundedText, historicalPurposeFromGroundedText, RUNNING_PURPOSES } from "@/domain/running-policy/purpose";

describe("unsupported purpose gates", () => {
  it.each([
    ["ACCEL", "ACCEL_PURPOSE_NOT_APPROVED"],
    ["MAX_SPEED", "MAX_SPEED_PURPOSE_NOT_APPROVED"],
    ["SPEED_ENDURANCE", "SPEED_ENDURANCE_PURPOSE_NOT_APPROVED"],
    ["BASIC", "BASIC_PURPOSE_NOT_APPROVED"],
    ["PRECOMP", "PRECOMP_PURPOSE_NOT_APPROVED"],
    ["RECOVERY", "RECOVERY_PURPOSE_NOT_APPROVED"],
  ] as const)("blocks %s specifically even before event input", (purpose, reason) => {
    expect(planRunningPrescription({ purpose, ageGroup: "HIGH_SCHOOL" })).toMatchObject({ status: "NEEDS_POLICY", reason });
  });

  it("recognizes elementary safety gate without requiring an event", () => {
    expect(planRunningPrescription({ ageGroup: "ELEMENTARY" })).toMatchObject({ status: "NEEDS_POLICY", reason: "ELEMENTARY_POLICY_NOT_APPROVED" });
  });

  it("does not alias low intensity to load reduction", () => {
    expect(planRunningPrescription({ ageGroup: "HIGH_SCHOOL", intensityPreference: "LOW" })).toMatchObject({ status: "NEEDS_POLICY", reason: "LOW_INTENSITY_NOT_APPROVED" });
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
