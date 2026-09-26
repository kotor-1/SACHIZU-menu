/**
 * R10-B3 — components/running/* の表示・操作 contract（新しい test 依存なし）。
 *
 * - react-dom/server の静的レンダリングで DOM 出力を検査（内部キー漏れ・a11y・タップ領域）
 * - hooks を持たない component は要素ツリーへ展開し、callback（確認チェック・override・再計算・選択）を直接呼ぶ
 */
import { describe, expect, it, vi } from "vitest";
import type { Finding } from "@/domain/running/types/findings";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { MethodTemplatePicker, MethodTemplatePickerView } from "@/components/running/method-template-picker";
import { RunningItemEditor, type RunningItemEditorProps } from "@/components/running/running-item-editor";
import type { OverrideDraft, RunningItemPresentationDto } from "@/presentation/running/dto";
import { buildFieldEditRequest, buildOverrideRequest } from "@/presentation/running/editor-requests";
import { overrideRequiresDoubleConfirmation, presentEligibilityOverrides } from "@/presentation/running/editor";
import { presentFindings } from "@/presentation/running/findings";
import { presentRunningItem } from "@/presentation/running/item";
import { presentSavedRunningMenuItem } from "@/presentation/running/server";
import { presentTemplatePicker } from "@/presentation/running/template";
import { filterTemplateGroups } from "@/presentation/running/template-search";
import { renderRationaleJa } from "@/domain/running/rationale/render-ja";
import {
  planAcc,
  planAssisted,
  planEa,
  planLsrIncomplete,
  planMvFly20,
  planRs,
  planSes,
  planStride,
  planTe,
  planTi,
  provenanceFor,
} from "../../repository/running/fixtures";
import {
  buttonByText,
  dtoRawKeyLeaks,
  expandTree,
  findAll,
  productionRuleSet,
  rawKeyLeaks,
  renderMarkup,
  stripTags,
  textOf,
  type HostNode,
} from "./helpers";

const PLANS = { planAcc, planMvFly20, planSes, planLsrIncomplete, planTe, planTi, planRs, planAssisted, planEa, planStride };

describe("R10-B3: interval plausibility wording", () => {
  it("possible exceed の文言はpolicyとcertaintyの両方で分ける", () => {
    const possibleFinding = (policy: NonNullable<Finding["plausibility"]>["policy"], ruleId: string): Finding => ({
      code: "PLAUSIBILITY_NOT_DETERMINABLE",
      severity: "BLOCK",
      scope: "SESSION",
      metric: ruleId,
      plausibility: { ruleId, policy, certainty: "POSSIBLE_EXCEED", presentationKind: "INTERVAL_UNCERTAIN" },
      evidenceIds: [],
    });
    const method = presentFindings([possibleFinding("METHOD_POLICY_HARD", "PLA_ITEM_DISTANCE_STANDARD")])[0]!;
    const product = presentFindings([possibleFinding("PRODUCT_DATA_SANITY_HARD", "PLA_MENU_TOTAL_DISTANCE")])[0]!;
    const review = presentFindings([possibleFinding("COACH_OVERRIDABLE_STRONG_REVIEW", "PLA_ITEM_TOTAL_DISTANCE")])[0]!;

    expect(method.message).toMatch(/練習の型の定義から外れる可能性/);
    expect(product.message).toMatch(/メニュー総距離の推定範囲が、アプリのデータ確認基準を超える可能性/);
    expect(product.message).not.toMatch(/方法上/);
    expect(review.message).toMatch(/通常の処方範囲を大きく外れる可能性/);
  });
});

function savedItem(p: RunningPrescriptionValue, id = "item-1", sessionFindings: Finding[] = []): RunningItemPresentationDto {
  const result = presentSavedRunningMenuItem(
    {
      id,
      displayName: null,
      rationale: renderRationaleJa(p.rationale).join("\n"),
      prescriptionKind: "RUNNING_V2",
      prescriptionJson: JSON.stringify(p),
      provenanceJson: JSON.stringify(provenanceFor(p)),
      ruleSetVersion: p.ruleSet.version,
      ruleSetContentHash: p.ruleSet.contentHash,
    },
    { sessionFindings },
  );
  if (result.status !== "OK") throw new Error(result.status);
  return result.item;
}

