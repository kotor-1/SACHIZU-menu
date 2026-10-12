import { describe, expect, it } from "vitest";
import { DEFAULT_TRAINING_CONDITIONS, trainingConditionsSchema, type TrainingConditions } from "@/domain/training-proposal/conditions";
import { assessExerciseEligibility } from "@/domain/training-proposal/eligibility";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";
import { catalogFixture } from "../fixtures/menu-composition";
import fullCatalog from "../fixtures/training-proposal-catalog.json";
import { exerciseVideoGuidanceSchema } from "@/domain/exercise/video-guidance";

function confirmed(): TrainingConditions {
  const c = structuredClone(DEFAULT_TRAINING_CONDITIONS);
  c.environment = { ...c.environment, straightMeters: 120, surface: "TRACK", flatSafe: true, trafficFree: true, obstacleFree: true };
  c.athlete = { ...c.athlete, ageYears: 17, experience: "EXPERIENCED", level: "INTERMEDIATE", maturity: "POST", supervised: true, familiarWithSprint: true };
  c.condition = { ...c.condition, fatigue: 2, hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 1, competitionDays: 14 };
  return c;
}
const movement = catalogFixture({ category: "DRILL", name: "ニーアップウォーク", metricType: "DISTANCE", description: "姿勢を保ち、一歩ごとに膝を上げて歩く。", difficulty: 1 });

describe("structured training conditions", () => {
  it("keeps unconfirmed safety and equipment details null without affirmative defaults", () => {
    const parsed = trainingConditionsSchema.parse({ ...DEFAULT_TRAINING_CONDITIONS,
      environment: { ...DEFAULT_TRAINING_CONDITIONS.environment, surface: "TRACK" } });
    expect(parsed.environment.flatSafe).toBeNull();
    expect(parsed.environment.straightMeters).toBeNull();
    expect(parsed.environment.equipment).toEqual([]);
    expect(assessExerciseEligibility(movement, parsed).eligible).toBe(false);
  });
  it("never assumes a surface from the location and requires an explicit choice", () => {
    expect(DEFAULT_TRAINING_CONDITIONS.environment.surface).toBeNull();
    const result = trainingConditionsSchema.safeParse(DEFAULT_TRAINING_CONDITIONS);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(issue => issue.message)).toContain("路面を選択してください。");
  });
  it("rejects unexpected fields, out-of-range fatigue and an unselected primary goal", () => {
    expect(trainingConditionsSchema.safeParse({ ...confirmed(), hiddenDose: 99 }).success).toBe(false);
    const c = confirmed(); c.condition.fatigue = 11;
    expect(trainingConditionsSchema.safeParse(c).success).toBe(false);
    c.condition.fatigue = 1; c.primaryGoal = "STRENGTH";
    expect(trainingConditionsSchema.safeParse(c).success).toBe(false);
  });
  it("keeps grade, experience and maturity independent and accepts explicit unknown maturity", () => {
    const c = confirmed(); c.athlete.grade = "高校3年"; c.athlete.maturity = "UNKNOWN"; c.athlete.experience = "UNKNOWN";
    expect(trainingConditionsSchema.parse(c).athlete).toMatchObject({ grade: "高校3年", maturity: "UNKNOWN", experience: "UNKNOWN" });
  });
  it("requires pain details and disallows duplicate equipment", () => {
    const c = confirmed(); c.condition.pain = "PRESENT";
    expect(trainingConditionsSchema.safeParse(c).success).toBe(false);
    c.condition.painDetails = "右足首の痛み";
    expect(trainingConditionsSchema.safeParse(c).success).toBe(true);
    c.environment.equipment = ["WALL", "WALL"];
    expect(trainingConditionsSchema.safeParse(c).success).toBe(false);
  });
});

