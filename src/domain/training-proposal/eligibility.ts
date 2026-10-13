import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { trainingConditionLevel, type TrainingConditions } from "./conditions";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";

export type ExerciseEligibility = {
  eligible: boolean; reasons: string[]; section: "MOVEMENT" | "STRENGTH" | null; stage: number;
  /** Place inside the section's order (warmupProgression or strengthProgression). Like the stage, an ordering cue only. */
  progression: number;
  family: string;
};
type CatalogRow = ComposerCatalogExercise & { equipmentTags?: readonly string[] };

/**
 * Space a travelling drill may use. Bouncing and rhythm drills (stage 3+) keep a 10m stopping
 * margin before the end of the straight, the Running Engine's smallest margin; walking-pace
 * drills stop within a step and may use the whole straight. An App heuristic, not a measurement.
 */
export function trainingStopMarginMeters(stage: number): number { return stage >= 3 ? 10 : 0; }
export function trainingUsableMeters(stage: number, straightMeters: number | null): number {
  return straightMeters === null || straightMeters <= 0 ? 0 : Math.max(0, straightMeters - trainingStopMarginMeters(stage));
}
/** The shortest travel that still holds a few movement cycles. */
const minimumTravelMeters = (stage: number) => stage >= 3 ? 10 : 5;

/** A name that says the movement itself bounces or hops. */
const BOUNCING_NAME = /スキップ|弾み|弾む|跳ん|跳び|ジャンプ|ホップ|ケンケン|ケンパ|ギャロップ|バウンド/u;
const BOUNCING = /スキップ|弾み|弾む|弾ん|跳ん|跳び|跳ね|跳ぶ|はね|ジャンプ|ホップ|ケンケン|ケンパ|ギャロップ|バウンド/u;
// Mentions that rule a movement out rather than in: 「高く跳び上がらずに」「バウンドしないよう」「膝をつかない」.
const NEGATED = /(?:跳び上が|跳ね|跳|弾|はね)(?:ら|ま|ば|ませ)?(?:ず|ない)|弾みをつけ(?:ず|ない)|(?:ジャンプ|ホップ|バウンド)(?:せず|しない)|(?:膝|手)を(?:(?:地面|床)に)?つ[かけ](?:ず|ない)|座ら(?:ず|ない)/gu;
// Lying, sitting, kneeling, on all fours or in a push-up or plank position. 「膝をつま先へ」 is a
// knee cue, not kneeling, so only 膝をつい・つけ・つき count.
const ON_GROUND = /四つ這い|四つん這い|うつ伏せ|うつぶせ|仰向け|あお向け|寝て|寝た|寝転|長座|座っ|座り|座る|腰かけ|腰掛け|膝立ち|膝をつ[いけき]|膝を(?:地面|床)につ|手を(?:地面|床)につ|手をつ[いけき]|手を接地|手と両(?:足|膝)を(?:地面|床)|手とつま先で|肘をつ[いけき]|前腕をつ|腕立て(?:伏せ)?(?:の)?姿勢|プランク(?:の)?姿勢|ハイプランク|上背部を/u;

/** How a movement is done, read from its name and registered description without negated mentions. */
function movementShape(name: string, description: string) {
  const said = `${name} ${description}`.normalize("NFKC").replace(/(?:跳|は)ね(?:上|あ)げ|跳び箱/gu, "").replace(NEGATED, "");
  const bouncing = BOUNCING.test(said);
  const oneLeg = bouncing && (/ケンケン|ケンパ/u.test(name) || /片(?:脚|足)/u.test(name) && /ジャンプ|ホップ|踏み切|弾/u.test(name)
    || /片(?:脚|足)(?:だけ)?で[^。、]{0,6}?(?:弾|ホップ|跳|踏み切)|片(?:脚|足)バネ/u.test(said));
  return { said, bouncing, oneLeg, onGround: ON_GROUND.test(said) };
}

/**
 * Place inside a 動きづくり stage, so a warm-up builds up instead of opening with bouncing:
 * 0 on the ground (lying, sitting, on all fours), 1 standing still, 2 walking, 3 at running pace,
 * 4 bouncing lightly, 5 skips and gallops, 6 jumps, 7 on one leg (ケンケン and other hops).
 */
export function warmupProgression(name: string, description: string, moving: boolean): number {
  const shape = movementShape(name, description);
  if (shape.bouncing) {
    return shape.oneLeg ? 7 : /スキップ|ギャロップ/u.test(name) ? 5 : /(?:軽く|小さく)(?:弾|跳|はね)|ポゴ|アンクルホップ/u.test(shape.said) ? 4 : 6;
  }
  if (shape.onGround) return 0;
  if (!moving) return 1;
  return /走(?!路)/u.test(name) || /走るリズム|走りながら|ジョグ/u.test(shape.said) ? 3 : 2;
}

