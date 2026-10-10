import { describe, expect, it } from "vitest";
import { presentSessionItemRow } from "@/presentation/running/session-item";
import { UNPRESCRIBED_RUNNING_KIND } from "@/domain/menu-composition/unprescribed-running";

describe("saved unprescribed Running Session row", () => {
  it("retains its status and reason from the saved kind even when its display name changes", () => {
    const row = presentSessionItemRow({
      id: "session-item-1", done: false, exercise: null, exerciseNameSnapshot: "400m repeat",
      plannedSets: 2, plannedReps: 4, plannedDistanceMeters: 400, plannedDurationSeconds: null,
      plannedRestSeconds: 300, plannedIntensityPercent: 75, plannedLoadKg: null, plannedNote: null,
      actualSets: null, actualReps: null, actualDistanceMeters: null, actualDurationSeconds: null,
      actualLoadKg: null, actualNote: null,
      prescriptionKind: UNPRESCRIBED_RUNNING_KIND,
      plannedPrescriptionJson: JSON.stringify({ kind: "UNPRESCRIBED_RUNNING", schemaVersion: 1,
        reasonCode: "MISSING_CONTEXT", reasonMessage: "年齢・種目の条件を確認してください。" }),
    });
    expect(row.exerciseNameSnapshot).toBe("400m repeat");
    expect(row.unprescribedRunning).toEqual({ reasonMessage: "年齢・種目の条件を確認してください。" });
    expect(row).not.toHaveProperty("plannedPrescriptionJson");
  });
});