function editorProps(value: RunningItemPresentationDto, overrides: Partial<RunningItemEditorProps> = {}): RunningItemEditorProps {
  return {
    value,
    fieldDrafts: {},
    confirmationState: { confirmedKeys: [] },
    overrideState: null,
    onChange: vi.fn(),
    onConfirmationChange: vi.fn(),
    onOverrideChange: vi.fn(),
    onEditRequest: vi.fn(),
    onOverrideRequest: vi.fn(),
    onRecalculateRequest: vi.fn(),
    ...overrides,
  };
}

function click(node: HostNode) {
  (node.props.onClick as () => void)();
}
function changeValue(node: HostNode, value: string) {
  (node.props.onChange as (e: unknown) => void)({ currentTarget: { value } });
}
function toggle(node: HostNode, checked: boolean) {
  (node.props.onChange as (e: unknown) => void)({ currentTarget: { checked } });
}

// ---------------------------------------------------------------------------
// 内部キー漏れ
// ---------------------------------------------------------------------------

describe("R10-B3: 内部キーを DOM / DTO の表示文字列へ出さない", () => {
  it.each(Object.entries(PLANS))("%s: editor の DOM と DTO に enum key が出ない", (_name, plan) => {
    const item = savedItem(plan(), "item-leak", [
      { code: "AGG_TOTAL_RUNNING_CONFIRM", severity: "REQUIRE_CONFIRMATION", scope: "SESSION", evidenceIds: [] } as Finding,
      { code: "WEEKLY_HIGH_WITHIN_48H", severity: "BLOCK_AUTOGEN", scope: "WEEK", evidenceIds: [] } as Finding,
      { code: "WEEKLY_HIGH_WITHIN_48H", severity: "REQUIRE_COACH_REVIEW", scope: "WEEK", evidenceIds: [] } as Finding,
    ]);
    const pendingConfirmationFindings = presentFindings([
      { code: "AGG_TOTAL_RUNNING_CONFIRM", severity: "REQUIRE_CONFIRMATION", scope: "SESSION", evidenceIds: [] } as Finding,
      { code: "PLAUSIBILITY_REQUIRE_CONFIRMATION", severity: "REQUIRE_CONFIRMATION", scope: "ITEM", metric: "PLA_REP_REST", evidenceIds: [] } as Finding,
    ]);
    const markup = renderMarkup(RunningItemEditor, editorProps(item, { pendingConfirmationFindings }));
    expect(markup).toContain("内容を確認しました");
    expect(rawKeyLeaks(markup)).toEqual([]);
    expect(dtoRawKeyLeaks(item)).toEqual([]);
    expect(dtoRawKeyLeaks(pendingConfirmationFindings)).toEqual([]);
    // provenance panel は <details> の中でも描画されている
    expect(stripTags(markup)).toMatch(/作成経緯と根拠/);
  });

  it("picker の DOM と DTO に Method / template id を出さない", () => {
    const picker = presentTemplatePicker(productionRuleSet());
    const markup = renderMarkup(MethodTemplatePicker, { picker, value: null, onSelect: () => {}, idPrefix: "picker" });
    expect(rawKeyLeaks(markup)).toEqual([]);
    expect(dtoRawKeyLeaks(picker)).toEqual([]);
    for (const t of productionRuleSet().templates) expect(markup, t.id).not.toContain(t.id);
  });
});

// ---------------------------------------------------------------------------
// Template picker
// ---------------------------------------------------------------------------

