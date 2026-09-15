import { describe, expect, it } from "vitest";
import { classify } from "@/domain/prescription/classify";
import {
  buildPrescriptionNote,
  suggestPrescription,
  type SuggestibleExercise,
  type SuggestionContext,
} from "@/domain/prescription/calculate";
import {
  ATHLETE_LEVELS,
  PRESCRIPTION_KINDS,
  type AthleteLevel,
  type PrescriptionKind,
} from "@/domain/prescription/constants";
import { TRAINING_PHASES } from "@/domain/menu/constants";

import goldenFixture from "../fixtures/prescription-legacy-golden.json";
import warningsFixture from "../fixtures/prescription-legacy-warnings.json";

/**
 * R0: legacy prescription engine（src/domain/prescription/）の
 * characterization / golden test。
 *
 * これは「現在のコードが正しい」ことを証明するテストではない。
 * classify() / suggestPrescription() が **今どう動いているか** を
 * tests/fixtures/prescription-legacy-golden.json と
 * tests/fixtures/prescription-legacy-warnings.json に固定し、
 * 以後 legacy engine（constants.ts / classify.ts / rules.ts / calculate.ts）が
 * 1 文字でも変わったら、このテストが必ず落ちるようにするためのもの。
 *
 * 正式仕様 docs/RUNNING_PRESCRIPTION_ENGINE_V2_SPEC.md §22 R0 に従い、
 * fixture は次の2グループで構成される:
 *
 *   - "matrix"（960件）: 12 PrescriptionKind × 4 AthleteLevel ×
 *     5 phase条件（PREPARATION/PRE_COMPETITION/COMPETITION/TRANSITION/
 *     期分け未指定） × 4 default pattern（A: defaultなし / B: ruleと整合する
 *     default / C: ruleより短いrest・異なるvolumeになるdefault /
 *     D: extremeだが現行schema上合法なdefault）の完全直積。
 *   - "regression"（11件）: 960 matrix に自然に収まらない、classify() の
 *     誤分類や context 省略時の既定値など、個別の既知の問題を固定した
 *     named case。
 *
 * fixture には既知の問題（レベル係数・期分け係数・classify の誤分類・
 * default 値優先による異常な総量など）がそのまま含まれている。
 * R0 ではそれらを修正しない。fixture を書き換えてよいのは、legacy engine
 * の挙動を意図的に変更したとき（R13 での係数削除など）だけであり、
 * このテストを通すために数値を書き換えることは「その挙動を正しいと
 * 認定する」ことを意味しない。
 *
 * fixture は一時生成スクリプト（repo には残っていない。実際の legacy
 * engine を実行して生成したもの）で作成した。
 */

type GoldenPrescription = {
  sets: number | null;
  reps: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  restSeconds: number | null;
  intensityPercent: number | null;
  loadKg: number | null;
};

type GoldenOutput = {
  kind: string;
  prescription: GoldenPrescription;
  rationale: string[];
  setRestSeconds: number | null;
  highIntensityMeters: number;
  contactCount: number;
};

type CaseGroup = "matrix" | "regression";
type DefaultPatternLabel = "A" | "B" | "C" | "D";

type GoldenCase = {
  id: string;
  group: CaseGroup;
  kind: PrescriptionKind;
  level: AthleteLevel | null;
  phaseTag: string | null;
  pattern: DefaultPatternLabel | null;
  note: string;
  input: {
    exercise: SuggestibleExercise;
    context: SuggestionContext;
  };
  output: GoldenOutput;
};

type GoldenFixture = {
  _meta: {
    prescriptionKindCount: number;
    athleteLevelCount: number;
    trainingPhaseConditionCount: number;
    defaultPatternCount: number;
    matrixCaseCount: number;
    expectedMatrixCaseCount: number;
    regressionCaseCount: number;
    totalCaseCount: number;
    requiredRegressionCaseIds: string[];
  };
  cases: GoldenCase[];
};

type WarningsFixture = {
  _meta: { caseCount: number };
  warningsByCaseId: Record<string, string[]>;
};

const golden = goldenFixture as unknown as GoldenFixture;
const warnings = warningsFixture as unknown as WarningsFixture;
const warningsByCaseId = warnings.warningsByCaseId;

const PHASE_TAGS = [...TRAINING_PHASES, "NO_PHASE"] as const;
const DEFAULT_PATTERNS = ["A", "B", "C", "D"] as const;

function reconstructNote(output: GoldenOutput, caseWarnings: string[]): string {
  const lines = [...output.rationale, ...caseWarnings.map((w) => `⚠ ${w}`)];
  return lines.join("\n").slice(0, 1000);
}

