/**
 * R10-B4A — presentation / editor 側の確認 contract と read-only 方針。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Finding } from "@/domain/running/types/findings";
import type { Provenance } from "@/domain/running/persistence/provenance";
import { MethodTemplatePicker } from "@/components/running/method-template-picker";
import { RunningItemEditor } from "@/components/running/running-item-editor";
import { FindingsList } from "@/components/running/findings-list";
import { confirmedCodesForRequest } from "@/presentation/running/editor-requests";
import { presentFindings } from "@/presentation/running/findings";
import { presentRunningItem } from "@/presentation/running/item";
import { presentTemplatePicker } from "@/presentation/running/template";
import { planAcc, provenanceFor } from "../../repository/running/fixtures";
import { buttonByText, expandTree, productionRuleSet, rawKeyLeaks, renderMarkup, stripTags } from "./helpers";

const confirm = (code: string, scope: Finding["scope"] = "SESSION") => ({ code, severity: "REQUIRE_CONFIRMATION", scope, evidenceIds: [] }) as Finding;

describe("R10-B4A: 確認 code は「いま示されている確認対象」だけからリクエストに載せる", () => {
  it("以前の結果のチェック状態（pending に無い key）は送らない", () => {
    const pending = presentFindings([confirm("AGG_TOTAL_RUNNING_CONFIRM"), { code: "HISTORY_UNKNOWN", severity: "INFO", scope: "WEEK", evidenceIds: [] } as Finding]);
    expect(confirmedCodesForRequest(pending, ["AGG_TOTAL_RUNNING_CONFIRM", "PLAUSIBILITY_REQUIRE_CONFIRMATION", "HISTORY_UNKNOWN"])).toEqual(["AGG_TOTAL_RUNNING_CONFIRM"]);
    expect(confirmedCodesForRequest([], ["AGG_TOTAL_RUNNING_CONFIRM"])).toEqual([]);
  });

  it("editor: 保存・再計算のリクエストには、チェック済みの pending code だけが入る", () => {
    const p = planAcc();
    const item = presentRunningItem({ id: "i1", displayName: null, rationale: "r", prescription: p, provenance: provenanceFor(p), exactRuleSet: { status: "OK", ruleSet: productionRuleSet() } });
    const onEditRequest = vi.fn();
    const onRecalculateRequest = vi.fn();
    const trees = expandTree(
      RunningItemEditor({
        value: item,
        fieldDrafts: { repRestS: "300" },
        confirmationState: { confirmedKeys: ["AGG_TOTAL_RUNNING_CONFIRM", "STALE_OLD_CODE"] },
        pendingConfirmationFindings: presentFindings([confirm("AGG_TOTAL_RUNNING_CONFIRM")]),
        overrideState: null,
        onChange: vi.fn(),
        onConfirmationChange: vi.fn(),
        onOverrideChange: vi.fn(),
        onEditRequest,
        onRecalculateRequest,
      }),
    );
    (buttonByText(trees, "この値で保存").find((b) => b.props.disabled === false)!.props.onClick as () => void)();
    expect(onEditRequest).toHaveBeenCalledWith(expect.objectContaining({ field: "repRestS", value: 300, confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM"] }));
    (buttonByText(trees, "現行ルールで再計算")[0]!.props.onClick as () => void)();
    expect(onRecalculateRequest).toHaveBeenCalledWith({ itemId: "i1", confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM"] });
  });
});

describe("R10-B4A: 保存済み Finding の確認記録", () => {
  it("provenance.findingConfirmations にある REQUIRE_CONFIRMATION は Finding を残したまま「コーチ確認済み」と表示（チェックボックスは出さない）", () => {
    const p = structuredClone(planAcc());
    p.findings = [...p.findings, confirm("PLAUSIBILITY_REQUIRE_CONFIRMATION", "ITEM")];
    const provenance: Provenance = { ...provenanceFor(planAcc()), findingConfirmations: [{ code: "PLAUSIBILITY_REQUIRE_CONFIRMATION", at: "2026-09-20T10:00:00+09:00" as never }] };
    const item = presentRunningItem({ id: "i2", displayName: null, rationale: "r", prescription: p, provenance, exactRuleSet: { status: "UNAVAILABLE" } });
    const dto = item.findings.find((f) => f.developerCode === "PLAUSIBILITY_REQUIRE_CONFIRMATION")!;
    expect(dto.confirmationRecordLabel).toBe("コーチ確認済み（2026/9/20）");

    const markup = renderMarkup(FindingsList, { findings: item.findings, idPrefix: "saved" });
    expect(stripTags(markup)).toMatch(/コーチ確認済み/);
    expect(stripTags(markup)).not.toMatch(/保存する前に、内容を確認したことを明示/);
    expect(markup).not.toContain('type="checkbox"');
    expect(rawKeyLeaks(markup)).toEqual([]);
  });

  it("確認記録の無い Finding には記録ラベルを付けない", () => {
    const p = structuredClone(planAcc());
    p.findings = [...p.findings, confirm("PLAUSIBILITY_REQUIRE_CONFIRMATION", "ITEM")];
    const item = presentRunningItem({ id: "i3", displayName: null, rationale: "r", prescription: p, provenance: provenanceFor(planAcc()), exactRuleSet: { status: "UNAVAILABLE" } });
    expect(item.findings.find((f) => f.developerCode === "PLAUSIBILITY_REQUIRE_CONFIRMATION")!.confirmationRecordLabel).toBeNull();
  });
});

describe("R10-B4A: picker は候補一覧", () => {
  it("候補であり追加時に判定する旨を表示する", () => {
    const text = stripTags(renderMarkup(MethodTemplatePicker, { picker: presentTemplatePicker(productionRuleSet()), value: null, onSelect: () => {}, idPrefix: "pk" }));
    expect(text).toMatch(/一覧は候補です/);
  });
});

describe("R10-B4A: aggregate field の逆算をしない（source audit）", () => {
  it("editor / request builder / service に、aggregate の値から sets・距離を割り戻すコードが無い", () => {
    const files = ["src/presentation/running/editor.ts", "src/presentation/running/editor-requests.ts", "src/actions/_running-plan-service.ts"];
    for (const file of files) {
      const code = fs
        .readFileSync(path.join(process.cwd(), file), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code, file).not.toMatch(/totalReps\s*\/|\/\s*totalReps|sessionVolumeM\s*\/|flyVolumeM\s*\/|Math\.(ceil|floor|round)\([^)]*(totalReps|Volume)/);
    }
  });
});
