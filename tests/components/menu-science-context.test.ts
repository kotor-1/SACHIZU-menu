import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { FreeformMenuComposer } from "@/components/menu/freeform-menu-composer";
import { menuCompositionContextSchema } from "@/domain/menu-composition/contracts";
import { renderMarkup, stripTags } from "../presentation/running/helpers";

describe("menu science context entry", () => {
  it("offers optional explicit context without inferring maturity from age or school grade", () => {
    const text = stripTags(renderMarkup(FreeformMenuComposer, { exercises: [] }));
    expect(text).toContain("走の補足情報（わかる範囲で任意）");
    expect(text).toContain("学年や年齢から成熟度・経験を推定しません");
    expect(text).toContain("初心者");
    expect(text).toContain("成熟度（自己申告・任意）");
    expect(text).toContain("直近7日間の高強度練習");
    expect(text).toContain("制御した90〜95%走");
  });

  it("accepts the optional nested context and rejects unsupported fields", () => {
    expect(menuCompositionContextSchema.safeParse({ science: {
      ageYears: 16, experience: "EXPERIENCED", maturity: "CIRCA", supervised: true,
      symptomFree: true, familiarWithSprint: true, hoursSinceHighIntensity: 48,
      hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 2,
      speedEnduranceMode: "CONTROLLED_90_95", referenceDistanceMeters: 60, referenceTimeSeconds: 12.4,
    } }).success).toBe(true);
    expect(menuCompositionContextSchema.safeParse({ science: { ageYears: 12, inferredMaturityFromGrade: "PRE" } }).success).toBe(false);
  });
});
