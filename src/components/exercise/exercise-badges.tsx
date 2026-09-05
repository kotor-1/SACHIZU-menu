import { Badge } from "@/components/ui";
import {
  DIFFICULTY_LABEL,
  EXERCISE_CATEGORY_COLOR,
  EXERCISE_CATEGORY_LABEL,
  TRAINING_TARGET_LABEL,
  type ExerciseCategory,
  type TrainingTarget,
} from "@/domain/exercise/constants";
import { REVIEW_STATUS_LABEL, type ReviewStatus } from "@/domain/shared/constants";

export function CategoryBadge({ category }: { category: string }) {
  const key = category as ExerciseCategory;
  return (
    <Badge className={EXERCISE_CATEGORY_COLOR[key] ?? undefined}>
      {EXERCISE_CATEGORY_LABEL[key] ?? category}
    </Badge>
  );
}

export function TargetBadge({ target }: { target: string }) {
  return (
    <Badge className="border-slate-200 bg-white text-slate-600">
      {TRAINING_TARGET_LABEL[target as TrainingTarget] ?? target}
    </Badge>
  );
}

export function DifficultyBadge({ level }: { level: number }) {
  return (
    <Badge className="border-slate-200 bg-slate-50 text-slate-600">
      <span className="text-amber-500">{"★".repeat(level)}</span>
      <span className="ml-1 text-slate-500">{DIFFICULTY_LABEL[level] ?? ""}</span>
    </Badge>
  );
}

/** 確認済みは既定なのでバッジを出さない（画面のノイズを減らす）。 */
export function StatusBadge({ status }: { status: string }) {
  if (status === "REVIEWED") return null;
  const cls =
    status === "DRAFT"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-slate-200 bg-slate-100 text-slate-500";
  return <Badge className={cls}>{REVIEW_STATUS_LABEL[status as ReviewStatus] ?? status}</Badge>;
}
