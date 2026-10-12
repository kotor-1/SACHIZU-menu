import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { EXERCISE_CATEGORY_LABEL, EXERCISE_PURPOSE_LABEL, TRACK_FIELD_EVENT_LABEL, TRAINING_TARGET_LABEL } from "@/domain/exercise/constants";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";

export const COMPOSER_CATALOG_LIMIT = 24;
export const COMPOSER_CATALOG_CHARACTER_LIMIT = 32000;
export const COMPOSER_CATALOG_ROLES = ["INTRO", "MOBILITY", "TECHNIQUE", "SUPPORT", "CLOSING"] as const;
export type ComposerCatalogRole = typeof COMPOSER_CATALOG_ROLES[number];
export type ComposerCatalogContext = { event?: string; availableTimeSeconds?: number };

/** Retrieval hints from registered movements, not prescribed phases or suitability guarantees. */
export function composerCatalogRoles(row: ComposerCatalogExercise): ComposerCatalogRole[] {
  if (row.status !== "REVIEWED" || isRunningExerciseForV2(row)) return [];
  const category = row.category.normalize("NFKC").toUpperCase();
  const movement = [row.name, row.description].filter(Boolean).join(" ").normalize("NFKC");
  const roles: ComposerCatalogRole[] = [];
  const hasMovement = Boolean(row.description?.trim());
  const walking = /歩行|ウォーク|ウォーキング|歩く|歩き|足踏み|軽く弾み/u.test(movement);
  const runningMovement = /走/u.test(row.name) || /疾走|助走|スプリント.*移行|加速へ移行|走り出|走り抜/u.test(movement);
  const explosiveOrRunning = runningMovement || /ジャンプ|ホップ|跳躍|爆発的/u.test(movement);
  if (category === "WARM_UP" || (hasMovement && ["MOBILITY", "DRILL"].includes(category) && walking && !explosiveOrRunning)) roles.push("INTRO");
  if (hasMovement && category === "MOBILITY") roles.push("MOBILITY");
  if (hasMovement && !runningMovement && ["DRILL", "HURDLE"].includes(category)
    && (row.targets.includes("TECHNIQUE") || row.purposes.some(value => ["TECHNIQUE", "GROUND_CONTACT", "ARM_SWING", "RHYTHM", "POSTURE"].includes(value)))) roles.push("TECHNIQUE");
  if (hasMovement && ["CORE", "STRENGTH"].includes(category)) roles.push("SUPPORT");
  // A slow floor/joint movement can be considered for closing even when the
  // catalog has no COOL_DOWN category. This never changes its registered category.
  const controlledMovement = /ゆっくり|保持|呼吸|伸張/u.test(movement);
  const movingThroughSpace = /前進|後進|歩行|歩き|進み|足踏み/u.test(movement);
  if (category === "COOL_DOWN" || (hasMovement && category === "MOBILITY" && controlledMovement && !movingThroughSpace && !explosiveOrRunning)) roles.push("CLOSING");
  return roles;
}

function boundedCatalogRow(row: ComposerCatalogExercise): ComposerCatalogExercise {
  return { ...row, description: row.description?.slice(0, 800) ?? null,
    coachingPoint: row.coachingPoint?.slice(0, 400) ?? null, commonMistake: row.commonMistake?.slice(0, 400) ?? null };
}
function words(text: string) {
  const normalized = text.normalize("NFKC").toLowerCase();
  return new Set([...new Intl.Segmenter("ja", { granularity: "word" }).segment(normalized)]
    .filter((entry) => entry.isWordLike && entry.segment.length > 1).map((entry) => entry.segment));
}
function labels(values: readonly string[], mapping: Record<string, string>) {
  return values.map((value) => mapping[value] ?? value).join(" ");
}
function catalogMetadata(row: ComposerCatalogExercise) {
  return [row.name, row.description, row.coachingPoint, row.tags.join(" "),
    EXERCISE_CATEGORY_LABEL[row.category as keyof typeof EXERCISE_CATEGORY_LABEL] ?? row.category,
    labels(row.purposes, EXERCISE_PURPOSE_LABEL), labels(row.events, TRACK_FIELD_EVENT_LABEL), labels(row.targets, TRAINING_TARGET_LABEL)]
    .join(" ").normalize("NFKC").toLowerCase();
}
type RankedExercise = { row: ComposerCatalogExercise; score: number; isPreferred: boolean };

