import { randomUUID } from "node:crypto";
import { z } from "zod";
import { editableCompositionSchema } from "@/domain/menu-composition/contracts";
import { trainingConditionsSchema } from "@/domain/training-proposal/conditions";
import { trainingAnnotationsSchema } from "@/domain/training-proposal/contracts";
import { runningMenuPrescriptionSchema } from "@/application/running-menu/persistence";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import { assertUsableSigningKey, HMAC_TOKEN_MAX_LENGTH, signHmacToken, verifyHmacToken } from "@/infra/security/hmac-token";

const claimsSchema = z.object({
  kind: z.literal("TRAINING_PROPOSAL"), version: z.literal(1), ownerId: z.string().min(1), menuId: z.string().uuid(),
  conditions: trainingConditionsSchema, proposal: editableCompositionSchema, annotations: trainingAnnotationsSchema,
  runningPrescription: runningMenuPrescriptionSchema.nullable(), runningStatusReason: z.string().max(1000).nullable(),
  allowedExerciseIds: z.array(z.string().min(1).max(64)).max(2000),
  messages: z.array(z.string().max(1000)).max(30), quality: z.enum(["READY", "LIMITED"]),
  revision: z.string().min(1).max(80).nullable(), issuedAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().positive(),
}).strict();
export type TrainingProposalClaims = z.infer<typeof claimsSchema>;
export function issueTrainingProposalToken(input: Omit<TrainingProposalClaims, "kind" | "version" | "menuId" | "issuedAtMs" | "expiresAtMs">
  & { menuId?: string }, key: string, nowMs = Date.now()) {
  assertUsableSigningKey(key);
  const claims = claimsSchema.parse({ ...input, kind: "TRAINING_PROPOSAL", version: 1, menuId: input.menuId ?? randomUUID(),
    issuedAtMs: nowMs, expiresAtMs: nowMs + 2 * 60 * 60 * 1000 });
  const token = signHmacToken(canonicalStringify(claims), key);
  if (token.length > HMAC_TOKEN_MAX_LENGTH) throw new Error("PREVIEW_TOO_LARGE");
  return token;
}
export function verifyTrainingProposalToken(token: string, key: string, nowMs = Date.now()): TrainingProposalClaims | null {
  assertUsableSigningKey(key);
  const verified = verifyHmacToken(token, key);
  if (!verified.ok) return null;
  try {
    const claims = claimsSchema.parse(JSON.parse(verified.payload));
    return claims.issuedAtMs <= nowMs && claims.expiresAtMs > nowMs && claims.expiresAtMs - claims.issuedAtMs <= 2 * 60 * 60 * 1000 ? claims : null;
  } catch { return null; }
}
