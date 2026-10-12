import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderMarkup, stripTags } from "../presentation/running/helpers";

vi.mock("@/actions/menu-composition-actions", () => ({ generateComposedMenuAction: vi.fn(), saveComposedMenuAction: vi.fn(), createManualComposedMenuAction: vi.fn() }));
vi.mock("@/actions/running-coach-preview-actions", () => ({ previewRunningCoachEditAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { durationBasisKey } from "@/domain/menu-composition/duration";
import { ComposedExerciseContent } from "@/components/menu/composed-item-content";
import { FreeformMenuComposer } from "@/components/menu/freeform-menu-composer";
import { SavedMenuDurationEditor } from "@/components/menu/saved-menu-duration-editor";
import { MenuItemForm } from "@/components/menu/menu-item-form";
import type { MenuItemFormValues } from "@/components/menu/menu-item-form";
import { legacyRunningExercise, runningSelectionValues, legacyDrillExercise, legacyBlock, legacyMenuItem, legacyBlockMarkup } from "../presentation/running/menu-fixtures";

describe("Freeform composer UI and frozen Running boundary", () => {
  it("accepts Japanese wishes and offers manual creation without mandatory templates", () => {
    const html = renderMarkup(FreeformMenuComposer, { exercises: [] });
    const text = stripTags(html);
    expect(text).toContain("やりたい練習"); expect(text).toContain("メニュー案を作る"); expect(text).toContain("手動で作る");
    expect(text).toContain("対象・走の条件を補足する（任意）");
    expect(text).not.toContain("対象グループ"); expect(text).not.toMatch(/Method|RuleSet|Template|STRIDE|ACCELERATION/);
  });
  it("shows saved menus as a compact summary with duration editing collapsed", () => {
    const composition = { blocks: [{ id: "block-1", name: "動きづくり", items: [{
      id: "item-1", type: "CATALOG_EXERCISE" as const, exerciseId: "exercise-1", displayName: "ニーアップウォーク",
      executionInstruction: "姿勢を保って行う", plannedNote: "", reason: "", plannedSets: 2, plannedReps: null,
      plannedDurationSeconds: 30, plannedDistanceMeters: null, plannedRestSeconds: 30,
    }] }] };
    const html = renderMarkup(SavedMenuDurationEditor, { menuId: "menu-1", sourceFingerprint: "fingerprint",
      composition, running: null, requestedSeconds: 1200,
      plan: { blocks: [{ blockId: "block-1", phase: "DRILLS_STRENGTH" as const, allocatedSeconds: 1200 }], transitionSeconds: 0 } });
    expect(html).toContain("<details>");
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(stripTags(html)).toContain("計画枠 20分");
    expect(stripTags(html)).toContain("時間配分を調整");
    expect(html).toContain('aria-label="動きづくりの配分（分）"');
    expect(stripTags(html)).toContain("時間配分を保存");
    expect(stripTags(html)).toContain("実際の所要時間を保証するものでもありません。");
  });
  it("keeps a stale estimate visibly invalid in the collapsed saved-menu summary", () => {
    const originalItem = { id: "item-1", type: "CATALOG_EXERCISE" as const, exerciseId: "exercise-1", displayName: "ドリル",
      executionInstruction: "ゆっくり行う", plannedNote: "", reason: "", plannedSets: 1, plannedReps: 10,
      plannedDurationSeconds: null, plannedDistanceMeters: null, plannedRestSeconds: 0 };
    const block = { id: "block-1", name: "動きづくり", items: [originalItem] };
    const html = renderMarkup(SavedMenuDurationEditor, { menuId: "menu-1", sourceFingerprint: "fingerprint",
      composition: { blocks: [{ ...block, items: [{ ...originalItem, plannedReps: 15 }] }] }, running: null, requestedSeconds: 120,
      plan: { blocks: [{ blockId: block.id, phase: "DRILLS_STRENGTH" as const, allocatedSeconds: 120,
        allocationBasis: { durationBasisKey: durationBasisKey(block, null), itemEstimatesSeconds: [60], preparationSeconds: 60,
          explanation: "編集前の10回の見積もり", preparationDescription: "準備" } }], transitionSeconds: 0 } });
    const text = stripTags(html);
    expect(text).toContain("旧配分 2分");
    expect(text).toContain("内容変更前の見積もりは無効です");
    expect(text).toContain("実測時間ではありません");
    expect(text).not.toContain("編集前の10回の見積もり");
    expect(text).not.toContain("配分内訳の合計は一致");
  });
  it("explains that a per-side count of ten means ten on each side", () => {
    const html = renderMarkup(ComposedExerciseContent, { item: { type: "CATALOG_EXERCISE", exerciseId: "exercise-1", displayName: "左右ドリル",
      executionInstruction: "左右10回ずつ行う", plannedNote: "", reason: "", plannedSets: 1, plannedReps: 10,
      plannedDurationSeconds: null, plannedDistanceMeters: null, plannedRestSeconds: 0 } });
    expect(stripTags(html)).toContain("回数欄は片側ごとの回数です（左右それぞれ10回）。");
    expect(stripTags(html)).not.toContain("20回");
  });
  it.each([
    ["PER_SIDE", "10", "片側ごとの回数", "回数は片側ごと（左右それぞれ10回）です。"],
    ["TOTAL_REPS", "20", "合計の回数", "回数は合計（合計20回）です。"],
    ["ALTERNATING_TOTAL", "20", "合計の回数", "回数は合計（合計20回）です。"],
  ] as const)("preserves approved %s labels in saved rows and the edit form", (countingUnit, reps, label, rowLabel) => {
    const countingUnits = { "ex-1": countingUnit };
    const initial: MenuItemFormValues = { ...runningSelectionValues(), exerciseId: "ex-1", reps, distanceMeters: "", note: "左右10回ずつ行う" };
    const html = renderMarkup(MenuItemForm as never, { action: vi.fn(), exercises: [legacyDrillExercise], initial,
      submitLabel: "保存", runningPolicyContext: true, countingUnits } as never);
    expect(stripTags(html)).toContain(label);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toMatch(new RegExp(`<input[^>]*name="reps"[^>]*value="${reps}"`));
    if (countingUnit !== "PER_SIDE") expect(stripTags(html)).not.toContain("片側ごとの回数");
    const row = legacyBlockMarkup({ block: legacyBlock([legacyMenuItem({ note: initial.note, reps: Number(reps) })]), countingUnits });
    expect(stripTags(row)).toContain(rowLabel);
    if (countingUnit !== "PER_SIDE") expect(stripTags(row)).not.toContain("回数は片側ごと");
  });
  it("uses explicit side wording when saved counting guidance is unavailable", () => {
    const initial: MenuItemFormValues = { ...runningSelectionValues(), exerciseId: "ex-1", reps: "10", distanceMeters: "", note: "左右10回ずつ行う" };
    const html = renderMarkup(MenuItemForm as never, { action: vi.fn(), exercises: [legacyDrillExercise], initial, submitLabel: "保存" } as never);
    expect(stripTags(html)).toContain("片側ごとの回数");
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
  it("keeps a saved unprescribed Running placeholder out of the exercise picker and recommendation flow", () => {
    const initial: MenuItemFormValues = { exerciseId: "", displayName: "走（未処方）", sets: "", reps: "", distanceMeters: "", durationSeconds: "", restSeconds: "", intensityPercent: "", loadKg: "", note: "" };
    const html = renderMarkup(MenuItemForm as never, { action: vi.fn(), exercises: [legacyRunningExercise], initial,
      submitLabel: "保存", runningPolicyContext: true, unprescribedRunning: { reasonCode: "MISSING_CONTEXT", reasonMessage: "年齢・種目の条件が不足しています。" } } as never);
    const text = stripTags(html);
    expect(text).toContain("走・未処方"); expect(text).toContain("年齢・種目の条件が不足しています。");
    expect(text).toContain("Engineの処方・推奨値はありません");
    expect(html).not.toContain("カタログから選ぶ"); expect(text).not.toContain("推奨処方を入れる");
    expect(text).not.toContain("手入力（Engine未処方）");
  });
});
