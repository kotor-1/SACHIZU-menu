/**
 * R10-B3 — Finding / confidence / dose の表示 DTO。
 */
import { describe, expect, it } from "vitest";
import type { Finding } from "@/domain/running/types/findings";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { ConfidenceBadge } from "@/components/running/confidence-badge";
import { FindingsList } from "@/components/running/findings-list";
import { presentConfidence } from "@/presentation/running/confidence";
import { presentDose } from "@/presentation/running/dose";
import { presentFindings } from "@/presentation/running/findings";
import { formatIntervalJa, formatRangeJa } from "@/presentation/running/format";
import { planAcc, planAssisted, planLsrIncomplete, planMvFly20, planRs, planSes, planStride, planTi } from "../../repository/running/fixtures";
import { rawKeyLeaks, renderMarkup, stripTags } from "./helpers";

function finding(code: string, severity: Finding["severity"], extra: Partial<Finding> = {}): Finding {
  return { code, severity, scope: "SESSION", evidenceIds: [], ...extra } as Finding;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

describe("R10-B3: FindingPresentationDto", () => {
  it("既知 code は日本語 message、severity は日本語ラベル（内部名を出さない）", () => {
    const [dto] = presentFindings([finding("AGG_REST_INFEASIBLE", "WARN")]);
    expect(dto!.message).toMatch(/レスト/);
    expect(dto!.severityLabels).toEqual(["注意"]);
    expect(dto!.isKnownCode).toBe(true);
    expect(dto!.developerCode).toBe("AGG_REST_INFEASIBLE");
  });

  it("6 severity すべてを日本語化する", () => {
    const labels = presentFindings(
      (["INFO", "WARN", "REQUIRE_CONFIRMATION", "REQUIRE_COACH_REVIEW", "BLOCK_AUTOGEN", "BLOCK"] as const).map((s, i) => finding(`RULESET_DRAFT_${i}`, s)),
    ).flatMap((d) => d.severityLabels);
    expect(labels.sort()).toEqual(["コーチ確認が必要", "作成不可", "情報", "注意", "確認が必要", "自動作成では制限"].sort());
  });

  it("同じ code の BLOCK_AUTOGEN + REQUIRE_COACH_REVIEW は1行にまとめ、両方のラベルを並べる（強い順）", () => {
    const dtos = presentFindings([
      finding("WEEKLY_HIGH_WITHIN_48H", "BLOCK_AUTOGEN", { scope: "WEEK" }),
      finding("WEEKLY_HIGH_WITHIN_48H", "REQUIRE_COACH_REVIEW", { scope: "WEEK" }),
      finding("HISTORY_UNKNOWN", "INFO", { scope: "WEEK" }),
    ]);
    expect(dtos).toHaveLength(2);
    expect(dtos[0]!.developerCode).toBe("WEEKLY_HIGH_WITHIN_48H");
    expect(dtos[0]!.severityLabels).toEqual(["自動作成では制限", "コーチ確認が必要"]);
    expect(dtos[0]!.restrictsAutoGeneration).toBe(true);
    expect(dtos[0]!.needsCoachReview).toBe(true);
    expect(dtos[0]!.scopeLabel).toBe("直近の練習の流れ");
  });

  it("BLOCK_AUTOGEN は「自動作成では制限」。「作成不可」「使用禁止」と表示しない", () => {
    const [dto] = presentFindings([finding("COMPETITION_AUTOGEN_BLOCKED", "BLOCK_AUTOGEN", { scope: "ITEM" })]);
    const markup = renderMarkup(FindingsList, { findings: [dto!], idPrefix: "t" });
    expect(stripTags(markup)).toMatch(/自動作成では制限/);
    expect(stripTags(markup)).not.toMatch(/作成不可|使用禁止|この内容では作成できません/);
    expect(dto!.blocksCreation).toBe(false);
  });

  it("BLOCK だけが「作成不可」「この内容では作成できません」。例外設定で解除できるとは書かない", () => {
    const [dto] = presentFindings([finding("AGG_TOTAL_RUNNING_BLOCK", "BLOCK")]);
    expect(dto!.blocksCreation).toBe(true);
    const text = stripTags(renderMarkup(FindingsList, { findings: [dto!], idPrefix: "t" }));
    expect(text).toMatch(/作成不可/);
    expect(text).toMatch(/この内容では作成できません/);
    expect(text).not.toMatch(/例外|override|解除/);
  });

  it("未知 code は raw code を DOM に出さず、安全な日本語 fallback（developerCode には保持）", () => {
    const [dto] = presentFindings([finding("AGG_SOMETHING_NEW_IN_R11", "REQUIRE_COACH_REVIEW"), finding("WEEKLY_FUTURE_RULE", "WARN")]);
    expect(dto!.isKnownCode).toBe(false);
    expect(dto!.message).toBe("確認が必要な情報があります。");
    expect(dto!.developerCode).toBe("AGG_SOMETHING_NEW_IN_R11");
    const markup = renderMarkup(FindingsList, { findings: presentFindings([finding("AGG_SOMETHING_NEW_IN_R11", "REQUIRE_COACH_REVIEW"), finding("WEEKLY_FUTURE_RULE", "WARN")]), idPrefix: "t" });
    expect(markup).not.toMatch(/AGG_|WEEKLY_/);
    expect(rawKeyLeaks(markup)).toEqual([]);
    expect(stripTags(markup)).toMatch(/確認が必要な情報があります/);
  });

  it("REQUIRE_CONFIRMATION は requiresExplicitConfirmation=true、confirmationKey は Finding code", () => {
    const [dto] = presentFindings([finding("AGG_TOTAL_RUNNING_CONFIRM", "REQUIRE_CONFIRMATION")]);
    expect(dto!.requiresExplicitConfirmation).toBe(true);
    expect(dto!.confirmationKey).toBe("AGG_TOTAL_RUNNING_CONFIRM");
    expect(dto!.severityNote).toMatch(/確認したことを明示/);
  });

  it("metric は自由文字列を出さず、既知の field / Method:field に完全一致したときだけ対象名にする。value / limit の不明側を 0 にしない", () => {
    const dtos = presentFindings([
      finding("OUTSIDE_RECOMMENDED", "WARN", { scope: "ITEM", metric: "totalReps", limit: { min: 1, max: 2, unit: "reps" } }),
      finding("AGG_METHOD_BUDGET_OVER_RECOMMENDED", "WARN", {
        metric: "ACCELERATION:sessionVolumeM",
        value: { lower: null, upper: 420, unit: "m", source: "PLANNED", confidence: "LOW" },
      }),
      finding("WEEKLY_HIGH_SESSIONS", "WARN", { scope: "WEEK", metric: "count=3" }),
    ]);
    const byCode = Object.fromEntries(dtos.map((d) => [d.developerCode, d]));
    expect(byCode.OUTSIDE_RECOMMENDED!.details).toEqual([{ subjectLabel: "総本数", valueLabel: null, limitLabel: "基準: 1〜2本" }]);
    expect(byCode.AGG_METHOD_BUDGET_OVER_RECOMMENDED!.details).toEqual([{ subjectLabel: "加速・この項目の総距離", valueLabel: "値: 不明〜420m", limitLabel: null }]);
    expect(byCode.WEEKLY_HIGH_SESSIONS!.details).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

describe("R10-B3: Confidence / DRAFT の区別", () => {
  const base = { directness: "PARTIAL", inputData: "MEDIUM" } as const;

  it("HIGH / MODERATE / LOW / POLICY_ONLY", () => {
    expect(presentConfidence({ ...base, prescription: "HIGH" }, "ACTIVE").prescriptionLabel).toBe("確信度 高");
    expect(presentConfidence({ ...base, prescription: "MODERATE" }, "ACTIVE").prescriptionLabel).toBe("確信度 中");
    expect(presentConfidence({ ...base, prescription: "LOW" }, "ACTIVE").prescriptionLabel).toBe("確信度 低");
    const policy = presentConfidence({ ...base, prescription: "POLICY_ONLY" }, "ACTIVE");
    expect(policy.prescriptionLabel).toBe("暫定ルール");
    expect(policy.isPolicyOnly).toBe(true);
    expect(policy.ruleSetNoticeLabel).toBeNull();
  });

  it("confidence=MODERATE × ruleSet=DRAFT は「確信度 中」と「ルールセット 暫定版」を別々に表示する", () => {
    const dto = presentConfidence({ ...base, prescription: "MODERATE" }, "DRAFT");
    expect(dto.prescriptionLabel).toBe("確信度 中");
    expect(dto.ruleSetNoticeLabel).toBe("ルールセット 暫定版");
    const text = stripTags(renderMarkup(ConfidenceBadge, { confidence: dto }));
    expect(text).toMatch(/確信度 中/);
    expect(text).toMatch(/ルールセット 暫定版/);
    expect(text).not.toMatch(/暫定ルール/);
  });

  it("POLICY_ONLY × ACTIVE は「暫定ルール」だけ（RuleSet を暫定版と表示しない）", () => {
    const text = stripTags(renderMarkup(ConfidenceBadge, { confidence: presentConfidence({ ...base, prescription: "POLICY_ONLY" }, "ACTIVE") }));
    expect(text).toMatch(/暫定ルール/);
    expect(text).not.toMatch(/ルールセット/);
  });

  it("directness を日本語化する", () => {
    expect(presentConfidence({ prescription: "LOW", directness: "DIRECT", inputData: "HIGH" }, "ACTIVE").directnessLabel).toBe("直接的");
    expect(presentConfidence({ prescription: "LOW", directness: "PARTIAL", inputData: "HIGH" }, "ACTIVE").directnessLabel).toBe("一部適用");
    expect(presentConfidence({ prescription: "LOW", directness: "INDIRECT", inputData: "HIGH" }, "ACTIVE").directnessLabel).toBe("間接的");
    expect(presentConfidence({ prescription: "LOW", directness: "NOT_APPLICABLE", inputData: "HIGH" }, "ACTIVE").directnessLabel).toBe("適用対象外");
  });
});

// ---------------------------------------------------------------------------
// Dose
// ---------------------------------------------------------------------------

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

describe("R10-B3: Dose presentation", () => {
  it("MAX_INTENT（加速）は「全力意図」で、% を表示しない（100% に変換しない）", () => {
    const p = planAcc();
    expect(p.intensity.reference.kind).toBe("MAX_INTENT");
    const dose = presentDose(p);
    expect(dose.intensityLabel).toBe("全力意図");
    expect(dose.intensityTargetLabel).toBeNull();
    expect(allStrings(dose).join(" ")).not.toMatch(/%/);
  });

  it("RELAXED_SUBMAX（流し）も数値目標を作らない", () => {
    const dose = presentDose(planStride());
    expect(dose.intensityLabel).toBe("リラックスした準最大");
    expect(dose.intensityTargetLabel).toBeNull();
  });

  it("rest は displayAsFloor なので「以上」を付ける（固定値風に見せない）", () => {
    const dose = presentDose(planTi());
    expect(dose.restLabel).toMatch(/^本間レスト .+以上$/);
    expect(dose.setRestLabel).toBe("セット間 8分以上");
    expect(presentDose(planLsrIncomplete()).intraRepRestLabel).toMatch(/^区間の間 .+以上$/);
  });

  it("FLY は助走 / フライ / 減速を区別し、減速をフライ区間へ合算しない", () => {
    const p = planMvFly20();
    if (p.rep.kind !== "FLY") throw new Error("unreachable");
    const dose = presentDose(p);
    if (dose.repStructure.kind !== "FLY") throw new Error("unreachable");
    expect(dose.repStructure.buildUpLabel).toBe(`助走 ${p.rep.buildUpDistanceM.value}m`);
    expect(dose.repStructure.flyZoneLabel).toBe(`フライ ${p.rep.flyZoneDistanceM.value}m`);
    expect(dose.repStructure.decelerationLabel).toBe(`減速 ${p.rep.decelerationDistanceM}m（高速で走る量には含めない）`);
    expect(dose.distanceLabel).toBe(`助走 ${p.rep.buildUpDistanceM.value}m ＋ フライ ${p.rep.flyZoneDistanceM.value}m`);
    expect(dose.distanceLabel).not.toMatch(/減速/);
  });

  it("減速区間が null（アシステッド）は 0m と表示しない", () => {
    const p = planAssisted();
    if (p.rep.kind !== "FLY") throw new Error("unreachable");
    expect(p.rep.decelerationDistanceM).toBeNull();
    const dose = presentDose(p);
    if (dose.repStructure.kind !== "FLY") throw new Error("unreachable");
    expect(dose.repStructure.decelerationLabel).toBeNull();
    expect(dose.repStructure.totalRunningLabel).toBeNull();
    expect(allStrings(dose).join(" ")).not.toMatch(/(^|[^0-9])0m/);
  });

  it("片側不明の区間は「不明」、両側不明は表示しない（0 にしない）", () => {
    const base = planSes();
    if (base.rep.kind !== "DURATION") throw new Error("unreachable");
    const oneSide = structuredClone(base) as RunningPrescriptionValue & { rep: { kind: "DURATION" } };
    oneSide.rep.displayDistanceM = { ...oneSide.rep.displayDistanceM, lower: null, upper: 95 };
    const d1 = presentDose(oneSide);
    if (d1.repStructure.kind !== "DURATION") throw new Error("unreachable");
    expect(d1.repStructure.approxDistanceLabel).toBe("距離の目安 不明〜95m");

    const unknown = structuredClone(base) as RunningPrescriptionValue & { rep: { kind: "DURATION" } };
    unknown.rep.displayDistanceM = { ...unknown.rep.displayDistanceM, lower: null, upper: null };
    const d2 = presentDose(unknown);
    if (d2.repStructure.kind !== "DURATION") throw new Error("unreachable");
    expect(d2.repStructure.approxDistanceLabel).toBeNull();
    expect(allStrings(d2).join(" ")).not.toMatch(/(^|[^0-9.])0m/);
    expect(formatIntervalJa({ lower: 12.5, upper: null }, "s")).toBe("12.5秒〜不明");
  });

  it("範囲は中央値にしない（88〜92% を 90% と表示しない）", () => {
    const p = structuredClone(planTi());
    p.intensity = { reference: p.intensity.reference, target: { lower: 88, upper: 92, unit: "percent", source: "RULE_DEFINITION", confidence: "MEDIUM" } } as RunningPrescriptionValue["intensity"];
    const dose = presentDose(p);
    expect(dose.intensityTargetLabel).toBe("強度の目安（最高速度に対する割合） 88〜92%");
    expect(dose.intensityTargetLabel).not.toMatch(/90%/);
    expect(formatRangeJa({ min: 120, max: 240 }, "s")).toBe("2分〜4分");
  });

  it("速度低下率の % は「速度低下率の目安」として言い分ける（最高速度に対する % と誤読させない）", () => {
    const dose = presentDose(planRs());
    expect(dose.intensityLabel).toMatch(/^速度低下率の目安/);
    expect(dose.intensityTargetLabel).toMatch(/^速度低下率の目安 /);
    expect(dose.intensityTargetLabel).not.toMatch(/最高速度/);
  });

  it("セットで区切らない構造は「N本」、分割走は区間を「＋」で並べる", () => {
    const dose = presentDose(planLsrIncomplete());
    expect(dose.countsLabel).toMatch(/^\d+本$/);
    expect(dose.distanceLabel).toBe("300m ＋ 100m");
    expect(presentDose(planTi()).countsLabel).toBe("3セット × 4本");
  });
});
