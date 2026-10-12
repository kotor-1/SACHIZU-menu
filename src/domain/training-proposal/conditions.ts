import { z } from "zod";

export const TRAINING_LOCATIONS = ["TRACK", "SCHOOL", "PARK", "ROAD", "INDOOR", "OTHER"] as const;
export const TRAINING_SURFACES = ["TRACK", "DIRT", "GRASS", "ASPHALT", "INDOOR", "OTHER"] as const;
export const TRAINING_EQUIPMENT = ["HILL", "STEP", "WALL", "HURDLE", "MINI_HURDLE", "CONES", "GRASS", "OTHER"] as const;
export const TRAINING_AGE_GROUPS = ["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "UNIVERSITY", "ADULT"] as const;
export const TRAINING_GOALS = ["ACCEL", "MAX_SPEED", "SPEED_ENDURANCE", "BASIC", "TECHNIQUE", "MOVEMENT", "STRENGTH", "PRECOMP", "RECOVERY"] as const;
/** Goals that the existing Running Engine can receive as a purpose. */
export const TRAINING_RUNNING_GOALS = ["ACCEL", "MAX_SPEED", "SPEED_ENDURANCE", "BASIC", "PRECOMP", "RECOVERY"] as const;
export type TrainingGoal = typeof TRAINING_GOALS[number];
export type TrainingRunningGoal = typeof TRAINING_RUNNING_GOALS[number];
export const TRAINING_LOCATION_LABELS: Record<typeof TRAINING_LOCATIONS[number], string> = {
  TRACK: "陸上競技場", SCHOOL: "学校のグラウンド", PARK: "公園・広場", ROAD: "自宅周辺・道路", INDOOR: "屋内・自宅", OTHER: "その他",
};
export const TRAINING_SURFACE_LABELS: Record<typeof TRAINING_SURFACES[number], string> = {
  TRACK: "全天候型舗装", DIRT: "土", GRASS: "芝生", ASPHALT: "アスファルト", INDOOR: "屋内床", OTHER: "その他",
};
export const TRAINING_EQUIPMENT_LABELS: Record<typeof TRAINING_EQUIPMENT[number], string> = {
  HILL: "坂道", STEP: "安定した段差・台", WALL: "手をつける安全な壁", HURDLE: "ハードル", MINI_HURDLE: "ミニハードル",
  CONES: "マーカー・コーン", GRASS: "芝生", OTHER: "その他の器具",
};
export const TRAINING_AGE_GROUP_LABELS: Record<typeof TRAINING_AGE_GROUPS[number], string> = {
  ELEMENTARY: "小学生", JUNIOR_HIGH: "中学生", HIGH_SCHOOL: "高校生", UNIVERSITY: "大学生", ADULT: "一般",
};
export const TRAINING_GOAL_LABELS: Record<TrainingGoal, string> = {
  ACCEL: "加速力向上", MAX_SPEED: "最高速度向上", SPEED_ENDURANCE: "スピード持久力向上", BASIC: "基礎走能力向上",
  TECHNIQUE: "スプリント技術改善", MOVEMENT: "動きづくり重視", STRENGTH: "筋力・パワー向上", PRECOMP: "大会前調整", RECOVERY: "低強度・回復目的",
};
const confirmed = z.boolean().nullable();
const nullableNumber = (max: number, min = 0) => z.number().finite().min(min).max(max).nullable();
/** null means unconfirmed. Missing affirmative safety/equipment facts never become available. */
export const trainingConditionsSchema = z.object({
  location: z.enum(TRAINING_LOCATIONS),
  environment: z.object({
    // null = not chosen yet. A location never implies its surface.
    straightMeters: nullableNumber(10000), surface: z.enum(TRAINING_SURFACES).nullable(),
    flatSafe: confirmed, trafficFree: confirmed, obstacleFree: confirmed,
    equipment: z.array(z.enum(TRAINING_EQUIPMENT)).max(TRAINING_EQUIPMENT.length),
    hill: z.object({ distanceMeters: nullableNumber(10000), slopePercent: nullableNumber(100), safe: confirmed }).strict().nullable(),
    step: z.object({ heightCm: nullableNumber(200), stable: confirmed, safe: confirmed }).strict().nullable(),
    wallStable: confirmed, otherEquipment: z.string().trim().max(400),
  }).strict(),
  athlete: z.object({
    ageGroup: z.enum(TRAINING_AGE_GROUPS), ageYears: z.number().int().min(6).max(100).nullable(), grade: z.string().trim().max(40),
    event: z.string().trim().min(1, "競技種目を選択してください。").max(32), experience: z.enum(["BEGINNER", "EXPERIENCED", "UNKNOWN"]),
    level: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]), maturity: z.enum(["PRE", "CIRCA", "POST", "UNKNOWN"]).nullable(),
    supervised: confirmed, familiarWithSprint: confirmed,
  }).strict(),
  goals: z.array(z.enum(TRAINING_GOALS)).min(1).max(TRAINING_GOALS.length), primaryGoal: z.enum(TRAINING_GOALS),
  condition: z.object({
    fatigue: z.number().int().min(1).max(10), soreness: z.enum(["NONE", "MILD", "STRONG"]),
    pain: z.enum(["NONE", "PRESENT"]), painDetails: z.string().trim().max(400), health: z.enum(["GOOD", "FAIR", "POOR"]),
    hoursSinceHighIntensity: nullableNumber(10000), hoursUntilNextHighIntensity: nullableNumber(10000),
    highIntensitySessionsLast7Days: z.number().int().min(0).max(30).nullable(),
    competitionDays: z.number().int().min(0).max(730).nullable(), load: z.enum(["LIGHT", "NORMAL", "HIGH"]),
    speedEnduranceMode: z.enum(["SPRINT_SPECIFIC", "CONTROLLED_90_95"]).nullable().optional(),
    referenceDistanceMeters: z.number().int().positive().max(400).nullable().optional(),
    referenceTimeSeconds: z.number().finite().positive().max(300).nullable().optional(),
  }).strict(),
  notes: z.string().trim().max(2000),
}).strict().superRefine((value, context) => {
  if (value.environment.surface === null) context.addIssue({ code: "custom", path: ["environment", "surface"], message: "路面を選択してください。" });
  if (!value.goals.includes(value.primaryGoal)) context.addIssue({ code: "custom", path: ["primaryGoal"], message: "主目的を選択した目的に含めてください。" });
  if (new Set(value.goals).size !== value.goals.length) context.addIssue({ code: "custom", path: ["goals"], message: "目的が重複しています。" });
  if (new Set(value.environment.equipment).size !== value.environment.equipment.length) context.addIssue({ code: "custom", path: ["environment", "equipment"], message: "設備が重複しています。" });
  if (value.condition.pain === "PRESENT" && !value.condition.painDetails) context.addIssue({ code: "custom", path: ["condition", "painDetails"], message: "痛みのある部位・状況を入力してください。" });
});
export type TrainingConditions = z.infer<typeof trainingConditionsSchema>;
export const DEFAULT_TRAINING_CONDITIONS: TrainingConditions = {
  location: "TRACK",
  environment: { straightMeters: null, surface: null, flatSafe: null, trafficFree: null, obstacleFree: null,
    equipment: [], hill: null, step: null, wallStable: null, otherEquipment: "" },
  athlete: { ageGroup: "HIGH_SCHOOL", ageYears: null, grade: "", event: "100m", experience: "UNKNOWN", level: "BEGINNER",
    maturity: null, supervised: null, familiarWithSprint: null },
  goals: ["ACCEL"], primaryGoal: "ACCEL",
  condition: { fatigue: 1, soreness: "NONE", pain: "NONE", painDetails: "", health: "GOOD", hoursSinceHighIntensity: null,
    hoursUntilNextHighIntensity: null, highIntensitySessionsLast7Days: null, competitionDays: null, load: "NORMAL", speedEnduranceMode: null,
    referenceDistanceMeters: null, referenceTimeSeconds: null },
  notes: "",
};

