import { presentRunningSessionSnapshot } from "@/application/running-session/snapshot";
import { parseUnprescribedRunning, UNPRESCRIBED_RUNNING_KIND } from "@/domain/menu-composition/unprescribed-running";

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

/** Keep the saved pending status visible without sending raw storage to the client. */
export function presentSavedUnprescribedSnapshot(item: SessionSnapshotSource) {
  if (item.prescriptionKind !== UNPRESCRIBED_RUNNING_KIND) return undefined;
  const metadata = parseUnprescribedRunning(item.prescriptionKind, item.plannedPrescriptionJson ?? null);
  return { reasonMessage: metadata?.reasonMessage ?? "走の項目は未処方です。" };
}
