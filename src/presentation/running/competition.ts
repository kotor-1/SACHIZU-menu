import {
  COMPETITION_PRIORITIES,
  competitionPrioritySchema,
  isoDateSchema,
  type CompetitionPriority,
} from "@/domain/running/types/primitives";
import type { CompetitionLoadCategories } from "@/domain/running/persistence/sessionSnapshot";
import { readCompetitionLoadCategories } from "@/domain/running/persistence/sessionSnapshot";

export const COMPETITION_PRIORITY_LABEL_JA = {
  TRAINING_MEET: "記録会・練習試合",
  NORMAL: "通常大会",
  IMPORTANT: "重要大会",
  PEAK: "最重要大会",
} as const satisfies Record<CompetitionPriority, string>;

type CompetitionPresentationSource = {
  id: string;
  name: string;
  date: Date;
  endDate: Date | null;
  priority: string;
  note: string | null;
};

export type CompetitionViewDto = {
  id: string;
  name: string;
  date: string;
  endDate: string | null;
  dateLabel: string;
  priority: CompetitionPriority;
  priorityLabel: string;
  note: string | null;
};

function dateParts(value: string): { year: number; month: number; day: number } {
  const iso = isoDateSchema.parse(value);
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

export function formatCompetitionDate(value: string): string {
  const { year, month, day } = dateParts(value);
  return `${year}年${month}月${day}日`;
}

export function formatCompetitionDateRange(start: string, end: string | null): string {
  if (end === null || end === start) return formatCompetitionDate(start);
  const from = dateParts(start);
  const to = dateParts(end);
  if (from.year !== to.year) return `${formatCompetitionDate(start)}〜${formatCompetitionDate(end)}`;
  if (from.month !== to.month) return `${formatCompetitionDate(start)}〜${to.month}月${to.day}日`;
  return `${formatCompetitionDate(start)}〜${to.day}日`;
}

/** DBのUTC 0:00 date-onlyをlocal timezoneで再解釈しない。 */
export function competitionDateFromDb(value: Date): string {
  return isoDateSchema.parse(value.toISOString().slice(0, 10));
}

export function presentCompetition(row: CompetitionPresentationSource): CompetitionViewDto {
  const priority = competitionPrioritySchema.parse(row.priority);
  const date = competitionDateFromDb(row.date);
  const endDate = row.endDate === null ? null : competitionDateFromDb(row.endDate);
  return {
    id: row.id,
    name: row.name,
    date,
    endDate,
    dateLabel: formatCompetitionDateRange(date, endDate),
    priority,
    priorityLabel: COMPETITION_PRIORITY_LABEL_JA[priority],
    note: row.note,
  };
}

export const COMPETITION_PRIORITY_OPTIONS = COMPETITION_PRIORITIES.map((value) => ({
  value,
  label: COMPETITION_PRIORITY_LABEL_JA[value],
}));

export const COMPETITION_LOAD_CATEGORY_LABEL_JA = {
  RACE: "個人種目",
  RELAY: "リレー",
} as const satisfies Record<CompetitionLoadCategories[number], string>;

export function competitionLoadCategoriesLabel(categories: CompetitionLoadCategories): string {
  return categories.map((category) => COMPETITION_LOAD_CATEGORY_LABEL_JA[category]).join("・");
}

export type CompetitionSessionViewDto = {
  id: string;
  date: string;
  dateLabel: string;
  status: string;
  categories: CompetitionLoadCategories | null;
  categoriesLabel: string;
};

export function presentCompetitionSession(row: {
  id: string;
  date: Date;
  status: string;
  planningSnapshotJson: string | null;
}): CompetitionSessionViewDto {
  const date = competitionDateFromDb(row.date);
  const read = readCompetitionLoadCategories(row.planningSnapshotJson);
  const categories = read.kind === "RESOLVED" ? read.categories : null;
  return {
    id: row.id,
    date,
    dateLabel: formatCompetitionDate(date),
    status: row.status,
    categories,
    categoriesLabel: categories === null ? "参加種別を確認できません" : competitionLoadCategoriesLabel(categories),
  };
}