describe("R10-B3: MethodTemplatePicker", () => {
  it("主名称は SessionTemplate.labelJa。分類名は template 名より弱く表示する。RuleSet JSON 全体を渡さない", () => {
    const rs = productionRuleSet();
    const picker = presentTemplatePicker(rs);
    expect(picker.groups).toHaveLength(10);
    expect(picker.groups.flatMap((g) => g.options).map((o) => o.label).sort()).toEqual(rs.templates.map((t) => t.labelJa).sort());
    // RuleSet に説明文フィールドは無いので DTO にも持たない（捏造しない）
    expect(Object.keys(picker.groups[0]!.options[0]!)).not.toContain("description");
    expect(JSON.stringify(picker).length).toBeLessThan(JSON.stringify(rs).length / 10);
    expect(picker.ruleSetNoticeLabel).toBeNull();

    const trees = expandTree(MethodTemplatePickerView({ picker, value: null, onSelect: () => {}, idPrefix: "p", query: "", onQueryChange: () => {} }));
    const groupHeading = findAll(trees, (n) => n.type === "h4" && textOf(n) === "最高速度")[0]!;
    // 同じテキストを持つ span のうち一番内側（= ラベル本体）
    const optionLabel = findAll(trees, (n) => n.type === "span" && textOf(n) === "フライ20m").at(-1)!;
    expect(String(groupHeading.props.className)).toMatch(/text-xs/);
    expect(String(groupHeading.props.className)).toMatch(/font-normal/);
    expect(String(optionLabel.props.className)).toMatch(/text-sm/);
    expect(String(optionLabel.props.className)).toMatch(/font-semibold/);
  });

  it("検索は labelJa と coachingAliases が対象（内部名では検索できない）", () => {
    const picker = presentTemplatePicker(productionRuleSet());
    expect(filterTemplateGroups(picker.groups, "フライ").flatMap((g) => g.options.map((o) => o.label))).toEqual(["フライ10m", "フライ20m", "フライ30m"]);
    expect(filterTemplateGroups(picker.groups, "wind sprint").flatMap((g) => g.options.map((o) => o.label))).toEqual(["リラックス流し"]);
    expect(filterTemplateGroups(picker.groups, "ＦＬＹ　２０")).toHaveLength(1);
    expect(filterTemplateGroups(picker.groups, "MV_FLY20")).toEqual([]);
    expect(filterTemplateGroups(picker.groups, "MAX_VELOCITY")).toEqual([]);
  });

  it("選択すると内部値（method / templateId）だけを callback へ返す。選択中はテキストでも示す", () => {
    const picker = presentTemplatePicker(productionRuleSet());
    const onSelect = vi.fn();
    const trees = expandTree(MethodTemplatePickerView({ picker, value: null, onSelect, idPrefix: "p", query: "フライ20", onQueryChange: () => {} }));
    const [option] = buttonByText(trees, "フライ20m");
    expect(option!.props.type).toBe("button");
    click(option!);
    expect(onSelect).toHaveBeenCalledWith({ method: "MAX_VELOCITY", templateId: "MV_FLY20" });

    const selected = expandTree(
      MethodTemplatePickerView({ picker, value: { method: "MAX_VELOCITY", templateId: "MV_FLY20" }, onSelect, idPrefix: "p", query: "フライ20", onQueryChange: () => {} }),
    );
    expect(buttonByText(selected, "フライ20m")[0]!.props["aria-pressed"]).toBe(true);
    expect(textOf(selected)).toMatch(/選択中/);
  });

  it("domain の判定結果が渡されたときだけ選択不可 + 日本語の理由（presentation は可否を判定しない）", () => {
    const rs = productionRuleSet();
    expect(presentTemplatePicker(rs).groups.flatMap((g) => g.options).every((o) => o.canAttemptSelection)).toBe(true);
    const picker = presentTemplatePicker(rs, {
      unavailable: new Map([["AS_TOWING", { reasons: [{ code: "ADVANCED_ONLY_NOT_PERMITTED", ruleId: "ADVANCED_ONLY:AS_TOWING", overrideAllowed: true }] }]]),
    });
    const towing = picker.groups.flatMap((g) => g.options).find((o) => o.templateIdInternal === "AS_TOWING")!;
    expect(towing.canAttemptSelection).toBe(false);
    expect(towing.restrictionMessage).toBe("上級者向けの練習の型のため、この対象では選べません。");
    const trees = expandTree(MethodTemplatePickerView({ picker, value: null, onSelect: () => {}, idPrefix: "p", query: "牽引", onQueryChange: () => {} }));
    expect(buttonByText(trees, "牽引走")[0]!.props.disabled).toBe(true);
  });

  it("検索欄は label と紐付き、選択肢のタップ領域は 44px 以上", () => {
    const markup = renderMarkup(MethodTemplatePicker, { picker: presentTemplatePicker(productionRuleSet()), value: null, onSelect: () => {}, idPrefix: "pk" });
    expect(markup).toContain('for="pk-search"');
    expect(markup).toContain('id="pk-search"');
    const trees = expandTree(MethodTemplatePickerView({ picker: presentTemplatePicker(productionRuleSet()), value: null, onSelect: () => {}, idPrefix: "p", query: "", onQueryChange: () => {} }));
    for (const b of findAll(trees, (n) => n.type === "button")) expect(String(b.props.className)).toMatch(/min-h-11/);
  });
});

// ---------------------------------------------------------------------------
// RunningItemEditor
// ---------------------------------------------------------------------------

