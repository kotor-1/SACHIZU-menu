import { z } from "zod";
import { EXERCISE_CATEGORIES } from "@/domain/exercise/constants";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";
import type { ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";
import { resolveWhitespaceQuote } from "@/domain/shared/source-quote";
import { unprescribedRunningItemSchema } from "./unprescribed-running";
import { runningScienceContextSchema } from "@/domain/running-policy/science-contracts";
import { DURATION_PHASES, allocationEstimateSchema } from "./duration";
import { exerciseRepetitionCountMatches } from "./dose-counting";
import { proposalPlanningSchema } from "./session-planning";

export const menuCompositionContextSchema = z.object({
  event: z.string().trim().min(1).max(32).optional(),
  ageGroup: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"]).optional(),
  availableTimeSeconds: z.number().int().positive().optional(),
  science: runningScienceContextSchema.optional(),
}).strict();
export const composeMenuInputSchema = z.object({
  requestText: z.string().trim().min(1).max(2000), context: menuCompositionContextSchema,
}).strict();
export type ComposeMenuInput = z.infer<typeof composeMenuInputSchema>;

// These are storage/input bounds, not training recommendations.
const doseFields = {
  plannedSets: z.number().int().min(1).max(99).nullable(),
  plannedReps: z.number().int().min(1).max(999).nullable(),
  plannedDurationSeconds: z.number().int().min(1).max(86400).nullable(),
  plannedDistanceMeters: z.number().finite().min(1).max(100000).nullable(),
  plannedRestSeconds: z.number().int().min(0).max(86400).nullable(),
};
const textFields = {
  displayName: z.string().trim().min(1).max(160),
  executionInstruction: z.string().trim().max(400),
  plannedNote: z.string().trim().max(200),
  reason: z.string().trim().max(160),
};
export const catalogCompositionItemSchema = z.object({
  type: z.literal("CATALOG_EXERCISE"), exerciseId: z.string().min(1).max(64), ...textFields, ...doseFields,
}).strict();
export const freeformCompositionItemSchema = z.object({
  type: z.literal("FREEFORM"), category: z.enum(EXERCISE_CATEGORIES),
  originalUserInstruction: z.string().trim().min(1).max(350), ...textFields, ...doseFields,
}).strict();
// The AI cannot express a Running prescription, even an echoed one.
export const runningCompositionItemSchema = z.object({ type: z.literal("RUNNING_POLICY") }).strict();
export const compositionItemSchema = z.discriminatedUnion("type", [
  runningCompositionItemSchema, catalogCompositionItemSchema, freeformCompositionItemSchema,
]);
export const menuOverviewSchema = z.object({
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(240),
  approach: z.string().trim().min(1).max(320),
}).strict();
export type MenuOverview = z.infer<typeof menuOverviewSchema>;
/** Generation outline, not a second prescription or a measured duration. Legacy drafts may omit it. */
export const sessionPlanSchema = z.object({
  blocks: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    phase: z.enum(DURATION_PHASES),
    purpose: z.string().trim().min(1).max(160),
    allocatedSeconds: z.number().int().min(0).max(604800).nullable(),
  }).strict()).min(1).max(12),
  timeBudgetReasoning: z.string().trim().min(1).max(400),
}).strict();
export const compositionBlockSchema = z.object({
  planBlockId: z.string().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(80),
  items: z.array(compositionItemSchema).min(1).max(30),
  phase: z.enum(DURATION_PHASES).optional(),
  allocatedSeconds: z.number().int().min(0).max(604800).nullable().optional(),
  allocationBasis: allocationEstimateSchema.nullable().optional(),
}).strict();
export const compositionSchema = z.object({
  planning: proposalPlanningSchema.optional(),
  sessionPlan: sessionPlanSchema.optional(),
  blocks: z.array(compositionBlockSchema).min(1).max(12),
  overview: menuOverviewSchema.optional(),
  transitionSeconds: z.number().int().min(0).max(604800).nullable().optional(),
  transitionDescription: z.string().trim().max(400).optional(),
}).strict();
export type MenuComposition = z.infer<typeof compositionSchema>;
export function sessionPlanMatchesComposition(value: MenuComposition): boolean {
  const outline = value.sessionPlan;
  return !outline || (outline.blocks.length === value.blocks.length
    && outline.blocks.every((block, index) => {
      const actual = value.blocks[index];
      return block.name === actual.name && block.phase === actual.phase
        && block.allocatedSeconds === actual.allocatedSeconds;
    }));
}
export type CompositionItem = z.infer<typeof compositionItemSchema>;
export type ExercisePlanItem = Exclude<CompositionItem, { type: "RUNNING_POLICY" }>;
export const editableCompositionSchema = z.object({
  blocks: z.array(z.object({
    id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80),
    items: z.array(z.union([
      runningCompositionItemSchema.extend({ id: z.string().min(1).max(80), plannedNote: z.string().max(1000) }),
      catalogCompositionItemSchema.extend({ id: z.string().min(1).max(80) }),
      freeformCompositionItemSchema.extend({ id: z.string().min(1).max(80) }),
      unprescribedRunningItemSchema,
    ])).max(30),
  }).strict()).min(1).max(12),
}).strict();
export type EditableComposition = z.infer<typeof editableCompositionSchema>;
export type EditableItem = EditableComposition["blocks"][number]["items"][number];

