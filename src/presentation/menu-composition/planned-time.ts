import { estimateSeconds, type Prescription } from "@/domain/shared/prescription";
import { finalRunningMenuPrescription, parseRunningMenuEnvelope, type RunningMenuFinalPrescription } from "@/application/running-menu/persistence";

/** Known rest is a lower bound; no invented running speed or target time. */
export function runningMinimumPlannedSeconds(p: Pick<RunningMenuFinalPrescription, "totalReps" | "repRestSeconds" | "setReps" | "setRestSeconds" | "coachTargetTimeSeconds" | "coachTargetTimeRange">): number {
  const rest = p.setReps === null
    ? Math.max(0, p.totalReps - 1) * (p.repRestSeconds ?? 0)
    : p.setReps.reduce((sum, reps) => sum + Math.max(0, reps - 1) * (p.repRestSeconds ?? 0), 0) + Math.max(0, p.setReps.length - 1) * (p.setRestSeconds ?? 0);
  return rest + p.totalReps * (p.coachTargetTimeSeconds ?? p.coachTargetTimeRange?.minSeconds ?? 0);
}
export function menuItemEstimatedSeconds(item: Prescription & { prescriptionKind?: string; prescriptionJson?: string | null }): number {
  if (item.prescriptionKind === "RUNNING_UNPRESCRIBED") {
    // Explicit human work/rest only; missing speed or duration stays unknown.
    const work = (item.durationSeconds ?? 0) * (item.reps ?? 1) * (item.sets ?? 1);
    const rest = Math.max(0, (item.reps ?? 1) - 1) * (item.sets ?? 1) * (item.restSeconds ?? 0);
    return work + rest;
  }
  if (item.prescriptionKind === "RUNNING_POLICY") {
    const envelope = parseRunningMenuEnvelope(item.prescriptionKind, item.prescriptionJson ?? null);
    return envelope ? runningMinimumPlannedSeconds(finalRunningMenuPrescription(envelope)) : 0;
  }
  // An instruction with no quantity has unknown duration, not a fictional 45 seconds.
  if (item.reps == null && item.distanceMeters == null && item.durationSeconds == null) return 0;
  return estimateSeconds(item);
}