const isRunningGoal = (goal: TrainingGoal): goal is TrainingRunningGoal => (TRAINING_RUNNING_GOALS as readonly string[]).includes(goal);
/**
 * The purpose sent to the Running Engine: the primary goal when it is a running goal,
 * otherwise the first selected running goal. Other running goals are never merged in.
 */
export function trainingRunningGoal(conditions: Pick<TrainingConditions, "goals" | "primaryGoal">): TrainingRunningGoal | null {
  if (isRunningGoal(conditions.primaryGoal)) return conditions.primaryGoal;
  return conditions.goals.find(isRunningGoal) ?? null;
}

/**
 * App hold levels (not a physiological conversion of the 1-10 scale):
 * HOLD = pain or poor health, nothing is proposed until a person checks;
 * STRONG_FATIGUE = only low-intensity movement, running and strength are held;
 * REPORTED = high-intensity running is held and doses are reduced.
 */
export type TrainingConditionLevel = "HOLD" | "STRONG_FATIGUE" | "REPORTED" | "NONE";
export function trainingConditionLevel(condition: TrainingConditions["condition"]): TrainingConditionLevel {
  if (condition.pain === "PRESENT" || condition.health === "POOR") return "HOLD";
  if (condition.fatigue >= 7 || condition.soreness === "STRONG") return "STRONG_FATIGUE";
  if (condition.fatigue >= 4 || condition.soreness === "MILD" || condition.health === "FAIR") return "REPORTED";
  return "NONE";
}

/** Conservative proposal volume, shared by suggestions and the content gate. Never lowers running intensity. */
export function trainingReducedLoad(conditions: TrainingConditions): boolean {
  const c = conditions.condition;
  return conditions.primaryGoal === "RECOVERY" || conditions.primaryGoal === "PRECOMP" || c.load === "LIGHT" || c.fatigue >= 4
    || c.soreness !== "NONE" || (c.competitionDays !== null && c.competitionDays <= 2) || conditions.athlete.experience !== "EXPERIENCED";
}
