import type { PrismaClient } from "@prisma/client";
import { hasGuidancePermission, type AuthenticatedGuidanceIdentity } from "@/domain/exercise/video-guidance-review";

/** The authenticated owner's grants, not URL/form input, bound the index lookup. */
export async function listGuidanceReviewsForIdentity(db: PrismaClient, identity: AuthenticatedGuidanceIdentity) {
  const ownerIds = identity.ownerIds.filter((owner) => hasGuidancePermission(identity, owner, "VIEW_VIDEO_GUIDANCE"));
  if (ownerIds.length === 0) return [];
  const heads = await db.exerciseVideoGuidanceHead.findMany({
    where: { ownerId: { in: ownerIds } },
    select: { ownerId: true, exerciseId: true, exercise: { select: { id: true, ownerId: true, name: true } } },
    orderBy: [{ ownerId: "asc" }, { exerciseId: "asc" }],
  });
  return heads.filter((head) => head.exercise.ownerId === head.ownerId && head.exercise.id === head.exerciseId)
    .map((head) => ({ ownerId: head.ownerId, exerciseId: head.exerciseId, exerciseName: head.exercise.name }));
}
