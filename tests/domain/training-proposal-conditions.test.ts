import { describe, expect, it } from "vitest";
import { DEFAULT_TRAINING_CONDITIONS, trainingConditionsSchema, type TrainingConditions } from "@/domain/training-proposal/conditions";
import { assessExerciseEligibility, movementDirectionSet } from "@/domain/training-proposal/eligibility";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";
import { trainingAvailability } from "@/domain/training-proposal/quality";
import { exerciseRepetitionCountMatches } from "@/domain/menu-composition/dose-counting";
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
    // The coach (2026-10-13): floor work can be done without a mat, so a mat is never required.
    const mat = catalogFixture({ description: "マットに仰向けで姿勢を保つ。" });
    expect(assessExerciseEligibility(mat, c).reasons).not.toContain("OTHER_EQUIPMENT_UNCONFIRMED:マット");
    expect(assessExerciseEligibility(mat, c).eligible).toBe(true);
    c.notes = "安全な坂とベンチがあります";
    const bench = catalogFixture({ description: "ベンチに両手を置いて体を支える。" });
    expect(assessExerciseEligibility(bench, c).reasons).toContain("OTHER_EQUIPMENT_UNCONFIRMED:ベンチ");
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
  it("never opens a warm-up with bouncing: a bouncing mobility drill is rhythm work, and each stage builds up from the ground", () => {
    const c = confirmed();
    // A real catalog entry, registered as mobility but done while bouncing forward.
    const arms = catalogFixture({ category: "MOBILITY", name: "軽く弾みながらの腕回し（前回し・左右交互）", metricType: "DISTANCE", difficulty: 1,
      description: "軽く弾むリズムで前進しながら、両腕を肘を伸ばしたまま前方向へ大きく回す。左右の腕は交互に回す。" });
    expect(assessExerciseEligibility(arms, c)).toMatchObject({ eligible: true, stage: 3, progression: 4 });
    const shoulders = catalogFixture({ category: "MOBILITY", name: "肩回し", description: "立位で肩を回す。", metricType: "REPS", difficulty: 1 });
    expect(assessExerciseEligibility(shoulders, c)).toMatchObject({ stage: 0, progression: 1 });
    const place = (name: string, description: string, metricType: "REPS" | "DISTANCE" = "REPS") =>
      assessExerciseEligibility(catalogFixture({ category: "DRILL", name, description, metricType, difficulty: 1 }), c).progression;
    // On the ground: lying, sitting, kneeling, on all fours, in a push-up or plank position.
    expect(place("キャット&ドッグ", "両手と両膝を地面につけた四つ這いの姿勢から、背中を丸めて反らす。")).toBe(0);
    expect(place("横向き胸椎回旋", "横向きに寝て両脚を重ねた姿勢から、上体をゆっくり回旋させる。")).toBe(0);
    expect(place("インチワーム（手足歩き）", "前屈して手を地面につき、手を交互に前へ歩かせて前進する。", "DISTANCE")).toBe(0);
    expect(place("骨盤の回旋", "低い台に腰かけて足を地面につけ、骨盤を左右へ交互に回す。")).toBe(0);
    expect(place("膝立ちキック", "膝立ちになり、正面へ脚を振り上げる。")).toBe(0);
    expect(place("ジャックナイフ", "しゃがんで両手で足首を持ち、膝を伸ばして腰を持ち上げる。")).toBe(1);
    // Negated mentions and look-alike cues do not count: 「膝をつかない」「膝をつま先の向きに」「跳び上がらずに」.
    expect(place("リバースランジ", "片脚を後ろへ引いて腰を落とし、膝をつかないように、膝をつま先の向きに保って立ち上がる。")).toBe(1);
    expect(place("脚の切り替え", "高く跳び上がらずに、その場で脚を前後に切り替える。")).toBe(1);
    expect(place("股関節回し", "前向きに進みながら、片脚の膝を外から内へ回す。", "DISTANCE")).toBe(2);
    expect(place("引きつけ走", "一定の歩数リズムを刻みながら、膝を高く引き上げて前進する。", "DISTANCE")).toBe(3);
    // The coach's order (2026-10-16): 両足ジャンプ and ケンケン are the basics, and skips and gallops come after them.
    expect(place("両足ジャンプ（腕振り）", "両足をそろえたまま連続してジャンプしながら前へ進む。", "DISTANCE")).toBe(5);
    expect(place("ケンケン", "片脚だけで連続して弾みながら前方へ進む。", "DISTANCE")).toBe(6);
    expect(place("引きつけジャンプ走", "片脚で小さくホップしながら、反対の膝を引き上げて前進する。", "DISTANCE")).toBe(6);
    expect(place("連続ニーアップ", "片脚の膝を引き上げた姿勢を保ち、支持脚の前足部でリズミカルに弾む片足バネのドリル。")).toBe(6);
    expect(place("スキップ", "リズムよくスキップで前へ進む。", "DISTANCE")).toBe(7);
    expect(place("ギャロップ（片脚リード走）", "片脚を前上方へ高く引き出して前へ進む。", "DISTANCE")).toBe(7);
  });
  it("keeps the two directions of one drill as a set with their own families, so neither is dropped as a duplicate", () => {
    const c = confirmed();
    const family = (name: string, category = "MOBILITY") => assessExerciseEligibility(catalogFixture({ category, name, metricType: "DISTANCE", difficulty: 1,
      description: "軽く弾むリズムで前進しながら、両腕を大きく回す。" }), c).family;
    expect(movementDirectionSet("前向きに進みながらの股関節回し（外から内）")).toEqual({ key: "進みながらの股関節回し", order: 0 });
    expect(movementDirectionSet("後ろ向きに進みながらの股関節回し（内から外）")).toEqual({ key: "進みながらの股関節回し", order: 1 });
    expect(movementDirectionSet("軽く弾みながらの腕回し（前回し・左右交互）")?.key).toBe(movementDirectionSet("軽く弾みながらの腕回し（後ろ回し・左右交互）")?.key);
    expect(family("軽く弾みながらの腕回し（前回し・左右交互）")).not.toBe(family("軽く弾みながらの腕回し（後ろ回し・左右交互）"));
    // 前進 says where the drill goes, not which way round it is done.
    expect(movementDirectionSet("片足連続ホップ（前進）")).toBeNull();
    expect(movementDirectionSet("引きつけウォーク")).toBeNull();
  });
  it("orders 補強 from jumps to standing work to the floor, and keeps a mobility drill named after a push-up position in 動きづくり", () => {
    const c = confirmed();
    const at = (category: string, name: string, description: string) =>
      assessExerciseEligibility(catalogFixture({ category, name, description, metricType: "REPS", difficulty: 2 }), c);
    expect(at("JUMP", "垂直跳び（カウンタームーブメントジャンプ）", "直立姿勢から両腕を振り上げて両脚で真上に跳躍する。")).toMatchObject({ section: "STRENGTH", progression: 0 });
    expect(at("STRENGTH", "自重スクワット", "両手を腰に当てて腰を落とし、足裏全体で地面を押して立ち上がる。")).toMatchObject({ section: "STRENGTH", progression: 1 });
    expect(at("CORE", "前鋸筋プッシュアップ", "腕を伸ばして手とつま先で体を支えた腕立て伏せの姿勢から、肩甲骨まわりだけを動かす。")).toMatchObject({ section: "STRENGTH", progression: 2 });
    expect(at("CORE", "肘つきプランク", "肘と前腕をつき、体を一直線に保つ。")).toMatchObject({ section: "STRENGTH", progression: 2 });
    expect(at("CORE", "後ろ手支持ヒップリフト", "座った姿勢から両手を体の後ろの地面につき、腰を持ち上げる。")).toMatchObject({ section: "STRENGTH", progression: 2 });
    expect(at("MOBILITY", "腕立て姿勢からの腕の振り上げ（胸椎回旋）", "腕立て伏せの姿勢から、片方の手を空へ伸ばして上体を回旋させる。"))
      .toMatchObject({ section: "MOVEMENT", stage: 0, progression: 0 });
  });
  it("does not read equipment into a way of sitting, a count of hurdles or a transcript note", () => {
    const c = confirmed();
    const hurdler = catalogFixture({ category: "HURDLE", name: "ハードラーストレッチ", metricType: "REPS", difficulty: 1, tags: ["ハードル座り"],
      description: "片脚を前へ伸ばし、もう一方の脚は外側後方へ開いた座り方(ハードル座り)をとり、上体を倒して起こす。" });
    expect(assessExerciseEligibility(hurdler, c)).toMatchObject({ eligible: true, section: "MOVEMENT", stage: 0, progression: 0 });
    const notes = catalogFixture({ category: "STRENGTH", name: "ヒップロックのPNF（対角の手足上げ）", metricType: "REPS", difficulty: 2,
      description: "立位で片手を上げ、反対側の脚を上げる。", coachingPoint: "240秒開始のASRブロック: 右脚から行う。" });
    expect(assessExerciseEligibility(notes, c).reasons).not.toContain("STEP_DETAILS_UNCONFIRMED");
    const counted = catalogFixture({ category: "DRILL", name: "ミニハードル走", metricType: "DISTANCE", difficulty: 2,
      description: "ミニハードルの間を1台につき2歩のリズムで進む。" });
    expect(assessExerciseEligibility(counted, c).reasons).toEqual(expect.arrayContaining(["MINI_HURDLE_UNAVAILABLE"]));
    expect(assessExerciseEligibility(counted, c).reasons).not.toContain("STEP_DETAILS_UNCONFIRMED");
    const step = catalogFixture({ category: "STRENGTH", name: "ステップアップ", metricType: "REPS", difficulty: 2, description: "片足を段差に乗せて踏み込み、立ち上がる。" });
    expect(assessExerciseEligibility(step, c).reasons).toContain("STEP_DETAILS_UNCONFIRMED");
  });
  it("uses the per-side count the reviewed instruction states, without the internal marker, so the App never contradicts its text", () => {
    const row = fullCatalog.catalog.find(row => row.name === "片足ケンケン引きつけドリル")!;
    const exercise = { ...row, videoGuidance: exerciseVideoGuidanceSchema.parse(row.videoGuidance) };
    expect(exercise).toMatchObject({ defaultReps: null, videoGuidance: { videoAnalysisStatus: "COACH_REVIEWED", countingUnit: "PER_SIDE" } });
    expect(exercise.videoGuidance.executionSummary).toMatch(/^COACH_DEFINED: /u);
    const c = confirmed(); c.athlete.level = "ADVANCED";
    const { item } = suggestCatalogItem(exercise, c);
    expect(item.executionInstruction).toMatch(/^片脚で連続ホップしながら前進し/u);
    expect(item.executionInstruction).toContain("片足10回を完了してから反対側10回を行う。");
    expect(item).toMatchObject({ plannedReps: 10, plannedSets: 3 });
    expect(item.plannedNote).toContain("回数は登録説明の片側10回。");
    expect(exerciseRepetitionCountMatches(item, exercise)).toBe(true);
    // A reduced day lowers the sets, never the count the instruction states.
    const light = confirmed(); light.athlete.level = "ADVANCED"; light.condition.load = "LIGHT";
    expect(suggestCatalogItem(exercise, light).item).toMatchObject({ plannedReps: 10, plannedSets: 2 });
  });
  it("treats a name that contains another registered name as its variant, so one proposal never holds both", () => {
    const c = confirmed();
    const rdl = catalogFixture({ id: "rdl", category: "STRENGTH", name: "ルーマニアンデッドリフト", metricType: "REPS", difficulty: 1,
      description: "立った姿勢から股関節を後ろへ引いて上体を倒し、起き上がる。" });
    const tripod = { ...rdl, id: "tripod", name: "足裏3点バランスでのルーマニアンデッドリフト" };
    const squat = { ...rdl, id: "squat", name: "自重スクワット" };
    const available = trainingAvailability([rdl, tripod, squat], c);
    const family = (id: string) => available.strength.find(x => x.row.id === id)!.eligibility.family;
    expect(family("tripod")).toBe(family("rdl"));
    expect(family("squat")).not.toBe(family("rdl"));
    expect(available.requiredStrength).toBe(2);
    // One name in two spellings is one family too.
    const knee = catalogFixture({ category: "CORE", name: "ニー to エルボー", metricType: "REPS", difficulty: 2, description: "仰向けで上体をひねり、対角の肘と膝を近づける。" });
    expect(assessExerciseEligibility({ ...knee, name: "ニー・トゥ・エルボー（対角膝肘引きつけ）" }, c).family).toBe(assessExerciseEligibility(knee, c).family);
  });
  it("prefers registered Exercise defaults and only scales total volume on a reduced day", () => {
    const plank = catalogFixture();
    expect(suggestCatalogItem(plank, confirmed()).item).toMatchObject({ plannedSets: 3, plannedDurationSeconds: 40, plannedRestSeconds: 60 });
    const light = confirmed(); light.condition.load = "LIGHT";
    expect(suggestCatalogItem(plank, light).item).toMatchObject({ plannedSets: 2, plannedDurationSeconds: 20, plannedRestSeconds: 60 });
    const mobility = catalogFixture({ category: "MOBILITY", name: "肩回し", metricType: "REPS", description: "立位で肩を回す。",
      defaultSets: null, defaultDurationSeconds: null, defaultRestSeconds: null });
    expect(suggestCatalogItem(mobility, confirmed())).toMatchObject({ item: { plannedSets: 1, plannedReps: 8, plannedRestSeconds: 20 },
      annotation: { stage: 0 } });
  });
  it("says where every suggested number comes from: the registered value or the App's conservative start", () => {
    const plank = catalogFixture();
    expect(suggestCatalogItem(plank, confirmed()).item.plannedNote).toMatch(/^登録された既定量をもとにした編集可能な提案。登録説明どおり/u);
    const light = confirmed(); light.condition.load = "LIGHT";
    expect(suggestCatalogItem(plank, light).item.plannedNote).toMatch(/^登録された既定量をもとにした編集可能な提案。今日の条件に合わせて控えめに調整。/u);
    const partial = catalogFixture({ defaultDurationSeconds: null });
    expect(suggestCatalogItem(partial, confirmed()).item.plannedNote).toMatch(/^登録された既定量（未登録の項目はアプリの初期値）をもとにした/u);
    const mobility = catalogFixture({ category: "MOBILITY", name: "肩回し", metricType: "REPS", description: "立位で肩を回す。",
      defaultSets: null, defaultDurationSeconds: null, defaultRestSeconds: null });
    const note = suggestCatalogItem(mobility, confirmed()).item.plannedNote;
    expect(note).toMatch(/^既定量が未登録のため、可動域の準備運動の一般的な範囲からアプリが決めた初期値（編集可能な仮提案）。/u);
    expect(note.length).toBeLessThanOrEqual(200);
  });
  const unregistered = (name: string, patch: Parameters<typeof catalogFixture>[0]) => catalogFixture({ id: name, name, difficulty: 2,
    defaultSets: null, defaultReps: null, defaultDurationSeconds: null, defaultDistanceMeters: null, defaultRestSeconds: null, ...patch });
  it("keeps a stopping margin after bouncing drills, shortens a registered distance and says so, and holds layout-bound drills", () => {
    const park = confirmed(); park.environment.straightMeters = 30;
    const gallop = catalogFixture({ id: "gallop", category: "DRILL", name: "ギャロップ（片脚リード走）", metricType: "DISTANCE", description: "片脚リードで前へ進む。",
      difficulty: 2, defaultSets: 3, defaultDurationSeconds: null, defaultDistanceMeters: 30, defaultRestSeconds: 60 });
    expect(assessExerciseEligibility(gallop, park)).toMatchObject({ eligible: true, stage: 3 });
    const shortened = suggestCatalogItem(gallop, park).item;
    expect(shortened).toMatchObject({ plannedSets: 3, plannedDistanceMeters: 20, plannedRestSeconds: 60 });
    expect(shortened.plannedNote).toContain("直線30mのため、止まる余裕10mを残して20m（登録は30m）。");
    // Walking-pace drills stop within a step and may use the whole straight.
    const narrow = confirmed(); narrow.environment.straightMeters = 12;
    expect(assessExerciseEligibility(movement, narrow)).toMatchObject({ eligible: true, stage: 2 });
    expect(suggestCatalogItem(movement, narrow).item).toMatchObject({ plannedDistanceMeters: 12 });
    expect(suggestCatalogItem(movement, narrow).item.plannedNote).toContain("直線12mに合わせて12m。");
    // A bouncing drill needs 10m of travel on top of the margin.
    const short = confirmed(); short.environment.straightMeters = 15;
    expect(assessExerciseEligibility(gallop, short).reasons).toContain("MOVEMENT_SPACE_TOO_SHORT");
    // Hurdle spacing fixes the layout, so a shorter variant is held instead of shortened.
    const hurdles = catalogFixture({ id: "hurdles", category: "DRILL", name: "ミニハードルまたぎ", metricType: "DISTANCE",
      description: "並べたミニハードルを1台ずつ膝を引き上げてまたぎ越して歩く。", difficulty: 2, defaultSets: 2, defaultDurationSeconds: null, defaultDistanceMeters: 20, defaultRestSeconds: null });
    const yard = confirmed(); yard.environment.straightMeters = 15; yard.environment.equipment = ["MINI_HURDLE"];
    expect(assessExerciseEligibility(hurdles, yard).reasons).toContain("REGISTERED_DISTANCE_EXCEEDS_SPACE");
    yard.environment.straightMeters = 25;
    expect(assessExerciseEligibility(hurdles, yard).eligible).toBe(true);
  });
  it("starts unregistered items from the kind of movement, and a reduced day lowers volume only", () => {
    const c = confirmed();
    const hop = unregistered("ケンケン", { category: "DRILL", metricType: "DISTANCE", description: "片脚で弾みながら前へ進む。" });
    const skip = unregistered("スキップ", { category: "DRILL", metricType: "DISTANCE", description: "リズムよくスキップで前へ進む。" });
    for (const row of [hop, skip]) expect(assessExerciseEligibility(row, c)).toMatchObject({ eligible: true, stage: 3 });
    // Hops load a leg on every contact: shorter passes and a full walk back.
    expect(suggestCatalogItem(hop, c).item).toMatchObject({ plannedSets: 2, plannedDistanceMeters: 10, plannedRestSeconds: 60 });
    expect(suggestCatalogItem(skip, c).item).toMatchObject({ plannedSets: 2, plannedDistanceMeters: 20, plannedRestSeconds: 45 });
    const squat = unregistered("自重スクワット", { category: "STRENGTH", metricType: "REPS", description: "足を肩幅に開いてしゃがみ、立ち上がる。" });
    const oneLeg = unregistered("シングルヒップリフト", { category: "CORE", metricType: "REPS", description: "仰向けで片脚ずつ腰を持ち上げる。" });
    const alternating = unregistered("手つきプランクからの膝引きつけ", { category: "CORE", metricType: "REPS", description: "腕立て姿勢から膝を引きつける動作を左右交互に繰り返す。" });
    expect(suggestCatalogItem(squat, c).item).toMatchObject({ plannedSets: 2, plannedReps: 10, plannedRestSeconds: 60 });
    expect(suggestCatalogItem(oneLeg, c).item).toMatchObject({ plannedSets: 2, plannedReps: 8 });
    expect(suggestCatalogItem(alternating, c).item).toMatchObject({ plannedSets: 2, plannedReps: 16 });
    expect(suggestCatalogItem(alternating, c).item.plannedNote).toContain("回数欄は左右合計");
    // "交互" between two positions is not a left/right count.
    const catDog = unregistered("キャット&ドッグ", { category: "MOBILITY", metricType: "REPS", description: "四つ這いで背中を丸める動きと反らせる動きを交互にゆっくり繰り返す。" });
    expect(suggestCatalogItem(catDog, c).item).toMatchObject({ plannedSets: 1, plannedReps: 8, plannedRestSeconds: 20 });
    expect(suggestCatalogItem(catDog, c).item.plannedNote).not.toContain("左右合計");
    const light = confirmed(); light.condition.load = "LIGHT";
    expect(suggestCatalogItem(skip, light).item).toMatchObject({ plannedSets: 1, plannedDistanceMeters: 15, plannedRestSeconds: 45 });
    expect(suggestCatalogItem(squat, light).item).toMatchObject({ plannedSets: 1, plannedReps: 8 });
    expect(suggestCatalogItem(alternating, light).item).toMatchObject({ plannedSets: 1, plannedReps: 12 });
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
  it("on a lighter day, reads a cue that rules full effort out as a cue, and still catches a demand for it", async () => {
    const { assessTrainingComposition } = await import("@/domain/training-proposal/quality");
    const row = catalogFixture({ category: "DRILL", name: "ギャロップ", description: "片脚リードで前へ進む。", metricType: "DISTANCE", difficulty: 2,
      defaultSets: null, defaultDistanceMeters: null, defaultRestSeconds: null, defaultDurationSeconds: null });
    const tired = confirmed(); tired.condition.fatigue = 5;
    const issuesFor = (intensity: string) => assessTrainingComposition({ blocks: [
      { id: "m", name: "動きづくり", items: [{ id: "x", type: "CATALOG_EXERCISE", exerciseId: row.id, displayName: row.name, executionInstruction: "片脚リードで前へ進む。",
        plannedNote: "仮提案", reason: "リズム", plannedSets: 1, plannedReps: null, plannedDurationSeconds: null, plannedDistanceMeters: 20, plannedRestSeconds: 30 }] },
      { id: "r", name: "走練習", items: [] }, { id: "s", name: "補強トレーニング", items: [] }] },
    { x: { intensity, stage: 3, family: "MOVEMENT:ギャロップ", relationship: "COMBINABLE", alternativeGroup: null } }, tired, [row], { proposal: false });
    // Wording from real Claude answers (2026-10-16) that the check used to read as a demand for full effort.
    for (const cue of ["全力は求めず、高い姿勢で鋭く下ろせる速さで行う。", "姿勢が崩れない範囲で力強く、全力は求めない", "高強度にしない。", "全力ではなく、動きを確かめる速さで。", "限界まで追い込まない。"]) {
      expect(issuesFor(cue)).not.toContain("LOAD_CONDITION_CONFLICT");
    }
    for (const demand of ["全力で行う。", "全力に近い速さで行う。", "全力で行い、無理のない範囲で続ける。", "限界まで追い込む。"]) {
      expect(issuesFor(demand)).toContain("LOAD_CONDITION_CONFLICT");
    }
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
