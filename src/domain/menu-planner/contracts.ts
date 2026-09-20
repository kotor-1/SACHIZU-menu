import { z } from "zod";

import {
  EXERCISE_CATEGORIES,
  EXERCISE_PURPOSES,
  TRACK_FIELD_EVENTS,
} from "@/domain/exercise/constants";
import { TRAINING_PHASES } from "@/domain/menu/constants";
import { ageBandSchema, envelopeTierSchema } from "@/domain/running/types/subject";
import {
  RUNNING_TRAINING_METHODS,
  runningTrainingMethodSchema,
} from "@/domain/running/types/method";
import type { AiSafeSubjectContext } from "@/domain/running/readiness/aiSafeContext";

export const MENU_PLANNER_SCHEMA_VERSION = 1 as const;
export const MENU_PLANNER_POLICY_ID = "R12_MENU_INTENT_V1" as const;

const CONTROL_OR_BIDI_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const HTML_PATTERN = /<\/?[a-z][^>]*>/iu;
const MARKUP_PATTERN = /```|`|\[[^\]]*\]\([^)]*\)|(^|\s)#{1,6}\s|\*\*|__/iu;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/iu;

function addDuplicateIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate values are not allowed.",
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}

function uniqueStringArray<TSchema extends z.ZodType<string>>(
  itemSchema: TSchema,
  maximum: number,
) {
  return z
    .array(itemSchema)
    .max(maximum)
    .superRefine((values, context) => addDuplicateIssue(values, context));
}

const identifierSchema = z.string().trim().min(1).max(64);

const trainingPhaseSchema = z.enum(TRAINING_PHASES);
const trackFieldEventSchema = z.enum(TRACK_FIELD_EVENTS);
const exercisePurposeSchema = z.enum(EXERCISE_PURPOSES);
const exerciseCategorySchema = z.enum(EXERCISE_CATEGORIES);

export const menuPlannerIntentRequestSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_SCHEMA_VERSION),
    requestText: z.string().trim().min(1).max(2_000),
    constraints: z
      .object({
        phase: trainingPhaseSchema.nullable(),
        targetEvents: uniqueStringArray(trackFieldEventSchema, 8),
        purposes: uniqueStringArray(exercisePurposeSchema, 16),
        availableMinutes: z.number().int().min(1).max(600).nullable(),
        equipment: z
          .object({
            availableTagIds: uniqueStringArray(identifierSchema, 30),
          })
          .strict()
          .nullable(),
        preferredExerciseIds: uniqueStringArray(identifierSchema, 20),
        excludedExerciseIds: uniqueStringArray(identifierSchema, 20),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const excluded = new Set(request.constraints.excludedExerciseIds);
    for (const [index, id] of request.constraints.preferredExerciseIds.entries()) {
      if (excluded.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An exercise cannot be both preferred and excluded.",
          path: ["constraints", "preferredExerciseIds", index],
        });
      }
    }
  });

export type MenuPlannerIntentRequest = z.infer<
  typeof menuPlannerIntentRequestSchema
>;

const phaseOrder = new Map(TRAINING_PHASES.map((value, index) => [value, index]));
const eventOrder = new Map(TRACK_FIELD_EVENTS.map((value, index) => [value, index]));
const purposeOrder = new Map(EXERCISE_PURPOSES.map((value, index) => [value, index]));

function compareByOrder<T extends string>(
  order: ReadonlyMap<T, number>,
  left: T,
  right: T,
): number {
  return (order.get(left) ?? 0) - (order.get(right) ?? 0);
}

export function canonicalizeMenuPlannerIntentRequest(
  input: unknown,
): MenuPlannerIntentRequest {
  const request = menuPlannerIntentRequestSchema.parse(input);
  return {
    schemaVersion: MENU_PLANNER_SCHEMA_VERSION,
    requestText: request.requestText,
    constraints: {
      phase:
        request.constraints.phase === null
          ? null
          : TRAINING_PHASES[phaseOrder.get(request.constraints.phase) ?? 0],
      targetEvents: [...request.constraints.targetEvents].sort((left, right) =>
        compareByOrder(eventOrder, left, right),
      ),
      purposes: [...request.constraints.purposes].sort((left, right) =>
        compareByOrder(purposeOrder, left, right),
      ),
      availableMinutes: request.constraints.availableMinutes,
      equipment:
        request.constraints.equipment === null
          ? null
          : {
              availableTagIds: [
                ...request.constraints.equipment.availableTagIds,
              ].sort(),
            },
      preferredExerciseIds: [
        ...request.constraints.preferredExerciseIds,
      ].sort(),
      excludedExerciseIds: [...request.constraints.excludedExerciseIds].sort(),
    },
  };
}

