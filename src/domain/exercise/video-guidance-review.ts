import { z } from "zod";
import { videoGuidanceObservationSchema } from "./video-guidance";
import { VIDEO_GUIDANCE_FIELDS } from "./video-guidance-persistence";

const id = z.string().min(1).max(128).refine((value) => value.trim() === value);
export const guidanceReviewScopeSchema = z.object({ ownerId: id, exerciseId: id }).strict();
const resolutionSchema = z.object({
  field: z.enum(VIDEO_GUIDANCE_FIELDS), state: z.enum(["KNOWN", "NOT_APPLICABLE"]),
  reason: z.string().trim().min(1).max(2000),
}).strict();
const command = {
  ownerId: id, exerciseId: id, operationKey: id, reason: z.string().trim().min(1).max(2000),
  candidateRevisionId: id, expectedRowVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedApprovedRevisionId: id.nullable(), expectedSourceBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
};
export const guidanceReviewCommandSchema = z.discriminatedUnion("operation", [
  z.object({ ...command, operation: z.literal("HOLD") }).strict(),
  z.object({ ...command, operation: z.literal("REJECT") }).strict(),
  z.object({ ...command, operation: z.literal("PUBLISH_AI") }).strict(),
  z.object({ ...command, operation: z.literal("APPROVE"), observation: videoGuidanceObservationSchema,
    resolutions: z.array(resolutionSchema).max(VIDEO_GUIDANCE_FIELDS.length)
      .refine((items) => new Set(items.map((item) => item.field)).size === items.length),
  }).strict(),
]);
export type GuidanceReviewCommand = z.infer<typeof guidanceReviewCommandSchema>;
export const GUIDANCE_PERMISSIONS = ["VIEW_VIDEO_GUIDANCE", "REVIEW_VIDEO_GUIDANCE", "PUBLISH_VIDEO_GUIDANCE", "ANALYZE_VIDEO_GUIDANCE"] as const;
export type GuidancePermission = (typeof GUIDANCE_PERMISSIONS)[number];
export type GuidanceReviewOperation = GuidanceReviewCommand["operation"];

/** Issued by a trusted server authentication adapter, never parsed from a browser form. */
export type AuthenticatedGuidanceIdentity = {
  actorId: string; ownerIds: readonly string[]; permissions: readonly string[];
  /** Server-issued grants are scoped to an owner, never a cross product of global permissions. */
  ownerPermissions?: readonly { ownerId: string; permissions: readonly GuidancePermission[] }[];
};
export function hasGuidancePermission(actor: AuthenticatedGuidanceIdentity, ownerId: string, permission: GuidancePermission) {
  if (!actor.ownerIds.includes(ownerId)) return false;
  if (actor.ownerPermissions !== undefined) {
    return actor.ownerPermissions.some((grant) => grant.ownerId === ownerId && grant.permissions.includes(permission));
  }
  // Compatibility for the trusted Phase 2 port: its single capability covered all operations.
  // The real session adapter always supplies ownerPermissions, including an empty array.
  return permission !== "ANALYZE_VIDEO_GUIDANCE" && actor.permissions.includes("REVIEW_VIDEO_GUIDANCE");
}
export interface GuidanceIdentityPort {
  currentIdentity(): Promise<AuthenticatedGuidanceIdentity | null>;
}
export class GuidanceReviewAccessError extends Error {
  constructor(readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "INVALID_REVIEW" | "UNRESOLVED_FIELDS") {
    super(code); this.name = "GuidanceReviewAccessError";
  }
}