function withHardSafety(p: RunningPrescriptionValue): RunningPrescriptionValue {
  const copy = structuredClone(p);
  copy.rest.repRestS = { ...copy.rest.repRestS, hardSafety: { min: 60, max: 1800, unit: "s" } };
  return copy;
}

describe("R10-B3: RunningItemEditor（controlled）", () => {
  it("[R10-B4A] 保存前の確認（Action が返した Finding）の行に「内容を確認しました」チェックボックス。操作は onConfirmationChange へ", () => {
    const confirmFinding = { code: "AGG_TOTAL_RUNNING_CONFIRM", severity: "REQUIRE_CONFIRMATION", scope: "SESSION", evidenceIds: [] } as Finding;
    // 保存済み / 一時的な Finding の一覧にはチェックボックスを出さない（操作に流用しない）
    const item = savedItem(planAcc(), "item-c", [confirmFinding]);
    expect(findAll(expandTree(RunningItemEditor(editorProps(item))), (n) => n.type === "input" && n.props.type === "checkbox")).toHaveLength(0);

    const pendingConfirmationFindings = presentFindings([confirmFinding]);
    const props = editorProps(item, { pendingConfirmationFindings });
    const trees = expandTree(RunningItemEditor(props));
    const checkboxes = findAll(trees, (n) => n.type === "input" && n.props.type === "checkbox");
    expect(checkboxes).toHaveLength(1);
    const labels = findAll(trees, (n) => n.type === "label" && n.props.htmlFor === checkboxes[0]!.props.id);
    expect(textOf(labels[0]!)).toBe("内容を確認しました");
    expect(String(labels[0]!.props.className)).toMatch(/min-h-11/);
    // メッセージと同じ行（li）にある
    const row = findAll(trees, (n) => n.type === "li" && findAll([n], (c) => c === checkboxes[0]).length > 0)[0]!;
    expect(textOf(row)).toMatch(/総走行距離/);

    toggle(checkboxes[0]!, true);
    expect(props.onConfirmationChange).toHaveBeenCalledWith("AGG_TOTAL_RUNNING_CONFIRM", true);

    const confirmed = expandTree(
      RunningItemEditor(editorProps(item, { pendingConfirmationFindings, confirmationState: { confirmedKeys: ["AGG_TOTAL_RUNNING_CONFIRM"] } })),
    );
    expect(findAll(confirmed, (n) => n.type === "input" && n.props.type === "checkbox")[0]!.props.checked).toBe(true);
  });

  it("推奨範囲 / コーチ調整可能範囲をテキストで区別し、hardSafety は存在するときだけ表示", () => {
    const item = savedItem(planAcc());
    const text = stripTags(renderMarkup(RunningItemEditor, editorProps(item)));
    expect(text).toMatch(/推奨範囲/);
    expect(text).toMatch(/コーチ調整可能範囲/);
    expect(text).not.toMatch(/安全上の範囲/);
    const hard = presentRunningItem({ id: "h", displayName: null, rationale: "r", prescription: withHardSafety(planAcc()), provenance: null, exactRuleSet: { status: "UNAVAILABLE" } });
    expect(stripTags(renderMarkup(RunningItemEditor, editorProps(hard)))).toMatch(/安全上の範囲/);
  });

  it("入力は onChange、保存は現在の表示値（displayedFromValue）付きのリクエストで onEditRequest へ", () => {
    const item = savedItem(planAcc(), "item-e");
    const rest = item.editor.fields.find((f) => f.keyInternal === "repRestS")!;
    const props = editorProps(item, { fieldDrafts: { repRestS: "360" } });
    const trees = expandTree(RunningItemEditor(props));

    const inputs = findAll(trees, (n) => n.type === "input" && n.props.type === "number");
    for (const input of inputs) {
      expect(findAll(trees, (n) => n.type === "label" && n.props.htmlFor === input.props.id), String(input.props.id)).toHaveLength(1);
    }
    const restInput = inputs.find((n) => n.props.value === "360")!;
    changeValue(restInput, "400");
    expect(props.onChange).toHaveBeenCalledWith("repRestS", "400");

    const saveButtons = buttonByText(trees, "この値で保存").filter((b) => b.props.disabled === false);
    expect(saveButtons).toHaveLength(1);
    click(saveButtons[0]!);
    expect(props.onEditRequest).toHaveBeenCalledWith({ itemId: "item-e", field: "repRestS", value: 360, displayedFromValue: rest.currentValue, confirmedFindingCodes: [] });
  });

  it("[R10-B4A] aggregate field は read-only: 現在値と範囲は表示し、直接編集・例外設定のボタンは出さない", () => {
    const item = savedItem(planLsrIncomplete(), "item-agg");
    const totalReps = item.editor.fields.find((f) => f.keyInternal === "totalReps")!;
    const counts = planLsrIncomplete().rationale.find((l) => l.code === "COUNTS_RESOLVED")!.params!.totalReps;
    expect(totalReps).toMatchObject({ readOnly: true, editable: false, currentValue: counts, overrideLayers: [] });
    expect(totalReps.recommended?.label).toBeTruthy();
    expect(totalReps.coachEditable?.label).toBeTruthy();
    expect(buildFieldEditRequest(item.id, totalReps, "2")).toEqual({ ok: false, message: "他の値から決まる合計・制約の値のため、直接は変更できません。" });

    const volume = item.editor.fields.find((f) => f.keyInternal === "sessionVolumeM")!;
    expect(volume).toMatchObject({ readOnly: true, editable: false, currentValue: null, overrideLayers: [] });

    // 行の中に入力欄・保存・例外設定ボタンが無く、「表示のみ」と現在値・範囲が見える
    const trees = expandTree(RunningItemEditor(editorProps(item)));
    // field の行（「総本数」「現在: …」で始まる li。Finding の詳細行とは区別する）
    const rows = findAll(trees, (n) => n.type === "li" && textOf(n).startsWith("総本数現在:"));
    expect(rows).toHaveLength(1);
    expect(findAll(rows, (n) => n.type === "input" || n.type === "button")).toEqual([]);
    expect(textOf(rows[0]!)).toMatch(/表示のみ/);
    expect(textOf(rows[0]!)).toMatch(/推奨範囲/);
    expect(textOf(rows[0]!)).toMatch(/コーチ調整可能範囲/);
  });

  it("[R10-B4A] 助走距離（EVENT_APPROACH_SPEED）は編集用の範囲ソースが無いので read-only", () => {
    // Legacy saved plans without a distance remain renderable; new F1 planning blocks them as unevaluable.
    const historical = structuredClone(planEa());
    if (historical.rep.kind !== "ATTEMPTS") throw new Error("expected ATTEMPTS");
    historical.rep.approachDistanceM = null;
    const item = savedItem(historical);
    const approach = item.editor.fields.find((f) => f.keyInternal === "approachDistanceM")!;
    expect(approach).toMatchObject({ readOnly: true, editable: false, overrideLayers: [], currentValueLabel: "未入力" });
    expect(approach.notEditableReason).toMatch(/ルールセットに無い/);
    expect(buildFieldEditRequest(item.id, approach, "20").ok).toBe(false);
  });

  it("練習の型で固定された値は編集欄も例外設定ボタンも出さない", () => {
    const item = savedItem(planAcc());
    const distance = item.editor.fields.find((f) => f.keyInternal === "repDistanceM")!;
    expect(distance.editable).toBe(false);
    expect(distance.overrideLayers).toEqual([]);
    expect(distance.notEditableReason).toBe("練習の型で決まっている値です。");
  });

  it("override: 開く → 値・理由・確認を controlled に更新 → 条件がそろうまで保存できない", () => {
    const item = savedItem(planAcc(), "item-o");
    const onOverrideChange = vi.fn();
    const closed = expandTree(RunningItemEditor(editorProps(item, { onOverrideChange })));
    const open = buttonByText(closed, "コーチ調整可能範囲の外にする")[0]!;
    click(open);
    const draft = onOverrideChange.mock.calls[0]![0] as Extract<OverrideDraft, { kind: "FIELD" }>;
    expect(draft).toMatchObject({ kind: "FIELD", layerInternal: "COACH_EDITABLE", valueText: "", reason: "", firstConfirmation: false });

    const onOverrideRequest = vi.fn();
    const partial = expandTree(RunningItemEditor(editorProps(item, { overrideState: { ...draft, valueText: "5" }, onOverrideChange, onOverrideRequest })));
    const reason = findAll(partial, (n) => n.type === "textarea")[0]!;
    expect(findAll(partial, (n) => n.type === "label" && n.props.htmlFor === reason.props.id)).toHaveLength(1);
    changeValue(reason, "本日は短縮して実施するため");
    expect(onOverrideChange).toHaveBeenLastCalledWith({ ...draft, valueText: "5", reason: "本日は短縮して実施するため" });
    expect(buttonByText(partial, "例外として保存")[0]!.props.disabled).toBe(true);
    // COACH_EDITABLE は domain が二重確認を要求しないので、確認チェックは1つ
    expect(findAll(partial, (n) => n.type === "input" && n.props.type === "checkbox")).toHaveLength(1);

    const ready = expandTree(
      RunningItemEditor(editorProps(item, { overrideState: { ...draft, valueText: "5", reason: "本日は短縮して実施するため", firstConfirmation: true }, onOverrideRequest })),
    );
    const save = buttonByText(ready, "例外として保存")[0]!;
    expect(save.props.disabled).toBe(false);
    click(save);
    expect(onOverrideRequest).toHaveBeenCalledWith({
      itemId: "item-o",
      kind: "FIELD",
      field: draft.fieldInternal,
      layer: "COACH_EDITABLE",
      newValue: 5,
      reason: "本日は短縮して実施するため",
      confirmedTwice: false,
      confirmedFindingCodes: [],
    });
  });

  it("安全上の範囲の外（HARD_SAFETY）は domain が要求する2段階確認を両方そろえるまで保存できない", () => {
    expect(overrideRequiresDoubleConfirmation({ kind: "FIELD", field: "repRestS", layer: "HARD_SAFETY" })).toBe(true);
    expect(overrideRequiresDoubleConfirmation({ kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" })).toBe(false);
    expect(overrideRequiresDoubleConfirmation({ kind: "ELIGIBILITY", ruleId: "R1" })).toBe(true);
    expect(overrideRequiresDoubleConfirmation({ kind: "READINESS", action: "CANCEL_HIGH_INTENSITY" })).toBe(false);

    const item = presentRunningItem({
      id: "hs",
      displayName: null,
      rationale: "r",
      prescription: withHardSafety(planAcc()),
      provenance: null,
      exactRuleSet: { status: "OK", ruleSet: productionRuleSet() },
    });
    const draft: OverrideDraft = { kind: "FIELD", fieldInternal: "repRestS", layerInternal: "HARD_SAFETY", valueText: "30", reason: "理由を十分に記録しています", firstConfirmation: true, secondConfirmation: false };
    const trees = expandTree(RunningItemEditor(editorProps(item, { overrideState: draft })));
    expect(findAll(trees, (n) => n.type === "input" && n.props.type === "checkbox")).toHaveLength(2);
    expect(buttonByText(trees, "例外として保存")[0]!.props.disabled).toBe(true);
    expect(buildOverrideRequest("hs", draft, item.editor)).toEqual({ ok: false, message: "確認の項目にチェックしてください。" });
    expect(buildOverrideRequest("hs", { ...draft, secondConfirmation: true }, item.editor)).toMatchObject({ ok: true, request: { confirmedTwice: true, layer: "HARD_SAFETY" } });
  });

  it("eligibility override は domain が overrideAllowed=true とした規則だけ（Finding code から推測しない）", () => {
    const options = presentEligibilityOverrides([
      { code: "ADVANCED_ONLY_NOT_PERMITTED", ruleId: "ADVANCED_ONLY:AS_TOWING", overrideAllowed: true },
      { code: "ELIGIBILITY_CONDITIONS_UNMET", ruleId: "ELIG_X", overrideAllowed: false },
      { code: "READINESS_CHECK_REQUIRED", ruleId: null, overrideAllowed: false },
    ]);
    expect(options).toEqual([{ ruleIdInternal: "ADVANCED_ONLY:AS_TOWING", message: "上級者向けの練習の型のため、この対象では選べません。", requiresDoubleConfirmation: true }]);

    const item = savedItem(planAcc());
    const noOverride = stripTags(renderMarkup(RunningItemEditor, editorProps(item)));
    expect(noOverride).not.toMatch(/選択条件の例外/);
    // Finding（BLOCK / REQUIRE_COACH_REVIEW）があっても override ボタンは増えない
    const withFindings = savedItem(planAcc(), "f", [{ code: "WEEKLY_HIGH_WITHIN_48H", severity: "BLOCK_AUTOGEN", scope: "WEEK", evidenceIds: [] } as Finding]);
    expect(buttonByText(expandTree(RunningItemEditor(editorProps(withFindings))), "選択条件の例外")).toHaveLength(0);
  });

  it("再計算ボタンは onRecalculateRequest(itemId)。前提がそろわなければ押せない", () => {
    const item = savedItem(planAcc(), "item-r");
    const props = editorProps(item);
    const trees = expandTree(RunningItemEditor(props));
    const recalc = buttonByText(trees, "現行ルールで再計算")[0]!;
    click(recalc);
    expect(props.onRecalculateRequest).toHaveBeenCalledWith({ itemId: "item-r", confirmedFindingCodes: [] });

    const noSnapshot = structuredClone(planAcc());
    delete (noSnapshot as { planningControls?: unknown }).planningControls;
    const legacy = presentRunningItem({ id: "old", displayName: null, rationale: "r", prescription: noSnapshot, provenance: null, exactRuleSet: { status: "OK", ruleSet: productionRuleSet() } });
    expect(legacy.canRecalculate).toBe(false);
    expect(buttonByText(expandTree(RunningItemEditor(editorProps(legacy))), "現行ルールで再計算")[0]!.props.disabled).toBe(true);
  });

  it("すべての button は type 明示・高さ 32px 以上。h-5 以下のボタンを作らない", () => {
    const item = savedItem(withHardSafety(planMvFly20()), "item-t", [{ code: "AGG_TOTAL_RUNNING_CONFIRM", severity: "REQUIRE_CONFIRMATION", scope: "SESSION", evidenceIds: [] } as Finding]);
    const draft: OverrideDraft = { kind: "FIELD", fieldInternal: "repRestS", layerInternal: "COACH_EDITABLE", valueText: "", reason: "", firstConfirmation: false, secondConfirmation: false };
    const trees = expandTree(RunningItemEditor(editorProps(item, { overrideState: draft })));
    const buttons = findAll(trees, (n) => n.type === "button");
    expect(buttons.length).toBeGreaterThan(3);
    for (const b of buttons) {
      expect(b.props.type, textOf(b)).toBe("button");
      expect(String(b.props.className), textOf(b)).toMatch(/\b(min-h-11|h-11|h-10|h-9|h-8)\b/);
      expect(String(b.props.className), textOf(b)).not.toMatch(/\bh-[1-5]\b/);
    }
    const summary = findAll(trees, (n) => n.type === "summary")[0]!;
    expect(String(summary.props.className)).toMatch(/min-h-11/);
  });

  it("長い日本語の題名・理由でも折り返せる（break-words / min-w-0）", () => {
    const longTitle = "とても長い練習の名前".repeat(20);
    const p = structuredClone(planAcc());
    p.rationale = p.rationale.map((l) => (l.code === "TEMPLATE_SELECTED" ? { ...l, params: { templateLabelJa: longTitle } } : l));
    const item = presentRunningItem({ id: "long", displayName: null, rationale: "長い理由".repeat(100), prescription: p, provenance: null, exactRuleSet: { status: "UNAVAILABLE" } });
    const trees = expandTree(RunningItemEditor(editorProps(item)));
    const h3 = findAll(trees, (n) => n.type === "h3")[0]!;
    expect(textOf(h3)).toBe(longTitle);
    expect(String(h3.props.className)).toMatch(/break-words/);
    const article = findAll(trees, (n) => n.type === "article")[0]!;
    expect(String(article.props.className)).toMatch(/min-w-0/);
    expect(renderMarkup(RunningItemEditor, editorProps(item))).not.toMatch(/\bw-\[\d{3,}px\]|\bmin-w-\[\d{3,}px\]/);
  });

  it("disabled のときは入力・確認・保存・再計算を操作できない", () => {
    const item = savedItem(planAcc(), "d", [{ code: "AGG_TOTAL_RUNNING_CONFIRM", severity: "REQUIRE_CONFIRMATION", scope: "SESSION", evidenceIds: [] } as Finding]);
    const trees = expandTree(
      RunningItemEditor(editorProps(item, { disabled: true, fieldDrafts: { repRestS: "360" }, pendingConfirmationFindings: presentFindings([{ code: "AGG_TOTAL_RUNNING_CONFIRM", severity: "REQUIRE_CONFIRMATION", scope: "SESSION", evidenceIds: [] } as Finding]) })),
    );
    for (const node of findAll(trees, (n) => n.type === "button" || n.type === "input" || n.type === "textarea")) {
      expect(node.props.disabled, `${node.type}:${textOf(node)}`).toBe(true);
    }
  });
});