describe("catalog environment eligibility", () => {
  it("requires confirmed safety for ordinary movement and keeps core out of the movement count", () => {
    expect(assessExerciseEligibility(movement, confirmed())).toMatchObject({ eligible: true, section: "MOVEMENT", stage: 2 });
    expect(assessExerciseEligibility(catalogFixture(), confirmed()).section).toBe("STRENGTH");
    const c = confirmed(); c.environment.obstacleFree = null;
    expect(assessExerciseEligibility(movement, c).reasons).toContain("SAFE_WORK_AREA_UNCONFIRMED");
  });
  it("requires step height, stability and safety, including equipment hidden in Guidance", () => {
    const row = fullCatalog.catalog.find(row => row.id === "cmtrfj71v003witxbzc6dyxio")!;
    const exercise = { ...row, videoGuidance: exerciseVideoGuidanceSchema.parse(row.videoGuidance) };
    const c = confirmed(); c.athlete.level = "ADVANCED";
    expect(assessExerciseEligibility(exercise, c).reasons).toContain("STEP_DETAILS_UNCONFIRMED");
    c.environment.equipment = ["STEP"]; c.environment.step = { heightCm: 10, stable: true, safe: true };
    expect(assessExerciseEligibility(exercise, c)).toMatchObject({ eligible: true, section: "STRENGTH" });
    c.environment.step.stable = null;
    expect(assessExerciseEligibility(exercise, c).eligible).toBe(false);
  });
  it("requires a stable wall, and toggling a step cannot substitute for a wall", () => {
    const row = catalogFixture({ category: "DRILL", name: "ウォールキック", description: "壁に両手をつき支持する。" });
    const c = confirmed(); c.environment.equipment = ["STEP"]; c.environment.step = { heightCm: 10, stable: true, safe: true };
    expect(assessExerciseEligibility(row, c).reasons).toContain("WALL_STABILITY_UNCONFIRMED");
    c.environment.equipment.push("WALL"); c.environment.wallStable = true;
    expect(assessExerciseEligibility(row, c).eligible).toBe(true);
  });
  it("never assumes hill distance/slope or miscellaneous equipment from location and notes", () => {
    const hill = catalogFixture({ category: "DRILL", name: "坂歩き", description: "坂を歩く。" });
    const c = confirmed(); c.location = "PARK"; c.notes = "安全な坂とマットがあります";
    expect(assessExerciseEligibility(hill, c).reasons).toContain("HILL_DETAILS_UNCONFIRMED");
    c.environment.equipment = ["HILL"]; c.environment.hill = { distanceMeters: 20, slopePercent: 5, safe: true };
    expect(assessExerciseEligibility(hill, c).eligible).toBe(true);
    const mat = catalogFixture({ description: "マットに仰向けで姿勢を保つ。" });
    expect(assessExerciseEligibility(mat, c).reasons).toContain("OTHER_EQUIPMENT_UNCONFIRMED:マット");
  });
  it("excludes hidden load and unknown equipment and does not turn low-amplitude descriptions into authorization", () => {
    const c = confirmed(); c.environment.equipment = ["OTHER"]; c.environment.otherEquipment = "メディシンボール、トランポリン";
    expect(assessExerciseEligibility(catalogFixture({ description: "軽いメディシンボールを保持する。" }), c).reasons).toContain("EXTERNAL_LOAD_DETAILS_UNCONFIRMED");
    expect(assessExerciseEligibility({ ...movement, equipmentTags: ["トランポリン"] }, c).reasons).toContain("UNKNOWN_EQUIPMENT_REQUIREMENT");
  });
  it("checks hurdle equipment and experience/supervision separately", () => {
    const row = catalogFixture({ category: "HURDLE", name: "ハードルまたぎ", description: "ハードルを歩いてまたぐ。" });
    const c = confirmed();
    expect(assessExerciseEligibility(row, c).reasons).toContain("HURDLE_UNAVAILABLE");
    c.environment.equipment = ["HURDLE"]; c.athlete.supervised = null;
    expect(assessExerciseEligibility(row, c).reasons).toContain("HURDLE_USE_REQUIRES_CONFIRMED_EXPERIENCE_AND_SUPERVISION");
    c.athlete.supervised = true;
    expect(assessExerciseEligibility(row, c).eligible).toBe(true);
  });
  it.each(["LIGHT", "FATIGUE", "RACE_TOMORROW", "RECOVERY", "PRECOMP"])("excludes high-load strength under %s without counting it as movement", reason => {
    const c = confirmed(); c.athlete.level = "ADVANCED";
    if (reason === "LIGHT") c.condition.load = "LIGHT";
    if (reason === "FATIGUE") c.condition.fatigue = 4;
    if (reason === "RACE_TOMORROW") c.condition.competitionDays = 1;
    if (reason === "RECOVERY" || reason === "PRECOMP") { c.primaryGoal = reason; c.goals = [reason]; }
    const jump = catalogFixture({ category: "JUMP", name: "連続ホップ", description: "連続ホップを行う。", difficulty: 3 });
    expect(assessExerciseEligibility(jump, c)).toMatchObject({ eligible: false, section: "STRENGTH" });
    expect(assessExerciseEligibility(jump, c).reasons).toContain("HIGH_LOAD_INCOMPATIBLE_WITH_CURRENT_CONDITIONS");
  });
  it("uses movement stages and groups only named variants, not every movement of one joint", () => {
    const c = confirmed();
    const mobility = catalogFixture({ category: "MOBILITY", name: "骨盤回旋", description: "立位で骨盤をゆっくり回旋する。" });
    expect(assessExerciseEligibility(mobility, c).stage).toBe(0);
    const hip = catalogFixture({ category: "MOBILITY", name: "股関節回し", description: "立位で股関節を回す。" });
    expect(assessExerciseEligibility(mobility, c).family).not.toBe(assessExerciseEligibility(hip, c).family);
    expect(assessExerciseEligibility({ ...hip, name: "股関節回し（左右交互）" }, c).family).toBe(assessExerciseEligibility(hip, c).family);
    const rhythm = catalogFixture({ category: "DRILL", name: "その場の脚入れ替え", description: "その場で小さく跳んで脚を入れ替える。" });
    expect(assessExerciseEligibility(rhythm, c).stage).toBe(3);
    expect(assessExerciseEligibility({ ...rhythm, name: "その場で挟み込み1回入れ替え" }, c).stage).toBe(4);
  });
  it("does not hide actual running in a catalog drill while allowing non-running technique cues", () => {
    const c = confirmed();
    const transition = catalogFixture({ category: "DRILL", name: "脚入れ替え", description: "脚を入れ替えて疾走へ移行する。" });
    expect(assessExerciseEligibility(transition, c).reasons).toContain("RUNNING_ENGINE_ONLY");
    const cue = { ...transition, description: "その場で疾走姿勢を確認する。" };
    expect(assessExerciseEligibility(cue, c)).toMatchObject({ eligible: true, stage: 4 });
  });
  it("keeps only low-intensity movement under strong fatigue and holds every item for pain or poor health", () => {
    const mobility = catalogFixture({ category: "MOBILITY", name: "キャット&ドッグ", description: "四つん這いで背中を丸めて反らす。", metricType: "REPS", difficulty: 1 });
    const skip = catalogFixture({ category: "DRILL", name: "スキップ", description: "リズムよくスキップで進む。", metricType: "DISTANCE", difficulty: 2 });
    const core = catalogFixture({ category: "CORE", name: "体幹保持", description: "仰向けで体幹の姿勢を保つ。", difficulty: 1 });
    const tired = confirmed(); tired.condition.fatigue = 7;
    expect(assessExerciseEligibility(mobility, tired).eligible).toBe(true);
    expect(assessExerciseEligibility(movement, tired).eligible).toBe(true);
    expect(assessExerciseEligibility(skip, tired).reasons).toContain("STRONG_FATIGUE_LOW_INTENSITY_ONLY");
    expect(assessExerciseEligibility(core, tired).reasons).toContain("STRONG_FATIGUE_STRENGTH_HELD");
    const sore = confirmed(); sore.condition.soreness = "STRONG";
    expect(assessExerciseEligibility(core, sore).reasons).toContain("STRONG_FATIGUE_STRENGTH_HELD");
    for (const change of [(c: TrainingConditions) => { c.condition.pain = "PRESENT"; c.condition.painDetails = "右ハムストリングス"; },
      (c: TrainingConditions) => { c.condition.health = "POOR"; }]) {
      const c = confirmed(); change(c);
      expect(assessExerciseEligibility(mobility, c).reasons).toContain("CURRENT_CONDITION_REQUIRES_REVIEW");
    }
  });
  it("separates low-amplitude jumps from intense plyometrics and never allows landings on an unknown surface", () => {
    const pogo = catalogFixture({ category: "JUMP", name: "両足アンクルホップ", description: "その場で足首の弾性を使い小さく跳ぶ。", difficulty: 1 });
    const bounding = catalogFixture({ category: "JUMP", name: "バウンディング", description: "左右交互に大きく跳躍して進む。", metricType: "DISTANCE", difficulty: 3 });
    const c = confirmed();
    expect(assessExerciseEligibility(pogo, c)).toMatchObject({ eligible: true, section: "STRENGTH" });
    expect(assessExerciseEligibility(bounding, c).reasons).toContain("HIGH_IMPACT_READINESS_UNCONFIRMED");
    c.athlete.level = "ADVANCED";
    expect(assessExerciseEligibility(bounding, c).eligible).toBe(true);
    for (const change of [(x: TrainingConditions) => { x.athlete.level = "BEGINNER"; }, (x: TrainingConditions) => { x.athlete.supervised = null; },
      (x: TrainingConditions) => { x.condition.fatigue = 4; }, (x: TrainingConditions) => { x.environment.surface = "ASPHALT"; }]) {
      const x = confirmed(); change(x);
      expect(assessExerciseEligibility(pogo, x).reasons).toContain("HIGH_IMPACT_READINESS_UNCONFIRMED");
    }
    const other = confirmed(); other.environment.surface = "OTHER";
    expect(assessExerciseEligibility(movement, other).reasons).toContain("SURFACE_UNCONFIRMED");
    expect(assessExerciseEligibility(pogo, other).reasons).toContain("SURFACE_UNCONFIRMED");
    const stationary = catalogFixture({ category: "MOBILITY", name: "肩回し", description: "立位で肩を回す。", metricType: "REPS", difficulty: 1 });
    expect(assessExerciseEligibility(stationary, other).eligible).toBe(true);
  });
  it("orders named jumps and gallops as rhythm work, after basic walking drills", () => {
    const c = confirmed();
    const jump = catalogFixture({ category: "DRILL", name: "両足ジャンプ（腕振り）", description: "腕振りと合わせて前へ進む。", metricType: "DISTANCE", difficulty: 2 });
    const gallop = catalogFixture({ category: "DRILL", name: "ギャロップ", description: "片脚リードで前へ進む。", metricType: "DISTANCE", difficulty: 2 });
    expect(assessExerciseEligibility(jump, c).stage).toBe(3);
    expect(assessExerciseEligibility(gallop, c).stage).toBe(3);
    expect(assessExerciseEligibility(movement, c).stage).toBe(2);
  });
  it("prefers registered Exercise defaults and only scales total volume on a reduced day", () => {
    const plank = catalogFixture();
    expect(suggestCatalogItem(plank, confirmed()).item).toMatchObject({ plannedSets: 3, plannedDurationSeconds: 40, plannedRestSeconds: 60 });
    const light = confirmed(); light.condition.load = "LIGHT";
    expect(suggestCatalogItem(plank, light).item).toMatchObject({ plannedSets: 2, plannedDurationSeconds: 20, plannedRestSeconds: 60 });
    const mobility = catalogFixture({ category: "MOBILITY", name: "肩回し", metricType: "REPS", description: "立位で肩を回す。",
      defaultSets: null, defaultDurationSeconds: null, defaultRestSeconds: null });
    expect(suggestCatalogItem(mobility, confirmed())).toMatchObject({ item: { plannedSets: 2, plannedReps: 6, plannedRestSeconds: 20 },
      annotation: { stage: 0 } });
  });
  it("says where every suggested number comes from: the registered value or the App's conservative start", () => {
    const plank = catalogFixture();
    expect(suggestCatalogItem(plank, confirmed()).item.plannedNote).toMatch(/^登録された既定量をもとにした編集可能な提案。登録説明どおり/u);
    const light = confirmed(); light.condition.load = "LIGHT";
    expect(suggestCatalogItem(plank, light).item.plannedNote).toMatch(/^登録された既定量をもとにした編集可能な提案。今日の条件に合わせて控えめに調整。/u);
    const partial = catalogFixture({ defaultDurationSeconds: null });
    expect(suggestCatalogItem(partial, confirmed()).item.plannedNote).toMatch(/^登録された既定量（未登録の項目はアプリの控えめな初期値）をもとにした/u);
    const mobility = catalogFixture({ category: "MOBILITY", name: "肩回し", metricType: "REPS", description: "立位で肩を回す。",
      defaultSets: null, defaultDurationSeconds: null, defaultRestSeconds: null });
    const note = suggestCatalogItem(mobility, confirmed()).item.plannedNote;
    expect(note).toMatch(/^既定量が未登録のため、アプリの控えめな初期値による編集可能な仮提案。/u);
    expect(note.length).toBeLessThanOrEqual(200);
  });
  it("treats a sprint prohibition as a cue but still catches a hidden running dose", async () => {
    const { assessTrainingComposition } = await import("@/domain/training-proposal/quality");
    const row = catalogFixture({ category: "DRILL", name: "ギャロップ", description: "片脚リードで前へ進む。", metricType: "DISTANCE", difficulty: 2,
      defaultSets: null, defaultDistanceMeters: null, defaultRestSeconds: null, defaultDurationSeconds: null });
    const issuesFor = (intensity: string, executionInstruction = "片脚リードで前へ進む。") => assessTrainingComposition({ blocks: [
      { id: "m", name: "動きづくり", items: [{ id: "x", type: "CATALOG_EXERCISE", exerciseId: row.id, displayName: row.name, executionInstruction,
        plannedNote: "仮提案", reason: "リズム", plannedSets: 1, plannedReps: null, plannedDurationSeconds: null, plannedDistanceMeters: 20, plannedRestSeconds: 30 }] },
      { id: "r", name: "走練習", items: [] }, { id: "s", name: "補強トレーニング", items: [] }] },
    { x: { intensity, stage: 3, family: "MOVEMENT:ギャロップ", relationship: "COMBINABLE", alternativeGroup: null } }, confirmed(), [row], { proposal: false });
    expect(issuesFor("リズムと短い接地を保てる速さで行い、全力疾走にしない。")).not.toContain("RUNNING_INSTRUCTION_OUTSIDE_ENGINE");
    expect(issuesFor("ダッシュはせず、リズムを優先する。")).not.toContain("RUNNING_INSTRUCTION_OUTSIDE_ENGINE");
    expect(issuesFor("全力疾走で行う。")).toContain("RUNNING_INSTRUCTION_OUTSIDE_ENGINE");
    expect(issuesFor("軽く行う。", "全力疾走しないで、30m走を3本加える。")).toContain("RUNNING_INSTRUCTION_OUTSIDE_ENGINE");
  });
  it("has more than ten actual movement families in the full reviewed catalog with confirmed ordinary track conditions", () => {
    const rows = fullCatalog.catalog.map(row => ({ ...row, videoGuidance: row.videoGuidance ? exerciseVideoGuidanceSchema.parse(row.videoGuidance) : null }));
    const eligible = rows.map(row => ({ row, assessment: assessExerciseEligibility(row, confirmed()) }))
      .filter(({ assessment }) => assessment.eligible && assessment.section === "MOVEMENT");
    expect(eligible.length).toBeGreaterThanOrEqual(10);
    expect(new Set(eligible.map(({ assessment }) => assessment.family)).size).toBeGreaterThanOrEqual(10);
    expect(eligible.every(({ row }) => !["CORE", "STRENGTH", "JUMP", "THROW"].includes(row.category))).toBe(true);
  });
});
