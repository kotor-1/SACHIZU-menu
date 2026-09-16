import { describe, expect, expectTypeOf, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  RUNNING_TRAINING_METHODS,
  runningTrainingMethodSchema,
} from "@/domain/running/types/method";
import {
  runningSelectionSchema,
  recoveryStructureSchema,
  ALL_TEMPLATE_IDS,
  TEMPLATE_IDS_BY_METHOD,
  type RunningSelection,
  type TemplateIdByMethod,
  type SessionTemplate,
} from "@/domain/running/types/template";
import {
  rangeSchema,
  softRangeSchema,
  quantityIntervalSchema,
} from "@/domain/running/types/primitives";
import {
  intensityReferenceSchema,
  timedMarkSchema,
  INTENSITY_REFERENCE_KINDS,
  type IntensityReference,
} from "@/domain/running/types/intensity";
import {
  fieldValueSchema,
  flyRepSchema,
  splitSegmentSchema,
  runningPrescriptionSchema,
  type FieldValue,
  type FlyRep,
  type SplitSegment,
  type RunningPrescription,
  type RunningPrescriptionValue,
} from "@/domain/running/types/prescription";
import { subjectSchema } from "@/domain/running/types/subject";

// ---------------------------------------------------------------------------
// RunningTrainingMethod
// ---------------------------------------------------------------------------

