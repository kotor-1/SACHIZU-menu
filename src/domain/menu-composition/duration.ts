import { z } from "zod";
import type { RunningMenuFinalPrescription } from "@/application/running-menu/persistence";
import type { EditableComposition, EditableItem } from "@/domain/menu-composition/contracts";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { itemTimingEvidenceSchema } from "./session-planning";

const MAX_ALLOCATED_SECONDS = 7 * 24 * 60 * 60;
export const DURATION_PHASES = ["WARM_UP", "DRILLS_STRENGTH", "RUNNING", "COOL_DOWN", "OTHER"] as const;
export const allocationEstimateSchema = z.object({
  itemEstimatesSeconds: z.array(z.number().int().min(0).max(MAX_ALLOCATED_SECONDS)).max(30),
  preparationSeconds: z.number().int().min(0).max(MAX_ALLOCATED_SECONDS),
  explanation: z.string().trim().min(1).max(400),
  preparationDescription: z.string().trim().max(240),
  itemBreakdowns: z.array(itemTimingEvidenceSchema).max(30).optional(),
}).strict();
export const allocationBasisSchema = allocationEstimateSchema.extend({
  durationBasisKey: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const durationPlanSchema = z.object({
  blocks: z.array(z.object({
    blockId: z.string().min(1).max(80),
    phase: z.enum(DURATION_PHASES),
    allocatedSeconds: z.number().int().min(0).max(MAX_ALLOCATED_SECONDS).nullable(),
    allocationBasis: allocationBasisSchema.optional(),
  }).strict()).max(12),
  transitionSeconds: z.number().int().min(0).max(MAX_ALLOCATED_SECONDS).nullable(),
  transitionDescription: z.string().trim().max(400).optional(),
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

export type DurationPlanIssue = {
  blockId: string;
  code: "MISSING_BASIS" | "STALE_BASIS" | "DOSE_MISSING" | "WORK_ESTIMATE_MISSING" | "BELOW_MINIMUM" | "BREAKDOWN_MISMATCH" | "TRANSITION_UNSPECIFIED" | "TARGET_MISMATCH";
  message: string;
};

export type MenuDurationSummary = {
  requestedSeconds: number | null;
  knownMinimumSeconds: number;
  plannedTotalSeconds: number | null;
  remainingSeconds: number | null;
  physicalDurationExact: false;
  budgetDifferenceSeconds: number | null;
  status: "OVER_BUDGET" | "UNDERALLOCATED" | "UNVERIFIED" | "MATCHES_REQUEST" | "NO_TARGET";
  planningStatus: "ACCOUNTED_FOR" | "NEEDS_REVIEW";
  planIssues: DurationPlanIssue[];
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

/** Bind estimates to dose and execution text. Database-generated IDs are excluded. */
export function durationBasisKey(block: EditableComposition["blocks"][number], runningPrescription: RunningDurationInput): string {
  const basis = block.items.map((item) => {
    if (item.type === "RUNNING_POLICY") {
      const prescription = runningPrescription !== null && "byItemId" in runningPrescription
        ? runningPrescription.byItemId[item.id] ?? null
        : runningPrescription;
      return { type: item.type, plannedNote: item.plannedNote, prescription: prescription ? {
        policyVersion: prescription.policyVersion, policyHash: prescription.policyHash, event: prescription.event,
        distanceMeters: prescription.distanceMeters, totalReps: prescription.totalReps,
        sets: prescription.sets, setReps: prescription.setReps, repRestSeconds: prescription.repRestSeconds,
        setRestSeconds: prescription.setRestSeconds, coachTargetTimeSeconds: prescription.coachTargetTimeSeconds ?? null,
        coachTargetTimeRange: prescription.coachTargetTimeRange ?? null,
        intensityPercent: prescription.science?.intensityPercent ?? null,
      } : null };
    }
    const executionText = item.type === "UNPRESCRIBED_RUNNING" ? item.plannedNote : [
      item.type === "FREEFORM" && item.originalUserInstruction ? `元の希望：${item.originalUserInstruction}` : "",
      item.executionInstruction, item.plannedNote,
    ].filter(Boolean).join("\n");
    return { type: item.type, executionText,
      ...(item.type !== "UNPRESCRIBED_RUNNING" ? { displayName: item.displayName } : {}),
      ...(item.type === "CATALOG_EXERCISE" ? { exerciseId: item.exerciseId } : {}),
      plannedSets: item.plannedSets, plannedReps: item.plannedReps, plannedDurationSeconds: item.plannedDurationSeconds,
      plannedDistanceMeters: item.plannedDistanceMeters, plannedRestSeconds: item.plannedRestSeconds,
      ...(item.type === "UNPRESCRIBED_RUNNING" ? { plannedIntensityPercent: item.plannedIntensityPercent } : {}) };
  });
  return sha256Utf8Hex(canonicalStringify(basis));
}

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
  const unknown: ItemMinimum["unknown"] = [];
  const needsRepRest = p.setReps === null ? p.totalReps > 1 : p.setReps.some(reps => reps > 1);
  if ((needsRepRest && p.repRestSeconds === null) || ((p.setReps?.length ?? 1) > 1 && p.setRestSeconds === null)) unknown.push("REST");
  const rest = p.setReps === null
    ? Math.max(0, p.totalReps - 1) * (p.repRestSeconds ?? 0)
    : p.setReps.reduce((sum, reps) => sum + Math.max(0, reps - 1) * (p.repRestSeconds ?? 0), 0)
      + Math.max(0, p.setReps.length - 1) * (p.setRestSeconds ?? 0);
  const target = p.coachTargetTimeSeconds ?? p.coachTargetTimeRange?.minSeconds ?? null;
  if (target === null) unknown.push("WORK");
  else if (p.coachTargetTimeRange) unknown.push("RUNNING_TARGET_RANGE");
  return { seconds: rest + p.totalReps * (target ?? 0), exact: unknown.length === 0, unknown };
}

function hasConfiguredDose(item: Exclude<EditableItem, { type: "RUNNING_POLICY" }>): boolean {
  const hasPrimaryDose = item.plannedDurationSeconds !== null || item.plannedReps !== null || item.plannedDistanceMeters !== null;
  return hasPrimaryDose && item.plannedSets !== null && !(item.plannedSets > 1 && item.plannedRestSeconds === null);
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
  const planIssues: DurationPlanIssue[] = [];
  const blocks = composition.blocks.map((block) => {
    const allocation = planById.get(block.id);
    let minimum = 0;
    let exact = true;
    const itemMinimums: ItemMinimum[] = [];
    for (const item of block.items) {
      let itemMinimum: ItemMinimum;
      if (item.type === "RUNNING_POLICY") {
        const itemRunning = runningPrescription !== null && "byItemId" in runningPrescription
          ? runningPrescription.byItemId[item.id] ?? null
          : runningPrescription;
        itemMinimum = runningMinimum(itemRunning);
        if (itemRunning === null || itemMinimum.unknown.includes("REST")) {
          planIssues.push({ blockId: block.id, code: "DOSE_MISSING", message: "走の処方または必要な休息時間を確認できません。" });
        }
      } else if (item.type === "UNPRESCRIBED_RUNNING") {
        itemMinimum = unprescribedMinimum(item);
      } else {
        itemMinimum = exerciseMinimum(item);
      }
      minimum += itemMinimum.seconds;
      itemMinimums.push(itemMinimum);
      exact = exact && itemMinimum.exact;
      for (const component of itemMinimum.unknown) {
        unknownComponents.push({
          blockId: block.id,
          ...(item.type === "RUNNING_POLICY" ? {} : { itemId: item.id }),
          component,
          reason: component === "WORK" ? "処方の数値だけでは運動時間が確定しません。計画上の見積もりと実測は別です。"
            : component === "REST" ? "セット構成または休息時間が未指定です。"
              : "走の目標タイムに幅があります。",
        });
      }
    }
    if (!allocation || allocation.allocatedSeconds === null) {
      unknownComponents.push({ blockId: block.id, component: "ALLOCATION", reason: "このブロックの時間配分が未入力です。" });
    }
    const basis = allocation?.allocationBasis;
    if (block.items.length === 0) {
      planIssues.push({ blockId: block.id, code: "DOSE_MISSING", message: "時間配分の対象となる項目がありません。" });
    }
    if (!basis) {
      planIssues.push({ blockId: block.id, code: "MISSING_BASIS", message: "ブロックの時間配分根拠がありません。" });
    } else {
      if (basis.durationBasisKey !== durationBasisKey(block, runningPrescription)) {
        planIssues.push({ blockId: block.id, code: "STALE_BASIS", message: "種目・実施量・実施指示が変わったため、以前の時間見積もりは無効です。" });
      }
      if (basis.itemEstimatesSeconds.length !== block.items.length || allocation?.allocatedSeconds === null || allocation?.allocatedSeconds === undefined
        || basis.itemEstimatesSeconds.reduce((sum, value) => sum + value, 0) + basis.preparationSeconds !== allocation.allocatedSeconds) {
        planIssues.push({ blockId: block.id, code: "BREAKDOWN_MISMATCH", message: "項目別時間と準備時間の合計がブロック配分と一致しません。" });
      }
      block.items.forEach((item, index) => {
        const estimate = basis.itemEstimatesSeconds[index];
        if (item.type !== "RUNNING_POLICY" && !hasConfiguredDose(item)) {
          planIssues.push({ blockId: block.id, code: "DOSE_MISSING", message: "種目の量・セット数・必要なセット間休息が未設定です。" });
        }
        if (estimate !== undefined && estimate < (itemMinimums[index]?.seconds ?? 0)) {
          planIssues.push({ blockId: block.id, code: "BELOW_MINIMUM", message: "項目の見積時間が計算できる最低時間を下回っています。" });
        }
        if (estimate !== undefined && itemMinimums[index]?.unknown.includes("WORK") && estimate <= itemMinimums[index]!.seconds) {
          planIssues.push({ blockId: block.id, code: "WORK_ESTIMATE_MISSING", message: "実施時間の見積もりがなく、既知の休息だけが計上されています。" });
        }
        if (itemMinimums[index]?.unknown.includes("REST")) {
          planIssues.push({ blockId: block.id, code: "DOSE_MISSING", message: "必要な休息時間が未設定です。" });
        }
        if (estimate !== undefined && itemMinimums[index]?.exact && estimate > itemMinimums[index]!.seconds) {
          planIssues.push({ blockId: block.id, code: "BREAKDOWN_MISMATCH", message: "計算できる項目時間を超える分は、項目見積ではなく準備時間へ分けてください。" });
        }
      });
      if (basis.preparationSeconds > 0 && !basis.preparationDescription.trim()) {
        planIssues.push({ blockId: block.id, code: "MISSING_BASIS", message: "準備時間の内容が未記入です。" });
      }
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
    planIssues.push({ blockId: "", code: "TRANSITION_UNSPECIFIED", message: "ブロック間の移動・準備時間が未設定です。" });
  } else if (validPlan.transitionSeconds > 0 && !validPlan.transitionDescription?.trim()) {
    unknownComponents.push({ blockId: "", component: "TRANSITION", reason: "入力された移動・準備時間の内容が未記入です。" });
    planIssues.push({ blockId: "", code: "TRANSITION_UNSPECIFIED", message: "ブロック間の移動・準備時間の内容が未記入です。" });
  }

  const phaseTotals = Object.fromEntries(DURATION_PHASES.map((phase) => [phase, { allocatedSeconds: 0, blockCount: 0 }])) as MenuDurationSummary["phases"];
  for (const row of blocks) {
    if (row.phase) {
      phaseTotals[row.phase].blockCount += 1;
      phaseTotals[row.phase].allocatedSeconds += row.allocatedSeconds ?? 0;
    }
  }
  const blockMinimumSeconds = blocks.reduce((sum, row) => sum + row.knownMinimumSeconds, 0);
  const knownMinimumSeconds = blockMinimumSeconds;
  const allBlocksCountable = blocks.every((row) => row.allocatedSeconds !== null) && orphanPlanBlockIds.length === 0;
  const plannedTotalSeconds = validPlan && allBlocksCountable && validPlan.transitionSeconds !== null
    ? blocks.reduce((sum, row) => sum + (row.allocatedSeconds ?? row.knownMinimumSeconds), 0) + validPlan.transitionSeconds
    : null;
  const underallocated = blocks.some((row) => row.underallocated);
  const budgetDifferenceSeconds = requestedSeconds === null || plannedTotalSeconds === null ? null : plannedTotalSeconds - requestedSeconds;
  const remainingSeconds = budgetDifferenceSeconds === null ? null : Math.max(0, -budgetDifferenceSeconds);
  for (const blockId of orphanPlanBlockIds) planIssues.push({ blockId, code: "MISSING_BASIS", message: "配分対象のブロックが現在のメニューにありません。" });
  if (requestedSeconds !== null && plannedTotalSeconds !== null && plannedTotalSeconds !== requestedSeconds) {
    planIssues.push({ blockId: "", code: "TARGET_MISMATCH", message: "計画配分の合計が希望時間と一致していません。" });
  }
  const planningStatus: MenuDurationSummary["planningStatus"] = planIssues.length === 0
    && blocks.every((row) => row.allocatedSeconds !== null)
    && validPlan?.transitionSeconds !== null && validPlan?.transitionSeconds !== undefined
      ? "ACCOUNTED_FOR" : "NEEDS_REVIEW";
  let status: MenuDurationSummary["status"];
  const knownWorkRestPlusTransition = knownMinimumSeconds + (validPlan?.transitionSeconds ?? 0);
  if (requestedSeconds !== null && (knownWorkRestPlusTransition > requestedSeconds || (plannedTotalSeconds !== null && plannedTotalSeconds > requestedSeconds))) status = "OVER_BUDGET";
  else if (underallocated || (requestedSeconds !== null && plannedTotalSeconds !== null && plannedTotalSeconds < requestedSeconds)) status = "UNDERALLOCATED";
  else if (requestedSeconds === null) status = "NO_TARGET";
  else if (plannedTotalSeconds === requestedSeconds && !unknownComponents.some((row) => row.component === "ALLOCATION" || row.component === "TRANSITION")) status = "MATCHES_REQUEST";
  else status = "UNVERIFIED";

  return { requestedSeconds, knownMinimumSeconds, plannedTotalSeconds, remainingSeconds, physicalDurationExact: false,
    budgetDifferenceSeconds, status, planningStatus, planIssues, blocks, phases: phaseTotals, unknownComponents, orphanPlanBlockIds };
}