export type ComposerCatalogExercise = {
  id: string; ownerId: string; status: string; name: string; category: string;
  description: string | null; coachingPoint: string | null; commonMistake: string | null;
  metricType: string; difficulty: number | null; energySystem: string | null;
  defaultSets: number | null; defaultReps: number | null; defaultDurationSeconds: number | null;
  defaultDistanceMeters: number | null; defaultRestSeconds: number | null;
  purposes: string[]; events: string[]; targets: string[]; tags: string[];
  equipmentTags?: string[];
  videoUrl: string | null; videoGuidance: ExerciseVideoGuidance | null;
};
export const EMPTY_EXERCISE_DOSE = {
  plannedSets: null, plannedReps: null, plannedDurationSeconds: null,
  plannedDistanceMeters: null, plannedRestSeconds: null,
};
export function exerciseDoseState(item: ExercisePlanItem): "CONFIGURED" | "UNCONFIGURED" {
  return [item.plannedReps, item.plannedDurationSeconds, item.plannedDistanceMeters].some((v) => v !== null) ? "CONFIGURED" : "UNCONFIGURED";
}
export function exercisePlanValues(item: ExercisePlanItem) {
  return { sets: item.plannedSets, reps: item.plannedReps, durationSeconds: item.plannedDurationSeconds,
    distanceMeters: item.plannedDistanceMeters, restSeconds: item.plannedRestSeconds };
}
export function exercisePlanNote(item: ExercisePlanItem): string | null {
  // Preserve the user's own instruction separately from the AI's wording.
  const parts = [item.type === "FREEFORM" ? `元の希望：${item.originalUserInstruction}` : "", item.executionInstruction, item.plannedNote];
  return parts.filter(Boolean).join("\n") || null;
}

