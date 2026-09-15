import { describe, expect, it } from "vitest";
import { EXERCISE_CATEGORIES } from "@/domain/exercise/constants";
import { TRAINING_PHASES } from "@/domain/menu/constants";
import { classify } from "@/domain/prescription/classify";
import {
  PRESCRIPTION_KINDS,
  type PrescriptionKind,
} from "@/domain/prescription/constants";
import {
  completeRestSeconds,
  PRESCRIPTION_RULES,
} from "@/domain/prescription/rules";
import {
  buildPrescriptionNote,
  suggestPrescription,
} from "@/domain/prescription/calculate";

const kinds = new Set<PrescriptionKind>(PRESCRIPTION_KINDS);

describe("classify", () => {
  it("maps every exercise category to a known prescription kind", () => {
    // energySystem も targets も無い（＝既存の登録済み種目と同じ状態）でも
    // 必ずどれかに落ちること。未分類を返すと処方が出せなくなる。
    for (const category of EXERCISE_CATEGORIES) {
      const kind = classify({ category });
      expect(kinds.has(kind), `${category} -> ${kind}`).toBe(true);
    }
  });

  it("separates acceleration from max velocity by target", () => {
    expect(
      classify({ category: "SPRINT", targets: ["ACCELERATION"] }),
    ).toBe("SPEED_ACCELERATION");
    expect(
      classify({ category: "SPRINT", targets: ["MAX_VELOCITY"] }),
    ).toBe("SPEED_MAX_VELOCITY");
  });

  it("treats a sprint with no target as acceleration (longest rest = safest)", () => {
    expect(classify({ category: "SPRINT" })).toBe("SPEED_ACCELERATION");
  });

  it("routes a glycolytic exercise to speed endurance regardless of category", () => {
    expect(
      classify({ category: "SPRINT", energySystem: "GLYCOLYTIC" }),
    ).toBe("SPEED_ENDURANCE");
  });

  it("keeps hurdle drills technical unless they are marked ALACTIC", () => {
    expect(classify({ category: "HURDLE" })).toBe("DRILL_TECHNICAL");
    // 全力で走るハードルドリルは技術ドリルの75秒レストでは足りない。
    expect(
      classify({ category: "HURDLE", energySystem: "ALACTIC" }),
    ).toBe("SPEED_ACCELERATION");
  });

  it("splits strength by difficulty, defaulting to hypertrophy", () => {
    expect(classify({ category: "STRENGTH", difficulty: 5 })).toBe(
      "STRENGTH_MAX",
    );
    expect(classify({ category: "STRENGTH", difficulty: 2 })).toBe(
      "STRENGTH_HYPERTROPHY",
    );
    // difficulty 未設定は安全側（軽い方）へ。
    expect(classify({ category: "STRENGTH" })).toBe("STRENGTH_HYPERTROPHY");
  });
});

describe("completeRestSeconds", () => {
  it("gives one minute per 10m", () => {
    expect(completeRestSeconds(30)).toBe(180);
    expect(completeRestSeconds(60)).toBe(360);
  });

  it("never goes below 2 minutes or above 10 minutes", () => {
    expect(completeRestSeconds(5)).toBe(120);
    expect(completeRestSeconds(500)).toBe(600);
  });
});

