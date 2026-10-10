import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import { runningScienceContextSchema } from "@/domain/running-policy/science-contracts";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import { runningPrescriptionFingerprint } from "@/application/running-menu/persistence";
import type { RunningMenuContextInput } from "@/application/running-menu/preview";
import type { VerifiedRunningIntent } from "@/application/running-menu/intent";
import { assertUsableSigningKey, signHmacToken, verifyHmacToken } from "@/infra/security/hmac-token";

const claim = <T extends z.ZodTypeAny>(value: T) => z.object({
  value,
  sourceText: z.string().min(1).max(160),
  sourceType: z.enum(["USER_TEXT", "USER_CONTEXT", "PROFILE"]),
}).strict();

const tokenSchema = z.object({
  kind: z.literal("RUNNING_MENU_PREVIEW"),
  // Purpose-aware intent is required for re-evaluation. Reject older signed
  // tokens that could silently omit an unsupported purpose from the Engine.
  schemaVersion: z.literal(2),
  ownerId: z.string().min(1),
  menuId: z.string().uuid(),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
  policyVersion: z.string(),
  policyHash: z.string(),
  requestText: z.string().min(1).max(2000),
  context: z.object({
    event: z.string().max(32).optional(),
    ageGroup: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"]).optional(),
    availableTimeSeconds: z.number().int().positive().optional(),
    science: runningScienceContextSchema.optional(),
  }).strict(),
  intent: z.object({
    runningRequested: z.literal(true),
    event: claim(z.string()).nullable(),
    ageGroup: claim(z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"])).nullable(),
    explicitDistances: z.array(claim(z.number().int().positive())).max(20),
    distancePreference: claim(z.enum(["SHORT", "LONG"])).nullable(),
    loadReductionRequested: claim(z.literal(true)).nullable(),
    fatigueState: claim(z.enum(["REPORTED", "STRONG_OR_UNWELL"])).nullable(),
    purpose: claim(z.enum(["ACCEL", "MAX_SPEED", "SPEED_ENDURANCE", "BASIC", "PRECOMP", "RECOVERY"])).nullable(),
    intensityPreference: claim(z.literal("LOW")).nullable(),
    competitionDays: claim(z.number().int().nonnegative()).nullable(),
    availableTimeSeconds: claim(z.number().int().positive()).nullable(),
    humanExplicitReps: claim(z.number().int().positive()).nullable(),
    humanExplicitRestSeconds: claim(z.number().int().positive()).nullable(),
    exerciseIds: z.array(z.string().min(1).max(64)).max(20),
  }).strict(),
  prescriptionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type RunningMenuPreviewClaims = z.infer<typeof tokenSchema>;

/** The same configured secret as the existing Menu Planner; no fallback key. */
export function runningMenuSigningKey(): string {
  return process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET ?? "";
}

export function issueRunningMenuPreviewToken(input: {
  ownerId: string;
  requestText: string;
  context: RunningMenuContextInput;
  intent: VerifiedRunningIntent;
  prescription: RunningPrescription;
}, key: string, nowMs = Date.now()): string {
  assertUsableSigningKey(key);
  const claims = tokenSchema.parse({
    kind: "RUNNING_MENU_PREVIEW",
    schemaVersion: 2,
    ownerId: input.ownerId,
    menuId: randomUUID(),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + 2 * 60 * 60 * 1000,
    policyVersion: input.prescription.policyVersion,
    policyHash: input.prescription.policyHash,
    requestText: input.requestText,
    context: input.context,
    intent: input.intent,
    prescriptionFingerprint: runningPrescriptionFingerprint(input.prescription),
  });
  return signHmacToken(canonicalStringify(claims), key);
}

export function verifyRunningMenuPreviewToken(token: string, key: string, nowMs = Date.now()): RunningMenuPreviewClaims | null {
  assertUsableSigningKey(key);
  const verified = verifyHmacToken(token, key);
  if (!verified.ok) return null;
  try {
    const parsed = tokenSchema.safeParse(JSON.parse(verified.payload));
    if (!parsed.success) return null;
    if (parsed.data.issuedAtMs > nowMs || parsed.data.expiresAtMs <= nowMs || parsed.data.expiresAtMs - parsed.data.issuedAtMs > 2 * 60 * 60 * 1000) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
