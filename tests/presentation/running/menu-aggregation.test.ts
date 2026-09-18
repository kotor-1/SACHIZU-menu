/**
 * R10-B4B — メニュー全体の合計（R6）の表示と、Action へ渡す FormData。
 */
import { describe, expect, it } from "vitest";
import { evaluateSessionAggregation } from "@/domain/running/aggregation";
import type { SessionAggregate } from "@/domain/running/aggregation/schema";
import { PLANNING_NOT_EVALUATED_REASONS } from "@/domain/running/persistence/sessionSnapshot";
import { presentMenuAggregation } from "@/presentation/running/menu";
import { MENU_AGGREGATION_NOT_EVALUATED_MESSAGE_JA } from "@/presentation/running/labels";
import {
  coachReferenceEditFormData,
  fieldEditFormData,
  overrideFormData,
  planRunningItemFormData,
  recalculateFormData,
  runningContextFormData,
} from "@/presentation/running/action-forms";
import { planAcc, planLsrIncomplete } from "../../repository/running/fixtures";
import { dtoRawKeyLeaks, productionRuleSet } from "./helpers";

function aggregateOf(competitionDay: boolean | "NOT_EVALUATED" = false): SessionAggregate {
  return evaluateSessionAggregation(
    [
      { kind: "RUNNING_V2", prescription: planAcc() },
      { kind: "RUNNING_V2", prescription: planLsrIncomplete() },
      { kind: "LEGACY", item: { category: "SPRINT", sets: 1, reps: 4, distanceMeters: 60, durationSeconds: null, restSeconds: 300 } },
    ],
    { ruleSet: productionRuleSet(), tier: "ADVANCED", availableMinutes: null, competitionDay, mode: "PLANNING" },
  );
}

describe("R10-B4B: メニュー全体の合計", () => {
  it("走項目が無ければ集計しない", () => {
    expect(presentMenuAggregation({ status: "SKIP" })).toEqual({ status: "NONE" });
  });

  it("評価できない理由は、コードではなく日本語で出す（版の混在は「揃え方」まで書く）", () => {
    for (const reason of PLANNING_NOT_EVALUATED_REASONS) {
      const dto = presentMenuAggregation({ status: "NOT_EVALUATED", reason });
      expect(dto).toEqual({ status: "NOT_EVALUATED", message: MENU_AGGREGATION_NOT_EVALUATED_MESSAGE_JA[reason] });
      if (dto.status !== "NOT_EVALUATED") throw new Error("unreachable");
      expect(dto.message).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
    }
    const mixed = presentMenuAggregation({ status: "NOT_EVALUATED", reason: "MIXED_RULESET_VERSIONS" });
    if (mixed.status !== "NOT_EVALUATED") throw new Error("unreachable");
    expect(mixed.message).toContain("現行ルールで再計算");
  });

  it("合計は単位つきの日本語で、範囲は範囲のまま出す（中央値にしない・0 にしない）", () => {
    const dto = presentMenuAggregation({ status: "EVALUATED", aggregate: aggregateOf(), plausibilityFindings: [], competitionDay: false });
    if (dto.status !== "EVALUATED") throw new Error("unreachable");
    const labels = dto.totals.map((t) => t.label);
    expect(labels).toContain("走行距離の合計");
    for (const total of dto.totals) expect(total.valueLabel).toMatch(/^[\d.]+(〜[\d.]+)?(m|回)$/);
    expect(dtoRawKeyLeaks(dto)).toEqual([]);
  });

  it("大会当日・計画日未設定は、それぞれ注記として出す", () => {
    const onCompetition = presentMenuAggregation({ status: "EVALUATED", aggregate: aggregateOf(true), plausibilityFindings: [], competitionDay: true });
    if (onCompetition.status !== "EVALUATED") throw new Error("unreachable");
    expect(onCompetition.competitionDayNote).toContain("大会");

    const unknown = presentMenuAggregation({
      status: "EVALUATED",
      aggregate: aggregateOf("NOT_EVALUATED"),
      plausibilityFindings: [],
      competitionDay: "NOT_EVALUATED",
    });
    if (unknown.status !== "EVALUATED") throw new Error("unreachable");
    expect(unknown.competitionDayNote).toContain("計画日が設定されていない");

    const normal = presentMenuAggregation({ status: "EVALUATED", aggregate: aggregateOf(), plausibilityFindings: [], competitionDay: false });
    if (normal.status !== "EVALUATED") throw new Error("unreachable");
    expect(normal.competitionDayNote).toBeNull();
  });

  it("domain の Finding をそのまま日本語化して出す（severity を変えない・件数を減らさない）", () => {
    const aggregate = aggregateOf();
    const dto = presentMenuAggregation({
      status: "EVALUATED",
      aggregate,
      plausibilityFindings: [{ code: "PLAUSIBILITY_SESSION_TOTAL_HIGH", severity: "WARN", scope: "SESSION", evidenceIds: [] }],
      competitionDay: false,
    });
    if (dto.status !== "EVALUATED") throw new Error("unreachable");
    const codes = new Set([...aggregate.findings.map((f) => f.code), "PLAUSIBILITY_SESSION_TOTAL_HIGH"]);
    expect(new Set(dto.findings.map((f) => f.developerCode))).toEqual(codes);
    expect(dtoRawKeyLeaks(dto)).toEqual([]);
  });
});