/** Place inside 補強: jumps first while the legs are fresh, then standing work, and the floor (core) last. */
export function strengthProgression(name: string, description: string, jump: boolean): number {
  return jump ? 0 : movementShape(name, description).onGround ? 2 : 1;
}

/** 動きづくり order: the stage, then the place inside it. Ties keep the given order (the sort is stable). */
export function compareMovementOrder(order: { stages: Record<string, number>; progressions: Record<string, number> }, a: string, b: string): number {
  return (order.stages[a] ?? 0) - (order.stages[b] ?? 0) || (order.progressions[a] ?? 0) - (order.progressions[b] ?? 0);
}
/** 補強 order: jumps, standing, then the floor. Ties keep the given order. */
export function compareStrengthOrder(order: { progressions: Record<string, number> }, a: string, b: string): number {
  return (order.progressions[a] ?? 0) - (order.progressions[b] ?? 0);
}

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
  // A mobility drill named after its start position (「腕立て姿勢からの腕の振り上げ（胸椎回旋）」) stays mobility.
  const coreOrStrength = ["CORE", "STRENGTH"].includes(category)
    || category !== "MOBILITY" && /プランク|腹筋|腕立て|スクワット|ヒップスラスト|クランチ|ハンドプレス/u.test(name);
  const running = isRunningExerciseForV2(row) || /疾走(?:する|へ|に|し|を行|区間)|走り抜|加速へ移行|スプリント(?:へ|に)移行/u.test(description);
  const section = running ? null : coreOrStrength || highImpact || externalLoad || category === "THROW" ? "STRENGTH"
    : ["DRILL", "MOBILITY", "WARM_UP", "COOL_DOWN", "HURDLE"].includes(category) ? "MOVEMENT" : null;
  const moving = /前進|後進|歩行|歩き|歩く|進む|進み/u.test(text) || row.metricType === "DISTANCE";
  // Stage numbers provide a logical ordering cue only, never a mandatory count. A name that says the
  // movement bounces (「軽く弾みながらの腕回し」) is rhythm work even when registered as mobility:
  // a warm-up must not open with bouncing.
  const stage = /疾走姿勢|走動作へつな|スプリントへつな/u.test(description) || /叩きつけ|スイングダウン|挟み込み|シザース/u.test(name) ? 4
    : BOUNCING_NAME.test(name) ? 3
      : category === "MOBILITY" || /回旋|回し|可動域|伸ば|ストレッチ/u.test(name) ? 0
        : /スキップ|弾み|跳ん|跳び|入れ替え|挟み込み|叩きつけ/u.test(text) ? 3
          : moving ? 2 : 1;
  const progression = section === "STRENGTH" ? strengthProgression(name, row.description ?? "", category === "JUMP" || highImpact)
    : warmupProgression(name, row.description ?? "", moving);
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

  // Words that only look like equipment: 「ASRブロック」 is a transcript segment in the analysis notes,
  // 「1台につき2歩」 counts hurdles, and 「ハードル座り」 is a way of sitting.
  const needsStep = /段差|階段|縁石|低い台|台の上|台に|台や|ブロック|ステップアップ/u.test(text.replace(/ASRブロック|[0-9]+台につき/gu, ""))
    || (row.equipmentTags ?? []).some(tag => /^(台|台・段差|段差マット)$/u.test(tag));
  const needsWall = /壁/u.test(text);
  const needsHill = /坂|傾斜地|登り坂/u.test(text);
  const miniHurdle = /ミニハードル/u.test(text);
  const fullHurdle = /ハードル/u.test(text.replace(/ミニハードル|ハードル座り/gu, ""));
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
  else if (moving && trainingUsableMeters(stage, env.straightMeters) < minimumTravelMeters(stage)) reasons.push("MOVEMENT_SPACE_TOO_SHORT");
  // A registered distance is shortened to the usable straight, and the suggestion's note says so.
  // Where the distance fixes an equipment layout (hurdle or marker spacing) a shorter variant is
  // a different drill, so it is held for review instead.
  if (moving && row.defaultDistanceMeters !== null && env.straightMeters !== null && /ハードル|マーカー|コーン/u.test(text)
    && row.defaultDistanceMeters > trainingUsableMeters(stage, env.straightMeters)) {
    reasons.push("REGISTERED_DISTANCE_EXCEEDS_SPACE");
  }
  // Group only the same named movement and its parenthesized variants; unrelated
  // hip/arm drills must not become one family merely because they use the same joint.
  const movementName = name.split(/[（(]/u)[0].replace(/[\s・\-]/gu, "").toLowerCase();
  const family = `${section ?? "UNSUPPORTED"}:${movementName}`;
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], section, stage, progression, family };
}
