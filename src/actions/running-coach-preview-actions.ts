"use server";

import { z } from "zod";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { applyRunningCoachEdit, runningCoachEditRequestSchema } from "@/application/running-menu/coach-edit";
import { runningMenuEnvelopeSchema, RUNNING_MENU_PRESCRIPTION_KIND } from "@/application/running-menu/persistence";
import { HMAC_TOKEN_MAX_LENGTH } from "@/infra/security/hmac-token";
import { evaluateSignedRunningPreview, runningSaveProvenance } from "./_running-menu-save-service";
import { runningScienceContextSchema } from "@/domain/running-policy/science-contracts";

const inputSchema = z.object({
  previewToken: z.string().min(1).max(HMAC_TOKEN_MAX_LENGTH),
  previewPolicyVersion: z.string().min(1).max(64),
  previewPolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  requestText: z.string().min(1).max(2000),
  context: z.object({
    event: z.string().max(32).optional(),
    ageGroup: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"]).optional(),
    availableTimeSeconds: z.number().int().positive().optional(),
    science: runningScienceContextSchema.optional(),
  }).strict(),
  previewPrescription: z.unknown(),
  coachEdit: runningCoachEditRequestSchema,
}).strict();

export async function previewRunningCoachEditAction(input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "INVALID_EDIT" as const };
  const evaluated = evaluateSignedRunningPreview(parsed.data);
  if (!evaluated.ok) return evaluated;
  const base = evaluated.prescription.prescription;
  const envelope = runningMenuEnvelopeSchema.parse({
    kind: RUNNING_MENU_PRESCRIPTION_KIND, schemaVersion: 1,
    policyVersion: base.policyVersion, policyHash: base.policyHash, prescription: base,
  });
  const result = applyRunningCoachEdit(envelope, runningSaveProvenance(evaluated.claims), parsed.data.coachEdit, new Date().toISOString());
  if (!result.ok) return result;
  return {
    ok: true as const,
    finalPrescription: result.envelope.finalPrescription,
    finalFingerprint: sha256Utf8Hex(canonicalStringify(result.envelope.finalPrescription)),
  };
}
