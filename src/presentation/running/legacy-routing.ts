/**
 * Running Prescription Engine v2 — [R10-B4B] legacy 種目を Running v2 へ案内するかどうか（表示の判断だけ）。
 *
 * 走系かどうかは**既存の分類 API**（`src/domain/prescription/classify.ts`）で決める。
 * 種目名や category の文字列リストをここで新しく作らない（legacy 側の分類が変われば自動で追従する）。
 *
 * legacy の処方ロジック（`src/domain/prescription/`）自体は変更しない。ここがやるのは
 * 「走系の種目では legacy の『推奨処方を入れる』を出さず、Running v2 の導線を案内する」だけ。
 */
import { classify, type ClassifiableExercise } from "@/domain/prescription/classify";
import { HIGH_INTENSITY_RUN_KINDS, type PrescriptionKind } from "@/domain/prescription/constants";

/**
 * Running v2 で扱う処方タイプ。高強度の走（加速 / 最高速 / スピード持久）に、
 * 走行量として扱うテンポ・持久を足したもの。どれも既存 enum の値で、ここで新しい分類を作っていない。
 */
export const RUNNING_V2_ROUTED_KINDS: readonly PrescriptionKind[] = [...HIGH_INTENSITY_RUN_KINDS, "TEMPO_AEROBIC"];

export function isRunningKindForV2(kind: PrescriptionKind): boolean {
  return RUNNING_V2_ROUTED_KINDS.includes(kind);
}

/** 走系の種目か（Exercise の知識だけで判断する。MenuItem の値は見ない）。 */
export function isRunningExerciseForV2(exercise: ClassifiableExercise): boolean {
  return isRunningKindForV2(classify(exercise));
}

/**
 * 走系の種目を legacy フォームで選んだときの案内。
 * 「使用禁止」ではなく「走トレーニングとして追加すると、根拠つきの処方になる」と伝える。
 */
export const LEGACY_RUNNING_SUGGESTION_NOTICE_JA =
  "走る種目は「＋ 走トレーニングを追加」から作ると、練習の型・強度の基準・確認事項つきの処方になります。ここでの入力もこれまでどおり保存できます。";
