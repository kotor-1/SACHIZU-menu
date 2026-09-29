import { describe, expect, it } from "vitest";
import { planRunningPrescription } from "@/domain/running-policy";
import {
  parseRunningMenuEnvelope,
  presentRunningMenuSnapshot,
  serializeRunningMenuEnvelope,
} from "@/application/running-menu/persistence";

function ready(distance = 60) {
  const result = planRunningPrescription({ event: "100m", ageGroup: "HIGH_SCHOOL", humanExplicitDistances: [distance] });
  if (result.status !== "READY") throw new Error(result.status);
  return result.prescription;
}

describe("Running MenuItem persistence envelope", () => {
  it("serializes and reloads a versioned READY snapshot without Method or Template", () => {
    const prescription = ready();
    const json = serializeRunningMenuEnvelope(prescription);
    expect(parseRunningMenuEnvelope("RUNNING_POLICY", json)).toMatchObject({
      kind: "RUNNING_POLICY", schemaVersion: 1,
      policyVersion: "rp-2026.09.0", policyHash: prescription.policyHash,
      prescription: { distanceMeters: 60, totalReps: 4, repRestSeconds: 240, setReps: null },
    });
    expect(json).not.toMatch(/runningMethod|sessionTemplateId|templateId/u);
    expect(presentRunningMenuSnapshot("RUNNING_POLICY", json)).toMatchObject({ status: "OK", title: "60m × 4本", restText: "1本ごとの休憩 4分" });
  });

  it("does not interpret legacy payload as a new Running prescription", () => {
    expect(parseRunningMenuEnvelope("RUNNING_V2", '{"kind":"RUNNING_POLICY"}')).toBeNull();
    expect(presentRunningMenuSnapshot("LEGACY", "{}")).toEqual({ status: "NOT_RUNNING_POLICY" });
  });

  it("does not show an inter-rep rest for one run", () => {
    const json = serializeRunningMenuEnvelope(ready(250));
    expect(presentRunningMenuSnapshot("RUNNING_POLICY", json)).toMatchObject({ status: "OK", title: "250m × 1本", restText: null });
  });

  it("rejects invalid set totals and mismatched policy metadata", () => {
    const json = JSON.parse(serializeRunningMenuEnvelope(ready())) as Record<string, unknown>;
    const prescription = json.prescription as Record<string, unknown>;
    prescription.sets = 2;
    prescription.setReps = [3, 2];
    prescription.setRestSeconds = 600;
    expect(parseRunningMenuEnvelope("RUNNING_POLICY", JSON.stringify(json))).toBeNull();
    prescription.sets = 1;
    prescription.setReps = null;
    prescription.setRestSeconds = null;
    json.policyVersion = "different";
    expect(parseRunningMenuEnvelope("RUNNING_POLICY", JSON.stringify(json))).toBeNull();
  });
});