describe("RunningTrainingMethod", () => {
  it("accepts all 10 canonical methods", () => {
    expect(RUNNING_TRAINING_METHODS.length).toBe(10);
    for (const m of RUNNING_TRAINING_METHODS) {
      expect(runningTrainingMethodSchema.safeParse(m).success, m).toBe(true);
    }
  });

  it("rejects SUBMAX_SPEED_ENDURANCE (Fable C-5: not a canonical Method)", () => {
    const result = runningTrainingMethodSchema.safeParse("SUBMAX_SPEED_ENDURANCE");
    expect(result.success).toBe(false);
    expect((RUNNING_TRAINING_METHODS as readonly string[]).includes("SUBMAX_SPEED_ENDURANCE")).toBe(
      false,
    );
  });

  it("rejects an arbitrary invalid enum value", () => {
    expect(runningTrainingMethodSchema.safeParse("NOT_A_METHOD").success).toBe(false);
    expect(runningTrainingMethodSchema.safeParse("").success).toBe(false);
    expect(runningTrainingMethodSchema.safeParse(123).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Range / SoftRange / QuantityInterval
// ---------------------------------------------------------------------------

describe("Range", () => {
  const meterRange = rangeSchema(z.literal("m"));

  it("accepts a valid closed range", () => {
    const parsed = meterRange.safeParse({ min: 10, max: 50, unit: "m" });
    expect(parsed.success).toBe(true);
  });

  it("rejects min > max", () => {
    const parsed = meterRange.safeParse({ min: 50, max: 10, unit: "m" });
    expect(parsed.success).toBe(false);
  });

  it("rejects the wrong unit literal", () => {
    const parsed = meterRange.safeParse({ min: 10, max: 50, unit: "s" });
    expect(parsed.success).toBe(false);
  });

  it("has both min and max required (not partial)", () => {
    expect(meterRange.safeParse({ min: 10, unit: "m" }).success).toBe(false);
    expect(meterRange.safeParse({ max: 50, unit: "m" }).success).toBe(false);
  });
});

describe("SoftRange", () => {
  const softSeconds = softRangeSchema(z.literal("s"));

  it("accepts HARD without hysteresis", () => {
    const parsed = softSeconds.safeParse({ min: 7, max: 15, unit: "s", softness: "HARD" });
    expect(parsed.success).toBe(true);
  });

  it("accepts SOFT with a hysteresis range", () => {
    const parsed = softSeconds.safeParse({
      min: 7,
      max: 15,
      unit: "s",
      softness: "SOFT",
      hysteresis: { min: 13, max: 17, unit: "s" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid softness value", () => {
    const parsed = softSeconds.safeParse({ min: 7, max: 15, unit: "s", softness: "MEDIUM" });
    expect(parsed.success).toBe(false);
  });
});

describe("QuantityInterval — null は 0 ではない", () => {
  const meterInterval = quantityIntervalSchema(z.literal("m"));

  it("allows both lower and upper to be null", () => {
    const parsed = meterInterval.safeParse({
      lower: null,
      upper: null,
      unit: "m",
      source: "UNKNOWN",
      confidence: "NONE",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // 明示的に null のままであることを確認する。0 に丸められていないこと。
      expect(parsed.data.lower).toBeNull();
      expect(parsed.data.upper).toBeNull();
      expect(parsed.data.lower).not.toBe(0);
      expect(parsed.data.upper).not.toBe(0);
    }
  });

  it("allows one side to be null while the other is a number", () => {
    const parsed = meterInterval.safeParse({
      lower: null,
      upper: 30,
      unit: "m",
      source: "ESTIMATED",
      confidence: "LOW",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects lower > upper when both are numbers", () => {
    const parsed = meterInterval.safeParse({
      lower: 50,
      upper: 10,
      unit: "m",
      source: "MEASURED",
      confidence: "HIGH",
    });
    expect(parsed.success).toBe(false);
  });

  it("R1 は null→0 正規化ユーティリティを提供しない（aggregation は R6）", () => {
    // domain/running/types 配下に「0 へ丸める」ような export が存在しないことを
    // 静的に確認する（新しく誰かがうっかり normalize ヘルパーを足したら検知する）。
    const typesDir = path.resolve(__dirname, "../../../src/domain/running/types");
    const files = fs.readdirSync(typesDir).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(typesDir, file), "utf-8");
      expect(
        /normalizeToZero|nullToZero|coalesceToZero|\?\?\s*0\b/.test(content),
        `${file} appears to normalize null to 0, which R1 must not do`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TimedMark — VIDEO timing で videoFps 必須
// ---------------------------------------------------------------------------

describe("TimedMark", () => {
  const base = {
    event: "FLY20" as const,
    timeS: 2.0,
    date: "2026-06-01",
  };

  it("does not require videoFps for non-VIDEO timing methods", () => {
    for (const timing of ["FAT", "PHOTO_CELL", "HAND", "RADAR_LASER", "UNKNOWN"] as const) {
      const parsed = timedMarkSchema.safeParse({ ...base, timing });
      expect(parsed.success, timing).toBe(true);
    }
  });

  it("requires videoFps when timing is VIDEO", () => {
    const withoutFps = timedMarkSchema.safeParse({ ...base, timing: "VIDEO" });
    expect(withoutFps.success).toBe(false);

    const withFps = timedMarkSchema.safeParse({ ...base, timing: "VIDEO", videoFps: 240 });
    expect(withFps.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IntensityReference — discriminated union
// ---------------------------------------------------------------------------

describe("IntensityReference", () => {
  it("covers the 9 required kinds", () => {
    expect(INTENSITY_REFERENCE_KINDS.length).toBe(9);
    expect(new Set(INTENSITY_REFERENCE_KINDS)).toEqual(
      new Set([
        "MAX_INTENT",
        "MEASURED_VMAX",
        "FLY_SPLIT",
        "SAME_DISTANCE_BEST",
        "RACE_PACE",
        "TARGET_SPLIT",
        "VELOCITY_DECREMENT",
        "RELAXED_SUBMAX",
        "COACH_DEFINED",
      ]),
    );
  });

  it("accepts MAX_INTENT with no numeric payload (ACCELERATION の偽精度回避)", () => {
    const parsed = intensityReferenceSchema.safeParse({ kind: "MAX_INTENT" });
    expect(parsed.success).toBe(true);
  });

  it("accepts RELAXED_SUBMAX with no numeric payload (STRIDE 専用)", () => {
    const parsed = intensityReferenceSchema.safeParse({ kind: "RELAXED_SUBMAX" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const parsed = intensityReferenceSchema.safeParse({ kind: "PERCENT_OF_PB" });
    expect(parsed.success).toBe(false);
  });

  it("MAX_INTENT が数値 % を一切持てないことを型でも確認する", () => {
    const ref: IntensityReference = { kind: "MAX_INTENT" };
    // @ts-expect-error -- MAX_INTENT は intensityPercent のようなフィールドを持てない
    const bad: IntensityReference = { kind: "MAX_INTENT", intensityPercent: 98 };
    expect(ref.kind).toBe("MAX_INTENT");
    expect(bad).toBeDefined();
  });

  it("VELOCITY_DECREMENT requires a band and measured flag", () => {
    const parsed = intensityReferenceSchema.safeParse({
      kind: "VELOCITY_DECREMENT",
      band: "MODERATE",
      measured: true,
    });
    expect(parsed.success).toBe(true);
    expect(intensityReferenceSchema.safeParse({ kind: "VELOCITY_DECREMENT" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Method × Template の型安全性（§3.3 の核心）
// ---------------------------------------------------------------------------

describe("Method × Template type safety", () => {
  it("accepts every valid (method, templateId) combination for all 10 methods", () => {
    for (const method of RUNNING_TRAINING_METHODS) {
      for (const templateId of TEMPLATE_IDS_BY_METHOD[method]) {
        const parsed = runningSelectionSchema.safeParse({ method, templateId });
        expect(parsed.success, `${method} + ${templateId}`).toBe(true);
      }
    }
  });

  it("rejects a mismatched (method, templateId) combination at runtime", () => {
    const parsed = runningSelectionSchema.safeParse({
      method: "MAX_VELOCITY",
      templateId: "ACC_BLOCK_20", // ACCELERATION の template を MAX_VELOCITY へ
    });
    expect(parsed.success).toBe(false);
  });

  it("template id と Method 値の名前空間が重複しない", () => {
    const methodNames = new Set<string>(RUNNING_TRAINING_METHODS);
    for (const templateId of ALL_TEMPLATE_IDS) {
      expect(methodNames.has(templateId), `template id collides with a Method name: ${templateId}`).toBe(
        false,
      );
    }
    // 全 template id がユニークであること（Method をまたいだ重複も無い）。
    expect(new Set(ALL_TEMPLATE_IDS).size).toBe(ALL_TEMPLATE_IDS.length);
  });

  it("type-level: 正しい組み合わせはコンパイルできる", () => {
    const ok: RunningSelection = { method: "MAX_VELOCITY", templateId: "MV_FLY20" };
    expect(ok.method).toBe("MAX_VELOCITY");
  });

  it("type-level: MAX_VELOCITY + ACC_BLOCK_20 はコンパイルできない", () => {
    // @ts-expect-error -- ACC_BLOCK_20 は ACCELERATION の template であり
    // MAX_VELOCITY と組み合わせることはできない。
    const bad: RunningSelection = { method: "MAX_VELOCITY", templateId: "ACC_BLOCK_20" };
    expect(bad).toBeDefined();
  });

  it("type-level: TemplateIdByMethod は method ごとに閉じている（indexed access）", () => {
    expectTypeOf<TemplateIdByMethod["ACCELERATION"]>().toEqualTypeOf<
      | "ACC_BLOCK_10"
      | "ACC_BLOCK_20"
      | "ACC_BLOCK_30"
      | "ACC_BLOCK_40"
      | "ACC_CROUCH_20"
      | "ACC_STANDING_20"
      | "ACC_FALLING_10"
    >();
    expectTypeOf<TemplateIdByMethod["STRIDE"]>().toEqualTypeOf<
      "ST_WARMUP" | "ST_RELAXED" | "ST_BETWEEN_SETS"
    >();
    // ACCELERATION の template id が STRIDE のそれと型として一致しないこと。
    expectTypeOf<TemplateIdByMethod["ACCELERATION"]>().not.toEqualTypeOf<
      TemplateIdByMethod["STRIDE"]
    >();
  });

  it("SessionTemplate<M> のジェネリック型が method ごとに templateId/recoveryStructure を拘束する", () => {
    expectTypeOf<SessionTemplate<"ACCELERATION">["id"]>().toEqualTypeOf<
      TemplateIdByMethod["ACCELERATION"]
    >();
    expectTypeOf<SessionTemplate<"ACCELERATION">["recoveryStructure"]>().toEqualTypeOf<null>();
    expectTypeOf<SessionTemplate<"LONG_SPRINT_RACE_SPECIFIC">["recoveryStructure"]>().toEqualTypeOf<
      z.infer<typeof recoveryStructureSchema>
    >();
  });
});

// ---------------------------------------------------------------------------
// FlyRep — build-up と fly zone の必須分離
// ---------------------------------------------------------------------------

describe("FlyRep", () => {
  function makeFieldValue(value: number): z.infer<ReturnType<typeof fieldValueSchema<"m">>> {
    return {
      value,
      unit: "m",
      recommended: { min: 0, max: 1000, unit: "m" },
      coachEditable: { min: 0, max: 1000, unit: "m" },
      hardSafety: null,
      position: "MIDDLE",
      origin: "ENGINE_POSITIONED",
      evidenceIds: [],
    };
  }

  it("keeps buildUpDistanceM and flyZoneDistanceM as separate fields", () => {
    const fly: FlyRep = {
      kind: "FLY",
      buildUpDistanceM: makeFieldValue(30),
      flyZoneDistanceM: makeFieldValue(20),
      decelerationDistanceM: 20,
      totalRunningDistanceM: 70,
      plannedHighSpeedExposureM: {
        lower: 20,
        upper: 20,
        unit: "m",
        source: "PLANNED",
        confidence: "MEDIUM",
      },
    };
    const parsed = flyRepSchema.safeParse(fly);
    expect(parsed.success).toBe(true);
    // build-up 40m + fly 20m を「60mのhigh-speed exposure」と混同しない
    // （§10）。plannedHighSpeedExposureM は fly zone 相当の 20m のみ。
    expect(fly.plannedHighSpeedExposureM.upper).toBe(20);
    expect(fly.plannedHighSpeedExposureM.upper).not.toBe(
      fly.buildUpDistanceM.value + fly.flyZoneDistanceM.value,
    );
  });

  it("rejects totalRunningDistanceM that does not equal build + fly + deceleration", () => {
    const bad = {
      kind: "FLY" as const,
      buildUpDistanceM: makeFieldValue(30),
      flyZoneDistanceM: makeFieldValue(20),
      decelerationDistanceM: 20,
      totalRunningDistanceM: 999, // 本来は 30+20+20=70 のはず
      plannedHighSpeedExposureM: {
        lower: 20,
        upper: 20,
        unit: "m" as const,
        source: "PLANNED" as const,
        confidence: "MEDIUM" as const,
      },
    };
    expect(flyRepSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SplitSegment（LONG_SPRINT_RACE_SPECIFIC の SPLIT rep で使う分割区間）
// ---------------------------------------------------------------------------

describe("SplitSegment", () => {
  it("accepts a segment with no rest after it (last segment)", () => {
    const segment: SplitSegment = { distanceM: 300, restAfterS: null };
    expect(splitSegmentSchema.safeParse(segment).success).toBe(true);
  });

  it("accepts a segment with a rest FieldValue after it", () => {
    const segment = {
      distanceM: 300,
      restAfterS: {
        value: 90,
        unit: "s",
        recommended: { min: 0, max: 300, unit: "s" },
        coachEditable: { min: 0, max: 300, unit: "s" },
        hardSafety: null,
        position: "MIDDLE",
        origin: "ENGINE_POSITIONED",
        evidenceIds: [],
      },
    };
    expect(splitSegmentSchema.safeParse(segment).success).toBe(true);
  });

  it("rejects a non-positive distanceM", () => {
    const segment = { distanceM: 0, restAfterS: null };
    expect(splitSegmentSchema.safeParse(segment).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RunningPrescription — 基本 parse と LONG だけの recoveryStructure
// ---------------------------------------------------------------------------

describe("RunningPrescription", () => {
  function makeFieldValue(unit: string, value: number) {
    return {
      value,
      unit,
      recommended: { min: 0, max: 1000, unit },
      coachEditable: { min: 0, max: 1000, unit },
      hardSafety: null,
      position: "MIDDLE" as const,
      origin: "ENGINE_POSITIONED" as const,
      evidenceIds: [] as string[],
    };
  }

  it("type-level: FieldValue<U>（手書き）は fieldValueSchema<U>（Zod由来）と構造的に一致する", () => {
    expectTypeOf<z.infer<ReturnType<typeof fieldValueSchema<"m">>>>().toEqualTypeOf<
      FieldValue<"m">
    >();
  });

  function baseCommon() {
    return {
      schemaVersion: 1 as const,
      tier: "DEVELOPMENTAL" as const,
      sets: makeFieldValue("sets", 2),
      repsPerSet: makeFieldValue("reps", 5),
      rest: {
        repRestS: makeFieldValue("s", 120),
        setRestS: null,
        intraRepRestS: null,
        displayAsFloor: true as const,
        feasibility: "OK" as const,
      },
      intensity: { reference: { kind: "MAX_INTENT" as const }, target: null },
      exposure: {
        totalRunningDistanceM: { lower: 60, upper: 60, unit: "m" as const, source: "PLANNED" as const, confidence: "MEDIUM" as const },
        plannedHighSpeedExposureM: { lower: 0, upper: 0, unit: "m" as const, source: "RULE_DEFINITION" as const, confidence: "HIGH" as const },
        nearMaxSprintVolumeM: { lower: 60, upper: 60, unit: "m" as const, source: "PLANNED" as const, confidence: "MEDIUM" as const },
      },
      stopPolicyId: "SP_ACC",
      monitoringSnapshot: {
        stopPolicy: {
          id: "SP_ACC",
          method: "ACCELERATION" as const,
          appliesToRecoveryStructure: null,
          appliesToEligibilityPath: "ANY" as const,
          referenceDescription: "test",
          ruleDescriptionJa: "test",
          consecutiveFailuresToStop: 2,
          numericStopAvailable: true,
        },
        timingTolerances: [
          {
            timing: "HAND" as const,
            toleranceS: 0.25,
            toleranceSPerFps: null,
            numericStopAllowed: true,
            coachOnlyRatioThreshold: 0.1,
            evidenceIds: [],
            judgement: "ENGINE_POLICY" as const,
            provisional: true as const,
          },
        ],
      },
      confidence: { prescription: "MODERATE" as const, directness: "PARTIAL" as const, inputData: "MEDIUM" as const },
      readinessApplied: [],
      safetyOutcome: "NONE" as const,
      findings: [],
      rationale: [],
      ruleSet: { version: "rs-test-0", contentHash: "deadbeef", status: "DRAFT" as const },
      generatedBy: { proposer: { kind: "ENGINE" as const }, createdByCoach: true, acceptedByCoachAt: null },
    };
  }

  it("parses a minimal valid ACCELERATION prescription (recoveryStructure must be null)", () => {
    const input = {
      method: "ACCELERATION" as const,
      templateId: "ACC_BLOCK_20" as const,
      recoveryStructure: null,
      rep: { kind: "DISTANCE" as const, distanceM: makeFieldValue("m", 20) },
      ...baseCommon(),
    };
    const parsed = runningPrescriptionSchema.safeParse(input);
    expect(parsed.success, JSON.stringify(parsed.success ? null : (parsed as z.SafeParseError<unknown>).error.issues)).toBe(true);
  });

  it("rejects ACCELERATION with a non-null recoveryStructure", () => {
    const input = {
      method: "ACCELERATION" as const,
      templateId: "ACC_BLOCK_20" as const,
      recoveryStructure: "FULL", // ACCELERATION は recoveryStructure を持てない
      rep: { kind: "DISTANCE" as const, distanceM: makeFieldValue("m", 20) },
      ...baseCommon(),
    };
    expect(runningPrescriptionSchema.safeParse(input).success).toBe(false);
  });

  it("requires recoveryStructure for LONG_SPRINT_RACE_SPECIFIC", () => {
    const withoutRecovery = {
      method: "LONG_SPRINT_RACE_SPECIFIC" as const,
      templateId: "LSR_SPECIAL_ENDURANCE_I" as const,
      recoveryStructure: null, // LONG では null は不可
      rep: {
        kind: "DURATION" as const,
        durationS: makeFieldValue("s", 25),
        displayDistanceM: { lower: 200, upper: 200, unit: "m" as const, source: "PLANNED" as const, confidence: "MEDIUM" as const },
      },
      ...baseCommon(),
    };
    expect(runningPrescriptionSchema.safeParse(withoutRecovery).success).toBe(false);

    const withRecovery = { ...withoutRecovery, recoveryStructure: "FULL" as const };
    const parsed = runningPrescriptionSchema.safeParse(withRecovery);
    expect(parsed.success, JSON.stringify(parsed.success ? null : (parsed as z.SafeParseError<unknown>).error.issues)).toBe(true);
  });

  it("accepts LONG_SPRINT_RACE_SPECIFIC with a SPLIT rep (broken-run variant) and INCOMPLETE recovery", () => {
    const input = {
      method: "LONG_SPRINT_RACE_SPECIFIC" as const,
      templateId: "LSR_BROKEN_400" as const,
      recoveryStructure: "INCOMPLETE" as const,
      rep: {
        kind: "SPLIT" as const,
        segments: [
          { distanceM: 300, restAfterS: makeFieldValue("s", 60) },
          { distanceM: 100, restAfterS: null },
        ],
      },
      ...baseCommon(),
    };
    const parsed = runningPrescriptionSchema.safeParse(input);
    expect(
      parsed.success,
      JSON.stringify(parsed.success ? null : (parsed as z.SafeParseError<unknown>).error.issues),
    ).toBe(true);
  });

  it("rejects a method/rep mismatch (e.g. FLY rep under ACCELERATION)", () => {
    const input = {
      method: "ACCELERATION" as const,
      templateId: "ACC_BLOCK_20" as const,
      recoveryStructure: null,
      rep: {
        kind: "FLY" as const,
        buildUpDistanceM: makeFieldValue("m", 30),
        flyZoneDistanceM: makeFieldValue("m", 20),
        decelerationDistanceM: 20,
        totalRunningDistanceM: 70,
        plannedHighSpeedExposureM: { lower: 20, upper: 20, unit: "m" as const, source: "PLANNED" as const, confidence: "MEDIUM" as const },
      },
      ...baseCommon(),
    };
    expect(runningPrescriptionSchema.safeParse(input).success).toBe(false);
  });

  it("type-level: RunningPrescription<M>（手書きジェネリック）と RunningPrescriptionValue の該当 branch（Zod由来）が構造的に一致する", () => {
    expectTypeOf<Extract<RunningPrescriptionValue, { method: "ACCELERATION" }>>().toEqualTypeOf<
      RunningPrescription<"ACCELERATION">
    >();
    expectTypeOf<
      Extract<RunningPrescriptionValue, { method: "LONG_SPRINT_RACE_SPECIFIC" }>
    >().toEqualTypeOf<RunningPrescription<"LONG_SPRINT_RACE_SPECIFIC">>();
    expectTypeOf<Extract<RunningPrescriptionValue, { method: "STRIDE" }>>().toEqualTypeOf<
      RunningPrescription<"STRIDE">
    >();
  });

  it("type-level: RunningPrescription<'LONG_SPRINT_RACE_SPECIFIC'> は recoveryStructure を必須にする", () => {
    expectTypeOf<
      RunningPrescription<"LONG_SPRINT_RACE_SPECIFIC">["recoveryStructure"]
    >().toEqualTypeOf<z.infer<typeof recoveryStructureSchema>>();
    expectTypeOf<RunningPrescription<"ACCELERATION">["recoveryStructure"]>().toEqualTypeOf<null>();
  });
});

// ---------------------------------------------------------------------------
// Subject（型のみ。resolveSubjectProfile は R3。ここでは parse できることだけ確認）
// ---------------------------------------------------------------------------

describe("Subject (types only — no resolution logic in R1)", () => {
  it("parses a minimal GROUP subject", () => {
    const parsed = subjectSchema.safeParse({
      kind: "GROUP",
      profile: {
        label: "短距離ブロック",
        members: [],
        allowAdvancedMethods: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a minimal ATHLETE subject with UNKNOWN maturity (no判定ロジックをここで実行しない)", () => {
    const parsed = subjectSchema.safeParse({
      kind: "ATHLETE",
      profile: {
        birthDate: null,
        primaryEvent: "100m",
        maturity: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
        trainingAge: { structuredSprintYears: null },
        marks: [],
        allowAdvancedMethods: false,
      },
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Import boundary（eslint 設定の存在確認）
// ---------------------------------------------------------------------------

describe("import boundary configuration exists (enforcement itself verified manually per R1 report)", () => {
  it("eslint.config.mjs restricts imports for src/domain/running/**", () => {
    const configPath = path.resolve(__dirname, "../../../eslint.config.mjs");
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain("src/domain/running/**");
    expect(content).toContain("no-restricted-imports");
    expect(content).toContain("@prisma/client");
    expect(content).toContain('"react"');
    expect(content).toMatch(/next/);
    expect(content).toMatch(/node:\*/);
  });
});
