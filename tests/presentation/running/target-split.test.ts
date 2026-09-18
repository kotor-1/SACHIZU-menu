/**
 * R10-B4A.2 — コーチ入力の目標スプリットの表示と入力コンポーネント。
 */
import { describe, expect, it, vi } from "vitest";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { toCoachReferenceInput } from "@/domain/running/planning/coachReference";
import { TargetSplitEditor } from "@/components/running/target-split-editor";
import { RunningItemEditor } from "@/components/running/running-item-editor";
import { MethodTemplatePicker } from "@/components/running/method-template-picker";
import type { TargetSplitSegmentDraft } from "@/presentation/running/dto";
import { presentDose } from "@/presentation/running/dose";
import { presentRunningItem } from "@/presentation/running/item";
import { presentTemplatePicker } from "@/presentation/running/template";
import { buildCoachReferenceEditRequest, buildTargetSplitInput, targetSplitDraftsFrom } from "@/presentation/running/target-split";
import { planAcc, planLsrIncomplete, provenanceFor } from "../../repository/running/fixtures";
import { expandTree, findAll, buttonByText, productionRuleSet, rawKeyLeaks, renderMarkup, stripTags, textOf } from "./helpers";

const SPLIT = toCoachReferenceInput({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }, { distanceM: 100, targetTimeS: 13.5 }] });

function longFullPrescription(): RunningPrescriptionValue {
  const p = structuredClone(planLsrIncomplete());
  p.intensity = { reference: SPLIT, target: null } as RunningPrescriptionValue["intensity"];
  return p;
}

function draft(distanceText: string, targetTimeText: string): TargetSplitSegmentDraft {
  return { distanceText, targetTimeText };
}

describe("R10-B4A.2: 入力値の組み立て（純粋関数）", () => {
  it("区間が1つも無ければ Action へ送らない", () => {
    expect(buildTargetSplitInput([])).toEqual({ ok: false, message: "目標スプリットの区間を1つ以上入力してください。" });
  });

  it("0以下・空欄・数値でない入力は、区間の番号付きで拒否する", () => {
    expect(buildTargetSplitInput([draft("300", "")])).toEqual({ ok: false, message: "区間1の距離と目標タイムは、0より大きい数値で入力してください。" });
    expect(buildTargetSplitInput([draft("300", "38"), draft("0", "13")])).toEqual({ ok: false, message: "区間2の距離と目標タイムは、0より大きい数値で入力してください。" });
    expect(buildTargetSplitInput([draft("abc", "38")]).ok).toBe(false);
  });

  it("正しい入力は domain の入力形へ（自動補完しない）", () => {
    const built = buildTargetSplitInput([draft("300", "38"), draft("100", "13.5")]);
    expect(built).toMatchObject({ ok: true, value: { kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }, { distanceM: 100, targetTimeS: 13.5 }] } });
    if (!built.ok) throw new Error("unreachable");
    expect(JSON.parse(built.json)).toEqual(built.value);
    expect(buildCoachReferenceEditRequest("item-1", [draft("300", "38")], ["AGG_TOTAL_RUNNING_CONFIRM"])).toEqual({
      ok: true,
      request: { itemId: "item-1", coachReference: { kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }] }, confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM"] },
    });
  });

  it("保存済みの exact な区間からだけ初期値を作る（保存が無ければ空。距離を自動で入れない）", () => {
    expect(targetSplitDraftsFrom(null)).toEqual([]);
    expect(targetSplitDraftsFrom([{ distanceM: 300, targetTimeS: 38 }])).toEqual([draft("300", "38")]);
  });
});

