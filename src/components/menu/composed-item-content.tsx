import type { ComposerCatalogExercise, ExercisePlanItem } from "@/domain/menu-composition/contracts";
import { exerciseDoseState, exercisePlanValues } from "@/domain/menu-composition/contracts";
import { formatPrescription } from "@/domain/shared/prescription";
import { VIDEO_COUNTING_UNIT_LABEL } from "@/domain/exercise/video-guidance";

export function safeExerciseVideoUrl(url: string | null): string | null {
  if (!url) return null;
  try { const parsed = new URL(url); return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null; } catch { return null; }
}

/** Shared readable content independent of the editable dose controls. */
export function ComposedExerciseContent({ item, exercise, aiProposed = true }: { item: ExercisePlanItem; exercise?: ComposerCatalogExercise; aiProposed?: boolean }) {
  const video = safeExerciseVideoUrl(exercise?.videoUrl ?? null);
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{item.displayName}</h4><span className="text-xs text-slate-500">{item.type === "FREEFORM" ? "今回だけの項目" : "カタログ種目"} ・ {aiProposed ? "AIの提案（編集可）" : "手動で編集"}</span></div>
    <p className="text-sm font-semibold">今回の実施内容</p>
    <p className="text-sm font-medium" data-dose-state={exerciseDoseState(item)}>{exerciseDoseState(item) === "UNCONFIGURED" ? "量未設定" : formatPrescription(exercisePlanValues(item))}</p>
    {item.executionInstruction && <p className="whitespace-pre-wrap text-sm">実施指示：{item.executionInstruction}</p>}
    {item.plannedNote && <p className="whitespace-pre-wrap text-sm">メモ：{item.plannedNote}</p>}
    {item.type === "FREEFORM" && <p className="whitespace-pre-wrap text-xs text-slate-500">元の希望：{item.originalUserInstruction}</p>}
    {item.reason && <p className="text-xs text-slate-500">選択理由：{item.reason}</p>}
    {exercise && <details className="text-sm"><summary className="cursor-pointer">種目の基本説明（参考）</summary>
      <p className="mt-2 text-xs text-slate-500">基本説明と異なる場合は、上の「今回の実施内容」を確認してください。</p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{exercise.description || "説明未登録"}</p>
      {exercise.coachingPoint && <p className="whitespace-pre-wrap text-sm">指導ポイント：{exercise.coachingPoint}</p>}
      {exercise.commonMistake && <p className="mt-2 whitespace-pre-wrap">注意点：{exercise.commonMistake}</p>}
      {exercise.videoGuidance && <><p className="mt-2 whitespace-pre-wrap">{exercise.videoGuidance.executionSummary}</p><p>数え方：{exercise.videoGuidance.bilateralCounting || VIDEO_COUNTING_UNIT_LABEL[exercise.videoGuidance.countingUnit]}</p><p className="text-xs text-slate-500">{exercise.videoGuidance.videoAnalysisStatus === "COACH_REVIEWED" ? "コーチ確認済みの動画情報" : "AIが整理した動画情報"}</p></>}
      <a href={`/exercises/${exercise.id}`} className="text-indigo-700 underline">種目ページを見る</a>
    </details>}
    {video && <a href={video} target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-indigo-700 underline">動画を見る</a>}
  </div>;
}