describe("suggestPrescription", () => {
  const acceleration = {
    category: "SPRINT",
    targets: ["ACCELERATION"],
    metricType: "DISTANCE",
  } as const;

  it("prescribes 30m x 5 x 2set with 3 minutes rest for acceleration", () => {
    const s = suggestPrescription(acceleration);
    expect(s.kind).toBe("SPEED_ACCELERATION");
    expect(s.prescription.distanceMeters).toBe(30);
    expect(s.prescription.reps).toBe(5);
    expect(s.prescription.sets).toBe(2);
    expect(s.prescription.restSeconds).toBe(180);
    expect(s.prescription.intensityPercent).toBe(95);
  });

  it("recomputes complete rest from the exercise's own distance", () => {
    // 種目側に60mが登録されていれば、レストも60m基準で6分になること。
    const s = suggestPrescription({
      ...acceleration,
      defaultDistanceMeters: 60,
    });
    expect(s.prescription.distanceMeters).toBe(60);
    expect(s.prescription.restSeconds).toBe(360);
  });

  it("lets the exercise's registered defaults win over the rule", () => {
    const s = suggestPrescription({
      ...acceleration,
      defaultSets: 3,
      defaultReps: 4,
      defaultRestSeconds: 90,
    });
    expect(s.prescription.sets).toBe(3);
    expect(s.prescription.reps).toBe(4);
    expect(s.prescription.restSeconds).toBe(90);
    expect(s.rationale.join()).toContain("既定値を優先");
  });

  it("reduces volume for a junior high athlete without touching intensity", () => {
    const base = suggestPrescription(acceleration, { level: "HS_ADVANCED" });
    const jhs = suggestPrescription(acceleration, { level: "JHS" });
    expect(jhs.prescription.reps).toBeLessThan(base.prescription.reps ?? 0);
    // 強度を落とすと狙うエネルギー系が変わってしまうので、レベルでは動かさない。
    expect(jhs.prescription.intensityPercent).toBe(
      base.prescription.intensityPercent,
    );
    expect(jhs.prescription.restSeconds).toBe(base.prescription.restSeconds);
  });

  it("moves volume and intensity by training phase", () => {
    const prep = suggestPrescription(acceleration, { phase: "PREPARATION" });
    const comp = suggestPrescription(acceleration, { phase: "COMPETITION" });
    expect(prep.prescription.reps).toBeGreaterThan(comp.prescription.reps ?? 0);
    expect(prep.prescription.intensityPercent).toBe(90);
    expect(comp.prescription.intensityPercent).toBe(97);
  });

  it("warns when a single exercise blows the session volume cap", () => {
    const s = suggestPrescription({
      ...acceleration,
      defaultDistanceMeters: 60,
      defaultReps: 6,
      defaultSets: 3,
    });
    // 60m × 6本 × 3set = 1080m。目安400mを大きく超える。
    expect(s.highIntensityMeters).toBe(1080);
    expect(s.warnings.join()).toContain("超えています");
  });

  it("counts reps instead of distance for a rep-measured drill", () => {
    const s = suggestPrescription({ category: "DRILL", metricType: "REPS" });
    expect(s.kind).toBe("DRILL_TECHNICAL");
    expect(s.prescription.distanceMeters).toBeNull();
    // 距離ドリルの「3本」ではなく回数ドリルの「10回」を使う。
    expect(s.prescription.reps).toBe(10);
  });

  it("does not print a rep count when the unit is time", () => {
    // 「3set × 15回 40秒」のような二重表記になるのを防ぐ。
    const s = suggestPrescription({ category: "CORE", metricType: "TIME" });
    expect(s.prescription.durationSeconds).toBe(40);
    expect(s.prescription.reps).toBeNull();
  });

  it("leaves warm-up and cool-down out of the volume scaling", () => {
    // 準備運動・整理運動はその日のトレーニング量ではないので、
    // 試合期でも中学生でも減らさない。
    const base = suggestPrescription({ category: "MOBILITY", metricType: "REPS" });
    const scaled = suggestPrescription(
      { category: "MOBILITY", metricType: "REPS" },
      { phase: "COMPETITION", level: "JHS" },
    );
    expect(scaled.prescription.reps).toBe(base.prescription.reps);
  });

  it("returns a rationale for every kind so no number is unexplained", () => {
    for (const category of EXERCISE_CATEGORIES) {
      const s = suggestPrescription({ category });
      expect(s.rationale.length, category).toBeGreaterThan(0);
      expect(buildPrescriptionNote(s).length, category).toBeGreaterThan(0);
    }
  });

  it("keeps every phase inside a sane intensity range", () => {
    for (const phase of TRAINING_PHASES) {
      const s = suggestPrescription(acceleration, { phase });
      const intensity = s.prescription.intensityPercent ?? 0;
      expect(intensity, phase).toBeGreaterThanOrEqual(50);
      expect(intensity, phase).toBeLessThanOrEqual(100);
    }
  });
});

describe("PRESCRIPTION_RULES", () => {
  it("has a rule and a written rationale for every kind", () => {
    for (const kind of PRESCRIPTION_KINDS) {
      const rule = PRESCRIPTION_RULES[kind];
      expect(rule, kind).toBeDefined();
      expect(rule.rationale.length, kind).toBeGreaterThan(0);
    }
  });

  it("never shortens rest for the ATP-CP kinds", () => {
    // ATP-CP系のレストを固定値で短く置いてしまうと、狙いがスピード持久に変わる。
    // 距離から計算する方式のままであることを守る。
    expect(PRESCRIPTION_RULES.SPEED_ACCELERATION.restPolicy).toBe(
      "COMPLETE_BY_DISTANCE",
    );
    expect(PRESCRIPTION_RULES.SPEED_MAX_VELOCITY.restPolicy).toBe(
      "COMPLETE_BY_DISTANCE",
    );
  });
});