function diversifyByRegisteredCategory(rows: readonly RankedExercise[], supplementalMobility: readonly RankedExercise[] = []): RankedExercise[] {
  const preferred = rows.filter(candidate => candidate.isPreferred);
  const remaining = rows.filter(candidate => !candidate.isPreferred);
  const relevant = remaining.filter(({ score }) => score > 0);
  const relevantCategories = new Set(preferred.map(({ row }) => row.category.normalize("NFKC").toUpperCase()));
  const firstRelevantByCategory: RankedExercise[] = [];
  for (const candidate of relevant) {
    const category = candidate.row.category.normalize("NFKC").toUpperCase();
    if (relevantCategories.has(category)) continue;
    relevantCategories.add(category);
    firstRelevantByCategory.push(candidate);
  }
  const firstRelevantIds = new Set(firstRelevantByCategory.map(({ row }) => row.id));
  const supplementalIds = new Set(supplementalMobility.map(({ row }) => row.id));
  const relevantRemainder = relevant.filter(({ row }) => !firstRelevantIds.has(row.id) && !supplementalIds.has(row.id));
  // Keep unmatched candidates in their original deterministic rank order. Do
  // not promote unrelated catalog entries just to make the prompt look varied.
  const unmatched = remaining.filter(({ score, row }) => score === 0 && !supplementalIds.has(row.id));
  return [...preferred, ...firstRelevantByCategory, ...supplementalMobility.filter(({ row }) => !firstRelevantIds.has(row.id)), ...relevantRemainder, ...unmatched];
}

function isRunningSessionRequest(requestText: string) {
  const text = requestText.normalize("NFKC").toLowerCase();
  return /短距離|陸上|スプリント|走|\b(?:60|80|100|200|400|800)\s?m\b/.test(text);
}

/** Mobility rows can supply warm-up/closing options in a running session. This is retrieval only. */
function isRunningRelevantMobility(row: ComposerCatalogExercise) {
  if (row.category.normalize("NFKC").toUpperCase() !== "MOBILITY") return false;
  const runningContext = row.events.some(value => ["SPRINT", "COMMON"].includes(value.toUpperCase()))
    || row.purposes.some(value => ["MOBILITY", "HIP_JOINT", "POSTURE", "BALANCE"].includes(value.toUpperCase()))
    || row.targets.some(value => ["MOBILITY", "TECHNIQUE", "COORDINATION"].includes(value.toUpperCase()));
  if (!runningContext) return false;
  const description = [row.name, row.description, row.coachingPoint].filter(Boolean).join(" ").normalize("NFKC");
  return /歩き|進み|回し|回旋|足踏み|伸ば|姿勢|ゆっくり|保持|動かし/.test(description);
}

function diversifyRunningSession(rows: readonly RankedExercise[]): RankedExercise[] {
  const mobility = rows.filter(({ row }) => isRunningRelevantMobility(row));
  const chosen: RankedExercise[] = [];
  const addFirst = (matches: (candidate: RankedExercise) => boolean) => {
    const candidate = mobility.find(row => !chosen.some(selected => selected.row.id === row.row.id) && matches(row));
    if (candidate) chosen.push(candidate);
  };
  // Prefer distinct registered movement roles instead of three arbitrary IDs.
  addFirst(({ row }) => /歩き|進み|足踏み|キック|弾み/.test([row.name, row.description].filter(Boolean).join(" ").normalize("NFKC")));
  addFirst(({ row }) => /ゆっくり|呼吸|保持|戻す|無理のない/.test([row.name, row.description, row.coachingPoint].filter(Boolean).join(" ").normalize("NFKC")));
  addFirst(({ row }) => /股関節|胸椎|背骨|骨盤/.test([row.name, row.description].filter(Boolean).join(" ").normalize("NFKC")));
  for (const candidate of mobility) {
    if (chosen.length >= 3) break;
    if (!chosen.some(selected => selected.row.id === candidate.row.id)) chosen.push(candidate);
  }
  const preferredMobilityIds = new Set(rows.filter(({ row, isPreferred }) => isPreferred && row.category.toUpperCase() === "MOBILITY").map(({ row }) => row.id));
  const hasMobilityRepresentative = !rows.some(({ row, isPreferred }) => isPreferred && row.category.toUpperCase() === "MOBILITY")
    && rows.some(({ row, score, isPreferred }) => !isPreferred && score > 0 && row.category.toUpperCase() === "MOBILITY");
  const quota = Math.max(0, 3 - preferredMobilityIds.size - Number(hasMobilityRepresentative));
  return diversifyByRegisteredCategory(rows, chosen.filter(({ row }) => !preferredMobilityIds.has(row.id)).slice(0, quota));
}

