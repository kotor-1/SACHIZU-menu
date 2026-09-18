/**
 * R10-B3 — 日本語ラベル registry と Finding message registry の網羅性。
 *
 * enum に値が増えた / domain に新しい Finding code が増えたのにラベル・文言が無い、を検出する。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_TYPES } from "@/domain/running/evidence/schema";
import { ELIGIBILITY_REASON_CODES } from "@/domain/running/planning/schema";
import { PLAUSIBILITY_FINDING_CODES } from "@/domain/running/plausibility/output";
import { STORED_MENU_NOT_EVALUATED_REASONS } from "@/actions/_running-menu-evaluation";
import { ENVELOPE_FIELDS, JUDGEMENTS, RULE_SET_STATUSES } from "@/domain/running/rules/schema";
import { FINDING_SCOPES, FINDING_SEVERITIES } from "@/domain/running/types/findings";
import { INTENSITY_REFERENCE_KINDS } from "@/domain/running/types/intensity";
import { RUNNING_TRAINING_METHODS } from "@/domain/running/types/method";
import {
  DIRECTNESS_VALUES,
  INPUT_DATA_CONFIDENCES,
  PRESCRIPTION_CONFIDENCE_VALUES,
  VALUE_ORIGINS,
  planningControlsSchema,
} from "@/domain/running/types/prescription";
import { RECOVERY_STRUCTURES } from "@/domain/running/types/template";
import { ELIGIBILITY_REASON_MESSAGE_JA, FINDING_MESSAGE_JA, UNKNOWN_FINDING_MESSAGE_JA } from "@/presentation/running/finding-messages";
import {
  DIRECTNESS_DESCRIPTION_JA,
  DIRECTNESS_LABEL_JA,
  EDITABLE_FIELD_DISPLAY,
  EVIDENCE_SOURCE_TYPE_LABEL_JA,
  FINDING_SCOPE_LABEL_JA,
  FINDING_SEVERITY_LABEL_JA,
  GENERATED_BY_LABEL_JA,
  INPUT_DATA_CONFIDENCE_LABEL_JA,
  INTENSITY_REFERENCE_LABEL_JA,
  JUDGEMENT_LABEL_JA,
  METHOD_LABEL_JA,
  POSITION_PREFERENCE_LABEL_JA,
  PRESCRIPTION_CONFIDENCE_DESCRIPTION_JA,
  PRESCRIPTION_CONFIDENCE_LABEL_JA,
  RECOVERY_STRUCTURE_LABEL_JA,
  RULE_SET_STATUS_LABEL_JA,
  VALUE_ORIGIN_LABEL_JA,
} from "@/presentation/running/labels";
import { rawKeyLeaks } from "./helpers";

const ROOT = process.cwd();

function expectFullJapaneseCoverage(name: string, values: readonly string[], table: Readonly<Record<string, string>>) {
  for (const value of values) {
    const label = table[value];
    expect(label, `${name}.${value} のラベルがありません`).toBeTypeOf("string");
    expect(label!.trim(), `${name}.${value}`).not.toBe("");
    expect(label, `${name}.${value} のラベルに内部キーが含まれています`).not.toBe(value);
    expect(rawKeyLeaks(label!), `${name}.${value}`).toEqual([]);
  }
  expect(Object.keys(table).sort(), `${name} に enum 以外のキーがあります`).toEqual([...values].sort());
}

describe("R10-B3: 日本語ラベル registry の網羅性", () => {
  it("10 Method すべてに日本語の分類名がある", () => {
    expect(RUNNING_TRAINING_METHODS).toHaveLength(10);
    expectFullJapaneseCoverage("Method", RUNNING_TRAINING_METHODS, METHOD_LABEL_JA);
  });

  it("RecoveryStructure / PrescriptionConfidence / Directness / InputDataConfidence", () => {
    expectFullJapaneseCoverage("RecoveryStructure", RECOVERY_STRUCTURES, RECOVERY_STRUCTURE_LABEL_JA);
    expectFullJapaneseCoverage("PrescriptionConfidence", PRESCRIPTION_CONFIDENCE_VALUES, PRESCRIPTION_CONFIDENCE_LABEL_JA);
    expectFullJapaneseCoverage("PrescriptionConfidence(description)", PRESCRIPTION_CONFIDENCE_VALUES, PRESCRIPTION_CONFIDENCE_DESCRIPTION_JA);
    expectFullJapaneseCoverage("Directness", DIRECTNESS_VALUES, DIRECTNESS_LABEL_JA);
    expectFullJapaneseCoverage("Directness(description)", DIRECTNESS_VALUES, DIRECTNESS_DESCRIPTION_JA);
    expectFullJapaneseCoverage("InputDataConfidence", INPUT_DATA_CONFIDENCES, INPUT_DATA_CONFIDENCE_LABEL_JA);
  });

  it("FindingSeverity / FindingScope", () => {
    expectFullJapaneseCoverage("FindingSeverity", FINDING_SEVERITIES, FINDING_SEVERITY_LABEL_JA);
    expectFullJapaneseCoverage("FindingScope", FINDING_SCOPES, FINDING_SCOPE_LABEL_JA);
  });

  it("Evidence sourceType（14種）/ Judgement / RuleSet status", () => {
    expect(SOURCE_TYPES).toHaveLength(14);
    expectFullJapaneseCoverage("SourceType", SOURCE_TYPES, EVIDENCE_SOURCE_TYPE_LABEL_JA);
    expectFullJapaneseCoverage("Judgement", JUDGEMENTS, JUDGEMENT_LABEL_JA);
    expectFullJapaneseCoverage("RuleSetStatus", RULE_SET_STATUSES, RULE_SET_STATUS_LABEL_JA);
  });

  it("generatedBy / positionPreference（null は「指定なし」）", () => {
    expectFullJapaneseCoverage("GeneratedBy", ["ENGINE", "AI_PLANNER"], GENERATED_BY_LABEL_JA);
    const preferenceValues = planningControlsSchema.shape.positionPreference.unwrap().options;
    expectFullJapaneseCoverage("PositionPreference", [...preferenceValues, "NONE"], POSITION_PREFERENCE_LABEL_JA);
  });

  it("IntensityReference kind / ValueOrigin / 編集 field（EnvelopeField + 助走距離）", () => {
    expectFullJapaneseCoverage("IntensityReference", INTENSITY_REFERENCE_KINDS, INTENSITY_REFERENCE_LABEL_JA);
    expectFullJapaneseCoverage("ValueOrigin", VALUE_ORIGINS, VALUE_ORIGIN_LABEL_JA);
    const fieldLabels = Object.fromEntries(Object.entries(EDITABLE_FIELD_DISPLAY).map(([k, v]) => [k, v.label]));
    expectFullJapaneseCoverage("EditableField", [...ENVELOPE_FIELDS, "approachDistanceM"], fieldLabels);
  });

  it("confidence の POLICY_ONLY は「暫定ルール」、RuleSet の DRAFT は「暫定版」（別の言葉）", () => {
    expect(PRESCRIPTION_CONFIDENCE_LABEL_JA.POLICY_ONLY).toBe("暫定ルール");
    expect(RULE_SET_STATUS_LABEL_JA.DRAFT).toBe("暫定版");
    expect(PRESCRIPTION_CONFIDENCE_LABEL_JA.HIGH).toBe("確信度 高");
    expect(PRESCRIPTION_CONFIDENCE_LABEL_JA.MODERATE).toBe("確信度 中");
    expect(PRESCRIPTION_CONFIDENCE_LABEL_JA.LOW).toBe("確信度 低");
  });
});

// ---------------------------------------------------------------------------
// Finding code の収集（ソース走査）
// ---------------------------------------------------------------------------

function listFiles(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, ext);
    return ext.test(entry.name) ? [full] : [];
  });
}

const FINDING_CALL = /\b(?:itemFinding|sessionFinding|weekFinding|finding|snapshotFinding|transientFinding|coachReviewFinding)\(\s*"([A-Z][A-Z0-9_]+)"/g;
const FINDING_LITERAL = /\{\s*code:\s*"([A-Z][A-Z0-9_]+)",\s*severity:/g;
const RULESET_FINDING_CODE = /"(?:findingCode|infoFindingCode|editableFindingCode)":\s*"([A-Z][A-Z0-9_]+)"/g;

function collectDomainFindingCodes(): string[] {
  const codes = new Set<string>();
  const sources = [
    ...listFiles(path.join(ROOT, "src/domain/running"), /\.ts$/),
    path.join(ROOT, "src/actions/_session-planning-service.ts"),
    path.join(ROOT, "src/actions/_running-menu-evaluation.ts"),
  ];
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(FINDING_CALL)) codes.add(m[1]!);
    for (const m of text.matchAll(FINDING_LITERAL)) codes.add(m[1]!);
  }
  for (const file of listFiles(path.join(ROOT, "src/domain/running/rules/sets"), /\.json$/)) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(RULESET_FINDING_CODE)) codes.add(m[1]!);
  }
  for (const code of Object.values(PLAUSIBILITY_FINDING_CODES)) codes.add(code);
  // [R10-B4B] 保存済みメニューを評価できなかった理由は、そのまま REQUIRE_COACH_REVIEW の Finding code になる
  // （B2 は `coachReviewFinding(evaluated.reason)` として渡す）。
  for (const reason of STORED_MENU_NOT_EVALUATED_REASONS) codes.add(reason);
  return [...codes].sort();
}

describe("R10-B3: Finding message registry の網羅性", () => {
  const codes = collectDomainFindingCodes();

  it("domain（R1〜R10）が出す Finding code をソースから収集できている", () => {
    expect(codes.length).toBeGreaterThan(80);
    for (const representative of [
      "RULESET_DRAFT",
      "WEEKLY_HIGH_WITHIN_48H",
      "WEEKLY_NONRUN_HIGH_WITHIN_48H",
      "HISTORY_UNKNOWN",
      "READINESS_CHECK_REQUIRED",
      "AGG_METHOD_BUDGET_OVER_RECOMMENDED",
      "AGG_HIGH_INTENSITY_BUDGET",
      "AGG_COMPETITION_DAY_EXTRA",
      "AGG_REST_INFEASIBLE",
      "AGG_TOTAL_RUNNING_CONFIRM",
      "AGG_TOTAL_RUNNING_BLOCK",
      "SNAPSHOT_JSON_INVALID",
      "RUNNING_CONTEXT_UNAVAILABLE",
      "SESSION_DATE_CONTEXT_MISMATCH",
      "MIXED_RULESET_VERSIONS",
      "RULESET_VERSION_UNAVAILABLE",
    ]) {
      expect(codes, representative).toContain(representative);
    }
  });

  it("収集したすべての Finding code に日本語 message がある（内部キーを含まない）", () => {
    const missing = codes.filter((code) => !Object.prototype.hasOwnProperty.call(FINDING_MESSAGE_JA, code));
    expect(missing, `message が無い Finding code: ${missing.join(", ")}`).toEqual([]);
    for (const [code, message] of Object.entries(FINDING_MESSAGE_JA)) {
      expect(message.trim(), code).not.toBe("");
      expect(rawKeyLeaks(message), code).toEqual([]);
    }
  });

  it("EligibilityReason code すべてに日本語 message がある", () => {
    for (const code of ELIGIBILITY_REASON_CODES) {
      expect(ELIGIBILITY_REASON_MESSAGE_JA[code], code).toBeTypeOf("string");
      expect(rawKeyLeaks(ELIGIBILITY_REASON_MESSAGE_JA[code]), code).toEqual([]);
    }
  });

  it("BLOCK_AUTOGEN 系の message は「使用禁止」「作成不可」と言わない", () => {
    for (const [code, message] of Object.entries(FINDING_MESSAGE_JA)) {
      expect(message, code).not.toMatch(/使用禁止/);
    }
    expect(UNKNOWN_FINDING_MESSAGE_JA).toBe("確認が必要な情報があります。");
  });
});
