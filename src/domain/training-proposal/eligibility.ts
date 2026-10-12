import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { trainingConditionLevel, type TrainingConditions } from "./conditions";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";

export type ExerciseEligibility = {
  eligible: boolean; reasons: string[]; section: "MOVEMENT" | "STRENGTH" | null; stage: number; family: string;
};
type CatalogRow = ComposerCatalogExercise & { equipmentTags?: readonly string[] };

/** Conservative retrieval boundary, not an exercise prescription or a suitability guarantee. */
export function assessExerciseEligibility(row: CatalogRow, conditions: TrainingConditions): ExerciseEligibility {
  const reasons: string[] = [];
  const guidance = row.videoGuidance;
  const name = row.name.normalize("NFKC");
  const description = [row.description, row.coachingPoint, ...(guidance ? [guidance.executionSummary, guidance.movementPattern,
    guidance.typicalStructure, guidance.setup, ...guidance.equipment, ...guidance.keyCues] : [])].filter(Boolean).join(" ").normalize("NFKC");
  const text = [name, description, ...row.tags, ...(row.equipmentTags ?? [])].join(" ");
  const category = row.category.toUpperCase();
  const highImpact = category === "JUMP" || /プライオ|バウンディング|爆発的|デプス|ドロップジャンプ|連続ホップ|連続跳躍|大ジャンプ|リバウンドジャンプ/u.test(text);
  // Low-amplitude rhythm jumps (pogo, rope) are distinct from bounding, drop/rebound and maximal jumps.
  const intenseImpact = highImpact && ((row.difficulty ?? 3) >= 3
    || /バウンディング|デプス|ドロップ|リバウンド|連続ホップ|連続跳躍|大ジャンプ|タック|爆発的/u.test(text));
  const externalLoad = /ダンベル|バーベル|ウェイト|ウエイト|メディシンボール|重り|加重/u.test(text);
  const coreOrStrength = ["CORE", "STRENGTH"].includes(category)
    || /プランク|腹筋|腕立て|スクワット|ヒップスラスト|クランチ|ハンドプレス/u.test(name);
  const running = isRunningExerciseForV2(row) || /疾走(?:する|へ|に|し|を行|区間)|走り抜|加速へ移行|スプリント(?:へ|に)移行/u.test(description);
  const section = running ? null : coreOrStrength || highImpact || externalLoad || category === "THROW" ? "STRENGTH"
    : ["DRILL", "MOBILITY", "WARM_UP", "COOL_DOWN", "HURDLE"].includes(category) ? "MOVEMENT" : null;
  const moving = /前進|後進|歩行|歩き|歩く|進む|進み/u.test(text) || row.metricType === "DISTANCE";
  // Stage numbers provide a logical ordering cue only, never a mandatory count.
  const stage = /疾走姿勢|走動作へつな|スプリントへつな/u.test(description) || /叩きつけ|スイングダウン|挟み込み|シザース/u.test(name) ? 4
    : category === "MOBILITY" || /回旋|回し|可動域|伸ば/u.test(name) ? 0
      : /スキップ|弾み|跳ん|跳び|入れ替え|挟み込み|叩きつけ/u.test(text) || /ジャンプ|ホップ|ケンケン|ケンパ|ギャロップ|バウンド/u.test(name) ? 3
        : moving ? 2 : 1;
  if (row.status !== "REVIEWED") reasons.push("UNREVIEWED_EXERCISE");
  if (!row.description?.trim()) reasons.push("MOVEMENT_DESCRIPTION_MISSING");
  if (running) reasons.push("RUNNING_ENGINE_ONLY");
  if (section === null && !running) reasons.push("UNSUPPORTED_EXERCISE_CATEGORY");
  const env = conditions.environment;
  const athlete = conditions.athlete;
  const state = conditions.condition;
  const level = trainingConditionLevel(state);
  if (env.flatSafe !== true || env.trafficFree !== true || env.obstacleFree !== true) reasons.push("SAFE_WORK_AREA_UNCONFIRMED");
  // An unknown surface still allows confirmed-flat, stationary work; never locomotion or landings.
  if ((env.surface === null || env.surface === "OTHER") && (moving || highImpact)) reasons.push("SURFACE_UNCONFIRMED");
  if (level === "HOLD") reasons.push("CURRENT_CONDITION_REQUIRES_REVIEW");
  if (level === "STRONG_FATIGUE") {
    // Strong fatigue keeps only low-intensity mobility/posture work. Strength and running are held.
    if (section === "STRENGTH") reasons.push("STRONG_FATIGUE_STRENGTH_HELD");
    else if (stage > 2 || (row.difficulty ?? 3) > 2 || highImpact
      || /走|ジャンプ|跳|ホップ|ケンケン|ケンパ|バウンド|スキップ|ギャロップ|ダッシュ|弾/u.test(name)) reasons.push("STRONG_FATIGUE_LOW_INTENSITY_ONLY");
  }

  const needsStep = /段差|階段|縁石|低い台|台の上|台に|台や|ブロック|ステップアップ/u.test(text)
    || (row.equipmentTags ?? []).some(tag => /^(台|台・段差|段差マット)$/u.test(tag));
  const needsWall = /壁/u.test(text);
  const needsHill = /坂|傾斜地|登り坂/u.test(text);
  const miniHurdle = /ミニハードル/u.test(text);
  const fullHurdle = /ハードル/u.test(text.replace(/ミニハードル/gu, ""));
  if (needsStep && (!env.equipment.includes("STEP") || !env.step || env.step.heightCm === null || env.step.heightCm <= 0
    || env.step.stable !== true || env.step.safe !== true)) reasons.push("STEP_DETAILS_UNCONFIRMED");
  if (needsWall && (!env.equipment.includes("WALL") || env.wallStable !== true)) reasons.push("WALL_STABILITY_UNCONFIRMED");
  if (needsHill && (!env.equipment.includes("HILL") || !env.hill || env.hill.distanceMeters === null || env.hill.distanceMeters <= 0
    || env.hill.slopePercent === null || env.hill.slopePercent <= 0 || env.hill.safe !== true)) reasons.push("HILL_DETAILS_UNCONFIRMED");
  if (miniHurdle && !env.equipment.includes("MINI_HURDLE")) reasons.push("MINI_HURDLE_UNAVAILABLE");
  if (fullHurdle && !env.equipment.includes("HURDLE")) reasons.push("HURDLE_UNAVAILABLE");
  if ((miniHurdle || fullHurdle) && (athlete.experience !== "EXPERIENCED" || athlete.supervised !== true)) reasons.push("HURDLE_USE_REQUIRES_CONFIRMED_EXPERIENCE_AND_SUPERVISION");
  if (/マーカー|コーン/u.test(text) && !env.equipment.includes("CONES")) reasons.push("CONES_UNAVAILABLE");
  const explicitOtherEquipment = env.equipment.includes("OTHER") ? env.otherEquipment.normalize("NFKC") : "";
  for (const equipment of ["マット", "ベンチ", "椅子", "なわとび", "フラットリング"] as const) {
    if (text.includes(equipment) && !explicitOtherEquipment.includes(equipment)) reasons.push(`OTHER_EQUIPMENT_UNCONFIRMED:${equipment}`);
  }
  const recognizedTags = /^(?:なし|無器具|自体重|自重|なわとび|ハードル|フラットリング|ブロック|ベンチ|マット|マーカー|ミニハードル|メディシンボール|台|台・段差|壁|椅子|段差|段差マット|段差・縁石|階段|坂|芝生|コーン)$/u;
  if ((row.equipmentTags ?? []).some(tag => !recognizedTags.test(tag.normalize("NFKC")))) reasons.push("UNKNOWN_EQUIPMENT_REQUIREMENT");
  if (externalLoad) reasons.push("EXTERNAL_LOAD_DETAILS_UNCONFIRMED");
  const landingReady = athlete.experience === "EXPERIENCED" && athlete.supervised === true && state.fatigue <= 3
    && state.soreness === "NONE" && state.health === "GOOD" && (env.surface === "TRACK" || env.surface === "GRASS");
  // Low-intensity jumps need confirmed experience and landing conditions; intense ones also need ADVANCED and post-maturity.
  if (highImpact && (!landingReady || athlete.level === "BEGINNER"
    || intenseImpact && (athlete.level !== "ADVANCED" || athlete.maturity !== "POST"))) reasons.push("HIGH_IMPACT_READINESS_UNCONFIRMED");
  if ((row.difficulty ?? 0) >= 4 && (athlete.experience !== "EXPERIENCED" || athlete.level !== "ADVANCED" || athlete.supervised !== true)) {
    reasons.push("ADVANCED_MOVEMENT_READINESS_UNCONFIRMED");
  }
  const highLoad = highImpact || externalLoad || (row.difficulty ?? 0) >= 4 || section === "STRENGTH" && (row.difficulty ?? 0) >= 3;
  if (highLoad && (state.load === "LIGHT" || state.fatigue >= 4 || state.soreness !== "NONE"
    || conditions.primaryGoal === "RECOVERY" || conditions.primaryGoal === "PRECOMP"
    || state.competitionDays !== null && state.competitionDays <= 1)) reasons.push("HIGH_LOAD_INCOMPATIBLE_WITH_CURRENT_CONDITIONS");
  if (athlete.ageGroup === "ELEMENTARY" && (row.difficulty === null || row.difficulty > 2 || athlete.supervised !== true)) reasons.push("CHILD_MOVEMENT_REQUIRES_CONFIRMED_SIMPLE_SUPERVISED_CONTENT");
  if (moving && (env.straightMeters === null || env.straightMeters <= 0)) reasons.push("MOVEMENT_SPACE_UNCONFIRMED");
  // This retrieval check cannot validate a shortened variant of the registered
  // distance. Hold it for review rather than silently authorizing that variant.
  if (moving && row.defaultDistanceMeters !== null && env.straightMeters !== null && row.defaultDistanceMeters > env.straightMeters) {
    reasons.push("REGISTERED_DISTANCE_EXCEEDS_SPACE");
  }
  // Group only the same named movement and its parenthesized variants; unrelated
  // hip/arm drills must not become one family merely because they use the same joint.
  const movementName = name.split(/[（(]/u)[0].replace(/[\s・\-]/gu, "").toLowerCase();
  const family = `${section ?? "UNSUPPORTED"}:${movementName}`;
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], section, stage, family };
}
