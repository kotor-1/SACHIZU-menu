import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { EXERCISE_CATEGORY_LABEL, EXERCISE_PURPOSE_LABEL, TRACK_FIELD_EVENT_LABEL, TRAINING_TARGET_LABEL } from "@/domain/exercise/constants";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";

export const COMPOSER_CATALOG_LIMIT = 24;
export const COMPOSER_CATALOG_CHARACTER_LIMIT = 32000;
function words(text: string) {
  const normalized = text.normalize("NFKC").toLowerCase();
  return new Set([...new Intl.Segmenter("ja", { granularity: "word" }).segment(normalized)]
    .filter((entry) => entry.isWordLike && entry.segment.length > 1).map((entry) => entry.segment));
}
function labels(values: readonly string[], mapping: Record<string, string>) {
  return values.map((value) => mapping[value] ?? value).join(" ");
}
/** Metadata retrieval limits prompt size. It does not prescribe training or invent age eligibility. */
export function selectComposerCatalog(rows: readonly ComposerCatalogExercise[], requestText: string, preferredIds: readonly string[] = []) {
  const tokens = words(requestText);
  const eligible = rows.filter((row) => row.status === "REVIEWED" && !isRunningExerciseForV2(row));
  const ranked = eligible.map((row) => {
    const metadata = [row.name, row.description, row.coachingPoint, row.tags.join(" "),
      EXERCISE_CATEGORY_LABEL[row.category as keyof typeof EXERCISE_CATEGORY_LABEL] ?? row.category,
      labels(row.purposes, EXERCISE_PURPOSE_LABEL), labels(row.events, TRACK_FIELD_EVENT_LABEL), labels(row.targets, TRAINING_TARGET_LABEL)].join(" ").normalize("NFKC").toLowerCase();
    const score = [...tokens].filter((word) => metadata.includes(word)).length;
    return { row, score: score + (preferredIds.includes(row.id) ? 1000 : 0) };
  }).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  const selected: ComposerCatalogExercise[] = [];
  let length = 0;
  for (const { row } of ranked) {
    const bounded = { ...row, description: row.description?.slice(0, 800) ?? null,
      coachingPoint: row.coachingPoint?.slice(0, 400) ?? null, commonMistake: row.commonMistake?.slice(0, 400) ?? null };
    const size = JSON.stringify(bounded).length;
    if (selected.length >= COMPOSER_CATALOG_LIMIT) break;
    if (length + size > COMPOSER_CATALOG_CHARACTER_LIMIT) continue;
    selected.push(bounded); length += size;
  }
  return selected;
}