// ---------------------------------------------------------------------------
// 1〜10: 正式仕様が求める整合性検証
// ---------------------------------------------------------------------------
describe("R0 golden fixture — cross-product integrity (spec §22 R0)", () => {
  const matrixCases = golden.cases.filter((c) => c.group === "matrix");
  const regressionCases = golden.cases.filter((c) => c.group === "regression");

  it("1. matrix case count is exactly 960", () => {
    expect(matrixCases.length).toBe(960);
    expect(golden._meta.matrixCaseCount).toBe(960);
    expect(golden._meta.expectedMatrixCaseCount).toBe(960);
  });

  it("2. covers exactly the 12 PrescriptionKind currently defined in code", () => {
    expect(PRESCRIPTION_KINDS.length).toBe(12);
    expect(golden._meta.prescriptionKindCount).toBe(PRESCRIPTION_KINDS.length);
    const observed = new Set(matrixCases.map((c) => c.kind));
    expect(observed.size).toBe(PRESCRIPTION_KINDS.length);
    for (const kind of PRESCRIPTION_KINDS) {
      expect(observed.has(kind), `missing kind in matrix: ${kind}`).toBe(true);
    }
  });

  it("3. covers exactly the 4 AthleteLevel currently defined in code", () => {
    expect(ATHLETE_LEVELS.length).toBe(4);
    expect(golden._meta.athleteLevelCount).toBe(ATHLETE_LEVELS.length);
    const observed = new Set(matrixCases.map((c) => c.level));
    expect(observed.size).toBe(ATHLETE_LEVELS.length);
    for (const level of ATHLETE_LEVELS) {
      expect(observed.has(level), `missing level in matrix: ${level}`).toBe(true);
    }
  });

  it("4. covers exactly 5 phase conditions (4 TrainingPhase enum values + null)", () => {
    // TrainingPhase 自体は4値のみ（src/domain/menu/constants.ts で確認済み）。
    // 5番目は「期分け未指定」= phase:null を表す "NO_PHASE" タグ。
    expect(TRAINING_PHASES.length).toBe(4);
    expect(PHASE_TAGS.length).toBe(5);
    expect(golden._meta.trainingPhaseConditionCount).toBe(5);
    const observed = new Set(matrixCases.map((c) => c.phaseTag));
    expect(observed.size).toBe(5);
    for (const tag of PHASE_TAGS) {
      expect(observed.has(tag), `missing phase condition in matrix: ${tag}`).toBe(true);
    }
  });

  it("5. covers exactly the 4 default patterns A/B/C/D", () => {
    expect(golden._meta.defaultPatternCount).toBe(4);
    const observed = new Set(matrixCases.map((c) => c.pattern));
    expect(observed).toEqual(new Set(DEFAULT_PATTERNS));
  });

  it("6+7+8. every (kind, level, phase, defaultPattern) combination is unique, with no duplicates and no gaps", () => {
    const expectedCombos = new Set<string>();
    for (const kind of PRESCRIPTION_KINDS) {
      for (const level of ATHLETE_LEVELS) {
        for (const phaseTag of PHASE_TAGS) {
          for (const pattern of DEFAULT_PATTERNS) {
            expectedCombos.add(`${kind}|${level}|${phaseTag}|${pattern}`);
          }
        }
      }
    }
    expect(expectedCombos.size).toBe(960);

    const actualCombos = matrixCases.map(
      (c) => `${c.kind}|${c.level}|${c.phaseTag}|${c.pattern}`,
    );
    const actualComboSet = new Set(actualCombos);

    // 重複なし: ユニーク化しても件数が変わらない。
    expect(actualComboSet.size).toBe(actualCombos.length);

    // 欠落なし: 期待した組み合わせが1つ残らず存在する。
    const missing = [...expectedCombos].filter((k) => !actualComboSet.has(k));
    expect(missing, `missing combinations (${missing.length})`).toEqual([]);

    // 余剰なし: 期待していない組み合わせが紛れ込んでいない。
    const extra = [...actualComboSet].filter((k) => !expectedCombos.has(k));
    expect(extra, `unexpected extra combinations (${extra.length})`).toEqual([]);

    // 完全一致（集合として）。
    expect(actualComboSet).toEqual(expectedCombos);
  });

  it("9. golden fixture and warnings fixture reference exactly the same case id set", () => {
    const goldenIds = new Set(golden.cases.map((c) => c.id));
    const warningIds = new Set(Object.keys(warningsByCaseId));
    expect(goldenIds.size).toBe(golden.cases.length); // id 自体の重複もここで検出
    expect(warningIds).toEqual(goldenIds);
    expect(warnings._meta.caseCount).toBe(golden.cases.length);
  });

  it("10. every required named regression case id is present", () => {
    expect(golden._meta.requiredRegressionCaseIds.length).toBeGreaterThan(0);
    const regressionIds = new Set(regressionCases.map((c) => c.id));
    for (const id of golden._meta.requiredRegressionCaseIds) {
      expect(regressionIds.has(id), `missing required regression case: ${id}`).toBe(true);
    }
  });

  it("total case count is matrix + regression, with no other groups", () => {
    expect(matrixCases.length + regressionCases.length).toBe(golden.cases.length);
    expect(golden._meta.regressionCaseCount).toBe(regressionCases.length);
    expect(golden._meta.totalCaseCount).toBe(golden.cases.length);
    for (const c of golden.cases) {
      expect(["matrix", "regression"]).toContain(c.group);
    }
  });
});

