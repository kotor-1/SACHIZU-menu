import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuidanceReviewAccessError } from "@/domain/exercise/video-guidance-review";
import { VideoGuidancePersistenceError } from "@/domain/exercise/video-guidance-persistence";

const mocked = vi.hoisted(() => ({ submit: vi.fn(), dependencies: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/application/menu-composition/video-guidance-review", () => ({ submitVideoGuidanceReview: mocked.submit }));
vi.mock("@/actions/_video-guidance-review-runtime", () => ({ getVideoGuidanceReviewDependencies: mocked.dependencies }));
vi.mock("next/cache", () => ({ revalidatePath: mocked.revalidate }));
import { videoGuidanceReviewAction } from "@/actions/video-guidance-review-actions";

const payload = {
  ownerId: "fixture-owner", exerciseId: "fixture-exercise", operation: "HOLD", operationKey: "fixture-operation",
  reason: "Explicit review", candidateRevisionId: "fixture-candidate", expectedRowVersion: 1,
  expectedApprovedRevisionId: null, expectedSourceBindingHash: "a".repeat(64),
};
const form = () => { const result = new FormData(); result.set("payload", JSON.stringify(payload)); return result; };
beforeEach(() => {
  vi.clearAllMocks();
  mocked.dependencies.mockReturnValue({});
  mocked.submit.mockRejectedValue(new GuidanceReviewAccessError("UNAUTHENTICATED"));
});

describe("Video-guidance review action boundary", () => {
  it.each(["extra-reviewer", "duplicate-payload", "invalid-json", "oversize"])("rejects %s before dependency construction", async (kind) => {
    const input = form();
    if (kind === "extra-reviewer") input.set("reviewerActorId", "forged-coach");
    if (kind === "duplicate-payload") input.append("payload", JSON.stringify(payload));
    if (kind === "invalid-json") input.set("payload", "not JSON");
    if (kind === "oversize") input.set("payload", " ".repeat(32001));
    expect(await videoGuidanceReviewAction(null, input)).toMatchObject({ ok: false, code: "INVALID_REVIEW" });
    expect(mocked.dependencies).not.toHaveBeenCalled();
    expect(mocked.submit).not.toHaveBeenCalled();
    expect(mocked.revalidate).not.toHaveBeenCalled();
  });

  it("reports disconnected authentication without revalidating or granting fallback identity", async () => {
    expect(await videoGuidanceReviewAction(null, form())).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    expect(mocked.submit).toHaveBeenCalledWith(payload, {});
    expect(mocked.revalidate).not.toHaveBeenCalled();
  });

  it("preserves a typed source error but hides internal exception details", async () => {
    mocked.submit.mockRejectedValueOnce(new VideoGuidancePersistenceError("SOURCE_MISMATCH"));
    expect(await videoGuidanceReviewAction(null, form())).toMatchObject({ ok: false, code: "SOURCE_MISMATCH" });
    mocked.submit.mockRejectedValueOnce(new Error("private infrastructure detail"));
    const failure = await videoGuidanceReviewAction(null, form());
    expect(failure).toMatchObject({ ok: false, code: "REVIEW_UNAVAILABLE" });
    expect(JSON.stringify(failure)).not.toContain("private infrastructure detail");
  });

  it("revalidates only the encoded scope returned by the successful service", async () => {
    mocked.submit.mockResolvedValueOnce({ head: { ownerId: "trusted/owner", exerciseId: "trusted exercise" } });
    const input = form();
    input.set("$ACTION_ID_fixture", "framework metadata");
    expect(await videoGuidanceReviewAction(null, input)).toMatchObject({ ok: true });
    expect(mocked.revalidate).toHaveBeenCalledExactlyOnceWith("/video-guidance/trusted%2Fowner/trusted%20exercise");
  });
});
