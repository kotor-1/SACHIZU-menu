import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { MenuDurationEditor } from "@/components/menu/menu-duration-editor";
import { durationBasisKey, type DurationPlan } from "@/domain/menu-composition/duration";
import type { EditableComposition } from "@/domain/menu-composition/contracts";
import { expandTree, findAll, renderMarkup, stripTags, type HostTree } from "../presentation/running/helpers";

const blockId = "62cdb944-7713-4772-91a5-2f76937c62ed";
const blockItem = {
  id: "item-1", type: "CATALOG_EXERCISE" as const, exerciseId: "exercise-1", displayName: "時間計測ドリル",
  executionInstruction: "", plannedNote: "", reason: "", plannedSets: 2, plannedReps: null,
  plannedDurationSeconds: 30, plannedDistanceMeters: null, plannedRestSeconds: 30,
};
const composition: EditableComposition = { blocks: [{ id: blockId, name: "準備", items: [blockItem] }] };
const plan: DurationPlan = { blocks: [{ blockId, phase: "WARM_UP", allocatedSeconds: 60 }], transitionSeconds: 0 };

function inputByLabel(nodes: HostTree[], label: string) {
  const input = findAll(nodes, (node) => node.type === "input" && node.props["aria-label"] === label)[0];
  if (!input) throw new Error(`missing input: ${label}`);
  return input;
}

