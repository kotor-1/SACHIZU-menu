/**
 * R10-B4A — REQUIRE_CONFIRMATION の明示確認 contract（純粋関数）と、Provenance の後方互換、
 * domain CoachOverride schema の confirmedTwice（合成 hardSafety セル）。
 */
import { describe, expect, it } from "vitest";
import { evaluateFindingConfirmation, requiredConfirmationCodes } from "@/domain/running/planning/confirmation";
import { planRunningPrescriptionWithRuleSet } from "@/domain/running/planning";
import { AGGREGATE_ENVELOPE_FIELDS } from "@/domain/running/planning/schema";
import { buildProvenance, provenanceSchema } from "@/domain/running/persistence/provenance";
import { getRuleSet } from "@/domain/running/rules/loader";
import { ENVELOPE_FIELDS, type RuleSet } from "@/domain/running/rules/schema";
import type { Finding } from "@/domain/running/types/findings";
import { COACH, makeRequest, plan, provenanceFor } from "../../repository/running/fixtures";

const finding = (code: string, severity: Finding["severity"]): Finding => ({ code, severity, scope: "SESSION", evidenceIds: [] }) as Finding;

describe("R10-B4A: requiredConfirmationCodes / evaluateFindingConfirmation", () => {
  it("REQUIRE_CONFIRMATION の code だけを重複なしで集める（同じ code の複数 Finding は1つ）", () => {
    expect(
      requiredConfirmationCodes([
        finding("A_CONFIRM", "REQUIRE_CONFIRMATION"),
        finding("A_CONFIRM", "REQUIRE_CONFIRMATION"),
        finding("B_REVIEW", "REQUIRE_COACH_REVIEW"),
        finding("C_BLOCK", "BLOCK"),
        finding("D_CONFIRM", "REQUIRE_CONFIRMATION"),
      ]),
    ).toEqual(["A_CONFIRM", "D_CONFIRM"]);
  });

  it.each([
    { name: "required なし + []", required: [], confirmed: [], expected: { kind: "CONFIRMED", confirmedCodes: [] } },
    { name: "required A + []", required: ["A"], confirmed: [], expected: { kind: "CONFIRMATION_REQUIRED", requiredFindingCodes: ["A"], missingFindingCodes: ["A"] } },
    { name: "required A + [A]", required: ["A"], confirmed: ["A"], expected: { kind: "CONFIRMED", confirmedCodes: ["A"] } },
    { name: "required A/B + [A]", required: ["A", "B"], confirmed: ["A"], expected: { kind: "CONFIRMATION_REQUIRED", requiredFindingCodes: ["A", "B"], missingFindingCodes: ["B"] } },
    { name: "required A + [OLD]", required: ["A"], confirmed: ["OLD"], expected: { kind: "CONFIRMATION_STATE_STALE", requiredFindingCodes: ["A"], staleFindingCodes: ["OLD"] } },
    { name: "required A + [A, OLD]", required: ["A"], confirmed: ["A", "OLD"], expected: { kind: "CONFIRMATION_STATE_STALE", requiredFindingCodes: ["A"], staleFindingCodes: ["OLD"] } },
    { name: "required なし + [OLD]", required: [], confirmed: ["OLD"], expected: { kind: "CONFIRMATION_STATE_STALE", requiredFindingCodes: [], staleFindingCodes: ["OLD"] } },
    { name: "重複 code は1回の確認で足りる", required: ["A", "A"], confirmed: ["A", "A"], expected: { kind: "CONFIRMED", confirmedCodes: ["A"] } },
  ])("$name", ({ required, confirmed, expected }) => {
    expect(evaluateFindingConfirmation(required, confirmed)).toEqual(expected);
  });
});

