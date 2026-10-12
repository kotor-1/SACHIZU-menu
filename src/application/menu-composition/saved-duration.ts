import type { MenuDetail } from "@/infra/repositories/menu-repository";
import { parseConfirmedCompositionContext } from "@/domain/menu-composition/saved-context";
import { calculateMenuDuration, type RunningDurationInput } from "@/domain/menu-composition/duration";
import type { EditableComposition } from "@/domain/menu-composition/contracts";
import { finalRunningMenuPrescription, parseRunningMenuEnvelope } from "@/application/running-menu/persistence";
import { parseUnprescribedRunning, UNPRESCRIBED_RUNNING_KIND } from "@/domain/menu-composition/unprescribed-running";

/** Read the current Menu rows, never a cached estimate or Exercise default. */
export function savedMenuDurationInput(menu: MenuDetail) {
  const context = parseConfirmedCompositionContext(menu.runningContextJson);
  if (!context) return null;
  const byItemId: Record<string, Exclude<RunningDurationInput, { byItemId: unknown }>> = {};
  const composition: EditableComposition = { blocks: menu.blocks.map(block => ({
    id: block.id, name: block.name,
    items: block.items.map(item => {
      if (item.prescriptionKind === UNPRESCRIBED_RUNNING_KIND) {
        const reason = parseUnprescribedRunning(item.prescriptionKind, item.prescriptionJson);
        return { id: item.id, type: "UNPRESCRIBED_RUNNING" as const,
          reasonCode: reason?.reasonCode ?? "UNPRESCRIBED", reasonMessage: reason?.reasonMessage ?? "走の処方は未確認です。",
          plannedNote: item.note ?? "", plannedSets: item.sets, plannedReps: item.reps,
          plannedDistanceMeters: item.distanceMeters, plannedDurationSeconds: item.durationSeconds,
          plannedRestSeconds: item.restSeconds, plannedIntensityPercent: item.intensityPercent };
      }
      if (item.prescriptionKind === "RUNNING_POLICY") {
        const envelope = parseRunningMenuEnvelope(item.prescriptionKind, item.prescriptionJson);
        byItemId[item.id] = envelope ? finalRunningMenuPrescription(envelope) : null;
        return { id: item.id, type: "RUNNING_POLICY" as const, plannedNote: item.note ?? "" };
      }
      return { id: item.id, ...(item.exerciseId
        ? { type: "CATALOG_EXERCISE" as const, exerciseId: item.exerciseId }
        : { type: "FREEFORM" as const, category: "OTHER" as const, originalUserInstruction: "" }), displayName: item.displayName ?? item.exercise?.name ?? "項目",
        // The persisted note already contains the original request, instruction and note.
        // Hash that same text once so edit invalidation survives a save/reload.
        executionInstruction: item.note ?? "", plannedNote: "", reason: "", plannedSets: item.sets, plannedReps: item.reps,
        plannedDistanceMeters: item.distanceMeters, plannedDurationSeconds: item.durationSeconds, plannedRestSeconds: item.restSeconds };
    }),
  })) };
  return { composition, running: { byItemId }, requestedSeconds: context.requestedTimeSeconds ?? null,
    plan: context.durationPlan ?? { blocks: [], transitionSeconds: null } };
}
export function savedMenuDuration(menu: MenuDetail) {
  const input = savedMenuDurationInput(menu);
  return input ? calculateMenuDuration(input.composition, input.running, input.requestedSeconds, input.plan) : null;
}
