import { z } from "zod";
import { editableCompositionSchema, type EditableComposition } from "@/domain/menu-composition/contracts";
import { runningMenuPrescriptionSchema } from "@/application/running-menu/persistence";
import { runningCoachEditRequestSchema } from "@/application/running-menu/coach-edit";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import { trainingConditionsSchema, type TrainingConditions } from "./conditions";

export const TRAINING_SECTION_NAMES = ["動きづくり", "走練習", "補強トレーニング"] as const;
export const trainingItemAnnotationSchema = z.object({
  intensity: z.string().trim().min(1).max(240),
  stage: z.number().int().min(0).max(4).nullable(), family: z.string().min(1).max(160),
  relationship: z.enum(["COMBINABLE", "ALTERNATIVE"]), alternativeGroup: z.string().trim().min(1).max(100).nullable(),
}).strict();
export type TrainingItemAnnotation = z.infer<typeof trainingItemAnnotationSchema>;
export const trainingAnnotationsSchema = z.record(z.string().min(1).max(80), trainingItemAnnotationSchema);

// Three sections belong to the app. The model only chooses catalog IDs and explains them:
// names, instructions and every quantity are set by the App from the catalog (registered
// Exercise.default* first), so it cannot introduce a dose, running prescription, freeform
// exercise, time budget, or a replacement section structure.
const trainingComposerSelectionSchema = z.object({
  exerciseId: z.string().min(1).max(64),
  reason: z.string().trim().min(1).max(160),
  intensity: z.string().trim().min(1).max(240),
  relationship: z.enum(["COMBINABLE", "ALTERNATIVE"]), alternativeGroup: z.string().trim().min(1).max(100).nullable(),
}).strict();
export const trainingComposerOutputSchema = z.object({
  movement: z.array(trainingComposerSelectionSchema).max(20),
  strength: z.array(trainingComposerSelectionSchema).max(10),
  explanation: z.string().trim().min(1).max(500),
  uncertainty: z.string().trim().min(1).max(400),
}).strict();
export type TrainingComposerOutput = z.infer<typeof trainingComposerOutputSchema>;
export type TrainingComposerSelection = TrainingComposerOutput["movement"][number];
export type TrainingProposalPreview = {
  conditions: TrainingConditions; composition: EditableComposition; previewToken: string;
  runningPrescription: RunningPrescription | null; runningStatusReason: string | null;
  annotations: Record<string, TrainingItemAnnotation>; selectedItemIds: string[];
  messages: string[]; quality: "READY" | "LIMITED"; menuName?: string;
  coachEdit?: z.infer<typeof runningCoachEditRequestSchema>;
};
export const trainingProposalSavedStateSchema = z.object({
  version: z.literal(1), conditions: trainingConditionsSchema, composition: editableCompositionSchema,
  selectedItemIds: z.array(z.string().min(1).max(80)).max(50), annotations: trainingAnnotationsSchema,
  runningPrescription: runningMenuPrescriptionSchema.nullable(), runningStatusReason: z.string().max(1000).nullable(),
  messages: z.array(z.string().max(1000)).max(30), quality: z.enum(["READY", "LIMITED"]),
  revision: z.string().min(1).max(80), coachEdit: runningCoachEditRequestSchema.optional(),
}).strict();
export type TrainingProposalSavedState = z.infer<typeof trainingProposalSavedStateSchema>;