describe("R10-B4A: Provenance の後方互換（findingConfirmations / overrides[].confirmedTwice）", () => {
  it("旧 provenance（新しい optional field 無し）をそのまま読める", () => {
    const old = JSON.parse(JSON.stringify(provenanceFor(plan("ACCELERATION", "ACC_BLOCK_30"))));
    expect("findingConfirmations" in old).toBe(false);
    old.overrides = [{ at: "2026-09-15T09:00:00+09:00", target: { kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" }, to: 350, reason: "以前の override" }];
    expect(provenanceSchema.safeParse(old).success).toBe(true);
  });

  it("確認した Finding が無ければ key を持たず、あれば code と日時だけを保存する", () => {
    const p = plan("ACCELERATION", "ACC_BLOCK_30");
    const base = provenanceFor(p);
    const args = { prescription: p, engineVersion: base.engineVersion, inputsDigest: base.inputsDigest, coachEdits: [], overrides: [], aiReason: null };
    expect("findingConfirmations" in buildProvenance({ ...args, findingConfirmations: [] })).toBe(false);
    const withConfirmation = buildProvenance({
      ...args,
      findingConfirmations: [{ code: "AGG_TOTAL_RUNNING_CONFIRM", at: "2026-09-20T10:00:00+09:00" as never }],
    });
    expect(withConfirmation.findingConfirmations).toEqual([{ code: "AGG_TOTAL_RUNNING_CONFIRM", at: "2026-09-20T10:00:00+09:00" }]);
  });

  it("確認記録は code の形・重複・余分な key を検証する（任意の文字列や健康情報を持てない）", () => {
    const base = JSON.parse(JSON.stringify(provenanceFor(plan("ACCELERATION", "ACC_BLOCK_30"))));
    const at = "2026-09-20T10:00:00+09:00";
    expect(provenanceSchema.safeParse({ ...base, findingConfirmations: [{ code: "痛みあり", at }] }).success).toBe(false);
    expect(provenanceSchema.safeParse({ ...base, findingConfirmations: [{ code: "A_CONFIRM", at }, { code: "A_CONFIRM", at }] }).success).toBe(false);
    expect(provenanceSchema.safeParse({ ...base, findingConfirmations: [{ code: "A_CONFIRM", at, note: "x" }] }).success).toBe(false);
  });
});

describe("R10-B4A: domain CoachOverride schema の confirmedTwice（合成 hardSafety セル）", () => {
  function ruleSetWithRepRestHardSafety(): RuleSet {
    const rs = structuredClone(getRuleSet("rs-2026.09.0")!);
    rs.ruleSetVersion = "rs-test-hard-safety";
    for (const envelope of rs.envelopes) {
      if (envelope.method === "ACCELERATION" && envelope.templateIds.includes("ACC_BLOCK_30") && envelope.fields.repRestS) {
        envelope.fields.repRestS = { ...envelope.fields.repRestS, hardSafety: { min: 60, max: 900, unit: "s" } };
      }
    }
    return rs;
  }

  const hardSafetyOverride = (confirmedTwice: boolean) => ({
    target: { kind: "FIELD", field: "repRestS", layer: "HARD_SAFETY" },
    newValue: 1000,
    reason: "安全上の範囲の外を検証するテスト",
    confirmedTwice,
    actor: COACH,
    at: "2026-09-15T09:00:00+09:00",
  });

  it("HARD_SAFETY: confirmedTwice=false は保存できる処方にならない。true なら（他の条件も満たせば）OK", () => {
    const resolved = { ruleSet: ruleSetWithRepRestHardSafety(), contentHash: "hash-hard-safety", isDraftFallback: false };
    const rejected = planRunningPrescriptionWithRuleSet(makeRequest("ACCELERATION", "ACC_BLOCK_30", { overrides: [hardSafetyOverride(false)] }), resolved);
    expect(rejected.status).toBe("BLOCKED");
    if (rejected.status !== "BLOCKED") throw new Error("unreachable");
    expect(rejected.findings.map((f) => f.code)).toContain("PLAN_REQUEST_INVALID");

    const accepted = planRunningPrescriptionWithRuleSet(makeRequest("ACCELERATION", "ACC_BLOCK_30", { overrides: [hardSafetyOverride(true)] }), resolved);
    expect(accepted.status, JSON.stringify(accepted)).toBe("OK");
    if (accepted.status !== "OK") throw new Error("unreachable");
    expect(accepted.prescription.rest.repRestS).toMatchObject({ value: 1000, origin: "COACH_OVERRIDE" });
  });
});

describe("R10-B4A: aggregate EnvelopeField の定義", () => {
  it("aggregate / constraint 型の5 field だけを直接 edit 対象外にする（すべて実在の EnvelopeField）", () => {
    expect([...AGGREGATE_ENVELOPE_FIELDS].sort()).toEqual(["attempts", "flyVolumeM", "sessionVolumeM", "totalReps", "vdecPercent"]);
    for (const field of AGGREGATE_ENVELOPE_FIELDS) expect(ENVELOPE_FIELDS).toContain(field);
  });
});
