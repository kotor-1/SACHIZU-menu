import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  ruleSetSchema,
  checkRuleSetCompleteness,
  envelopeCellSchema,
  eligibilityRuleSchema,
  plausibilityRuleSchema,
  type RuleSet,
} from "@/domain/running/rules/schema";
import { getRuleSet, getActiveRuleSet, selectActiveRuleSet, listRuleSetVersions } from "@/domain/running/rules/loader";
import { RUNNING_TRAINING_METHODS } from "@/domain/running/types/method";
import { TEMPLATE_IDS_BY_METHOD, ALL_TEMPLATE_IDS } from "@/domain/running/types/template";

const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures/running");

function loadFixture(name: string): RuleSet {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf-8"));
  const parsed = ruleSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fixture ${name} failed to parse: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// loader: getRuleSet / getActiveRuleSet（本番 rs-2026.09.0）
// ---------------------------------------------------------------------------

describe("loader: getRuleSet / getActiveRuleSet", () => {
  it("getRuleSet('rs-2026.09.0') は ACTIVE の RuleSet を返す", () => {
    const rs = getRuleSet("rs-2026.09.0");
    expect(rs).not.toBeNull();
    expect(rs?.status).toBe("ACTIVE");
  });

  it("存在しない version は null を返す", () => {
    expect(getRuleSet("rs-9999.99.9")).toBeNull();
  });

  it("ACTIVE 版（rs-2026.09.0）があるため getActiveRuleSet は isDraftFallback=false を返す", () => {
    const result = getActiveRuleSet("2030-01-01");
    expect(result.isDraftFallback).toBe(false);
    expect(result.ruleSet.status).toBe("ACTIVE");
    expect(result.ruleSet.ruleSetVersion).toBe("rs-2026.09.0");
  });

  it("listRuleSetVersions に rs-2026.09.0 が含まれる", () => {
    expect(listRuleSetVersions()).toContain("rs-2026.09.0");
  });
});

// ---------------------------------------------------------------------------
// T-RV-03: 旧 RuleSet が残り、新 version 追加後も旧 version を取得できる
// ---------------------------------------------------------------------------

describe("T-RV-03: active RuleSet selection across versions (rs-test-a / rs-test-b)", () => {
  const a = loadFixture("rs-test-a"); // status=ACTIVE, validFrom=2020-01-01
  const b = loadFixture("rs-test-b"); // status=DRAFT,  validFrom=2025-06-01, supersedes rs-test-a

  it("両方の fixture が RuleSetSchema を満たす", () => {
    expect(a.ruleSetVersion).toBe("rs-test-a");
    expect(b.ruleSetVersion).toBe("rs-test-b");
    expect(b.supersedes).toBe("rs-test-a");
  });

  it("新しい version（DRAFT）を追加しても、旧 version（ACTIVE）は引き続き選択可能", () => {
    // rs-test-b は DRAFT なので、ACTIVE な rs-test-a が優先して選ばれる。
    const result = selectActiveRuleSet([a, b], "2026-01-01");
    expect(result.ruleSet.ruleSetVersion).toBe("rs-test-a");
    expect(result.isDraftFallback).toBe(false);
  });

  it("旧 version（rs-test-a）は new version 追加後もそのままの内容で個別に参照できる（RETIRED でも削除しない設計）", () => {
    const found = [a, b].find((rs) => rs.ruleSetVersion === "rs-test-a");
    expect(found).toBeDefined();
    expect(found?.envelopes[0]?.fields.repDistanceM?.recommended).toEqual({ min: 80, max: 100, unit: "m" });
  });

  it("plannedDate に応じて正しい版が選ばれる（ACTIVE が無い日付では DRAFT に fallback）", () => {
    // a を DRAFT に差し替えた別シナリオ: ACTIVE が存在しない場合は DRAFT の中で最新の validFrom を選ぶ。
    const aAsDraft: RuleSet = { ...a, status: "DRAFT" };
    const result = selectActiveRuleSet([aAsDraft, b], "2026-01-01");
    expect(result.isDraftFallback).toBe(true);
    // aAsDraft(2020-01-01) と b(2025-06-01) のうち、より新しい b が選ばれる。
    expect(result.ruleSet.ruleSetVersion).toBe("rs-test-b");
  });
});

// ---------------------------------------------------------------------------
// RuleSetSchema: cross-validation（§19.1）
// ---------------------------------------------------------------------------

describe("RuleSetSchema cross-validation", () => {
  const base = loadFixture("rs-test-a");

  it("baseline fixture はそのまま valid", () => {
    expect(ruleSetSchema.safeParse(base).success).toBe(true);
  });

  it("templateId が Method 値と衝突すると reject する", () => {
    const bad = {
      ...base,
      templates: [{ ...base.templates[0], id: "STRIDE" }],
      envelopes: [{ ...base.envelopes[0], templateIds: ["STRIDE"] }],
    };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("templateId の接頭辞が method と食い違うと reject する", () => {
    const bad = { ...base, templates: [{ ...base.templates[0], id: "ACC_FAKE" }] };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("method×templateId が R1 の RunningSelection と一致しないと reject する", () => {
    const bad = { ...base, templates: [{ ...base.templates[0], id: "ST_NOT_A_REAL_TEMPLATE" }] };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("templateId の重複を reject する", () => {
    const bad = { ...base, templates: [base.templates[0], base.templates[0]] };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("LONG_SPRINT_RACE_SPECIFIC 以外の template に recoveryStructure が設定されていると reject する", () => {
    const bad = { ...base, templates: [{ ...base.templates[0], recoveryStructure: "FULL" }] };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("Evidence id の重複を reject する", () => {
    const bad = { ...base, evidence: [base.evidence[0], base.evidence[0]] };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("Envelope が実在しない Evidence id を参照すると reject する", () => {
    const bad = {
      ...base,
      envelopes: [
        {
          ...base.envelopes[0],
          fields: {
            repDistanceM: { ...base.envelopes[0].fields.repDistanceM, evidenceIds: ["EV_DOES_NOT_EXIST"] },
          },
        },
      ],
    };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("Envelope が実在しない templateId を参照すると reject する", () => {
    const bad = { ...base, envelopes: [{ ...base.envelopes[0], templateIds: ["ST_DOES_NOT_EXIST"] }] };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("MethodMeta.stopPolicyIds が実在しない StopPolicy を参照すると reject する", () => {
    const bad = { ...base, methods: [{ ...base.methods[0], stopPolicyIds: ["SP_DOES_NOT_EXIST"] }] };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("StopPolicy.id の重複を reject する", () => {
    const bad = { ...base, stopPolicies: [base.stopPolicies[0], base.stopPolicies[0]] };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("recommended が coachEditable の範囲を超えていると reject する（recommended ⊆ coachEditable）", () => {
    const parsed = envelopeCellSchema.safeParse({
      recommended: { min: 5, max: 200, unit: "m" },
      coachEditable: { min: 10, max: 100, unit: "m" },
      hardSafety: null,
      evidenceIds: [],
      judgement: "ENGINE_POLICY",
    });
    expect(parsed.success).toBe(false);
  });

  it("hardSafety != null のとき coachEditable が hardSafety をはみ出すと reject する", () => {
    const parsed = envelopeCellSchema.safeParse({
      recommended: null,
      coachEditable: { min: 0, max: 500, unit: "m" },
      hardSafety: { min: 0, max: 300, unit: "m" },
      evidenceIds: [],
      judgement: "ENGINE_POLICY",
    });
    expect(parsed.success).toBe(false);
  });

  it("hardSafety が null のときは coachEditable の範囲チェックをしない（rs-2026.09.0 の初版方針）", () => {
    const parsed = envelopeCellSchema.safeParse({
      recommended: null,
      coachEditable: { min: 0, max: 100000, unit: "m" },
      hardSafety: null,
      evidenceIds: [],
      judgement: "ENGINE_POLICY",
    });
    expect(parsed.success).toBe(true);
  });

  it("recommended が null の場合は範囲チェックをスキップする（ASSISTED/TI_COACH_DEFINED のような手動専用セル）", () => {
    const parsed = envelopeCellSchema.safeParse({
      recommended: null,
      coachEditable: { min: 0, max: 100, unit: "m" },
      hardSafety: null,
      evidenceIds: [],
      judgement: "ENGINE_POLICY",
    });
    expect(parsed.success).toBe(true);
  });

  it("Envelope の unit が期待される unit と食い違うと reject する（repDistanceM は m のはず）", () => {
    const bad = {
      ...base,
      envelopes: [
        {
          ...base.envelopes[0],
          fields: {
            repDistanceM: {
              recommended: { min: 80, max: 100, unit: "s" },
              coachEditable: { min: 50, max: 150, unit: "s" },
              hardSafety: null,
              evidenceIds: ["EV_TEST_POLICY"],
              judgement: "ENGINE_POLICY",
            },
          },
        },
      ],
    };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("EligibilityRule: outcome=INELIGIBLE のとき overrideAllowed が null だと reject する", () => {
    expect(
      eligibilityRuleSchema.safeParse({
        ruleId: "TEST",
        method: "STRIDE",
        templateIds: ["ST_WARMUP"],
        maturityCategory: "PRE",
        outcome: "INELIGIBLE",
        requiresReview: false,
        overrideAllowed: null,
        conditionNote: null,
      }).success,
    ).toBe(false);
  });

  it("EligibilityRule: outcome=AUTO のとき overrideAllowed が non-null だと reject する", () => {
    expect(
      eligibilityRuleSchema.safeParse({
        ruleId: "TEST",
        method: "STRIDE",
        templateIds: ["ST_WARMUP"],
        maturityCategory: "PRE",
        outcome: "AUTO",
        requiresReview: false,
        overrideAllowed: true,
        conditionNote: null,
      }).success,
    ).toBe(false);
  });

  it("PlausibilityRule: scope=RATIO のとき ratioMultiplier が必須", () => {
    expect(
      plausibilityRuleSchema.safeParse({
        ruleId: "TEST",
        scope: "RATIO",
        targetLabel: "test",
        field: "totalReps",
        appliesToMethods: null,
        unit: "reps",
        confirmThreshold: null,
        blockThreshold: null,
        ratioMultiplier: null,
        note: null,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-EV-03: Moran 16×20 が Envelope から参照できない（CONTEXT_ONLY のガード）
// ---------------------------------------------------------------------------

describe("T-EV-03: Moran evidence cannot be used as prescription basis", () => {
  it("rs-2026.09.0 の EV_MORAN_2016_YOUTH_DOSE は usage=CONTEXT_ONLY である", () => {
    const rs = getRuleSet("rs-2026.09.0")!;
    const moran = rs.evidence.find((e) => e.id === "EV_MORAN_2016_YOUTH_DOSE");
    expect(moran).toBeDefined();
    expect(moran?.usage).toBe("CONTEXT_ONLY");
  });

  it("rs-2026.09.0 のどの Envelope も EV_MORAN_2016_YOUTH_DOSE を参照していない", () => {
    const rs = getRuleSet("rs-2026.09.0")!;
    for (const env of rs.envelopes) {
      for (const cell of Object.values(env.fields)) {
        if (!cell) continue;
        expect(cell.evidenceIds).not.toContain("EV_MORAN_2016_YOUTH_DOSE");
      }
    }
  });

  it("RuleSetSchema は CONTEXT_ONLY Evidence を Envelope が参照すると reject する（Moran を模した最小ケース）", () => {
    const base = loadFixture("rs-test-a");
    const bad = {
      ...base,
      evidence: [
        ...base.evidence,
        {
          id: "EV_TEST_CONTEXT_ONLY",
          sourceType: "META_ANALYSIS",
          studyDesign: null,
          population: { ageBands: "ANY", maturity: "ANY", sexes: "ANY", performanceLevels: "ANY", sport: "TEAM_SPORT" },
          reference: { citation: "test", year: null, doi: null, url: null },
          evidenceLevel: 1,
          applicabilityNotes: "test",
          usage: "CONTEXT_ONLY",
          verification: "SECONDARY_REPORT_ONLY",
          reportedBy: ["HUMAN"],
          provisional: true,
        },
      ],
      envelopes: [
        {
          ...base.envelopes[0],
          fields: {
            repDistanceM: { ...base.envelopes[0].fields.repDistanceM, evidenceIds: ["EV_TEST_CONTEXT_ONLY"] },
          },
        },
      ],
    };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });

  it("RuleSetSchema は CHECK_ONLY Evidence を Envelope が参照しても reject する", () => {
    const base = loadFixture("rs-test-a");
    const bad = {
      ...base,
      evidence: [
        ...base.evidence,
        {
          id: "EV_TEST_CHECK_ONLY",
          sourceType: "OBSERVATIONAL",
          studyDesign: null,
          population: { ageBands: "ANY", maturity: "ANY", sexes: "ANY", performanceLevels: "ANY", sport: "GENERAL" },
          reference: { citation: "test", year: null, doi: null, url: null },
          evidenceLevel: 3,
          applicabilityNotes: "test",
          usage: "CHECK_ONLY",
          verification: "SECONDARY_REPORT_ONLY",
          reportedBy: ["HUMAN"],
          provisional: true,
        },
      ],
      envelopes: [
        {
          ...base.envelopes[0],
          fields: {
            repDistanceM: { ...base.envelopes[0].fields.repDistanceM, evidenceIds: ["EV_TEST_CHECK_ONLY"] },
          },
        },
      ],
    };
    expect(ruleSetSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-STR-02: STRIDE 専用 Envelope に TEMPO_EXTENSIVE の量が混入していない
// ---------------------------------------------------------------------------

describe("T-STR-02: STRIDE envelope does not inherit TEMPO_EXTENSIVE volume", () => {
  it("STRIDE の sessionVolumeM.coachEditable.max は 900 以下（TEの1000-2000mを参照しない）", () => {
    const rs = getRuleSet("rs-2026.09.0")!;
    const strideEnvelopes = rs.envelopes.filter((e) => e.method === "STRIDE");
    expect(strideEnvelopes.length).toBeGreaterThan(0);
    for (const env of strideEnvelopes) {
      const vol = env.fields.sessionVolumeM;
      expect(vol).toBeDefined();
      expect(vol!.coachEditable.max).toBeLessThanOrEqual(900);
    }
  });

  it("STRIDE の Envelope は intensityPercent フィールドを持たない（RELAXED_SUBMAX・数値%なし）", () => {
    const rs = getRuleSet("rs-2026.09.0")!;
    for (const env of rs.envelopes.filter((e) => e.method === "STRIDE")) {
      expect(env.fields.intensityPercent).toBeUndefined();
    }
  });

  it("TEMPO_EXTENSIVE の Envelope とは method が異なる（データの取り違えが無いこと）", () => {
    const rs = getRuleSet("rs-2026.09.0")!;
    const strideTemplateIds = new Set(rs.templates.filter((t) => t.method === "STRIDE").map((t) => t.id));
    const teTemplateIds = new Set(rs.templates.filter((t) => t.method === "TEMPO_EXTENSIVE").map((t) => t.id));
    for (const id of strideTemplateIds) expect(teTemplateIds.has(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §22 R2 完了条件: 網羅性（本番 rs-2026.09.0 のみに要求）
// ---------------------------------------------------------------------------

describe("rs-2026.09.0 completeness (§22 R2 completion criteria)", () => {
  const rs = getRuleSet("rs-2026.09.0")!;

  it("checkRuleSetCompleteness は問題なしを返す", () => {
    expect(checkRuleSetCompleteness(rs)).toEqual([]);
  });

  it("全10 canonical Method の MethodMeta が存在する（SUBMAX_SPEED_ENDURANCE は含まれない）", () => {
    const methodsSeen = new Set(rs.methods.map((m) => m.method));
    expect(methodsSeen.size).toBe(10);
    for (const m of RUNNING_TRAINING_METHODS) expect(methodsSeen.has(m)).toBe(true);
    expect(methodsSeen.has("SUBMAX_SPEED_ENDURANCE" as never)).toBe(false);
  });

  it("§3.3 の全38 template が存在する", () => {
    const templateIdsSeen = new Set(rs.templates.map((t) => t.id));
    expect(templateIdsSeen.size).toBe(ALL_TEMPLATE_IDS.length);
    for (const method of RUNNING_TRAINING_METHODS) {
      for (const id of TEMPLATE_IDS_BY_METHOD[method]) {
        expect(templateIdsSeen.has(id), `missing template ${id}`).toBe(true);
      }
    }
  });

  it("template id は全体で一意、かつ Method 名と衝突しない", () => {
    const ids = rs.templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const methodNames = new Set<string>(RUNNING_TRAINING_METHODS);
    for (const id of ids) expect(methodNames.has(id)).toBe(false);
  });

  it("§5.6 の主要 Evidence id が存在する", () => {
    const ids = new Set<string>(rs.evidence.map((e) => e.id));
    const required = [
      "EV_HAUGEN_2019_REVIEW",
      "EV_HAUGEN_2019_ACC_EXAMPLES",
      "EV_HAUGEN_2019_MV_EXAMPLES",
      "EV_HAUGEN_2019_SES_EXAMPLES",
      "EV_HAUGEN_2019_VOLUME_TABLE",
      "EV_HAUGEN_2019_TEMPO",
      "EV_HAUGEN_2019_VITTORI",
      "EV_VITTORI_1981_PRIMARY",
      "EV_HAUGEN_2019_48H",
      "EV_UKA_CLASSIFICATION",
      "EV_PETRAKOS_2016_VDEC",
      "EV_RESISTED_META_2024_2025",
      "EV_ASSISTED_EVIDENCE_LIMITED",
      "EV_MORAN_2016_YOUTH_DOSE",
      "EV_MATURITY_NOT_AGE",
      "EV_GROWTH_VELOCITY_7_2",
      "EV_BOSQUET_2007_TAPER",
      "EV_RESISTED_RECOVERY_2023",
      "EV_THOMAS_2018",
      "EV_WELLNESS_SR",
      "EV_TIMING_ERROR_REPORTS",
      "EV_JAAF_JHS_GUIDE",
      "EV_ENGINE_SAFETY_POLICY",
      "EV_JAAF_WIND_SPRINT",
      "EV_ENGINE_POLICY",
    ];
    for (const id of required) expect(ids.has(id), `missing evidence ${id}`).toBe(true);
    expect(rs.evidence.length).toBe(required.length);
  });

  it("EV_THOMAS_2018 は CROSSOVER_REPEATED_MEASURES（RCTではない）", () => {
    const thomas = rs.evidence.find((e) => e.id === "EV_THOMAS_2018");
    expect(thomas?.sourceType).toBe("CROSSOVER_REPEATED_MEASURES");
  });

  it("EV_MATURITY_NOT_AGE は CONSENSUS_STATEMENT として代表され、studyDesign に一次資料未照合の注記がある（R2 implementation representation policy）", () => {
    const ev = rs.evidence.find((e) => e.id === "EV_MATURITY_NOT_AGE");
    expect(ev?.sourceType).toBe("CONSENSUS_STATEMENT");
    expect(ev?.studyDesign).toContain("一次資料未照合");
  });

  it("§10.2 の全 TimingMethod（6種）が存在する", () => {
    const seen = new Set(rs.timingTolerances.map((t) => t.timing));
    for (const t of ["HAND", "PHOTO_CELL", "FAT", "VIDEO", "RADAR_LASER", "UNKNOWN"] as const) {
      expect(seen.has(t)).toBe(true);
    }
  });

  it("RADAR_LASER と UNKNOWN は numericStopAllowed=false（COACH_ONLY）", () => {
    for (const timing of ["RADAR_LASER", "UNKNOWN"] as const) {
      const rule = rs.timingTolerances.find((t) => t.timing === timing);
      expect(rule?.numericStopAllowed).toBe(false);
    }
  });

  it("全 timingTolerances は provisional=true（確定値として扱わない）", () => {
    for (const t of rs.timingTolerances) expect(t.provisional).toBe(true);
  });

  it("§10.3 の全12 StopPolicy id が存在する", () => {
    const ids = new Set<string>(rs.stopPolicies.map((s) => s.id));
    const required = [
      "SP_ACC", "SP_MV", "SP_SES", "SP_LSR_FULL", "SP_LSR_INCOMPLETE_ADV",
      "SP_LSR_INCOMPLETE_STRICT", "SP_TE", "SP_TI", "SP_RS", "SP_AS", "SP_EA", "SP_STRIDE",
    ];
    for (const id of required) expect(ids.has(id), `missing stop policy ${id}`).toBe(true);
    expect(rs.stopPolicies.length).toBe(required.length);
  });

  it("LONG_SPRINT_RACE_SPECIFIC は FULL と INCOMPLETE それぞれの StopPolicy を持つ", () => {
    const lsr = rs.stopPolicies.filter((s) => s.method === "LONG_SPRINT_RACE_SPECIFIC");
    expect(lsr.some((s) => s.appliesToRecoveryStructure === "FULL")).toBe(true);
    expect(lsr.some((s) => s.appliesToRecoveryStructure === "INCOMPLETE")).toBe(true);
  });

  it("§4.4 の eligibility 全16行×4 maturityCategory = 64件が存在する", () => {
    expect(rs.eligibility.length).toBe(64);
    const ruleIds = new Set(rs.eligibility.map((e) => e.ruleId));
    expect(ruleIds.size).toBe(64);
  });

  it("ASSISTED_SPRINT は全 maturityCategory で INELIGIBLE または advancedOnly の手動のみ（自動生成されない）", () => {
    const rows = rs.eligibility.filter((e) => e.method === "ASSISTED_SPRINT");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.outcome).not.toBe("AUTO");
  });

  it("LONG INCOMPLETE は PRE/EFFECTIVE_UNKNOWN/CIRCA で override不可の INELIGIBLE（Fable C-7）", () => {
    const rows = rs.eligibility.filter(
      (e) => e.method === "LONG_SPRINT_RACE_SPECIFIC" && e.templateIds.includes("LSR_300_PLUS_100"),
    );
    for (const cat of ["PRE", "EFFECTIVE_UNKNOWN", "CIRCA"] as const) {
      const row = rows.find((r) => r.maturityCategory === cat);
      expect(row?.outcome).toBe("INELIGIBLE");
      expect(row?.overrideAllowed).toBe(false);
    }
  });

  it("§8.5 の plausibility 主要行が存在する", () => {
    const labels = rs.plausibility.map((p) => p.targetLabel);
    expect(labels).toContain("メニュー全体の総走行距離");
    expect(labels).toContain("sets/reps取り違え疑い");
    expect(labels).toContain("入力: 100m記録");
    expect(labels).toContain("入力: 身長");
  });

  it("メニュー全体の総走行距離の BLOCK 閾値は 30000m（80km 事故を BLOCK できる設定）", () => {
    const rule = rs.plausibility.find((p) => p.targetLabel === "メニュー全体の総走行距離");
    expect(rule?.blockThreshold?.max).toBe(30000);
    // 80,000m は明らかに BLOCK 閾値(30000m)を超える。
    expect(80000).toBeGreaterThan(rule!.blockThreshold!.max!);
  });

  it("vmaxEstimationModels は空配列（R7ではまだ実装しない）", () => {
    expect(rs.vmaxEstimationModels).toEqual([]);
  });

  it("[R5] readinessRules は空ではない（§13 の判定データはすべて RuleSet 側にある）", () => {
    expect(rs.readinessRules.length).toBeGreaterThan(0);
  });

  it("[R6] aggregationRules は空ではない（§11 の判定データはすべて RuleSet 側にある）", () => {
    expect(rs.aggregationRules.length).toBeGreaterThan(0);
  });

  it("[R7] weeklyRules / phaseRules / competitionRules は空ではない（§12/§14 の判定データはすべて RuleSet 側にある）", () => {
    expect(rs.weeklyRules.length).toBeGreaterThan(0);
    expect(rs.phaseRules.length).toBeGreaterThan(0);
    expect(rs.competitionRules.length).toBeGreaterThan(0);
  });

  it("constraints は R3 で正式化され、4件のConstraintRuleを持つ（§8.2 U12 hard / U15 ASSISTED + §7.5 complexity cap ×2）", () => {
    expect(rs.constraints.length).toBe(4);
    const ids = new Set(rs.constraints.map((c) => c.id));
    expect(ids.has("CONSTRAINT_U12_HARD")).toBe(true);
    expect(ids.has("CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE")).toBe(true);
    expect(ids.has("CONSTRAINT_MATURITY_COMPLEXITY_CAP")).toBe(true);
    expect(ids.has("CONSTRAINT_TRAINING_AGE_BEGINNER_COMPLEXITY_CAP")).toBe(true);
  });

  it("CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE は U15 の ASSISTED_SPRINT だけを override 不可で disallow し、complexity 上限は持たない（§8.2 R3 errata）", () => {
    const c = rs.constraints.find((c) => c.id === "CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE")!;
    expect(c.match).toEqual({ dimension: "AGE_BAND", ageBands: ["U15"] });
    expect(c.disallowedMethods).toEqual(["ASSISTED_SPRINT"]);
    expect(c.disallowedTemplateIds).toEqual([]);
    expect(c.overrideAllowed).toBe(false);
    expect(c.maxAutoComplexity).toBeNull();
    expect(c.judgement).toBe("ENGINE_POLICY");
    expect(c.provisional).toBe(true);
  });

  it("U18 を年齢だけで ASSISTED 禁止にする ConstraintRule は存在しない", () => {
    const u18Assisted = rs.constraints.filter(
      (c) =>
        c.match.dimension === "AGE_BAND" &&
        (c.match.ageBands as readonly string[]).includes("U18") &&
        c.disallowedMethods.includes("ASSISTED_SPRINT"),
    );
    expect(u18Assisted).toEqual([]);
  });

  it("changelog に R3 の変更（constraints / complexity / requiresPhaseEvaluation / U15 ASSISTED）が記録されている", () => {
    const r3 = rs.changelog.find((line) => line.startsWith("R3:"));
    expect(r3).toBeDefined();
    expect(r3).toContain("constraints");
    expect(r3).toContain("complexity");
    expect(r3).toContain("requiresPhaseEvaluation");
    expect(r3).toContain("U15 ASSISTED_SPRINT");
    expect(rs.status).toBe("ACTIVE");
    expect(rs.validFrom).toBe("2026-09-15");
  });

  it("CONSTRAINT_U12_HARD は ASSISTED/LONG/TEMPO_INTENSIVE を disallow、RS_SLED_HEAVY をdisallowTemplateIds、override不可、complexity上限LOW", () => {
    const c = rs.constraints.find((c) => c.id === "CONSTRAINT_U12_HARD")!;
    expect(c.match).toEqual({ dimension: "AGE_BAND", ageBands: ["U12"] });
    expect(new Set(c.disallowedMethods)).toEqual(
      new Set(["ASSISTED_SPRINT", "LONG_SPRINT_RACE_SPECIFIC", "TEMPO_INTENSIVE"]),
    );
    expect(c.disallowedTemplateIds).toEqual(["RS_SLED_HEAVY"]);
    expect(c.overrideAllowed).toBe(false);
    expect(c.maxAutoComplexity).toBe("LOW");
  });

  it("全38 template が complexity（LOW/MEDIUM/HIGH）を持つ（§7.5 分類表の完全転記。R2実装時の欠落をR3で補完）", () => {
    for (const t of rs.templates) {
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(t.complexity);
    }
    expect(rs.templates.length).toBe(38);
  });

  it("§7.5 complexity の代表値: ACC_STANDING_20=LOW, ACC_BLOCK_20=MEDIUM, LSR_RACE_MODEL=HIGH, RS_SLED_HEAVY=HIGH, MV_FLY10=LOW, ST_WARMUP=LOW", () => {
    const byId = new Map(rs.templates.map((t) => [t.id, t.complexity]));
    expect(byId.get("ACC_STANDING_20")).toBe("LOW");
    expect(byId.get("ACC_BLOCK_20")).toBe("MEDIUM");
    expect(byId.get("LSR_RACE_MODEL")).toBe("HIGH");
    expect(byId.get("RS_SLED_HEAVY")).toBe("HIGH");
    expect(byId.get("MV_FLY10")).toBe("LOW");
    expect(byId.get("ST_WARMUP")).toBe("LOW");
  });

  it("eligibility: requiresPhaseEvaluation=true は SES+POST の1件のみ（他63件はfalse）", () => {
    const flagged = rs.eligibility.filter((e) => e.requiresPhaseEvaluation);
    expect(flagged.length).toBe(1);
    expect(flagged[0].ruleId).toBe("ELIG_SES_POST");
    expect(flagged[0].method).toBe("SPRINT_ENDURANCE_SHORT");
    expect(flagged[0].maturityCategory).toBe("POST");
    expect(rs.eligibility.length).toBe(64);
  });

  it("R2 の Critical transcription 値が R3 の変更後も同一である（ACC/MV/SES/STRIDE の代表値）", () => {
    const acc = rs.envelopes.find((e) => e.method === "ACCELERATION" && e.tier === "DEVELOPMENTAL")!;
    expect(acc.fields.repDistanceM!.recommended).toEqual({ min: 10, max: 20, unit: "m" });
    const mv = rs.envelopes.find((e) => e.method === "MAX_VELOCITY" && e.tier === "ADVANCED")!;
    expect(mv.fields.flyVolumeM!.recommended).toEqual({ min: 50, max: 150, unit: "m" });
    const vittori = rs.envelopes.find(
      (e) => e.method === "TEMPO_INTENSIVE" && e.templateIds.includes("TI_VITTORI_SE" as never),
    )!;
    expect(vittori.fields.repsPerSet!.recommended).toEqual({ min: 3, max: 5, unit: "reps" });
    expect(vittori.fields.sets!.recommended).toEqual({ min: 2, max: 4, unit: "sets" });
    const assisted = rs.envelopes.find((e) => e.method === "ASSISTED_SPRINT")!;
    expect(assisted.fields.intensityPercent!.coachEditable).toEqual({ min: 100, max: 105, unit: "percent" });
    expect(rs.evidence.length).toBe(25);
    expect(rs.evidence.filter((e) => e.verification === "PRIMARY_CHECKED").map((e) => e.id).sort()).toEqual([
      "EV_JAAF_JHS_GUIDE",
      "EV_JAAF_WIND_SPRINT",
      "EV_PETRAKOS_2016_VDEC",
      "EV_VITTORI_1981_PRIMARY",
    ]);
  });

  it("status=ACTIVE である（OPEN20 一次資料照合・human approval 済み）", () => {
    expect(rs.status).toBe("ACTIVE");
  });

  it("Evidence の verification は一次照合済みと二次報告を区別する", () => {
    const primary = new Set(["EV_JAAF_JHS_GUIDE", "EV_JAAF_WIND_SPRINT", "EV_PETRAKOS_2016_VDEC", "EV_VITTORI_1981_PRIMARY"]);
    for (const e of rs.evidence) {
      expect(e.verification).toBe(primary.has(e.id) ? "PRIMARY_CHECKED" : "SECONDARY_REPORT_ONLY");
    }
  });

  it("Evidence verification の分布: total=25, PRIMARY_CHECKED=4（レビュー/公式資料の照合状態を保持）", () => {
    expect(rs.evidence.length).toBe(25);
    const counts = { SECONDARY_REPORT_ONLY: 0, PRIMARY_CHECKED: 0 };
    for (const e of rs.evidence) {
      counts[e.verification] += 1;
    }
    expect(counts.SECONDARY_REPORT_ONLY).toBe(21);
    expect(counts.PRIMARY_CHECKED).toBe(4);

    const enginePolicy = rs.evidence.find((e) => e.id === "EV_ENGINE_POLICY")!;
    expect(enginePolicy.sourceType).toBe("ENGINE_POLICY");
    expect(enginePolicy.verification).toBe("SECONDARY_REPORT_ONLY");
    expect(enginePolicy.provisional).toBe(true);
  });

  it("rs-2026.09.0.validFrom は 2026-09-15（正式仕様書の日付に合わせる）", () => {
    expect(rs.validFrom).toBe("2026-09-15");
  });
});

// ---------------------------------------------------------------------------
// §22 R2 #7: production RuleSet は loader 相当で shape + completeness の両方を通す
// ---------------------------------------------------------------------------

describe("loader-level completeness enforcement (parseProductionRuleSet)", () => {
  const realRaw = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../src/domain/running/rules/sets/rs-2026.09.0.json"), "utf-8"),
  );

  it("実際の rs-2026.09.0.json は parseProductionRuleSet を通る（shape + completeness 両方満たす）", async () => {
    const { parseProductionRuleSet } = await import("@/domain/running/rules/loader");
    expect(() => parseProductionRuleSet(realRaw)).not.toThrow();
  });

  it("Method が1つ欠けた production RuleSet は拒否される", async () => {
    const { parseProductionRuleSet } = await import("@/domain/running/rules/loader");
    const mutated = { ...realRaw, methods: realRaw.methods.filter((m: { method: string }) => m.method !== "STRIDE") };
    expect(() => parseProductionRuleSet(mutated)).toThrow(/completeness/);
  });

  it("template が1つ欠けた production RuleSet は拒否される（他から参照されているため schema 段階で reject、または completeness 不足で reject）", async () => {
    const { parseProductionRuleSet } = await import("@/domain/running/rules/loader");
    const mutated = { ...realRaw, templates: realRaw.templates.filter((t: { id: string }) => t.id !== "ST_WARMUP") };
    expect(() => parseProductionRuleSet(mutated)).toThrow();
  });

  it("Envelope から参照されている Evidence を1件欠かすと（evidence completeness 欠落）shape validation の時点で拒否される", async () => {
    const { parseProductionRuleSet } = await import("@/domain/running/rules/loader");
    // EV_ENGINE_POLICY は ACCELERATION の tier 縮約セルから参照されている。
    const mutated = {
      ...realRaw,
      evidence: realRaw.evidence.filter((e: { id: string }) => e.id !== "EV_ENGINE_POLICY"),
    };
    expect(() => parseProductionRuleSet(mutated)).toThrow();
  });

  it("checkRuleSetCompleteness は index.ts の公開 API から export されていない", async () => {
    const api = await import("@/domain/running");
    expect("checkRuleSetCompleteness" in api).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 数値転記の代表値監査（§7.4 との照合。§22 R2 の要求）
// ---------------------------------------------------------------------------

describe("numerical transcription audit against §7.4", () => {
  const rs = getRuleSet("rs-2026.09.0")!;

  function envelope(method: string, tier: string, templateId: string) {
    return rs.envelopes.find(
      (e) => e.method === method && e.tier === tier && e.templateIds.includes(templateId as never),
    );
  }

  it("ACCELERATION DEV: repDistanceM recommended 10-20", () => {
    const env = envelope("ACCELERATION", "DEVELOPMENTAL", "ACC_BLOCK_20")!;
    expect(env.fields.repDistanceM!.recommended).toEqual({ min: 10, max: 20, unit: "m" });
  });

  it("ACCELERATION ADV: sessionVolumeM recommended 100-300", () => {
    const env = envelope("ACCELERATION", "ADVANCED", "ACC_BLOCK_20")!;
    expect(env.fields.sessionVolumeM!.recommended).toEqual({ min: 100, max: 300, unit: "m" });
  });

  it("MAX_VELOCITY DEV: flyZoneM recommended 10-10 (fly10中心)", () => {
    const env = envelope("MAX_VELOCITY", "DEVELOPMENTAL", "MV_FLY10")!;
    expect(env.fields.flyZoneM!.recommended).toEqual({ min: 10, max: 10, unit: "m" });
  });

  it("MAX_VELOCITY ADV: flyVolumeM recommended 50-150, repRestS recommended 480-900", () => {
    const env = envelope("MAX_VELOCITY", "ADVANCED", "MV_FLY20")!;
    expect(env.fields.flyVolumeM!.recommended).toEqual({ min: 50, max: 150, unit: "m" });
    expect(env.fields.repRestS!.recommended).toEqual({ min: 480, max: 900, unit: "s" });
  });

  it("SPRINT_ENDURANCE_SHORT: repDurationS は 7-15秒軸、DEV totalReps 2-3、ADV totalReps 4-6", () => {
    const dev = envelope("SPRINT_ENDURANCE_SHORT", "DEVELOPMENTAL", "SES_100")!;
    const adv = envelope("SPRINT_ENDURANCE_SHORT", "ADVANCED", "SES_100")!;
    expect(dev.fields.repDurationS!.recommended).toEqual({ min: 7, max: 12, unit: "s" });
    expect(adv.fields.repDurationS!.recommended).toEqual({ min: 7, max: 15, unit: "s" });
    expect(dev.fields.totalReps!.recommended).toEqual({ min: 2, max: 3, unit: "reps" });
    expect(adv.fields.totalReps!.recommended).toEqual({ min: 4, max: 6, unit: "reps" });
    // ADV の rest は long rest（20-30分域）。
    expect(adv.fields.repRestS!.recommended).toEqual({ min: 1200, max: 1800, unit: "s" });
  });

  it("LONG_SPRINT_RACE_SPECIFIC: FULL と INCOMPLETE が別 Envelope として存在する", () => {
    const full = rs.envelopes.find(
      (e) => e.method === "LONG_SPRINT_RACE_SPECIFIC" && e.recoveryStructure === "FULL" && e.tier === "ADVANCED",
    );
    const incomplete = rs.envelopes.find(
      (e) => e.method === "LONG_SPRINT_RACE_SPECIFIC" && e.recoveryStructure === "INCOMPLETE",
    );
    expect(full).toBeDefined();
    expect(incomplete).toBeDefined();
    expect(full!.templateIds).not.toEqual(incomplete!.templateIds);
  });

  it("TEMPO_EXTENSIVE: ADV sessionVolumeM recommended 1000-2000, DEV 400-1000", () => {
    const adv = envelope("TEMPO_EXTENSIVE", "ADVANCED", "TE_200")!;
    const dev = envelope("TEMPO_EXTENSIVE", "DEVELOPMENTAL", "TE_200")!;
    expect(adv.fields.sessionVolumeM!.recommended).toEqual({ min: 1000, max: 2000, unit: "m" });
    expect(dev.fields.sessionVolumeM!.recommended).toEqual({ min: 400, max: 1000, unit: "m" });
  });

  it("TEMPO_INTENSIVE: TI_VITTORI_SE repDistanceM 60-80m・intensityPercent 90-95", () => {
    const env = envelope("TEMPO_INTENSIVE", "ADVANCED", "TI_VITTORI_SE")!;
    expect(env.fields.repDistanceM!.recommended).toEqual({ min: 60, max: 80, unit: "m" });
    expect(env.fields.intensityPercent!.recommended).toEqual({ min: 90, max: 95, unit: "percent" });
  });

  it("TEMPO_INTENSIVE: TI_VITTORI_SE の repsPerSet/sets は R2 errata（§7.4）どおり分離されている", () => {
    const env = envelope("TEMPO_INTENSIVE", "ADVANCED", "TI_VITTORI_SE")!;
    // repsPerSet = 3–5（recommended・coachEditable とも。coachEditable を独自に広げない）
    expect(env.fields.repsPerSet!.recommended).toEqual({ min: 3, max: 5, unit: "reps" });
    expect(env.fields.repsPerSet!.coachEditable).toEqual({ min: 3, max: 5, unit: "reps" });
    // sets = 2–4（recommended・coachEditable とも）
    expect(env.fields.sets!.recommended).toEqual({ min: 2, max: 4, unit: "sets" });
    expect(env.fields.sets!.coachEditable).toEqual({ min: 2, max: 4, unit: "sets" });
    expect(env.fields.repsPerSet!.judgement).toBe("ENGINE_POLICY");
    expect(env.fields.sets!.judgement).toBe("ENGINE_POLICY");
  });

  it("TEMPO_INTENSIVE: repsPerSet/sets 修正後も sessionVolumeM との間に矛盾がない（recommended内で volume が成立し得る）", () => {
    const env = envelope("TEMPO_INTENSIVE", "ADVANCED", "TI_VITTORI_SE")!;
    const dist = env.fields.repDistanceM!.recommended!;
    const reps = env.fields.repsPerSet!.recommended!;
    const sets = env.fields.sets!.recommended!;
    const vol = env.fields.sessionVolumeM!.recommended!;
    // 最小構成（60m×3reps×2sets=360m）〜最大構成（80m×5reps×4sets=1600m）が
    // sessionVolumeM の coachEditable 範囲（400–2000m）と矛盾しないことを確認する
    // （recommended 600–1200m はその内側の代表域）。
    const minVolume = dist.min * reps.min * sets.min;
    const maxVolume = dist.max * reps.max * sets.max;
    expect(minVolume).toBeGreaterThanOrEqual(0);
    expect(maxVolume).toBeLessThanOrEqual(env.fields.sessionVolumeM!.coachEditable.max);
    expect(vol.min).toBeGreaterThan(0);
  });

  it("TEMPO_INTENSIVE: TI_COACH_DEFINED の repsPerSet/sets は既存方針（recommended=null）を維持", () => {
    const devEnv = envelope("TEMPO_INTENSIVE", "DEVELOPMENTAL", "TI_COACH_DEFINED")!;
    const advEnv = envelope("TEMPO_INTENSIVE", "ADVANCED", "TI_COACH_DEFINED")!;
    for (const env of [devEnv, advEnv]) {
      expect(env.fields.repsPerSet!.recommended).toBeNull();
      expect(env.fields.repsPerSet!.coachEditable).toEqual({ min: 1, max: 10, unit: "reps" });
      expect(env.fields.sets!.recommended).toBeNull();
      expect(env.fields.sets!.coachEditable).toEqual({ min: 1, max: 4, unit: "sets" });
    }
  });

  it("TEMPO_INTENSIVE: TI_COACH_DEFINED は全フィールドで recommended=null", () => {
    const devEnv = envelope("TEMPO_INTENSIVE", "DEVELOPMENTAL", "TI_COACH_DEFINED")!;
    const advEnv = envelope("TEMPO_INTENSIVE", "ADVANCED", "TI_COACH_DEFINED")!;
    for (const env of [devEnv, advEnv]) {
      for (const cell of Object.values(env.fields)) {
        expect(cell!.recommended).toBeNull();
      }
    }
  });

  it("RESISTED_SPRINT: vdec は専用分類帯を持ち、Envelope の数値 recommended ではない", () => {
    expect(rs.envelopes.filter((e) => e.method === "RESISTED_SPRINT" && e.fields.vdecPercent).every((e) => e.fields.vdecPercent!.recommended === null)).toBe(true);
    expect(rs.vdecClassificationBands).toEqual([
      expect.objectContaining({ classification: "LIGHT", lowerPercent: 0, lowerInclusive: true, upperPercent: 10, upperInclusive: false, classificationOnly: true }),
      expect.objectContaining({ classification: "MODERATE", lowerPercent: 10, lowerInclusive: true, upperPercent: 15, upperInclusive: false, classificationOnly: true }),
      expect.objectContaining({ classification: "UNRESOLVED_REVIEW", lowerPercent: 15, lowerInclusive: true, upperPercent: 30, upperInclusive: true, classificationOnly: true }),
      expect.objectContaining({ classification: "VERY_HEAVY", lowerPercent: 30, lowerInclusive: false, upperPercent: null, upperInclusive: false, classificationOnly: true }),
    ]);
  });

  it("E15 growth velocity は CHECK_ONLY、E16 taper は sprint-specific source-backed ではない", () => {
    const growth = rs.evidence.find((e) => e.id === "EV_GROWTH_VELOCITY_7_2")!;
    expect(growth.usage).toBe("CHECK_ONLY");
    expect(growth.applicabilityNotes).toContain("hard stop/eligibility cutoffではない");

    const taper = rs.competitionRules.find((r) => r.taperGuidance !== null)!.taperGuidance!;
    expect(taper.evidenceId).toBe("EV_ENGINE_POLICY");
    expect(taper.applicabilityNotes).toContain("sprint-specific prescription にはしない");
    expect(rs.evidence.find((e) => e.id === "EV_BOSQUET_2007_TAPER")!.usage).toBe("CONTEXT_ONLY");
  });

  it("E02–E06 の tier 縮約・例示を primary universal prescription として扱わない", () => {
    const accelerationDev = rs.envelopes.find((e) => e.method === "ACCELERATION" && e.tier === "DEVELOPMENTAL")!;
    expect(accelerationDev.fields.repDistanceM!.judgement).toBe("ENGINE_POLICY");
    expect(accelerationDev.fields.repRestS!.judgement).toBe("ENGINE_POLICY");

    const mvDev = rs.envelopes.find((e) => e.method === "MAX_VELOCITY" && e.tier === "DEVELOPMENTAL")!;
    expect(mvDev.fields.buildUpM!.evidenceIds).toEqual(["EV_ENGINE_POLICY"]);
    expect(mvDev.fields.repRestS!.evidenceIds).toEqual(["EV_ENGINE_POLICY"]);

    const sesDev = rs.envelopes.find((e) => e.method === "SPRINT_ENDURANCE_SHORT" && e.tier === "DEVELOPMENTAL")!;
    expect(sesDev.fields.totalReps!.evidenceIds).toEqual(["EV_ENGINE_POLICY"]);
    expect(sesDev.fields.totalReps!.judgement).toBe("ENGINE_POLICY");

    const tempo = rs.evidence.find((e) => e.id === "EV_HAUGEN_2019_TEMPO")!;
    expect(tempo.applicabilityNotes).toContain("elite sprint coaching practice");
    expect(tempo.applicabilityNotes).toContain("universal youth");
  });

  it("E22 pain safety は JSPO の unsupported attribution ではなく非診断的 policy", () => {
    const safety = rs.evidence.find((e) => e.id === "EV_ENGINE_SAFETY_POLICY")!;
    expect(safety.sourceType).toBe("ENGINE_POLICY");
    expect(safety.usage).toBe("CHECK_ONLY");
    expect(safety.applicabilityNotes).toContain("旧JSPO attributionは使用しない");
    expect(JSON.stringify(safety)).not.toContain("EV_JSPO_GROWTH_GUIDE");
  });

  it("E23 generic STRIDE envelope は JAAF direct prescription を参照しない", () => {
    for (const env of rs.envelopes.filter((e) => e.method === "STRIDE")) {
      for (const cell of Object.values(env.fields)) {
        if (!cell) continue;
        expect(cell.evidenceIds).toEqual(["EV_ENGINE_POLICY"]);
        expect(cell.evidenceIds).not.toContain("EV_JAAF_WIND_SPRINT");
      }
    }
    expect(rs.evidence.find((e) => e.id === "EV_JAAF_WIND_SPRINT")!.usage).toBe("CONTEXT_ONLY");
  });

  it("RESISTED_SPRINT: repDistanceM は DEV=ENGINE_POLICY、ADV=SOURCE_BACKED（OPEN-23: Haugen 10–30m BEST_PRACTICE_SYNTHESIS）", () => {
    const devVol = rs.envelopes.find(
      (e) => e.method === "RESISTED_SPRINT" && e.tier === "DEVELOPMENTAL" && e.fields.repDistanceM,
    )!;
    const advVol = rs.envelopes.find(
      (e) => e.method === "RESISTED_SPRINT" && e.tier === "ADVANCED" && e.fields.repDistanceM,
    )!;
    expect(devVol.fields.repDistanceM!.judgement).toBe("ENGINE_POLICY");
    expect(devVol.fields.repDistanceM!.evidenceIds).toEqual(["EV_ENGINE_POLICY"]);
    expect(advVol.fields.repDistanceM!.judgement).toBe("SOURCE_BACKED");
    expect(advVol.fields.repDistanceM!.evidenceIds).toEqual(["EV_HAUGEN_2019_VOLUME_TABLE"]);
    expect(devVol.fields.repDistanceM!.evidenceIds).not.toContain("EV_RESISTED_META_2024_2025");
    expect(advVol.fields.repDistanceM!.evidenceIds).not.toContain("EV_RESISTED_META_2024_2025");
  });

  it("RESISTED_SPRINT: HEAVY (RS_SLED_HEAVY) は DEVELOPMENTAL tier の Envelope を持たない（DEVでは不適格）", () => {
    const devHeavy = rs.envelopes.find(
      (e) => e.method === "RESISTED_SPRINT" && e.tier === "DEVELOPMENTAL" && e.templateIds.includes("RS_SLED_HEAVY" as never),
    );
    expect(devHeavy).toBeUndefined();
  });

  it("RESISTED_SPRINT: RS_HILL_SHORT は vdecPercent を持たない（平地参照が無いため）", () => {
    for (const env of rs.envelopes.filter((e) => e.method === "RESISTED_SPRINT")) {
      if (env.templateIds.includes("RS_HILL_SHORT" as never) && env.templateIds.length === 1) {
        expect(env.fields.vdecPercent).toBeUndefined();
      }
    }
  });

  it("ASSISTED_SPRINT: 全フィールドで recommended=null（自動生成不可）", () => {
    const env = rs.envelopes.find((e) => e.method === "ASSISTED_SPRINT")!;
    expect(env.tier).toBe("ADVANCED");
    for (const cell of Object.values(env.fields)) {
      expect(cell!.recommended).toBeNull();
    }
  });

  it("ASSISTED_SPRINT: intensityPercent は既存 EnvelopeField を representation として流用し、100-105%・recommended=null・hardSafety=null", () => {
    const env = rs.envelopes.find((e) => e.method === "ASSISTED_SPRINT")!;
    const cell = env.fields.intensityPercent!;
    expect(cell).toBeDefined();
    expect(cell.recommended).toBeNull();
    expect(cell.coachEditable).toEqual({ min: 100, max: 105, unit: "percent" });
    expect(cell.hardSafety).toBeNull();
    expect(cell.judgement).toBe("ENGINE_POLICY");
    // 100% 下限は「Vmax超の曝露」を Range で表す representation policy であり、
    // 科学的閾値として EV_ASSISTED_EVIDENCE_LIMITED（CHECK_ONLY）を根拠にしない。
    expect(cell.evidenceIds).toEqual(["EV_ENGINE_POLICY"]);
    expect(cell.evidenceIds).not.toContain("EV_ASSISTED_EVIDENCE_LIMITED");
  });

  it("ASSISTED_SPRINT: MethodMeta が enabledByDefault=false・advancedOnly=true・allowedIntensityReferences=[MEASURED_VMAX]", () => {
    const meta = rs.methods.find((m) => m.method === "ASSISTED_SPRINT")!;
    expect(meta.enabledByDefault).toBe(false);
    expect(meta.advancedOnly).toBe(true);
    expect(meta.allowedIntensityReferences).toEqual(["MEASURED_VMAX"]);
  });

  it("STRIDE: repDistanceM recommended 80-120、repsPerSet recommended 3-4、TE の量を使わない", () => {
    const env = rs.envelopes.find((e) => e.method === "STRIDE" && e.tier === "DEVELOPMENTAL")!;
    expect(env.fields.repDistanceM!.recommended).toEqual({ min: 80, max: 120, unit: "m" });
    expect(env.fields.repsPerSet!.recommended).toEqual({ min: 3, max: 4, unit: "reps" });
  });
});

// ---------------------------------------------------------------------------
// judgement / evidence 整合の監査（§22 R2 #33）
// ---------------------------------------------------------------------------

describe("judgement vs evidence audit", () => {
  const rs = getRuleSet("rs-2026.09.0")!;
  const evidenceById = new Map(rs.evidence.map((e) => [e.id, e]));

  it("judgement=ENGINE_POLICY の cell は EV_ENGINE_POLICY を含む", () => {
    for (const env of rs.envelopes) {
      for (const [field, cell] of Object.entries(env.fields)) {
        if (!cell || cell.judgement !== "ENGINE_POLICY") continue;
        expect(
          cell.evidenceIds.includes("EV_ENGINE_POLICY" as never),
          `${env.method}/${env.tier}/${field} judgement=ENGINE_POLICY だが EV_ENGINE_POLICY を含まない`,
        ).toBe(true);
      }
    }
  });

  it("judgement=SOURCE_BACKED の cell は少なくとも1件、ENGINE_POLICY 以外の PRESCRIPTION evidence を含む", () => {
    for (const env of rs.envelopes) {
      for (const [field, cell] of Object.entries(env.fields)) {
        if (!cell || cell.judgement !== "SOURCE_BACKED") continue;
        const hasNonPolicyPrescriptionEvidence = cell.evidenceIds.some((id) => {
          const e = evidenceById.get(id);
          return e && e.sourceType !== "ENGINE_POLICY" && e.usage === "PRESCRIPTION";
        });
        expect(
          hasNonPolicyPrescriptionEvidence,
          `${env.method}/${env.tier}/${field} judgement=SOURCE_BACKED だが非ENGINE_POLICYのPRESCRIPTION evidenceが無い`,
        ).toBe(true);
      }
    }
  });

  it("judgement=OPEN の cell は EV_ENGINE_POLICY を含む（未確定な暫定値としての根拠を追える）", () => {
    for (const env of rs.envelopes) {
      for (const cell of Object.values(env.fields)) {
        if (!cell || cell.judgement !== "OPEN") continue;
        expect(cell.evidenceIds.includes("EV_ENGINE_POLICY" as never)).toBe(true);
      }
    }
  });

  it("すべての Envelope cell の evidenceIds は空ではない（判断根拠が必ず追える）", () => {
    for (const env of rs.envelopes) {
      for (const [field, cell] of Object.entries(env.fields)) {
        if (!cell) continue;
        expect(cell.evidenceIds.length, `${env.method}/${env.tier}/${field}`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// [R4 structured metadata] planning が文字列・ID 命名を解析しないための機械可読フィールド
// ---------------------------------------------------------------------------

describe("R4 structured metadata（rs-2026.09.0）", () => {
  const rs = getRuleSet("rs-2026.09.0")!;
  const emptyConditions = {
    requiresEnvelopeTier: null,
    requiresTrainingAgeTiers: null,
    requiresPrimaryEvents: null,
    requiresAllowAdvancedMethods: false,
    requiresMeasuredVelocityDecrement: false,
    requiresVmaxConfidenceAtLeast: null,
    requiresPhaseNotIn: null,
    anyOf: null,
    whenUnmet: null,
  };
  const eligibilityConditionBranchDefaults = {
    requiresEnvelopeTier: null,
    requiresTrainingAgeTiers: null,
    requiresPrimaryEvents: null,
    requiresAllowAdvancedMethods: false,
    requiresMeasuredVelocityDecrement: false,
    requiresVmaxConfidenceAtLeast: null,
    requiresPhaseNotIn: null,
  };

  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  it("既存の閾値・数値データはF1のpolicy/scope metadata変更で変わっていない", async () => {
    const { createHash } = await import("node:crypto");
    const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../src/domain/running/rules/sets/rs-2026.09.0.json"), "utf-8"));
    const NEW_KEYS: Record<string, string[]> = {
      templates: ["approachType", "resistanceBand", "fixedDistanceField"],
      eligibility: ["conditions", "autoGenerationLimits"],
      stopPolicies: ["appliesToEligibilityPath", "runtime"],
      plausibility: ["inputTarget", "outputTarget", "boundaryPolicies", "appliesToMethods", "targetLabel", "note"],
    };
    const EXPECTED: Record<string, string> = {
      methods: "b048e8197b8f0b0ab617aaa8ec57a195d3b600ce531ea3ceda6fa9555ec2f3ee",
      timingTolerances: "8b0d3b0264e7629f8157e93c1353ac511ea1bb709f6bb07bc63e65560ed6c04e",
      constraints: "cebe8dd9bfd111a78e6107b7d9640c81be6f1e4e43c5b514772fe463fe479a17",
      stopPolicies: "2550dabf2fc0bb93672c8aad4c64cb3cccd9d7f8f2e9523e58f1fdd68a2f6eff",
      plausibility: "54c6a55a16b4b7c0c7553af2c34b11e4854eccebbe611134f5b001bcc86dd509",
      eligibility: "ffb3a80c2117700bae73784411d1e9d923c7898d14f47e3c804c6deb65abc202",
      templates: "4a42d63c2f254f6e8a2871790114abe594417601fc3a192bd6d2c7ff1071ddee",
    };
    for (const [section, expected] of Object.entries(EXPECTED)) {
      const rows = (raw[section] as Record<string, unknown>[]).map((row) =>
        Object.fromEntries(Object.entries(row).filter(([k]) => !(NEW_KEYS[section] ?? []).includes(k))),
      );
      expect(createHash("sha256").update(canonical(rows)).digest("hex"), section).toBe(expected);
    }
    expect(rs.status).toBe("ACTIVE");
    expect(rs.validFrom).toBe("2026-09-15");
    expect(rs.ruleSetVersion).toBe("rs-2026.09.0");
  });

  // [R8] 上の byte freeze は StopPolicy.runtime を除外する（R8 で追加した metadata のため）。除外した領域を
  // 未検証のまま残さないよう、runtime は §10.3 の表と全件・全フィールドを明示的に照合する。
  it("[R8] StopPolicy.runtime は全 policy に存在し、§10.3 の表と全フィールド一致（freeze 除外の未検証領域にしない）", () => {
    const none = {
      firstFailureAction: null,
      consecutiveFailureAction: null,
      tooFastConsecutiveThreshold: null,
      poorStartConsecutiveThreshold: null,
      techniqueDeterioratingAction: "COACH_REVIEW",
      techniqueNotGoodAction: null,
      techniqueMissingAction: null,
      velocityDecrementOutOfBandAction: null,
      effortBecameMaximalAction: null,
      plannedCountUnit: "REPS",
    };
    const EXPECTED: Record<string, { consecutiveFailuresToStop: number | null; numericStopAvailable: boolean; runtime: Record<string, unknown> }> = {
      // 1回目 FAIL → EXTEND_REST（1回まで）。2回連続 FAIL → END_SESSION_QUALITY。startQuality=POOR 2回連続 → COACH_REVIEW
      SP_ACC: { consecutiveFailuresToStop: 2, numericStopAvailable: true, runtime: { ...none, timingEvaluation: "SLOWER_THAN_REFERENCE_FAILS", reference: "PRIOR_SESSION_BEST", firstFailureAction: "EXTEND_REST", consecutiveFailureAction: "END_SESSION_QUALITY", poorStartConsecutiveThreshold: 2 } },
      // SP_ACC と同じ（参照はセッション内 fly ベスト）
      SP_MV: { consecutiveFailuresToStop: 2, numericStopAvailable: true, runtime: { ...none, timingEvaluation: "SLOWER_THAN_REFERENCE_FAILS", reference: "PRIOR_SESSION_BEST", firstFailureAction: "EXTEND_REST", consecutiveFailureAction: "END_SESSION_QUALITY", poorStartConsecutiveThreshold: 2 } },
      // 目標区間の上端（無ければセッション内ベスト）。2回連続 FAIL → END_SESSION_QUALITY
      SP_SES: { consecutiveFailuresToStop: 2, numericStopAvailable: true, runtime: { ...none, timingEvaluation: "SLOWER_THAN_REFERENCE_FAILS", reference: "TARGET_UPPER_ELSE_PRIOR_SESSION_BEST", consecutiveFailureAction: "END_SESSION_QUALITY" } },
      // 目標スプリット上端。2回連続 FAIL → END_SESSION_QUALITY
      SP_LSR_FULL: { consecutiveFailuresToStop: 2, numericStopAvailable: true, runtime: { ...none, timingEvaluation: "SLOWER_THAN_REFERENCE_FAILS", reference: "TARGET_UPPER", consecutiveFailureAction: "END_SESSION_QUALITY" } },
      // 分割走内の低下では止めない。2回連続で目標超過 → COACH_REVIEW
      SP_LSR_INCOMPLETE_ADV: { consecutiveFailuresToStop: 2, numericStopAvailable: true, runtime: { ...none, timingEvaluation: "SLOWER_THAN_REFERENCE_FAILS", reference: "TARGET_UPPER", consecutiveFailureAction: "COACH_REVIEW" } },
      // SP_LSR_FULL と同じ
      SP_LSR_INCOMPLETE_STRICT: { consecutiveFailuresToStop: 2, numericStopAvailable: true, runtime: { ...none, timingEvaluation: "SLOWER_THAN_REFERENCE_FAILS", reference: "TARGET_UPPER", consecutiveFailureAction: "END_SESSION_QUALITY" } },
      // 数値 stop なし（COACH_ONLY）。目標下端より速すぎが2回 → WARN
      SP_TE: { consecutiveFailuresToStop: null, numericStopAvailable: false, runtime: { ...none, timingEvaluation: "FASTER_THAN_TARGET_LOWER_WARNS", reference: "TARGET_LOWER", tooFastConsecutiveThreshold: 2 } },
      // 2回連続 FAIL → END_SET
      SP_TI: { consecutiveFailuresToStop: 2, numericStopAvailable: true, runtime: { ...none, timingEvaluation: "SLOWER_THAN_REFERENCE_FAILS", reference: "TARGET_UPPER", consecutiveFailureAction: "END_SET" } },
      // band 外 → COACH_REVIEW
      SP_RS: { consecutiveFailuresToStop: null, numericStopAvailable: false, runtime: { ...none, timingEvaluation: "NONE", reference: "NONE", velocityDecrementOutOfBandAction: "COACH_REVIEW" } },
      // technique ≠ GOOD → STOP_SAFETY（未入力は GOOD と推測しない）
      SP_AS: { consecutiveFailuresToStop: null, numericStopAvailable: false, runtime: { ...none, timingEvaluation: "NONE", reference: "NONE", techniqueDeterioratingAction: null, techniqueNotGoodAction: "STOP_SAFETY", techniqueMissingAction: "COACH_REVIEW" } },
      // COACH_ONLY。attempts 上限到達 → END_SESSION_QUALITY
      SP_EA: { consecutiveFailuresToStop: null, numericStopAvailable: false, runtime: { ...none, timingEvaluation: "NONE", reference: "NONE", plannedCountUnit: "ATTEMPTS" } },
      // 数値 stop なし。コーチの「全力化」判定 → COACH_REVIEW
      SP_STRIDE: { consecutiveFailuresToStop: null, numericStopAvailable: false, runtime: { ...none, timingEvaluation: "NONE", reference: "NONE", effortBecameMaximalAction: "COACH_REVIEW" } },
    };
    expect(rs.stopPolicies.map((sp) => sp.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const sp of rs.stopPolicies) {
      const expected = EXPECTED[sp.id];
      expect(sp.runtime, sp.id).toBeDefined();
      expect(sp.runtime, sp.id).toEqual(expected.runtime);
      expect(sp.consecutiveFailuresToStop, sp.id).toBe(expected.consecutiveFailuresToStop);
      expect(sp.numericStopAvailable, sp.id).toBe(expected.numericStopAvailable);
    }
    const r8 = rs.changelog.find((line) => line.startsWith("R8:"));
    expect(r8).toBeDefined();
    expect(r8).toContain("timingTolerances are unchanged");
  });

  it("changelog に R4 の metadata 追加が記録され、数値は不変と明記されている", () => {
    const r4 = rs.changelog.find((line) => line.startsWith("R4:"));
    expect(r4).toBeDefined();
    expect(r4).toContain("conditionNote is now explanatory only");
    expect(r4).toContain("unchanged");
  });

  it("EligibilityRule.conditions: conditionNote が機械判定を含んでいた5行 + [R7] phase 条件を持つ1行だけが requires* を持つ", () => {
    const withConditions = rs.eligibility.filter((r) => r.conditions.whenUnmet !== null);
    expect(Object.fromEntries(withConditions.map((r) => [r.ruleId, r.conditions]))).toEqual({
      ELIG_LONG_FULL_POST: { ...emptyConditions, requiresTrainingAgeTiers: ["TRAINED", "ADVANCED"], requiresPrimaryEvents: ["200m", "400m", "400mH"], whenUnmet: "MANUAL_WITH_REVIEW" },
      ELIG_LONG_INCOMPLETE_POST: { ...emptyConditions, requiresEnvelopeTier: "ADVANCED", requiresPrimaryEvents: ["200m", "400m", "400mH"], whenUnmet: "MANUAL_WITH_REVIEW" },
      ELIG_RS_MODERATE_POST: { ...emptyConditions, requiresEnvelopeTier: "ADVANCED", whenUnmet: "MANUAL_WITH_REVIEW" },
      ELIG_RS_HEAVY_POST: { ...emptyConditions, requiresEnvelopeTier: "ADVANCED", requiresMeasuredVelocityDecrement: true, whenUnmet: "INELIGIBLE_NON_OVERRIDABLE" },
      ELIG_ASSISTED_ALL_POST: {
        ...emptyConditions,
        requiresEnvelopeTier: "ADVANCED",
        requiresAllowAdvancedMethods: true,
        requiresVmaxConfidenceAtLeast: "MEDIUM",
        whenUnmet: "INELIGIBLE_NON_OVERRIDABLE",
      },
      // [R7 correction] requiresPhaseEvaluation=true 行の唯一の実データ（§4.5 の SES POST の OR 条件:
      // tier=ADVANCED、または (POST & tier≥DEVELOPING & phase≠TRANSITION)）。POST 条件自体はこの
      // 行が maturityCategory="POST" のときだけ評価される既存の仕組みで担保されるため、branch には
      // 重複させない。
      ELIG_SES_POST: {
        ...emptyConditions,
        anyOf: [
          { ...eligibilityConditionBranchDefaults, requiresEnvelopeTier: "ADVANCED" },
          { ...eligibilityConditionBranchDefaults, requiresTrainingAgeTiers: ["DEVELOPING", "TRAINED", "ADVANCED"], requiresPhaseNotIn: ["TRANSITION"] },
        ],
        whenUnmet: "MANUAL_WITH_REVIEW",
      },
    });
    for (const r of rs.eligibility.filter((row) => row.conditions.whenUnmet === null)) {
      expect(r.conditions, r.ruleId).toEqual(emptyConditions);
    }
  });

  it("EligibilityRule.autoGenerationLimits: MV_FLY10 の reps≤3（PRE/EU/CIRCA）と TE の lower half（PRE/EU/CIRCA）だけ", () => {
    const limited = rs.eligibility.filter((r) => r.autoGenerationLimits.maxTotalReps !== null || r.autoGenerationLimits.positionCap !== null);
    expect(Object.fromEntries(limited.map((r) => [r.ruleId, r.autoGenerationLimits]))).toEqual({
      ELIG_MV_FLY10_PRE: { maxTotalReps: 3, positionCap: null },
      ELIG_MV_FLY10_EFFECTIVE_UNKNOWN: { maxTotalReps: 3, positionCap: null },
      ELIG_MV_FLY10_CIRCA: { maxTotalReps: 3, positionCap: null },
      ELIG_TE_ALL_PRE: { maxTotalReps: null, positionCap: "LOWER_HALF" },
      ELIG_TE_ALL_EFFECTIVE_UNKNOWN: { maxTotalReps: null, positionCap: "LOWER_HALF" },
      ELIG_TE_ALL_CIRCA: { maxTotalReps: null, positionCap: "LOWER_HALF" },
    });
    // 説明文としての conditionNote は残す（削除しない）
    expect(rs.eligibility.find((r) => r.ruleId === "ELIG_MV_FLY10_PRE")?.conditionNote).toBe("reps≤3");
  });

  it("SessionTemplate: approachType は EA だけ（§4.4 の SHORT / FULL の行と一致）、resistanceBand は sled だけ、fixedDistanceField は ACC/MV/TE/TI_VITTORI_SE", () => {
    const byId = new Map(rs.templates.map((t) => [t.id, t]));
    const shortRows = rs.eligibility.find((r) => r.ruleId === "ELIG_EA_SHORT_POST")!.templateIds;
    const fullRows = rs.eligibility.find((r) => r.ruleId === "ELIG_EA_FULL_POST")!.templateIds;
    for (const id of shortRows) expect(byId.get(id)?.approachType, id).toBe("SHORT");
    for (const id of fullRows) expect(byId.get(id)?.approachType, id).toBe("FULL");
    expect(rs.templates.filter((t) => t.approachType !== null).map((t) => t.id).sort()).toEqual([...shortRows, ...fullRows].sort());

    expect(Object.fromEntries(rs.templates.filter((t) => t.resistanceBand !== null).map((t) => [t.id, t.resistanceBand]))).toEqual({
      RS_SLED_LIGHT: "LIGHT",
      RS_SLED_MODERATE: "MODERATE",
      RS_SLED_HEAVY: "HEAVY",
    });
    // resistanceBand を持つ template は、その band の vdecPercent Envelope を持つ
    for (const t of rs.templates.filter((x) => x.resistanceBand !== null)) {
      expect(rs.envelopes.some((e) => e.templateIds.includes(t.id as never) && e.fields.vdecPercent), t.id).toBe(true);
    }

    const fixed = Object.fromEntries(rs.templates.filter((t) => t.fixedDistanceField !== null).map((t) => [t.id, t.fixedDistanceField]));
    expect(fixed).toEqual({
      ACC_BLOCK_10: "repDistanceM",
      ACC_BLOCK_20: "repDistanceM",
      ACC_BLOCK_30: "repDistanceM",
      ACC_BLOCK_40: "repDistanceM",
      ACC_CROUCH_20: "repDistanceM",
      ACC_STANDING_20: "repDistanceM",
      ACC_FALLING_10: "repDistanceM",
      MV_FLY10: "flyZoneM",
      MV_FLY20: "flyZoneM",
      MV_FLY30: "flyZoneM",
      TE_100: "repDistanceM",
      TE_200: "repDistanceM",
      TE_300: "repDistanceM",
      TI_VITTORI_SE: "repDistanceM",
    });
    // SES の displayDistanceM は表示専用（一次軸は時間）なので固定しない
    for (const t of rs.templates.filter((x) => x.method === "SPRINT_ENDURANCE_SHORT")) expect(t.fixedDistanceField, t.id).toBeNull();
  });

  it("StopPolicy.appliesToEligibilityPath: LONG INCOMPLETE の2件だけが経路で分かれ、他はすべて ANY", () => {
    expect(Object.fromEntries(rs.stopPolicies.filter((sp) => sp.appliesToEligibilityPath !== "ANY").map((sp) => [sp.id, sp.appliesToEligibilityPath]))).toEqual({
      SP_LSR_INCOMPLETE_ADV: "AUTO_CONDITIONS_MET",
      SP_LSR_INCOMPLETE_STRICT: "MANUAL_OR_OVERRIDE",
    });
  });

  it("PlausibilityRule.inputTarget: scope=INPUT の4行だけが持つ", () => {
    expect(Object.fromEntries(rs.plausibility.filter((p) => p.inputTarget !== null).map((p) => [p.ruleId, p.inputTarget]))).toEqual({
      PLA_INPUT_100M_RECORD: { kind: "TIMED_MARK", event: "100m" },
      PLA_INPUT_FLY_10M: { kind: "TIMED_MARK", event: "FLY10" },
      PLA_INPUT_HEIGHT: { kind: "HEIGHT_CM" },
      PLA_INPUT_APPROACH_DISTANCE: { kind: "COACH_EDIT_APPROACH_DISTANCE_M" },
    });
  });

  it("F1 plausibility boundaries keep frozen policy per threshold side and remove dead method scopes", () => {
    const byId = Object.fromEntries(rs.plausibility.map((rule) => [rule.ruleId, rule]));
    expect(byId.PLA_ITEM_DISTANCE_STANDARD?.boundaryPolicies).toEqual({ min: null, max: "METHOD_POLICY_HARD" });
    expect(byId.PLA_ITEM_DISTANCE_TEMPO?.boundaryPolicies).toEqual({ min: null, max: "METHOD_POLICY_HARD" });
    expect(byId.PLA_ITEM_DISTANCE_TEMPO?.appliesToMethods).toEqual(["TEMPO_INTENSIVE"]);
    expect(byId.PLA_FLY_ZONE_M?.appliesToMethods).toEqual(["ASSISTED_SPRINT"]);
    expect(byId.PLA_REP_DURATION_NON_LONG?.appliesToMethods).toEqual(["SPRINT_ENDURANCE_SHORT"]);
    expect(byId.PLA_REPS_PER_SET?.boundaryPolicies.max).toBe("COACH_OVERRIDABLE_STRONG_REVIEW");
    expect(byId.PLA_MENU_TOTAL_DISTANCE?.boundaryPolicies.max).toBe("PRODUCT_DATA_SANITY_HARD");
    expect(byId.PLA_INPUT_100M_RECORD?.boundaryPolicies).toEqual({ min: "NON_OVERRIDABLE_DATA_SANITY_HARD", max: "COACH_OVERRIDABLE_STRONG_REVIEW" });
    expect(byId.PLA_INPUT_FLY_10M?.boundaryPolicies).toEqual({ min: "NON_OVERRIDABLE_DATA_SANITY_HARD", max: "COACH_OVERRIDABLE_STRONG_REVIEW" });
    expect(byId.PLA_INPUT_HEIGHT?.boundaryPolicies).toEqual({
      min: "DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW",
      max: "DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW",
    });
  });

  it("eventDefinitions は全 TimedMark / RaceEvent を網羅し、fly の距離は R3 の fly split 計算と一致する", async () => {
    const { computeFlySplitVelocity } = await import("@/domain/running/context/performance");
    const { TIMED_MARK_EVENTS } = await import("@/domain/running/types/intensity");
    const { RACE_EVENTS } = await import("@/domain/running/types/primitives");
    expect(rs.eventDefinitions.timedMarks.map((d) => d.event).sort()).toEqual([...TIMED_MARK_EVENTS].sort());
    expect(rs.eventDefinitions.raceEvents.map((d) => d.event).sort()).toEqual([...RACE_EVENTS].sort());
    for (const def of rs.eventDefinitions.timedMarks.filter((d) => d.segment === "FLY_ZONE")) {
      const v = computeFlySplitVelocity({ event: def.event, timeS: 2, date: "2026-09-01" as never, timing: "RADAR_LASER" }, rs);
      expect(v.valueMps * 2, def.event).toBeCloseTo(def.distanceM, 10);
    }
    expect(rs.eventDefinitions.raceEvents.find((d) => d.event === "400mH")).toEqual({ event: "400mH", distanceM: 400, hurdles: true });
  });

  it("monitoring snapshot の schema は RuleSet の StopPolicy / TimingTolerance 行をそのまま受け付ける（strict。項目が増えたら snapshot を明示的に更新する）", async () => {
    const { stopPolicySnapshotSchema, timingToleranceSnapshotSchema } = await import("@/domain/running/types/prescription");
    for (const sp of rs.stopPolicies) expect(stopPolicySnapshotSchema.safeParse(sp).success, sp.id).toBe(true);
    for (const t of rs.timingTolerances) expect(timingToleranceSnapshotSchema.safeParse(t).success, t.timing).toBe(true);
  });

  it("schema は metadata の不整合を拒否する", () => {
    const base = loadFixture("rs-test-a");
    // approachType は EVENT_APPROACH_SPEED だけ
    expect(ruleSetSchema.safeParse({ ...base, templates: [{ ...base.templates[0], approachType: "SHORT" }] }).success).toBe(false);
    // resistanceBand は RESISTED_SPRINT だけ
    expect(ruleSetSchema.safeParse({ ...base, templates: [{ ...base.templates[0], resistanceBand: "LIGHT" }] }).success).toBe(false);
    // fixedDistanceField には displayDistanceM が必要
    expect(ruleSetSchema.safeParse({ ...base, templates: [{ ...base.templates[0], fixedDistanceField: "repDistanceM" }] }).success).toBe(false);
    // stop policy は method × recoveryStructure で一意に選べる必要がある
    expect(ruleSetSchema.safeParse({ ...base, stopPolicies: [{ ...base.stopPolicies[0], appliesToEligibilityPath: "AUTO_CONDITIONS_MET" }] }).success).toBe(false);

    const row = {
      ruleId: "ELIG_TEST",
      method: "STRIDE",
      templateIds: ["ST_WARMUP"],
      maturityCategory: "POST",
      outcome: "AUTO",
      requiresReview: false,
      overrideAllowed: null,
      conditionNote: null,
      requiresPhaseEvaluation: false,
      conditions: { ...emptyConditions },
      autoGenerationLimits: { maxTotalReps: null, positionCap: null },
    };
    expect(eligibilityRuleSchema.safeParse(row).success).toBe(true);
    expect(eligibilityRuleSchema.safeParse({ ...row, conditions: { ...emptyConditions, whenUnmet: "MANUAL_WITH_REVIEW" } }).success).toBe(false);
    expect(eligibilityRuleSchema.safeParse({ ...row, conditions: { ...emptyConditions, requiresEnvelopeTier: "ADVANCED" } }).success).toBe(false);

    // [R7 correction] anyOf（OR）と平坦な requires* は同時に指定できない。
    expect(
      eligibilityRuleSchema.safeParse({
        ...row,
        conditions: {
          ...emptyConditions,
          requiresEnvelopeTier: "ADVANCED",
          anyOf: [
            { ...eligibilityConditionBranchDefaults, requiresEnvelopeTier: "ADVANCED" },
            { ...eligibilityConditionBranchDefaults, requiresAllowAdvancedMethods: true },
          ],
          whenUnmet: "MANUAL_WITH_REVIEW",
        },
      }).success,
    ).toBe(false);
    // anyOf の branch は何か requires* を持たなければならない（空の branch は禁止）。
    expect(
      eligibilityRuleSchema.safeParse({
        ...row,
        conditions: {
          ...emptyConditions,
          anyOf: [eligibilityConditionBranchDefaults, { ...eligibilityConditionBranchDefaults, requiresEnvelopeTier: "ADVANCED" }],
          whenUnmet: "MANUAL_WITH_REVIEW",
        },
      }).success,
    ).toBe(false);
    // anyOf の branch が phase に依存するなら requiresPhaseEvaluation=true が必須（flat と同じ規律）。
    expect(
      eligibilityRuleSchema.safeParse({
        ...row,
        requiresPhaseEvaluation: false,
        conditions: {
          ...emptyConditions,
          anyOf: [
            { ...eligibilityConditionBranchDefaults, requiresEnvelopeTier: "ADVANCED" },
            { ...eligibilityConditionBranchDefaults, requiresPhaseNotIn: ["TRANSITION"] },
          ],
          whenUnmet: "MANUAL_WITH_REVIEW",
        },
      }).success,
    ).toBe(false);
    // 正常系: outcome=AUTO + requiresPhaseEvaluation=true + anyOf は通る。
    expect(
      eligibilityRuleSchema.safeParse({
        ...row,
        requiresPhaseEvaluation: true,
        conditions: {
          ...emptyConditions,
          anyOf: [
            { ...eligibilityConditionBranchDefaults, requiresEnvelopeTier: "ADVANCED" },
            { ...eligibilityConditionBranchDefaults, requiresPhaseNotIn: ["TRANSITION"] },
          ],
          whenUnmet: "MANUAL_WITH_REVIEW",
        },
      }).success,
    ).toBe(true);
    expect(
      eligibilityRuleSchema.safeParse({ ...row, outcome: "INELIGIBLE", overrideAllowed: true, autoGenerationLimits: { maxTotalReps: 3, positionCap: null } }).success,
    ).toBe(false);

    const pla = rs.plausibility.find((p) => p.ruleId === "PLA_INPUT_HEIGHT")!;
    expect(plausibilityRuleSchema.safeParse({ ...pla, inputTarget: null }).success).toBe(false);
    const item = rs.plausibility.find((p) => p.scope === "ITEM_FIELD")!;
    expect(plausibilityRuleSchema.safeParse({ ...item, inputTarget: { kind: "HEIGHT_CM" } }).success).toBe(false);
  });

  it("fixture（rs-test-a / rs-test-b）も R4 metadata を持って schema を通る", () => {
    for (const name of ["rs-test-a", "rs-test-b"]) {
      const fx = loadFixture(name);
      expect(fx.templates[0].approachType).toBeNull();
      expect(fx.stopPolicies[0].appliesToEligibilityPath).toBe("ANY");
      expect(fx.eventDefinitions).toEqual({ timedMarks: [], raceEvents: [] });
    }
  });
});