describe("R10-B4B: Action へ渡す FormData", () => {
  it("確認済み Finding は複数値として送る（Action は getAll で読む）", () => {
    const form = fieldEditFormData({ itemId: "i1", field: "repsPerSet", value: 4, displayedFromValue: 5, confirmedFindingCodes: ["A_B", "C_D"] });
    expect(form.get("itemId")).toBe("i1");
    expect(form.get("field")).toBe("repsPerSet");
    expect(form.get("value")).toBe("4");
    expect(form.getAll("confirmedFindingCodes")).toEqual(["A_B", "C_D"]);
  });

  it("例外設定は二重確認の状態を必ず明示する（未送信にしない）", () => {
    const yes = overrideFormData({
      itemId: "i1",
      kind: "FIELD",
      field: "sets",
      layer: "HARD_SAFETY",
      newValue: 9,
      reason: "この日は特別に行うため",
      confirmedTwice: true,
      confirmedFindingCodes: [],
    });
    expect([yes.get("targetKind"), yes.get("layer"), yes.get("newValue"), yes.get("confirmedTwice")]).toEqual(["FIELD", "HARD_SAFETY", "9", "true"]);

    const no = overrideFormData({ itemId: "i1", kind: "ELIGIBILITY", ruleId: "R-1", reason: "理由を10文字以上", confirmedTwice: false, confirmedFindingCodes: [] });
    expect([no.get("targetKind"), no.get("ruleId"), no.get("confirmedTwice")]).toEqual(["ELIGIBILITY", "R-1", "false"]);
    expect(no.has("field")).toBe(false);
  });

  it("追加は method / templateId / 位置の指定 / 目標スプリットだけを送る（版・確信度を送らない）", () => {
    const form = planRunningItemFormData({
      selection: { method: "ACCELERATION", templateId: "ACC_BLOCK_30" },
      positionPreference: "LOWER",
      confirmedFindingCodes: [],
      coachReferenceJson: null,
    });
    expect([...form.keys()].sort()).toEqual(["method", "positionPreference", "templateId"]);

    const withSplit = planRunningItemFormData({
      selection: { method: "LONG_SPRINT_RACE_SPECIFIC", templateId: "LSR_SPECIAL_ENDURANCE_I" },
      positionPreference: null,
      confirmedFindingCodes: ["X_Y"],
      coachReferenceJson: JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }] }),
    });
    expect(withSplit.get("positionPreference")).toBe("");
    expect(JSON.parse(String(withSplit.get("coachReferenceJson")))).toEqual({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }] });
    expect(withSplit.getAll("confirmedFindingCodes")).toEqual(["X_Y"]);
  });

  it("目標スプリットの更新・再計算・設定保存も、送る値は最小限", () => {
    const split = coachReferenceEditFormData({
      itemId: "i1",
      coachReference: { kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }] },
      confirmedFindingCodes: [],
    });
    expect([...split.keys()].sort()).toEqual(["coachReferenceJson", "itemId"]);
    expect([...recalculateFormData({ itemId: "i1", confirmedFindingCodes: [] }).keys()]).toEqual(["itemId"]);
    expect([...runningContextFormData("{}").keys()]).toEqual(["runningContext"]);
  });
});
