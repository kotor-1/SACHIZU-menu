import { z } from "zod";
import type { RunningMenuFinalPrescription } from "@/application/running-menu/persistence";
import type { EditableComposition, EditableItem } from "@/domain/menu-composition/contracts";

const MAX_ALLOCATED_SECONDS = 7 * 24 * 60 * 60;
export const DURATION_PHASES = ["WARM_UP", "DRILLS_STRENGTH", "RUNNING", "COOL_DOWN", "OTHER"] as const;
export const durationPlanSchema = z.object({
  blocks: z.array(z.object({
    blockId: z.string().min(1).max(80),
    phase: z.enum(DURATION_PHASES),
    allocatedSeconds: z.number().int().min(0).max(MAX_ALLOCATED_SECONDS).nullable(),
  }).strict()).max(12),
  transitionSeconds: z.number().int().min(0).max(MAX_ALLOCATED_SECONDS).nullable(),
}).strict().superRefine((plan, ctx) => {
  const ids = plan.blocks.map((block) => block.blockId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["blocks"], message: "duplicate block allocation" });
});
export type DurationPlan = z.infer<typeof durationPlanSchema>;
export type MenuDurationPlan = DurationPlan;

export type DurationUnknown = {
  blockId: string;
  itemId?: string;
  component: "WORK" | "REST" | "TRANSITION" | "ALLOCATION" | "RUNNING_TARGET_RANGE";
  reason: string;
};

export type MenuDurationSummary = {
  requestedSeconds: number | null;
  knownMinimumSeconds: number;
  plannedTotalSeconds: number | null;
  remainingSeconds: number | null;
  physicalDurationExact: false;
  budgetDifferenceSeconds: number | null;
  status: "OVER_BUDGET" | "UNDERALLOCATED" | "UNVERIFIED" | "MATCHES_REQUEST" | "NO_TARGET";
  blocks: Array<{
    blockId: string;
    phase: typeof DURATION_PHASES[number] | null;
    knownMinimumSeconds: number;
    allocatedSeconds: number | null;
    allocationDifferenceSeconds: number | null;
    underallocated: boolean;
    physicalDurationExact: boolean;
  }>;
  phases: Record<typeof DURATION_PHASES[number], { allocatedSeconds: number; blockCount: number }>;
  unknownComponents: DurationUnknown[];
  orphanPlanBlockIds: string[];
};

type ItemMinimum = { seconds: number; exact: boolean; unknown: DurationUnknown["component"][] };
export type RunningDurationInput = RunningMenuFinalPrescription | null | {
  byItemId: Readonly<Record<string, RunningMenuFinalPrescription | null>>;
};

function exerciseMinimum(item: Exclude<EditableItem, { type: "RUNNING_POLICY" | "UNPRESCRIBED_RUNNING" }>): ItemMinimum {
  const unknown: ItemMinimum["unknown"] = [];
  const sets = item.plannedSets;
  let seconds = 0;

  if (item.plannedDurationSeconds !== null) {
    seconds += item.plannedDurationSeconds * (sets ?? 1);
    if (sets === null) unknown.push("WORK");
  } else if (item.plannedReps !== null || item.plannedDistanceMeters !== null) {
    unknown.push("WORK");
  } else {
    unknown.push("WORK");
  }

  if (sets !== null && sets > 1) {
    if (item.plannedRestSeconds === null) unknown.push("REST");
    else seconds += (sets - 1) * item.plannedRestSeconds;
  } else if (sets === null && item.plannedRestSeconds !== null && item.plannedRestSeconds > 0) {
    unknown.push("REST");
  }

  return { seconds, exact: unknown.length === 0, unknown };
}

function unprescribedMinimum(item: Extract<EditableItem, { type: "UNPRESCRIBED_RUNNING" }>): ItemMinimum {
  // Manual input is a plan, not an approved Engine dose. Unspecified repetitions,
  // sets or set-boundary rests never acquire a default through time accounting.
  const unknown: ItemMinimum["unknown"] = [];
  const reps = item.plannedReps;
  const sets = item.plannedSets;
  const duration = item.plannedDurationSeconds;
  let seconds = duration === null ? 0 : duration * (reps ?? 1) * (sets ?? 1);
  if (duration === null || reps === null || sets === null) unknown.push("WORK");
  if (reps !== null && reps > 1 && item.plannedRestSeconds !== null) seconds += (reps - 1) * (sets ?? 1) * item.plannedRestSeconds;
  if (reps === null || sets === null || (reps > 1 && item.plannedRestSeconds === null) || (sets !== null && sets > 1)) unknown.push("REST");
  return { seconds, exact: unknown.length === 0, unknown };
}

function runningMinimum(p: RunningMenuFinalPrescription | null): ItemMinimum {
  if (!p) return { seconds: 0, exact: false, unknown: ["WORK", "REST"] };
  const rest = p.setReps === null
    ? Math.max(0, p.totalReps - 1) * (p.repRestSeconds ?? 0)
    : p.setReps.reduce((sum, reps) => sum + Math.max(0, reps - 1) * (p.repRestSeconds ?? 0), 0)
      + Math.max(0, p.setReps.length - 1) * (p.setRestSeconds ?? 0);
  const target = p.coachTargetTimeSeconds ?? p.coachTargetTimeRange?.minSeconds ?? null;
  if (target === null) return { seconds: rest, exact: false, unknown: ["WORK"] };
  if (p.coachTargetTimeRange) return { seconds: rest + p.totalReps * target, exact: false, unknown: ["RUNNING_TARGET_RANGE"] };
  return { seconds: rest + p.totalReps * target, exact: true, unknown: [] };
}

