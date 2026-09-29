import { presentRunningSessionSnapshot } from "@/application/running-session/snapshot";

export type SessionSnapshotSource = {
  prescriptionKind?: string;
  plannedPrescriptionJson?: string | null;
};

/** Converts raw Session storage to a small, JSON-safe display value on the server. */
export function presentSavedRunningSnapshot(item: SessionSnapshotSource) {
  return item.prescriptionKind === "RUNNING_POLICY"
    ? presentRunningSessionSnapshot(item.prescriptionKind, item.plannedPrescriptionJson ?? null)
    : undefined;
}
