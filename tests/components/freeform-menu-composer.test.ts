import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderMarkup, stripTags } from "../presentation/running/helpers";

vi.mock("@/actions/menu-composition-actions", () => ({ generateComposedMenuAction: vi.fn(), saveComposedMenuAction: vi.fn(), createManualComposedMenuAction: vi.fn() }));
vi.mock("@/actions/running-coach-preview-actions", () => ({ previewRunningCoachEditAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { FreeformMenuComposer } from "@/components/menu/freeform-menu-composer";
import { MenuItemForm } from "@/components/menu/menu-item-form";
import { legacyRunningExercise, runningSelectionValues } from "../presentation/running/menu-fixtures";

describe("Freeform composer UI and frozen Running boundary", () => {
  it("accepts Japanese wishes and offers manual creation without mandatory templates", () => {
    const html = renderMarkup(FreeformMenuComposer, { exercises: [] });
    const text = stripTags(html);
    expect(text).toContain("やりたい練習"); expect(text).toContain("メニュー案を作る"); expect(text).toContain("手動で作る");
    expect(text).not.toContain("対象グループ"); expect(text).not.toMatch(/Method|RuleSet|Template|STRIDE|ACCELERATION/);
  });
  it("contains no runtime video analysis, direct API or legacy Method/template picker", () => {
    const client = readFileSync("src/components/menu/freeform-menu-composer.tsx", "utf8");
    expect(client).not.toMatch(/\bfetch\s*\(|OPENAI|suggestPrescription|planRunningPrescription|RunningItemCreateForm|templatePicker/);
    const generation = readFileSync("src/application/menu-composition/generate.ts", "utf8");
    expect(generation).not.toMatch(/enrichExerciseVideo|VideoGuidanceAnalyzer|analyze\(/);
  });
  it("suppresses generic Running suggestions in new context even with legacy feature flag off", () => {
    const html = renderMarkup(MenuItemForm as never, { action: vi.fn(), exercises: [legacyRunningExercise], initial: runningSelectionValues(), submitLabel: "追加", runningPolicyContext: true, runningV2Enabled: false } as never);
    const text = stripTags(html);
    expect(text).not.toContain("推奨処方を入れる"); expect(text).not.toContain("練習の型"); expect(text).toContain("走の確認済み処方とコーチ調整");
  });
});