describe("MenuDurationEditor", () => {
  it("shows known lower-bound time, under-allocation and explicit planning-only meaning", () => {
    const html = renderMarkup(MenuDurationEditor, {
      composition, running: null, requestedSeconds: 50, plan, onChange: vi.fn(),
    });
    const text = stripTags(html);
    expect(text).toContain("1分30秒"); // 2 x 30s work + 30s rest
    expect(text).toContain("配分が既知の最低時間を下回っています。");
    expect(text).toContain("実際の所要時間を保証するものでもありません。");
    expect(text).toContain("目安時間を超えています");
  });

  it("formats negative budget differences by magnitude and does not claim equality without a target", () => {
    const emptyComposition: EditableComposition = { blocks: [{ id: blockId, name: "準備", items: [] }] };
    const oneMinute: DurationPlan = { blocks: [{ blockId, phase: "WARM_UP", allocatedSeconds: 60 }], transitionSeconds: 0 };
    const shortHtml = renderMarkup(MenuDurationEditor, {
      composition: emptyComposition, running: null, requestedSeconds: 90, plan: oneMinute, onChange: vi.fn(),
    });
    const shortText = stripTags(shortHtml).replace(/\s+/gu, " ").trim();
    expect(shortText).toMatch(/希望との差：\s*−30秒\s*（残り）/u);
    expect(shortText).not.toContain("−1分-30秒");

    const noTargetHtml = renderMarkup(MenuDurationEditor, {
      composition: emptyComposition, running: null, requestedSeconds: null, plan: oneMinute, onChange: vi.fn(),
    });
    const noTargetText = stripTags(noTargetHtml).replace(/\s+/gu, "");
    expect(noTargetText).toMatch(/希望との差：\s*目安時間は未指定です/u);
    expect(noTargetText).not.toContain("（一致）");
    expect(noTargetText).toContain("クールダウン：未割当（必要性を確認。ブロックや配分を自動追加しません。）");
  });

  it.each([
    ["dose", { plannedSets: 3 }],
    ["exercise", { exerciseId: "exercise-2" }],
    ["instruction", { executionInstruction: "左右それぞれ丁寧に実施する" }],
  ])("invalidates the prior estimate visibly after a %s edit", (_field, patch) => {
    const priorPlan: DurationPlan = { blocks: [{ blockId, phase: "WARM_UP", allocatedSeconds: 180,
      allocationBasis: { durationBasisKey: durationBasisKey(composition.blocks[0]!, null), itemEstimatesSeconds: [90],
        preparationSeconds: 90, explanation: "保存前の見積もりの説明", preparationDescription: "器具の準備" } }], transitionSeconds: 0 };
    const changed: EditableComposition = { blocks: [{ ...composition.blocks[0]!, items: [{ ...blockItem, ...patch }] }] };
    const html = renderMarkup(MenuDurationEditor, { composition: changed, running: null, requestedSeconds: 180, plan: priorPlan, onChange: vi.fn() });
    const text = stripTags(html);
    expect(text).toContain("以前の時間見積もりは無効です");
    expect(text).toContain("旧配分を含む合計");
    expect(text).not.toContain("保存前の見積もりの説明");
    expect(text).not.toContain("配分が目安時間に一致しています");
    expect(text).toContain("実際に計測した時間ではありません");
  });

  it("does not certify an outdated basis just because a user changes its allocation minutes", () => {
    const onChange = vi.fn();
    const originalKey = durationBasisKey(composition.blocks[0]!, null);
    const priorPlan: DurationPlan = { blocks: [{ blockId, phase: "WARM_UP", allocatedSeconds: 180,
      allocationBasis: { durationBasisKey: originalKey, itemEstimatesSeconds: [90], preparationSeconds: 90,
        explanation: "以前の見積もり", preparationDescription: "器具の準備" } }], transitionSeconds: 0 };
    const changed: EditableComposition = { blocks: [{ ...composition.blocks[0]!, items: [{ ...blockItem, plannedSets: 3 }] }] };
    const nodes = expandTree(createElement(MenuDurationEditor, { composition: changed, running: null, requestedSeconds: 180, plan: priorPlan, onChange }));
    (inputByLabel(nodes, "準備の配分（分）").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "5" } });
    const updated = onChange.mock.calls[0]![0] as DurationPlan;
    expect(updated.blocks[0]!.allocatedSeconds).toBe(300);
    expect(updated.blocks[0]!.allocationBasis!.durationBasisKey).toBe(originalKey);
    expect(stripTags(renderMarkup(MenuDurationEditor, { composition: changed, running: null, requestedSeconds: 300, plan: updated, onChange }))).toContain("以前の時間見積もりは無効です");
  });

  it("converts block minutes to seconds and changes phase without mutating doses", () => {
    const onChange = vi.fn();
    const nodes = expandTree(createElement(MenuDurationEditor, {
      composition, running: null, requestedSeconds: 600, plan, onChange,
    }));
    const allocation = inputByLabel(nodes, "準備の配分（分）");
    (allocation.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "12.5" } });
    expect(onChange).toHaveBeenLastCalledWith({
      blocks: [{ blockId, phase: "WARM_UP", allocatedSeconds: 750 }], transitionSeconds: 0,
    });
    const phase = findAll(nodes, (node) => node.type === "select" && node.props["aria-label"] === "準備の時間分類")[0];
    (phase!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "DRILLS_STRENGTH" } });
    expect(onChange).toHaveBeenLastCalledWith({
      blocks: [{ blockId, phase: "DRILLS_STRENGTH", allocatedSeconds: 60 }], transitionSeconds: 0,
    });
    expect(composition.blocks[0]!.items[0]).toEqual(blockItem);
  });

  it("keeps blank allocations unknown and permits a zero transition", () => {
    const onChange = vi.fn();
    const nodes = expandTree(createElement(MenuDurationEditor, {
      composition, running: null, requestedSeconds: null,
      plan: { blocks: [{ blockId, phase: "OTHER", allocatedSeconds: null }], transitionSeconds: null }, onChange,
    }));
    (inputByLabel(nodes, "準備の配分（分）").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({
      blocks: [{ blockId, phase: "OTHER", allocatedSeconds: null }], transitionSeconds: null,
    });
    (inputByLabel(nodes, "ブロック間の移動・準備時間（分）").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith({
      blocks: [{ blockId, phase: "OTHER", allocatedSeconds: null }], transitionSeconds: 0,
    });
  });
});
