import type { EditableComposition, MenuComposition } from "@/domain/menu-composition/contracts";
import { calculateMenuDuration, durationBasisKey, type DurationPlan, type RunningDurationInput } from "@/domain/menu-composition/duration";

/** Scheduling estimates do not prescribe exercise volume or shorten Engine rest. */
export function proposedDurationPlan(proposal: MenuComposition, composition: EditableComposition,
  running: RunningDurationInput): DurationPlan {
  const minimum = calculateMenuDuration(composition, running, null);
  return {
    transitionSeconds: proposal.transitionSeconds ?? null,
    ...(proposal.transitionDescription !== undefined ? { transitionDescription: proposal.transitionDescription } : {}),
    blocks: composition.blocks.map((block, index) => {
      const proposed = proposal.blocks[index];
      const seconds = proposed?.allocatedSeconds ?? null;
      const lowerBound = minimum.blocks[index].knownMinimumSeconds;
      return { blockId: block.id,
        phase: block.items.some(item => item.type === "RUNNING_POLICY" || item.type === "UNPRESCRIBED_RUNNING")
          ? "RUNNING" : proposed?.phase ?? "OTHER",
        allocatedSeconds: seconds === null ? null : seconds < lowerBound ? Math.ceil(lowerBound / 60) * 60 : seconds,
        ...(proposed?.allocationBasis ? { allocationBasis: { ...proposed.allocationBasis, durationBasisKey: durationBasisKey(block, running) } } : {}),
      };
    }),
  };
}