function contextEvent(event: string | undefined, requestText: string): string | null {
  const text = (event ?? requestText).normalize("NFKC").toLowerCase();
  if (/ハードル|\b(?:100|110|400)\s?mh\b/u.test(text)) return "HURDLE";
  if (/中長距離|\b(?:800|1500|3000|5000|10000)\s?m\b/u.test(text)) return "MIDDLE_DISTANCE";
  if (/短距離|スプリント|\b(?:60|80|100|200|400)\s?m\b/u.test(text)) return "SPRINT";
  return null;
}

/** Reserve alternatives for movement roles before filling the same bounded prompt. */
function selectWholeSessionCatalog(rows: readonly RankedExercise[], requestText: string, context: ComposerCatalogContext) {
  const event = contextEvent(context.event, requestText);
  const contextWords = new Set(["です", "ます", "ため", "たい", "したら", "向け", "少し", "一番", "高校生", "中学生", "小学生", "週末", "来週", "試合", "メニュー", "練習"]);
  const contentWords = [...words(requestText)].filter(word => !contextWords.has(word) && !/^\d+(?:m|分|秒|回)?$/u.test(word));
  const eventScore = (row: ComposerCatalogExercise) => event === null ? 0
    : Number(row.events.includes(event) || row.events.includes("COMMON"));
  const ranked = rows.map(candidate => ({ ...candidate, score: contentWords.filter(word => catalogMetadata(candidate.row).includes(word)).length }))
    .sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred)
    || eventScore(b.row) - eventScore(a.row) || b.score - a.score
    || Number(b.row.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED") - Number(a.row.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED")
    || Number(Boolean(b.row.description?.trim())) - Number(Boolean(a.row.description?.trim()))
    || a.row.name.normalize("NFKC").localeCompare(b.row.name.normalize("NFKC"), "ja") || a.row.id.localeCompare(b.row.id));
  // Unknown event metadata is not an eligibility exclusion. Explicit matches
  // remain first; known unrelated events do not consume the role reservations.
  const relevant = ranked.filter(({ row, score }) => event === null ? score > 0 || composerCatalogRoles(row).length > 0
    : eventScore(row) > 0 || (row.events.length === 0 && score > 0));
  const selected: ComposerCatalogExercise[] = [];
  const selectedIds = new Set<string>();
  const selectedNames = new Set<string>();
  let length = 2; // JSON array brackets; commas are counted on insertion.
  const normalizedName = (row: ComposerCatalogExercise) => row.name.normalize("NFKC").toLowerCase().replace(/\s/gu, "");
  const add = (candidate: RankedExercise, allowRepeatedName = false) => {
    if (selected.length >= COMPOSER_CATALOG_LIMIT || selectedIds.has(candidate.row.id)) return false;
    if (!allowRepeatedName && selectedNames.has(normalizedName(candidate.row))) return false;
    const bounded = boundedCatalogRow(candidate.row);
    const size = JSON.stringify(bounded).length + Number(selected.length > 0);
    if (length + size > COMPOSER_CATALOG_CHARACTER_LIMIT) return false;
    selected.push(bounded); selectedIds.add(bounded.id); selectedNames.add(normalizedName(bounded)); length += size;
    return true;
  };
  for (const candidate of ranked.filter(row => row.isPreferred)) add(candidate, true);
  const reserved = new Map(COMPOSER_CATALOG_ROLES.map(role => [role,
    selected.filter(row => composerCatalogRoles(row).includes(role)).length]));
  const movementFamily = (row: ComposerCatalogExercise) => {
    const movement = [row.name, row.description].join(" ");
    if (/胸椎|背骨|背中/u.test(movement)) return "SPINE";
    if (row.purposes.includes("HIP_JOINT") || /股関節/u.test(row.name)) return "HIP";
    if (row.purposes.includes("ANKLE_JOINT") || /足首|かかと/u.test(row.name)) return "ANKLE";
    if (row.purposes.includes("ARM_SWING") || /腕回し/u.test(row.name)) return "ARM";
    return row.category + row.metricType;
  };
  const roleCandidates = (role: ComposerCatalogRole) => {
    const usedMetrics = new Set(selected.filter(row => composerCatalogRoles(row).includes(role)).map(row => row.metricType));
    const usedFamilies = new Set(selected.filter(row => composerCatalogRoles(row).includes(role)).map(movementFamily));
    const stationary = (row: ComposerCatalogExercise) => /その場|静止|軌道を確認/u.test([row.name, row.description].join(" "));
    return relevant.filter(({ row }) => composerCatalogRoles(row).includes(role)).sort((a, b) => b.score - a.score
      || (role === "SUPPORT" ? Number(usedMetrics.has(a.row.metricType)) - Number(usedMetrics.has(b.row.metricType)) : 0)
      || (["INTRO", "MOBILITY", "CLOSING"].includes(role) ? Number(usedFamilies.has(movementFamily(a.row))) - Number(usedFamilies.has(movementFamily(b.row))) : 0)
      || (role === "TECHNIQUE" ? Number(composerCatalogRoles(a.row).includes("INTRO")) - Number(composerCatalogRoles(b.row).includes("INTRO"))
        || Number(event !== "HURDLE" && a.row.category === "HURDLE") - Number(event !== "HURDLE" && b.row.category === "HURDLE")
        || Number(stationary(b.row)) - Number(stationary(a.row)) : 0)
      || Number(b.row.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED") - Number(a.row.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED")
      || (a.row.difficulty ?? 99) - (b.row.difficulty ?? 99));
  };
  // Two alternatives per available role improve the model's choice. They are
  // not minimum exercise counts, fixed phases, or additional training volume.
  for (let alternatives = 1; alternatives <= 2; alternatives++) {
    for (const role of COMPOSER_CATALOG_ROLES) {
      if ((reserved.get(role) ?? 0) >= alternatives) continue;
      for (const candidate of roleCandidates(role)) {
        if (add(candidate)) { reserved.set(role, (reserved.get(role) ?? 0) + 1); break; }
      }
    }
  }
  // Continue balancing the available roles. Registered jumps/throws and other
  // unmatched categories are not promoted merely to make the catalog diverse.
  const roleRows = COMPOSER_CATALOG_ROLES.map(roleCandidates);
  for (let index = 0; roleRows.some(group => index < group.length); index++) {
    for (const group of roleRows) if (group[index]) add(group[index]);
  }
  for (const candidate of ranked) add(candidate);
  for (const candidate of ranked) add(candidate, true);
  return selected;
}

