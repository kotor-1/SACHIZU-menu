import { describe, expect, it } from "vitest";
import { renderMarkup, stripTags } from "../presentation/running/helpers";
import { PROPOSAL_WAIT_DEFAULT_SECONDS, ProposalWaitView, proposalWaitEstimate, proposalWaitSample } from "@/components/menu/proposal-wait-status";

const markup = (elapsedSeconds: number, estimateSeconds = 20) => renderMarkup(ProposalWaitView, { elapsedSeconds, estimateSeconds });
const text = (elapsedSeconds: number, estimateSeconds = 20) => stripTags(markup(elapsedSeconds, estimateSeconds)).replace(/\s+/g, "");
const width = (elapsedSeconds: number, estimateSeconds = 20) => Number(markup(elapsedSeconds, estimateSeconds).match(/width:([\d.]+)%/)?.[1]);

describe("proposal wait countdown (offline rendering, no Luna call)", () => {
  it("starts from the usual Luna time and then follows the waits seen on this screen", () => {
    expect(proposalWaitEstimate([])).toBe(PROPOSAL_WAIT_DEFAULT_SECONDS);
    expect(proposalWaitEstimate([12.4])).toBe(15);
    expect(proposalWaitEstimate([11, 13, 30])).toBe(15);
    expect(proposalWaitEstimate([10, 14])).toBe(14);
    // Instant answers (nothing to choose from, AI unavailable) and waits past the limit are not samples.
    expect(proposalWaitEstimate([0.4, 1.2, 58])).toBe(PROPOSAL_WAIT_DEFAULT_SECONDS);
    expect(proposalWaitEstimate([3, 3])).toBe(8);
    expect(proposalWaitEstimate([49, 50])).toBe(45);
    expect([2.9, 3, 50, 50.1].map(proposalWaitSample)).toEqual([false, true, true, false]);
  });

  it("counts down the seconds, then says it is nearly done without filling the bar", () => {
    expect(text(0)).toContain("あと約20秒");
    expect(text(12.3)).toContain("あと約8秒");
    expect(text(19.2)).toContain("あと約1秒");
    expect(text(20)).toContain("まもなく完成します");
    expect(text(20)).not.toContain("あと約");
    expect([0, 10, 20].map(seconds => width(seconds))).toEqual([0, 45, 90]);
    expect(width(45)).toBeGreaterThan(90);
    expect(width(300)).toBeLessThan(100);
    expect(text(25)).not.toContain("遅れています");
  });

  it("explains a late answer in one short line and tells screen readers without reading every second", () => {
    expect(text(30)).toContain("AIの返事が遅れています。長くても50秒ほどで表示します。");
    expect(text(50)).toContain("通信に時間がかかっています。このままお待ちください。");
    expect(text(39, 30)).not.toContain("遅れています");
    expect(text(40, 30)).toContain("遅れています");
    const html = markup(5);
    expect(html).toContain('<p role="status" class="sr-only">提案を作成しています。20秒ほどかかります。</p>');
    expect(html).toContain('<div aria-hidden="true">');
  });
});
