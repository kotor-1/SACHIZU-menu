import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VideoGuidanceReviewPanel } from "@/components/exercise/video-guidance-review";
import type { VideoGuidanceReviewPageData } from "@/application/menu-composition/video-guidance-review";
import type { ReviewGuidanceRevision } from "@/infra/repositories/video-guidance-repository";
import { persistenceAssessments, persistenceBinding, persistenceNow, persistencePayload } from "../fixtures/video-guidance-persistence";

vi.mock("@/actions/video-guidance-review-actions", () => ({ videoGuidanceReviewAction: vi.fn() }));

function fixture(partial: boolean): VideoGuidanceReviewPageData {
  const revision: ReviewGuidanceRevision = {
    revisionId: "revision-1", guidance: { ...persistencePayload }, sourceBinding: { ...persistenceBinding },
    fieldAssessment: persistenceAssessments.map((field) => ({ ...field })), sourceStatus: "CURRENT",
    revisionOrigin: "LEGACY_IMPORT", parentRevisionId: null, baseAiRevisionId: null, aiMetadata: null,
    provenance: { source: "offline fixture" }, reviewerActorId: null, reviewerIdentity: "NOT_REVIEWED",
    reviewReason: null, analyzedAt: persistencePayload.analyzedAt, reviewedAt: null, createdAt: persistenceNow.toISOString(),
  };
  if (partial) {
    revision.guidance.countingUnit = "CUSTOM";
    revision.guidance.bilateralCounting = "左右は未確定";
    revision.guidance.typicalStructure = "回数・時間・1回の定義は未確定";
    for (const field of revision.fieldAssessment) if (["countingUnit", "bilateralCounting", "typicalStructure"].includes(field.field)) field.state = "UNRESOLVED";
  } else {
    revision.guidance.videoAnalysisStatus = "COACH_REVIEWED";
    revision.guidance.coachReviewedAt = persistenceNow.toISOString();
    revision.reviewedAt = persistenceNow.toISOString();
    revision.reviewerIdentity = "LEGACY_UNKNOWN";
  }
  return {
    exercise: { id: "exercise-a", ownerId: "owner-a", name: partial ? "未確定の種目" : "片脚の種目", videoUrl: persistenceBinding.sourceUrl,
      metricType: "REPS", defaultSets: 3, defaultReps: null, defaultDistanceMeters: null, defaultRestSeconds: 60 },
    review: {
      head: { ownerId: "owner-a", exerciseId: "exercise-a", approvedRevisionId: partial ? null : revision.revisionId,
        activeAiRevisionId: partial ? revision.revisionId : null, latestCandidateRevisionId: partial ? revision.revisionId : null, rowVersion: 1, updatedAt: persistenceNow },
      effective: revision, candidate: partial ? revision : null, aiOriginal: partial ? revision : null,
      previousApproved: null, candidateDecision: partial ? "PENDING" : null, auditEvents: [],
    },
  };
}
const render = (data: VideoGuidanceReviewPageData) => renderToStaticMarkup(createElement(VideoGuidanceReviewPanel,
  { data, operationKey: "offline-operation", sourceBindingHash: "a".repeat(64) }));

describe("Video guidance review presentation", () => {
  it("shows legacy unknown reviewer, authoritative values and null defaults without creating controls", () => {
    const data = fixture(false), before = structuredClone(data);
    const html = render(data);
    expect(html).toContain("LEGACY_UNKNOWN");
    expect(html).toContain("片側10回、その後反対側10回");
    expect(html).toContain("距離 未記録 / 休憩 60");
    expect(html).not.toContain('name="operation"');
    expect(html).not.toContain("20m");
    expect(data).toEqual(before);
  });
  it("shows each unknown without preselecting a resolution or enabling approval", () => {
    const html = render(fixture(true));
    expect(html).toContain("AI解析・未承認");
    expect(html).toContain("左右は未確定");
    expect(html.match(/<option value="" selected="">未解決/g)).toHaveLength(3);
    expect(html).toMatch(/<button[^>]*value="APPROVE"[^>]*disabled=""/);
    for (const value of ["HOLD", "REJECT", "PUBLISH_AI", "APPROVE"]) expect(html).toContain(`value="${value}"`);
  });
  it("displays source mismatch and keeps review controls disabled", () => {
    const data = fixture(true);
    data.review.candidate!.sourceStatus = "SOURCE_MISMATCH";
    const html = render(data);
    expect(html).toContain("変更を検出・操作不可");
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(4);
  });
  it("escapes untrusted guidance and suppresses unsafe source links", () => {
    const data = fixture(true);
    data.review.candidate!.guidance.executionSummary = '<script>alert("unsafe")</script>';
    data.review.candidate!.sourceBinding.sourceUrl = "javascript:alert(1)";
    const html = render(data);
    expect(html).not.toContain('<script>alert("unsafe")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("元動画を開く");
  });
});