export const exerciseCandidateDtoSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(120),
    category: exerciseCategorySchema,
    purposes: uniqueStringArray(exercisePurposeSchema, 16),
    events: uniqueStringArray(trackFieldEventSchema, 8),
    equipmentTagIds: uniqueStringArray(identifierSchema, 30),
  })
  .strict();

export type ExerciseCandidateDto = z.infer<typeof exerciseCandidateDtoSchema>;

export const equipmentCandidateDtoSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(40),
  })
  .strict();

export type EquipmentCandidateDto = z.infer<typeof equipmentCandidateDtoSchema>;

export const runningTemplateCandidateDtoSchema = z
  .object({
    method: runningTrainingMethodSchema,
    templateId: identifierSchema,
    label: z.string().trim().min(1).max(120),
  })
  .strict();

export type RunningTemplateCandidateDto = z.infer<
  typeof runningTemplateCandidateDtoSchema
>;

const resolvedAgeBandSchema = z.union([ageBandSchema, z.literal("UNKNOWN")]);

export const menuPlannerAiSafeSubjectContextSchema: z.ZodType<AiSafeSubjectContext> = z
  .object({
    tier: envelopeTierSchema,
    ageBand: resolvedAgeBandSchema,
    allowedMethods: uniqueStringArray(
      runningTrainingMethodSchema,
      RUNNING_TRAINING_METHODS.length,
    ),
    autogenBlockedMethods: uniqueStringArray(
      runningTrainingMethodSchema,
      RUNNING_TRAINING_METHODS.length,
    ),
    highIntensityAllowedToday: z.union([
      z.boolean(),
      z.literal("UNKNOWN"),
    ]),
    primaryEvent: z.string().trim().min(1).max(64),
  })
  .strict();

const menuPlannerCatalogSchema = z
  .object({
    exercises: z.array(exerciseCandidateDtoSchema),
    runningTemplates: z.array(runningTemplateCandidateDtoSchema),
    equipment: z.array(equipmentCandidateDtoSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    addDuplicateIssue(
      catalog.exercises.map((candidate) => candidate.id),
      context,
      ["exercises"],
    );
    addDuplicateIssue(
      catalog.runningTemplates.map((candidate) => candidate.templateId),
      context,
      ["runningTemplates"],
    );
    addDuplicateIssue(
      catalog.equipment.map((candidate) => candidate.id),
      context,
      ["equipment"],
    );
  });

export const menuPlannerProviderRequestSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_SCHEMA_VERSION),
    policy: z
      .object({
        id: z.literal(MENU_PLANNER_POLICY_ID),
      })
      .strict(),
    coachRequest: menuPlannerIntentRequestSchema,
    subject: menuPlannerAiSafeSubjectContextSchema,
    catalog: menuPlannerCatalogSchema,
  })
  .strict();

export type MenuPlannerProviderRequest = z.infer<
  typeof menuPlannerProviderRequestSchema
>;

function normalizedPlainText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function plainTextSchema(maximum: number) {
  return z
    .string()
    .superRefine((value, context) => {
      const normalized = value.normalize("NFKC");
      if (CONTROL_OR_BIDI_PATTERN.test(normalized)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Control and bidi characters are not allowed.",
        });
      }
      if (
        HTML_PATTERN.test(normalized) ||
        MARKUP_PATTERN.test(normalized) ||
        URL_PATTERN.test(normalized)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "HTML, markup, and URLs are not allowed.",
        });
      }
    })
    .transform(normalizedPlainText)
    .pipe(z.string().min(1).max(maximum));
}