/** Calculates only explicitly specified work/rest lower bounds. It never modifies a dose. */
export function calculateMenuDuration(
  composition: EditableComposition,
  runningPrescription: RunningDurationInput,
  requestedSeconds: number | null,
  plan?: DurationPlan | null,
): MenuDurationSummary {
  const parsedPlan = plan == null ? null : durationPlanSchema.safeParse(plan);
  const validPlan = parsedPlan?.success ? parsedPlan.data : null;
  const planById = new Map(validPlan?.blocks.map((row) => [row.blockId, row]) ?? []);
  const unknownComponents: DurationUnknown[] = [];
  const blocks = composition.blocks.map((block) => {
    const allocation = planById.get(block.id);
    let minimum = 0;
    let exact = true;
    for (const item of block.items) {
      let itemMinimum: ItemMinimum;
      if (item.type === "RUNNING_POLICY") {
        const itemRunning = runningPrescription !== null && "byItemId" in runningPrescription
          ? runningPrescription.byItemId[item.id] ?? null
          : runningPrescription;
        itemMinimum = runningMinimum(itemRunning);
      } else if (item.type === "UNPRESCRIBED_RUNNING") {
        itemMinimum = unprescribedMinimum(item);
      } else {
        itemMinimum = exerciseMinimum(item);
      }
      minimum += itemMinimum.seconds;
      exact = exact && itemMinimum.exact;
      for (const component of itemMinimum.unknown) {
        unknownComponents.push({
          blockId: block.id,
          ...(item.type === "RUNNING_POLICY" ? {} : { itemId: item.id }),
          component,
          reason: component === "WORK" ? "実施時間を数値化できる処方がありません。"
            : component === "REST" ? "セット構成または休息時間が未指定です。"
              : "走の目標タイムに幅があります。",
        });
      }
    }
    if (!allocation || allocation.allocatedSeconds === null) {
      unknownComponents.push({ blockId: block.id, component: "ALLOCATION", reason: "このブロックの時間配分が未入力です。" });
    }
    return {
      blockId: block.id,
      phase: allocation?.phase ?? null,
      knownMinimumSeconds: minimum,
      allocatedSeconds: allocation?.allocatedSeconds ?? null,
      allocationDifferenceSeconds: allocation?.allocatedSeconds == null ? null : allocation.allocatedSeconds - minimum,
      underallocated: allocation?.allocatedSeconds != null && allocation.allocatedSeconds < minimum,
      physicalDurationExact: exact,
    };
  });

  const currentIds = new Set(composition.blocks.map((block) => block.id));
  const orphanPlanBlockIds = (validPlan?.blocks ?? []).map((row) => row.blockId).filter((id) => !currentIds.has(id));
  for (const blockId of orphanPlanBlockIds) unknownComponents.push({ blockId, component: "ALLOCATION", reason: "配分対象のブロックは現在のメニューにありません。" });

  if (validPlan?.transitionSeconds == null) {
    unknownComponents.push({ blockId: "", component: "TRANSITION", reason: "ブロック間の移動・準備時間が未入力です。" });
  }

  const phaseTotals = Object.fromEntries(DURATION_PHASES.map((phase) => [phase, { allocatedSeconds: 0, blockCount: 0 }])) as MenuDurationSummary["phases"];
  for (const row of blocks) {
    if (row.phase) {
      phaseTotals[row.phase].blockCount += 1;
      phaseTotals[row.phase].allocatedSeconds += row.allocatedSeconds ?? 0;
    }
  }
  const blockMinimumSeconds = blocks.reduce((sum, row) => sum + row.knownMinimumSeconds, 0);
  const knownMinimumSeconds = blockMinimumSeconds + (validPlan?.transitionSeconds ?? 0);
  const allBlocksCountable = blocks.every((row) => row.allocatedSeconds !== null || row.physicalDurationExact) && orphanPlanBlockIds.length === 0;
  const plannedTotalSeconds = validPlan && allBlocksCountable && validPlan.transitionSeconds !== null
    ? blocks.reduce((sum, row) => sum + (row.allocatedSeconds ?? row.knownMinimumSeconds), 0) + validPlan.transitionSeconds
    : null;
  const underallocated = blocks.some((row) => row.underallocated);
  const budgetDifferenceSeconds = requestedSeconds === null || plannedTotalSeconds === null ? null : plannedTotalSeconds - requestedSeconds;
  const remainingSeconds = budgetDifferenceSeconds === null ? null : Math.max(0, -budgetDifferenceSeconds);
  let status: MenuDurationSummary["status"];
  if (requestedSeconds !== null && (knownMinimumSeconds > requestedSeconds || (plannedTotalSeconds !== null && plannedTotalSeconds > requestedSeconds))) status = "OVER_BUDGET";
  else if (underallocated || (requestedSeconds !== null && plannedTotalSeconds !== null && plannedTotalSeconds < requestedSeconds)) status = "UNDERALLOCATED";
  else if (requestedSeconds === null) status = "NO_TARGET";
  else if (plannedTotalSeconds === requestedSeconds && !unknownComponents.some((row) => row.component === "ALLOCATION" || row.component === "TRANSITION")) status = "MATCHES_REQUEST";
  else status = "UNVERIFIED";

  return { requestedSeconds, knownMinimumSeconds, plannedTotalSeconds, remainingSeconds, physicalDurationExact: false,
    budgetDifferenceSeconds, status, blocks, phases: phaseTotals, unknownComponents, orphanPlanBlockIds };
}
