import { DEFAULT_TRAINING_CONDITIONS, trainingConditionLevel, type TrainingConditions, type TrainingGoal } from "./conditions";

/**
 * 画面で選ぶのは5つだけ（場所・走れる直線・選手・目的・今日の状態）。
 * ほかの条件はここで決まった値に置き換え、提案の判定（安全・負荷・走の処方）は従来どおり行う。
 *
 * 前提として置くもの（画面の提案ボタン「安全を確認して提案する」で確認したことにする）:
 *   - 場所は平坦で滑りにくく、車や自転車が来ず、障害物がない。
 *   - コーチ等が見守る。器具は使わない（自体重の種目だけ）。
 */
export const SIMPLE_LOCATIONS = ["TRACK", "SCHOOL", "PARK", "ROAD", "INDOOR"] as const;
export type SimpleLocation = (typeof SIMPLE_LOCATIONS)[number];
export const SIMPLE_LOCATION_LABELS: Record<SimpleLocation, string> = {
  TRACK: "陸上競技場", SCHOOL: "学校のグラウンド", PARK: "公園・広場", ROAD: "道路・空き地", INDOOR: "屋内",
};
export const SIMPLE_DISTANCES = [0, 10, 20, 30, 50, 100, 200, 400] as const;
export type SimpleDistance = (typeof SIMPLE_DISTANCES)[number];
export const simpleDistanceLabel = (meters: SimpleDistance) => meters === 0 ? "なし" : meters === 400 ? "トラック1周" : `${meters}m`;

/** 路面は場所から決める。公園は芝か土か分からないため、着地の多い種目を出さない土として扱う。 */
const SURFACE_BY_LOCATION = { TRACK: "TRACK", SCHOOL: "DIRT", PARK: "DIRT", ROAD: "ASPHALT", INDOOR: "INDOOR" } as const;
/** 競技場はトラック1周（折り返しのない400m）を走れるものとして始める。ほかは場所の目安。 */
export const DEFAULT_STRAIGHT_BY_LOCATION: Record<SimpleLocation, SimpleDistance> = { TRACK: 400, SCHOOL: 50, PARK: 30, ROAD: 20, INDOOR: 0 };

/** 年齢は年代の目安（走の処方が年代と年齢の整合を確かめるため）。 */
type AthleteProfile = Pick<TrainingConditions["athlete"], "ageGroup" | "ageYears" | "experience" | "level" | "maturity" | "familiarWithSprint">;
const ATHLETES = {
  ELEMENTARY: { label: "小学生", profile: { ageGroup: "ELEMENTARY", ageYears: 11, experience: "BEGINNER", level: "BEGINNER", maturity: "PRE", familiarWithSprint: false } },
  JUNIOR_HIGH_BEGINNER: { label: "中学生（始めたばかり）", profile: { ageGroup: "JUNIOR_HIGH", ageYears: 13, experience: "BEGINNER", level: "BEGINNER", maturity: "CIRCA", familiarWithSprint: false } },
  JUNIOR_HIGH: { label: "中学生（経験あり）", profile: { ageGroup: "JUNIOR_HIGH", ageYears: 14, experience: "EXPERIENCED", level: "INTERMEDIATE", maturity: "CIRCA", familiarWithSprint: true } },
  HIGH_SCHOOL_BEGINNER: { label: "高校生（始めたばかり）", profile: { ageGroup: "HIGH_SCHOOL", ageYears: 16, experience: "BEGINNER", level: "BEGINNER", maturity: "POST", familiarWithSprint: false } },
  HIGH_SCHOOL: { label: "高校生（経験あり）", profile: { ageGroup: "HIGH_SCHOOL", ageYears: 17, experience: "EXPERIENCED", level: "INTERMEDIATE", maturity: "POST", familiarWithSprint: true } },
  ADULT: { label: "大学生・一般", profile: { ageGroup: "UNIVERSITY", ageYears: 20, experience: "EXPERIENCED", level: "ADVANCED", maturity: "POST", familiarWithSprint: true } },
} as const satisfies Record<string, { label: string; profile: AthleteProfile }>;
export type SimpleAthlete = keyof typeof ATHLETES;
export const SIMPLE_ATHLETES = Object.keys(ATHLETES) as SimpleAthlete[];
export const SIMPLE_ATHLETE_LABELS = Object.fromEntries(SIMPLE_ATHLETES.map(key => [key, ATHLETES[key].label])) as Record<SimpleAthlete, string>;

export const SIMPLE_GOALS = ["ACCEL", "MAX_SPEED", "SPEED_ENDURANCE", "BASIC", "TECHNIQUE", "MOVEMENT", "STRENGTH", "PRECOMP", "RECOVERY"] as const satisfies readonly TrainingGoal[];
export const SIMPLE_GOAL_LABELS: Record<TrainingGoal, string> = {
  ACCEL: "加速", MAX_SPEED: "最高速度", SPEED_ENDURANCE: "スピード持久", BASIC: "基礎の走力", TECHNIQUE: "走りの技術",
  MOVEMENT: "動きづくり", STRENGTH: "筋力・パワー", PRECOMP: "大会前の調整", RECOVERY: "疲労回復",
};

