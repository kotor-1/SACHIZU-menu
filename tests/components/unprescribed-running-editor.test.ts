import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { UnprescribedRunningEditor } from "@/components/menu/unprescribed-running-editor";
import type { UnprescribedRunningItem } from "@/domain/menu-composition/unprescribed-running";
import { expandTree, findAll, renderMarkup, stripTags, type HostTree } from "../presentation/running/helpers";

const base: UnprescribedRunningItem = {
  type: "UNPRESCRIBED_RUNNING", id: "draft-running-1", reasonCode: "MISSING_CONTEXT",
  reasonMessage: "年齢・種目の条件が不足しています。", plannedNote: "",
  plannedSets: null, plannedReps: null, plannedDistanceMeters: null, plannedDurationSeconds: null,
  plannedRestSeconds: null, plannedIntensityPercent: null,
};

function inputByLabel(tree: HostTree[], label: string) {
  const input = findAll(tree, (node) => node.type === "input" && node.props["aria-label"] === label)[0];
  if (!input) throw new Error(`missing input ${label}`);
  return input;
}

describe("UnprescribedRunningEditor", () => {
  it("starts with no dose values, explains the missing prescription, and keeps all fields editable", () => {
    const html = renderMarkup(UnprescribedRunningEditor, { item: base, onChange: vi.fn() });
    const text = stripTags(html);
    expect(text).toContain("走・未処方");
    expect(text).toContain(base.reasonMessage);
    expect(text).toContain("Engineの処方・推奨値はありません");
    expect(text).not.toContain("手入力（Engine未処方）");
    const tree = expandTree(createElement(UnprescribedRunningEditor, { item: base, onChange: vi.fn() }));
    for (const label of ["セット数", "回数", "距離（m）", "1本の時間（秒）", "休息（秒）", "強度（%）"]) {
      expect(inputByLabel(tree, label).props.value).toBe("");
    }
    expect(inputByLabel(tree, "強度（%）").props).toMatchObject({ min: 1, max: 100, step: 1 });
  });

  it("marks numeric edits as manual and preserves them as a patch, without a prescription action", () => {
    const onChange = vi.fn();
    const tree = expandTree(createElement(UnprescribedRunningEditor, { item: base, onChange }));
    (inputByLabel(tree, "距離（m）").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "120" } });
    expect(onChange).toHaveBeenCalledWith({ plannedDistanceMeters: 120 });
    const manual = renderMarkup(UnprescribedRunningEditor, { item: { ...base, plannedDistanceMeters: 120 }, onChange });
    expect(stripTags(manual)).toContain("手入力（Engine未処方）");
    expect(stripTags(manual)).not.toContain("推奨処方を入れる");
  });
});