describe("R10-B4A.2: 表示", () => {
  it("基準は「コーチ設定の目標スプリット」。区間は「300m：38秒」の形で出し、内部 enum を出さない", () => {
    const dose = presentDose(longFullPrescription());
    expect(dose.intensityLabel).toBe("コーチ設定の目標スプリット");
    expect(dose.coachTargetSplit).toEqual({
      heading: "コーチ設定の目標スプリット",
      segments: [
        { distanceLabel: "300m", targetTimeLabel: "38秒" },
        { distanceLabel: "100m", targetTimeLabel: "13.5秒" },
      ],
    });
    // GROUP ではエンジンの目標タイムを出さない
    expect(dose.intensityTargetLabel).toBeNull();
  });

  it("ATHLETE の合計目標は「コーチ設定の目標タイム」と示す（エンジンが推定した個別目標と区別する）", () => {
    const p = longFullPrescription();
    p.intensity = { reference: SPLIT, target: { lower: 51.5, upper: 51.5, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } } as RunningPrescriptionValue["intensity"];
    expect(presentDose(p).intensityTargetLabel).toBe("コーチ設定の目標タイム 51.5秒");
  });

  it("editor DTO は保存済みの exact な区間と、この Method が入力を受け付けるかを持つ", () => {
    const item = presentRunningItem({
      id: "i1",
      displayName: null,
      rationale: "r",
      prescription: longFullPrescription(),
      provenance: provenanceFor(planLsrIncomplete()),
      exactRuleSet: { status: "OK", ruleSet: productionRuleSet() },
    });
    expect(item.editor.targetSplit).toEqual({ current: [{ distanceM: 300, targetTimeS: 38 }, { distanceM: 100, targetTimeS: 13.5 }], acceptsInput: true });

    const acc = presentRunningItem({
      id: "i2",
      displayName: null,
      rationale: "r",
      prescription: planAcc(),
      provenance: null,
      exactRuleSet: { status: "OK", ruleSet: productionRuleSet() },
    });
    expect(acc.editor.targetSplit).toEqual({ current: null, acceptsInput: false });

    const unknownRuleSet = presentRunningItem({ id: "i3", displayName: null, rationale: "r", prescription: longFullPrescription(), provenance: null, exactRuleSet: { status: "UNAVAILABLE" } });
    expect(unknownRuleSet.editor.targetSplit.acceptsInput).toBeNull();
  });

  it("picker は RuleSet のデータから、目標スプリットを入力できる型かどうかを持つ", () => {
    const options = presentTemplatePicker(productionRuleSet()).groups.flatMap((g) => g.options);
    expect(options.find((o) => o.templateIdInternal === "LSR_SPECIAL_ENDURANCE_I")!.acceptsCoachTargetSplit).toBe(true);
    expect(options.find((o) => o.templateIdInternal === "EA_JUMP_FULL_APPROACH")!.acceptsCoachTargetSplit).toBe(true);
    expect(options.find((o) => o.templateIdInternal === "ACC_BLOCK_30")!.acceptsCoachTargetSplit).toBe(false);
    expect(rawKeyLeaks(renderMarkup(MethodTemplatePicker, { picker: presentTemplatePicker(productionRuleSet()), value: null, onSelect: () => {}, idPrefix: "pk" }))).toEqual([]);
  });

  it("editor の DOM に区間が出て、内部キーは漏れない", () => {
    const item = presentRunningItem({
      id: "i4",
      displayName: null,
      rationale: "r",
      prescription: longFullPrescription(),
      provenance: provenanceFor(planLsrIncomplete()),
      exactRuleSet: { status: "OK", ruleSet: productionRuleSet() },
    });
    const markup = renderMarkup(RunningItemEditor, {
      value: item,
      fieldDrafts: {},
      confirmationState: { confirmedKeys: [] },
      overrideState: null,
      onChange: () => {},
      onConfirmationChange: () => {},
      onOverrideChange: () => {},
    });
    const text = stripTags(markup);
    expect(text).toMatch(/コーチ設定の目標スプリット/);
    expect(text).toMatch(/300m：38秒/);
    expect(rawKeyLeaks(markup)).toEqual([]);
  });
});

describe("R10-B4A.2: TargetSplitEditor", () => {
  const baseProps = (segments: TargetSplitSegmentDraft[], onChange = vi.fn()) => ({ idPrefix: "ts", segments, onChange });

  it("区間の追加・削除・入力を controlled に返す（自動で距離やタイムを入れない）", () => {
    const empty = baseProps([]);
    const emptyTree = expandTree(TargetSplitEditor(empty));
    expect(textOf(emptyTree)).toMatch(/区間がまだありません/);
    (buttonByText(emptyTree, "区間を追加")[0]!.props.onClick as () => void)();
    expect(empty.onChange).toHaveBeenCalledWith([{ distanceText: "", targetTimeText: "" }]);

    const filled = baseProps([draft("300", "38"), draft("100", "13")]);
    const tree = expandTree(TargetSplitEditor(filled));
    const distanceInput = findAll(tree, (n) => n.type === "input" && n.props.id === "ts-distance-0")[0]!;
    (distanceInput.props.onChange as (e: unknown) => void)({ currentTarget: { value: "350" } });
    expect(filled.onChange).toHaveBeenLastCalledWith([draft("350", "38"), draft("100", "13")]);

    const timeInput = findAll(tree, (n) => n.type === "input" && n.props.id === "ts-time-1")[0]!;
    (timeInput.props.onChange as (e: unknown) => void)({ currentTarget: { value: "12.5" } });
    expect(filled.onChange).toHaveBeenLastCalledWith([draft("300", "38"), draft("100", "12.5")]);

    const remove = findAll(tree, (n) => n.type === "button" && n.props["aria-label"] === "区間2を削除")[0]!;
    (remove.props.onClick as () => void)();
    expect(filled.onChange).toHaveBeenLastCalledWith([draft("300", "38")]);
  });

  it("入力欄にラベルが紐づき、削除ボタンに読み上げ用の名前がある。タップ領域は 44px 以上", () => {
    const tree = expandTree(TargetSplitEditor(baseProps([draft("300", "38")])));
    for (const input of findAll(tree, (n) => n.type === "input")) {
      expect(findAll(tree, (n) => n.type === "label" && n.props.htmlFor === input.props.id), String(input.props.id)).toHaveLength(1);
      expect(String(input.props.className)).toMatch(/h-11/);
    }
    for (const button of findAll(tree, (n) => n.type === "button")) {
      expect(button.props.type).toBe("button");
      expect(String(button.props.className)).toMatch(/\b(h-11|min-h-11)\b/);
    }
    expect(findAll(tree, (n) => n.type === "button" && n.props["aria-label"] === "区間1を削除")).toHaveLength(1);
  });

  it("disabled と入力エラーを表示でき、内部キーを出さない", () => {
    const markup = renderMarkup(TargetSplitEditor, {
      idPrefix: "ts",
      segments: [draft("300", "")],
      onChange: () => {},
      disabled: true,
      errorMessage: buildTargetSplitInput([draft("300", "")]).ok ? null : "区間1の距離と目標タイムは、0より大きい数値で入力してください。",
    });
    expect(markup).toContain('role="alert"');
    expect(stripTags(markup)).toMatch(/区間1の距離と目標タイム/);
    const tree = expandTree(TargetSplitEditor({ idPrefix: "ts", segments: [draft("300", "")], onChange: () => {}, disabled: true }));
    for (const node of findAll(tree, (n) => n.type === "input" || n.type === "button")) expect(node.props.disabled).toBe(true);
    expect(rawKeyLeaks(markup)).toEqual([]);
  });
});
