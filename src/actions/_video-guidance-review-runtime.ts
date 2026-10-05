import { resolve } from "node:path";
import { prisma } from "@/infra/db/prisma";
import { VideoGuidanceRepository } from "@/infra/repositories/video-guidance-repository";
import { createGuidanceSourceRepository } from "@/infra/repositories/video-guidance-source-repository";
import { createLocalVideoSourceBindingResolver } from "@/infra/exercise/local-video-source-binding";
import { videoGuidanceIdentity } from "@/infra/auth/video-guidance-identity";
import type { GuidanceReviewDependencies } from "@/application/menu-composition/video-guidance-review";
import type { AuthenticatedGuidanceIdentity } from "@/domain/exercise/video-guidance-review";
import { listGuidanceReviewsForIdentity } from "@/infra/repositories/video-guidance-access-repository";

/** No use-server directive: dependency construction is not a public endpoint. */
export function getVideoGuidanceReviewDependencies(): GuidanceReviewDependencies {
  const sources = createGuidanceSourceRepository(prisma);
  const resolveSource = createLocalVideoSourceBindingResolver(resolve(process.cwd(), "public"), sources.findVideo);
  return { identity: videoGuidanceIdentity, sources, repository: new VideoGuidanceRepository(prisma, resolveSource) };
}
export function listAccessibleGuidanceReviews(identity: AuthenticatedGuidanceIdentity) {
  return listGuidanceReviewsForIdentity(prisma, identity);
}
