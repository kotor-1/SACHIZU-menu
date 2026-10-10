import { describe, expect, it } from "vitest";
import { menuItemEstimatedSeconds } from "@/presentation/menu-composition/planned-time";

describe("unprescribed running time never uses generic work estimates", () => {
  it("does not invent work seconds from a distance or repetition count", () => {
    expect(menuItemEstimatedSeconds({ prescriptionKind: "RUNNING_UNPRESCRIBED", sets: 2, reps: 4, distanceMeters: 50 })).toBe(0);
  });
  it("counts only explicit between-repetition rest when work is unknown", () => {
    expect(menuItemEstimatedSeconds({ prescriptionKind: "RUNNING_UNPRESCRIBED", sets: 2, reps: 4, distanceMeters: 50, restSeconds: 60 })).toBe(360);
  });
  it("counts manually specified per-repetition work without inventing set rest", () => {
    expect(menuItemEstimatedSeconds({ prescriptionKind: "RUNNING_UNPRESCRIBED", sets: 2, reps: 2, durationSeconds: 5, restSeconds: 60 })).toBe(140);
  });
});