/** Metadata retrieval limits prompt size. It does not prescribe training or invent age eligibility. */
export function selectComposerCatalog(rows: readonly ComposerCatalogExercise[], requestText: string, preferredIds: readonly string[] = [], context: ComposerCatalogContext = {}) {
  const tokens = words(requestText);
  const eligible = rows.filter((row) => row.status === "REVIEWED" && !isRunningExerciseForV2(row));
  const ranked = eligible.map((row) => {
    const metadata = catalogMetadata(row);
    const score = [...tokens].filter((word) => metadata.includes(word)).length;
    return { row, score, isPreferred: preferredIds.includes(row.id) };
  }).sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred) || b.score - a.score || a.row.id.localeCompare(b.row.id));
  const normalizedRequest = requestText.normalize("NFKC");
  const focusedRequest = /(?:走(?:練習)?|補強|体幹|筋力|ストレッチ|ドリル)(?:だけ|のみ)(?!でなく|ではなく)/u.test(normalizedRequest)
    || eligible.some(({ name }) => {
      const registeredName = name.normalize("NFKC").split(/[（(]/u)[0].trim();
      const index = registeredName ? normalizedRequest.indexOf(registeredName) : -1;
      return index >= 0 && /^(?:だけ|のみ)(?!でなく|ではなく)/u.test(normalizedRequest.slice(index + registeredName.length));
    });
  if ((context.availableTimeSeconds ?? 0) >= 3600 && !focusedRequest) return selectWholeSessionCatalog(ranked, requestText, context);
  const selected: ComposerCatalogExercise[] = [];
  let length = 0;
  // Keep explicit interpreter matches first. For the rest, surface one item from
  // each relevant registered category before repeating a category. Unmatched
  // catalog entries keep their prior deterministic order. This adds variety without inventing
  // phase eligibility or overriding request-specific matches.
  const diverseRanked = isRunningSessionRequest(requestText)
    ? diversifyRunningSession(ranked)
    : diversifyByRegisteredCategory(ranked);
  for (const { row } of diverseRanked) {
    const bounded = boundedCatalogRow(row);
    const size = JSON.stringify(bounded).length;
    if (selected.length >= COMPOSER_CATALOG_LIMIT) break;
    if (length + size > COMPOSER_CATALOG_CHARACTER_LIMIT) continue;
    selected.push(bounded); length += size;
  }
  return selected;
}
