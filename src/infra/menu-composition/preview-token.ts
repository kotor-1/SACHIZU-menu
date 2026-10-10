import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import { editableCompositionSchema, menuCompositionContextSchema } from "@/domain/menu-composition/contracts";
import { runningMenuPrescriptionSchema } from "@/application/running-menu/persistence";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { isCurrentRunningPolicy } from "@/domain/running-policy/science-policy";
import { assertUsableSigningKey, HMAC_TOKEN_MAX_LENGTH, signHmacToken, verifyHmacToken } from "@/infra/security/hmac-token";
import { unprescribedRunningContextSchema } from "@/domain/menu-composition/unprescribed-running";

const schema = z.object({
  kind: z.literal("MENU_COMPOSITION_PREVIEW"), schemaVersion: z.literal(1), ownerId: z.string().min(1),
  menuId: z.string().uuid(), issuedAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().positive(),
  requestText: z.string().min(1).max(2000), context: menuCompositionContextSchema,
  requestedTimeSeconds: z.number().int().positive().nullable().optional(),
  unprescribedRunning: unprescribedRunningContextSchema.nullable().optional(),
  policyVersion: z.string().min(1).max(64), policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  allowedExerciseIds: z.array(z.string().min(1).max(64)).max(2000),
  proposal: editableCompositionSchema, runningToken: z.string().max(HMAC_TOKEN_MAX_LENGTH).nullable(),
  runningPrescription: runningMenuPrescriptionSchema.nullable(), runningSourceTexts: z.array(z.string()).max(20),
}).strict().superRefine((claims, context) => {
  if (!isCurrentRunningPolicy(claims.policyVersion, claims.policyHash)) {
    context.addIssue({ code: "custom", path: ["policyVersion"], message: "unsupported running policy identity" });
  }
  if (claims.runningPrescription !== null) {
    if (claims.policyVersion !== claims.runningPrescription.policyVersion || claims.policyHash !== claims.runningPrescription.policyHash) {
      context.addIssue({ code: "custom", path: ["runningPrescription"], message: "running policy identity mismatch" });
    }
  } else if (claims.policyVersion !== RUNNING_POLICY_VERSION || claims.policyHash !== RUNNING_POLICY_HASH) {
    context.addIssue({ code: "custom", path: ["policyVersion"], message: "composition policy identity mismatch" });
  }
});
export type MenuCompositionClaims = z.infer<typeof schema>;
export function issueMenuCompositionToken(input: Omit<MenuCompositionClaims, "kind" | "schemaVersion" | "menuId" | "issuedAtMs" | "expiresAtMs" | "policyVersion" | "policyHash">, key: string, nowMs = Date.now()) {
  assertUsableSigningKey(key);
  const claims = schema.parse({ ...input, kind: "MENU_COMPOSITION_PREVIEW", schemaVersion: 1,
    menuId: randomUUID(), issuedAtMs: nowMs, expiresAtMs: nowMs + 2 * 60 * 60 * 1000,
    policyVersion: input.runningPrescription?.policyVersion ?? RUNNING_POLICY_VERSION,
    policyHash: input.runningPrescription?.policyHash ?? RUNNING_POLICY_HASH });
  const token = signHmacToken(canonicalStringify(claims), key);
  if (token.length > HMAC_TOKEN_MAX_LENGTH) throw new Error("PREVIEW_TOO_LARGE");
  return token;
}
export function verifyMenuCompositionToken(token: string, key: string, nowMs = Date.now()): MenuCompositionClaims | null {
  assertUsableSigningKey(key);
  const verified = verifyHmacToken(token, key);
  if (!verified.ok) return null;
  try {
    const claims = schema.parse(JSON.parse(verified.payload));
    if (claims.issuedAtMs > nowMs || claims.expiresAtMs <= nowMs || claims.expiresAtMs - claims.issuedAtMs > 2 * 60 * 60 * 1000) return null;
    if ((claims.runningToken === null) !== (claims.runningPrescription === null)) return null;
    if (claims.unprescribedRunning && claims.runningPrescription) return null;
    return claims;
  } catch { return null; }
}
