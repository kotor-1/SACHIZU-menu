/**
 * [R12-A2.1] MenuPlanner preview の presentation 契約。
 *
 * engine が返した INELIGIBLE の意味（EligibilityReason / substitutes / confirmationRequired）が
 * 表示変換で失われたり、Finding へ捏造されたりしないことを直接確認する。
 */
import { describe, expect, it } from "vitest";

import type { EligibilityReason } from "@/domain/running/planning/schema";
import {
  presentMenuPlannerPreview,
  type MenuPlannerPreviewPresentationInput,
} from "@/presentation/menu-planner/preview";

type PresentationItem = MenuPlannerPreviewPresentationInput["blocks"][number]["items"][number];

function item(overrides: Partial<PresentationItem> = {}): PresentationItem {
  return {
    itemKey: "item-01",
    selection: { kind: "RUNNING", method: "SPRINT_ENDURANCE_SHORT", templateId: "SES_80" },
    title: "スプリント持久80m",
    state: "REJECTED",
    runningPrescription: null,
    legacyPrescription: null,
    legacySetRestSeconds: null,
    aiReason: null,
    engineRationale: ["Running処方エンジンが自動作成を停止しました。"],
    findings: [],
    warnings: [],
    eligibilityReasons: [],
    substitutes: [],
    confirmationRequiredCodes: [],
    ...overrides,
  };
}

function input(items: readonly PresentationItem[]): MenuPlannerPreviewPresentationInput {
  return {
    menuName: "menu",
    statusOnSave: "DRAFT",
    ruleSet: { version: "rs-2026.09.0", status: "DRAFT" },
    blocks: [{ blockKey: "block-01", title: "主運動", items }],
    aggregation: { status: "NONE" },
    estimatedTime: { seconds: null, quality: "UNKNOWN", availableMinutes: null, exceedsAvailable: false },
    canSave: false,
    binding: { contextFingerprint: "fp", materializationDigest: "dg" },
  };
}

const REASONS: EligibilityReason[] = [
  { code: "LOW_CONFIDENCE_HIGH_METABOLIC_AUTOGEN_BLOCKED", ruleId: null, overrideAllowed: false },
  { code: "ELIGIBILITY_CONDITIONS_UNMET", ruleId: "ELIG_ASSISTED_ALL_POST", overrideAllowed: true },
];

describe("R12-A2.1 MenuPlanner preview presentation", () => {
  it("EligibilityReason を engine の意味のまま表示 DTO に写す", () => {
    const preview = presentMenuPlannerPreview(input([item({ eligibilityReasons: REASONS })]));
    const reasons = preview.blocks[0]!.items[0]!.eligibilityReasons;
    expect(reasons).toHaveLength(2);
    expect(reasons.map((reason) => reason.developerCode)).toEqual([
      "LOW_CONFIDENCE_HIGH_METABOLIC_AUTOGEN_BLOCKED",
      "ELIGIBILITY_CONDITIONS_UNMET",
    ]);
    // overrideAllowed は code から推測せず engine の値を写す。
    expect(reasons.map((reason) => reason.overrideAllowed)).toEqual([false, true]);
    expect(reasons[1]!.ruleIdInternal).toBe("ELIG_ASSISTED_ALL_POST");
    // Coach が読める日本語が付く（未知コードでも安全な汎用文にフォールバックする）。
    for (const reason of reasons) expect(reason.message.length).toBeGreaterThan(0);
  });

  it("substitutes は informational としてそのまま運ばれ、選択の同一性を変えない", () => {
    const preview = presentMenuPlannerPreview(
      input([
        item({
          substitutes: [
            { method: "TEMPO_EXTENSIVE", templateId: "TE_200", label: "テンポ走200m" },
            { method: "STRIDE", templateId: "ST_RELAXED", label: null },
          ],
        }),
      ]),
    );
    expect(preview.blocks[0]!.items[0]!.substitutes).toEqual([
      { method: "TEMPO_EXTENSIVE", templateId: "TE_200", label: "テンポ走200m" },
      { method: "STRIDE", templateId: "ST_RELAXED", label: null },
    ]);
  });

  it("confirmationRequiredCodes を落とさず、承認としても扱わない", () => {
    const preview = presentMenuPlannerPreview(
      input([item({ confirmationRequiredCodes: ["AGG_METHOD_BUDGET_OVER_RECOMMENDED"] })]),
    );
    const presented = preview.blocks[0]!.items[0]!;
    expect(presented.confirmationRequiredCodes).toEqual(["AGG_METHOD_BUDGET_OVER_RECOMMENDED"]);
    // 確認要求は AI の自動 save を許す根拠にならない（canSave は入力のまま）。
    expect(preview.canSave).toBe(false);
  });

  it("INELIGIBLE の理由を Finding へ捏造しない", () => {
    const preview = presentMenuPlannerPreview(input([item({ eligibilityReasons: REASONS })]));
    const presented = preview.blocks[0]!.items[0]!;
    expect(presented.findings).toEqual([]);
    expect(presented.eligibilityReasons).toHaveLength(2);
  });

  it("aiReason と engineRationale を混ぜない", () => {
    const preview = presentMenuPlannerPreview(
      input([item({ aiReason: "狙いを満たすため", engineRationale: ["engine の根拠"] })]),
    );
    const presented = preview.blocks[0]!.items[0]!;
    expect(presented.aiReason).toBe("狙いを満たすため");
    expect(presented.engineRationale).toEqual(["engine の根拠"]);
  });
});