type ConditionProfile = Pick<TrainingConditions["condition"], "fatigue" | "soreness" | "health" | "hoursSinceHighIntensity" | "hoursUntilNextHighIntensity" | "highIntensitySessionsLast7Days" | "load">;
const STATES = {
  GOOD: { label: "元気", profile: { fatigue: 2, soreness: "NONE", health: "GOOD", hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 1, load: "NORMAL" } },
  // 筋肉痛までは言っていないので、疲労だけを申告したものとして扱う（高強度の走は止まる）。
  TIRED: { label: "少し疲れている", profile: { fatigue: 5, soreness: "NONE", health: "GOOD", hoursSinceHighIntensity: 48, hoursUntilNextHighIntensity: 48, highIntensitySessionsLast7Days: 2, load: "NORMAL" } },
  VERY_TIRED: { label: "かなり疲れている", profile: { fatigue: 8, soreness: "STRONG", health: "FAIR", hoursSinceHighIntensity: 24, hoursUntilNextHighIntensity: 48, highIntensitySessionsLast7Days: 3, load: "LIGHT" } },
  // 痛みの部位は聞かないため、体調不良として扱う（どちらも提案を止め、指導者の確認を求める）。
  UNWELL: { label: "痛み・体調不良がある", profile: { fatigue: 5, soreness: "NONE", health: "POOR", hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 1, load: "LIGHT" } },
} as const satisfies Record<string, { label: string; profile: ConditionProfile }>;
export type SimpleState = keyof typeof STATES;
export const SIMPLE_STATES = Object.keys(STATES) as SimpleState[];
export const SIMPLE_STATE_LABELS = Object.fromEntries(SIMPLE_STATES.map(key => [key, STATES[key].label])) as Record<SimpleState, string>;

export type SimpleConditions = { location: SimpleLocation; straightMeters: SimpleDistance; athlete: SimpleAthlete; goal: TrainingGoal; state: SimpleState };
export const DEFAULT_SIMPLE_CONDITIONS: SimpleConditions = { location: "TRACK", straightMeters: 400, athlete: "HIGH_SCHOOL", goal: "ACCEL", state: "GOOD" };

/** 5つの選択から、提案に渡す条件一式を作る。 */
export function conditionsFromSimple(simple: SimpleConditions): TrainingConditions {
  const base = structuredClone(DEFAULT_TRAINING_CONDITIONS);
  const state = STATES[simple.state].profile;
  return {
    ...base,
    location: simple.location,
    environment: { ...base.environment, straightMeters: simple.straightMeters, surface: SURFACE_BY_LOCATION[simple.location],
      flatSafe: true, trafficFree: true, obstacleFree: true, equipment: [] },
    athlete: { ...base.athlete, ...ATHLETES[simple.athlete].profile, supervised: true },
    goals: [simple.goal], primaryGoal: simple.goal,
    condition: { ...base.condition, ...state, pain: "NONE", painDetails: "",
      load: simple.goal === "RECOVERY" ? "LIGHT" : state.load,
      // 大会前の調整は、大会前日の軽い流しとして扱う。
      competitionDays: simple.goal === "PRECOMP" ? 1 : null,
      speedEnduranceMode: simple.goal === "SPEED_ENDURANCE" ? "SPRINT_SPECIFIC" : null },
  };
}

/** 保存済みの条件を、5つの選択に読み替える（以前の詳しい条件で作ったメニューを開いたとき用）。 */
export function simpleFromConditions(conditions: TrainingConditions): SimpleConditions {
  const location: SimpleLocation = (SIMPLE_LOCATIONS as readonly string[]).includes(conditions.location) ? conditions.location as SimpleLocation : "TRACK";
  const straight = conditions.environment.straightMeters;
  const straightMeters = straight === null ? DEFAULT_STRAIGHT_BY_LOCATION[location]
    : [...SIMPLE_DISTANCES].reverse().find(option => option <= straight) ?? 0;
  const { ageGroup, experience } = conditions.athlete;
  const athlete: SimpleAthlete = ageGroup === "ELEMENTARY" ? "ELEMENTARY"
    : ageGroup === "JUNIOR_HIGH" ? experience === "EXPERIENCED" ? "JUNIOR_HIGH" : "JUNIOR_HIGH_BEGINNER"
      : ageGroup === "HIGH_SCHOOL" ? experience === "EXPERIENCED" ? "HIGH_SCHOOL" : "HIGH_SCHOOL_BEGINNER" : "ADULT";
  const level = trainingConditionLevel(conditions.condition);
  const state: SimpleState = level === "HOLD" ? "UNWELL" : level === "STRONG_FATIGUE" ? "VERY_TIRED" : level === "REPORTED" ? "TIRED" : "GOOD";
  return { location, straightMeters, athlete, goal: conditions.primaryGoal, state };
}
