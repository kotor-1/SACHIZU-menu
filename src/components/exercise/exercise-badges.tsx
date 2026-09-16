import { Badge } from "@/components/ui";
import {
  DIFFICULTY_LABEL,
  ENERGY_SYSTEM_COLOR,
  ENERGY_SYSTEM_LABEL,
  EXERCISE_CATEGORY_COLOR,
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_PURPOSE_LABEL,
  TRACK_FIELD_EVENT_LABEL,
  TRAINING_TARGET_LABEL,
  type EnergySystem,
  type ExerciseCategory,
  type ExercisePurposeValue,
  type TrackFieldEvent,
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

export function PurposeBadge({ purpose }: { purpose: string }) {
  return (
    <Badge className="border-teal-200 bg-teal-50 text-teal-700">
      {EXERCISE_PURPOSE_LABEL[purpose as ExercisePurposeValue] ?? purpose}
    </Badge>
  );
}

export function EventBadge({ event }: { event: string }) {
  return (
    <Badge className="border-purple-200 bg-purple-50 text-purple-700">
      {TRACK_FIELD_EVENT_LABEL[event as TrackFieldEvent] ?? event}
    </Badge>
  );
}

/** 未設定なら出さない（処方側で推定するため、空欄自体は異常ではない）。 */
export function EnergySystemBadge({ energySystem }: { energySystem: string | null }) {
  if (!energySystem) return null;
  const key = energySystem as EnergySystem;
  return (
    <Badge className={ENERGY_SYSTEM_COLOR[key] ?? undefined}>
      {ENERGY_SYSTEM_LABEL[key] ?? energySystem}
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