const blockNameSchema = plainTextSchema(80);
const clarificationTextSchema = plainTextSchema(200);
const clarificationOptionSchema = plainTextSchema(80);

export const aiRunningItemProposalSchema = z
  .object({
    blockName: blockNameSchema,
    method: runningTrainingMethodSchema,
    templateId: identifierSchema,
    positionPreference: z.enum(["LOWER", "MIDDLE"]).nullable(),
    reason: z.string().max(300),
  })
  .strict();

export type AiRunningItemProposal = z.infer<
  typeof aiRunningItemProposalSchema
>;

export const aiExerciseItemProposalSchema = z
  .object({
    blockName: blockNameSchema,
    exerciseId: identifierSchema,
    reason: z.string().max(300),
  })
  .strict();

export type AiExerciseItemProposal = z.infer<
  typeof aiExerciseItemProposalSchema
>;

const aiRunningPlannerItemProposalSchema = z
  .object({
    kind: z.literal("RUNNING"),
    proposal: aiRunningItemProposalSchema,
  })
  .strict();

const aiExercisePlannerItemProposalSchema = z
  .object({
    kind: z.literal("EXERCISE"),
    proposal: aiExerciseItemProposalSchema,
  })
  .strict();

export const aiPlannerItemProposalSchema = z.discriminatedUnion("kind", [
  aiRunningPlannerItemProposalSchema,
  aiExercisePlannerItemProposalSchema,
]);

export type AiPlannerItemProposal = z.infer<
  typeof aiPlannerItemProposalSchema
>;

export const AI_CLARIFICATION_MISSING_FIELDS = [
  "PURPOSE",
  "EVENT",
  "EQUIPMENT",
  "EXERCISE_PREFERENCE",
  "REQUEST_DETAIL",
] as const;

export const aiClarificationQuestionSchema = z
  .object({
    missingField: z.enum(AI_CLARIFICATION_MISSING_FIELDS),
    text: clarificationTextSchema,
    options: z
      .array(clarificationOptionSchema)
      .max(4)
      .superRefine((options, context) => {
        if (options.length === 1) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Clarification options must contain zero or two to four items.",
          });
        }
        addDuplicateIssue(options, context);
      }),
  })
  .strict();

export type AiClarificationQuestion = z.infer<
  typeof aiClarificationQuestionSchema
>;

export const aiPlannerProposalSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_SCHEMA_VERSION),
    items: z.array(aiPlannerItemProposalSchema).max(20),
    question: aiClarificationQuestionSchema.nullable(),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.question === null && proposal.items.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A proposal without a question must contain at least one item.",
        path: ["items"],
      });
    }
    if (proposal.question !== null && proposal.items.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A clarification question cannot coexist with proposal items.",
        path: ["items"],
      });
    }

    const exerciseIds = new Set<string>();
    const runningSelections = new Set<string>();
    const closedBlocks = new Set<string>();
    const distinctBlocks = new Set<string>();
    let currentBlock: string | null = null;

    for (const [index, item] of proposal.items.entries()) {
      const blockName = item.proposal.blockName;
      distinctBlocks.add(blockName);

      if (currentBlock !== blockName) {
        if (currentBlock !== null) closedBlocks.add(currentBlock);
        if (closedBlocks.has(blockName)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A closed block cannot reappear later in the item order.",
            path: ["items", index, "proposal", "blockName"],
          });
        }
        currentBlock = blockName;
      }

      if (item.kind === "EXERCISE") {
        if (exerciseIds.has(item.proposal.exerciseId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate exercise proposals are not allowed.",
            path: ["items", index, "proposal", "exerciseId"],
          });
        }
        exerciseIds.add(item.proposal.exerciseId);
      } else {
        const selection = `${item.proposal.method}:${item.proposal.templateId}`;
        if (runningSelections.has(selection)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate running template proposals are not allowed.",
            path: ["items", index, "proposal", "templateId"],
          });
        }
        runningSelections.add(selection);
      }
    }

    if (distinctBlocks.size > 8) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A proposal may contain at most eight blocks.",
        path: ["items"],
      });
    }
  });

export type AiPlannerProposal = z.infer<typeof aiPlannerProposalSchema>;