// ---------------------------------------------------------------------------
// 各 case ごとの characterization テスト（実際の legacy engine と突き合わせ）
// ---------------------------------------------------------------------------
describe.each(golden.cases)("legacy golden case: $id", (goldenCase: GoldenCase) => {
  const expectedWarnings = warningsByCaseId[goldenCase.id];

  it("classify() returns the frozen kind", () => {
    expect(classify(goldenCase.input.exercise)).toBe(goldenCase.output.kind);
  });

  it("suggestPrescription() matches the frozen output exactly (characterization, not correctness)", () => {
    const actual = suggestPrescription(
      goldenCase.input.exercise,
      goldenCase.input.context,
    );

    expect(actual.kind).toBe(goldenCase.output.kind);
    expect(actual.prescription).toEqual(goldenCase.output.prescription);
    expect(actual.rationale).toEqual(goldenCase.output.rationale);
    expect(actual.setRestSeconds).toBe(goldenCase.output.setRestSeconds);
    expect(actual.highIntensityMeters).toBe(goldenCase.output.highIntensityMeters);
    expect(actual.contactCount).toBe(goldenCase.output.contactCount);
  });

  it("suggestPrescription() warnings match the frozen warnings fixture exactly", () => {
    const actual = suggestPrescription(
      goldenCase.input.exercise,
      goldenCase.input.context,
    );
    expect(actual.warnings).toEqual(expectedWarnings);
  });

  it("buildPrescriptionNote() still reconstructs from rationale + warnings the same way", () => {
    const actual = suggestPrescription(
      goldenCase.input.exercise,
      goldenCase.input.context,
    );
    const expectedNote = reconstructNote(goldenCase.output, expectedWarnings);
    expect(buildPrescriptionNote(actual)).toBe(expectedNote);
  });
});

describe("golden harness self-check (guards against a no-op comparison)", () => {
  // 目的: この golden test の deep-equality 比較が、実際に差分を検出できることを
  // 確認する。legacy source は一切編集しない。fixture の期待値を in-memory で
  // 1 項目だけ改変した synthetic な期待値を作り、実際の出力と一致しないことを
  // 確かめるだけ。
  it("detects a mutated expectation as a mismatch (sets +1)", () => {
    const sample = golden.cases.find(
      (c) => c.id === "matrix__SPEED_ACCELERATION__HS_ADVANCED__PRE_COMPETITION__A",
    );
    expect(sample).toBeDefined();
    if (!sample) return;

    const actual = suggestPrescription(sample.input.exercise, sample.input.context);
    const mutated: GoldenPrescription = {
      ...sample.output.prescription,
      sets: (sample.output.prescription.sets ?? 0) + 1,
    };

    expect(actual.prescription).toEqual(sample.output.prescription);
    expect(actual.prescription).not.toEqual(mutated);
  });

  it("detects a mutated rationale string as a mismatch", () => {
    const sample = golden.cases.find(
      (c) => c.id === "matrix__TEMPO_AEROBIC__HS_ADVANCED__PRE_COMPETITION__A",
    );
    expect(sample).toBeDefined();
    if (!sample) return;

    const actual = suggestPrescription(sample.input.exercise, sample.input.context);
    const mutatedRationale = [...sample.output.rationale, "改変された余分な行"];

    expect(actual.rationale).toEqual(sample.output.rationale);
    expect(actual.rationale).not.toEqual(mutatedRationale);
  });

  it("detects a mutated warnings array as a mismatch", () => {
    const sampleId = "defaultPattern__D1_pace_run_5000m_extreme_volume";
    const sample = golden.cases.find((c) => c.id === sampleId);
    expect(sample).toBeDefined();
    if (!sample) return;

    const actual = suggestPrescription(sample.input.exercise, sample.input.context);
    const expected = warningsByCaseId[sampleId];
    const mutatedWarnings = [...expected, "捏造された警告"];

    expect(actual.warnings).toEqual(expected);
    expect(actual.warnings).not.toEqual(mutatedWarnings);
  });

  it("detects a missing combination as a mismatch (sanity check for check #6/7/8's own logic)", () => {
    const combos = new Set(
      golden.cases
        .filter((c) => c.group === "matrix")
        .map((c) => `${c.kind}|${c.level}|${c.phaseTag}|${c.pattern}`),
    );
    const syntheticComboThatShouldNotExist = "NOT_A_REAL_KIND|JHS|NO_PHASE|A";
    expect(combos.has(syntheticComboThatShouldNotExist)).toBe(false);
  });
});
