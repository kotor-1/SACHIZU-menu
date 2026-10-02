import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposedExerciseContent, safeExerciseVideoUrl } from "@/components/menu/composed-item-content";
import { runningMinimumPlannedSeconds } from "@/presentation/menu-composition/planned-time";
import { catalogFixture, catalogPlan, freeformPlan } from "../fixtures/menu-composition";

describe("Composed preview communicates content and quantity", () => {
  it("shows catalog description, dose, instructions, coaching and video", () => {
    const html = renderToStaticMarkup(createElement(ComposedExerciseContent, { item: catalogPlan(), exercise: catalogFixture() }));
    for (const text of ["肘をついて身体をまっすぐ保つ", "腰を反らさない", "AIの提案", "動画を見る", "30秒", "実施指示", "選択理由"]) expect(html).toContain(text);
  });
  it("makes absent dose explicit while keeping freeform user instructions", () => {
    const html = renderToStaticMarkup(createElement(ComposedExerciseContent, { item: freeformPlan({ plannedReps: null }), aiProposed: false }));
    expect(html).toContain("量未設定"); expect(html).toContain('data-dose-state="UNCONFIGURED"'); expect(html).toContain("元の希望");
  });
  it("does not expose unsafe media schemes", () => {
    expect(safeExerciseVideoUrl("javascript:alert(1)")).toBeNull(); expect(safeExerciseVideoUrl("/tmp/video.mp4")).toBeNull();
  });
  it("counts 2 inter-rep rests for 3 reps; split rests use between-set semantics", () => {
    const base = { totalReps: 3, repRestSeconds: 900, setReps: null, setRestSeconds: null, coachTargetTimeSeconds: null, coachTargetTimeRange: null };
    expect(runningMinimumPlannedSeconds(base)).toBe(1800);
    expect(runningMinimumPlannedSeconds({ ...base, coachTargetTimeSeconds: 15 })).toBe(1845);
    expect(runningMinimumPlannedSeconds({ ...base, totalReps: 4, setReps: [2, 2], setRestSeconds: 1200 })).toBe(3000);
  });
});