/** Validates both model proposals and human-edited final plans. No defaults are copied. */
export function validateComposition(value: unknown, options: {
  catalog: readonly ComposerCatalogExercise[]; ownerId: string; requestText: string;
  runningAvailable: boolean; unprescribedRunningAvailable?: boolean; runningSourceTexts?: readonly string[]; edited?: boolean;
}): { ok: true; value: MenuComposition | EditableComposition } | { ok: false; code: string } {
  const parsed = options.edited ? editableCompositionSchema.safeParse(value) : compositionSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: "INVALID_COMPOSITION" };
  if (!options.edited && !sessionPlanMatchesComposition(parsed.data as MenuComposition)) {
    return { ok: false, code: "SESSION_PLAN_MISMATCH" };
  }
  const items = parsed.data.blocks.flatMap<CompositionItem | EditableItem>((block) => block.items);
  if (items.length === 0) return { ok: false, code: "EMPTY_MENU" };
  if (items.length > 50) return { ok: false, code: "TOO_MANY_ITEMS" };
  const runningCount = items.filter((item) => item.type === "RUNNING_POLICY").length;
  const markerAvailable = options.runningAvailable || (!options.edited && options.unprescribedRunningAvailable);
  if (runningCount > 1 || (!markerAvailable && runningCount > 0) || (!options.edited && options.runningAvailable && runningCount !== 1)) return { ok: false, code: "RUNNING_AUTHORITY" };
  const pendingCount = items.filter(item => item.type === "UNPRESCRIBED_RUNNING").length;
  if (pendingCount > 1 || (pendingCount > 0 && (!options.edited || !options.unprescribedRunningAvailable || options.runningAvailable))) return { ok: false, code: "RUNNING_AUTHORITY" };
  if (options.edited) {
    const ids = (parsed.data as EditableComposition).blocks.flatMap((block) => [block.id, ...block.items.map((item) => item.id)]);
    if (new Set(ids).size !== ids.length) return { ok: false, code: "DUPLICATE_ITEM_ID" };
  }
  for (const item of items) {
    if (item.type === "RUNNING_POLICY" || item.type === "UNPRESCRIBED_RUNNING") continue;
    if ([item.plannedReps, item.plannedDurationSeconds, item.plannedDistanceMeters].filter((v) => v !== null).length > 1) return { ok: false, code: "CONFLICTING_UNITS" };
    if (item.type === "CATALOG_EXERCISE") {
      const exercise = options.catalog.find((row) => row.id === item.exerciseId);
      if (!exercise || exercise.ownerId !== options.ownerId || exercise.status !== "REVIEWED") return { ok: false, code: "INVALID_EXERCISE" };
      if (exercise.name !== item.displayName) return { ok: false, code: "EXERCISE_NAME_MISMATCH" };
      if (isRunningExerciseForV2(exercise)) return { ok: false, code: "RUNNING_AUTHORITY" };
      if (!exerciseRepetitionCountMatches(item, exercise)) return { ok: false, code: "DOSE_COUNT_MISMATCH" };
    } else {
      if (isRunningExerciseForV2(item)) return { ok: false, code: "RUNNING_AUTHORITY" };
      // A model-selected FREEFORM category cannot prove that an unknown exercise
      // is non-Running. In a pending Running draft only catalog-backed exercises
      // may receive model doses; people can still fill freeform values afterwards.
      if (!options.edited && options.unprescribedRunningAvailable &&
          [item.plannedSets, item.plannedReps, item.plannedDurationSeconds, item.plannedDistanceMeters, item.plannedRestSeconds].some(value => value !== null)) {
        return { ok: false, code: "RUNNING_AUTHORITY" };
      }
      if (!options.edited) {
        const source = resolveWhitespaceQuote(options.requestText, item.originalUserInstruction);
        if (!source) return { ok: false, code: "UNGROUNDED_USER_INSTRUCTION" };
        item.originalUserInstruction = source.sourceText;
        if (options.unprescribedRunningAvailable) {
          // Do not let prose reintroduce a dose hidden behind OTHER/DRILL either.
          // Preserve the user's original request for later manual editing instead.
          item.displayName = "自由項目（元の希望）";
          item.executionInstruction = source.sourceText;
          item.plannedNote = "";
          item.reason = "未登録の項目は数量・実施方法を手動で確認してください。";
        }
      }
      if (!item.executionInstruction && !item.plannedNote) return { ok: false, code: "MISSING_INSTRUCTION" };
      // Running clauses already bound by the frozen interpreter cannot become freeform doses.
      if ((options.runningSourceTexts ?? []).some((source) => source.trim() && item.originalUserInstruction.normalize("NFKC").includes(source.normalize("NFKC")))) return { ok: false, code: "RUNNING_AUTHORITY" };
    }
  }
  return { ok: true, value: parsed.data };
}

export function editableComposition(proposal: MenuComposition, makeId: () => string): EditableComposition {
  return { blocks: proposal.blocks.map((block) => ({ id: makeId(), name: block.name,
    items: block.items.map((item) => item.type === "RUNNING_POLICY" ? { ...item, id: makeId(), plannedNote: "" } : { ...item, id: makeId() }),
  })) };
}
