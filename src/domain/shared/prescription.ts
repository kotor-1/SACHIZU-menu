import type { MetricType } from "@/domain/exercise/constants";

/**
 * 「負荷の処方」を表す値オブジェクト。
 *
 * DB 上は各テーブルが別々の列名で持つ（Exercise は default*、
 * MenuItem は素の名前、SessionItem は planned* / actual*）が、
 * アプリ内では常にこの型に正規化して扱う。
 * 表示・集計ロジックを 1 箇所に集約するのが目的。
 */
export type Prescription = {
  sets?: number | null;
  reps?: number | null;
  distanceMeters?: number | null;
  durationSeconds?: number | null;
  restSeconds?: number | null;
  intensityPercent?: number | null;
  loadKg?: number | null;
};

export const EMPTY_PRESCRIPTION: Prescription = {};

/** 何らかの値が入っているか。 */
export function hasPrescription(p: Prescription | null | undefined): boolean {
  if (!p) return false;
  return Object.values(p).some((v) => v !== null && v !== undefined);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
}

function formatDistance(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toString().replace(/\.0$/, "")}km`
    : `${meters}m`;
}

/**
 * 処方を人が読む 1 行に整形する。
 * 例: "3set × 30m @90% / レスト 2分"
 * perSideReps のときは回数が片側ごとの値であることを「片側15回」と明示する。
 */
export function formatPrescription(p: Prescription | null | undefined, options: { perSideReps?: boolean } = {}): string {
  if (!hasPrescription(p) || !p) return "";

  // 「何を」の部分（回数 / 距離 / 時間）
  const unit: string[] = [];
  if (p.reps != null) unit.push(`${options.perSideReps ? "片側" : ""}${p.reps}回`);
  if (p.distanceMeters != null) unit.push(formatDistance(p.distanceMeters));
  if (p.durationSeconds != null) unit.push(formatDuration(p.durationSeconds));

  const main: string[] = [];
  if (p.sets != null) main.push(`${p.sets}set`);
  if (unit.length > 0) main.push(unit.join(" "));

  let head = main.join(" × ");
  if (p.loadKg != null) head += `${head ? " " : ""}${p.loadKg}kg`;
  if (p.intensityPercent != null) head += `${head ? " " : ""}@${p.intensityPercent}%`;

  const tail: string[] = [];
  if (p.restSeconds != null) tail.push(`レスト ${formatDuration(p.restSeconds)}`);

  return [head, tail.join(" ")].filter(Boolean).join(" / ");
}

/**
 * 種目の metricType に応じて、入力フォームで見せるべき数値項目を返す。
 * 「距離で測る種目に回数欄を出さない」ための単純な出し分け。
 */
export function fieldsForMetric(
  metric: MetricType,
): Array<keyof Prescription> {
  const common: Array<keyof Prescription> = ["sets", "restSeconds"];
  switch (metric) {
    case "DISTANCE":
      return [...common, "distanceMeters", "intensityPercent"];
    case "TIME":
      return [...common, "durationSeconds", "intensityPercent"];
    case "REPS":
    default:
      return [...common, "reps", "loadKg"];
  }
}

/**
 * 所要時間のざっくり見積り（秒）。
 * メニューの「想定所要時間」を自動計算するために使う。
 * 実施時間が不明な項目は 1 セットあたり 45 秒として概算する。
 */
const ASSUMED_WORK_SECONDS = 45;

export function estimateSeconds(p: Prescription | null | undefined): number {
  if (!p) return 0;
  const sets = p.sets ?? 1;
  const workPerSet = p.durationSeconds ?? ASSUMED_WORK_SECONDS;
  const restPerSet = p.restSeconds ?? 0;
  return sets * workPerSet + Math.max(0, sets - 1) * restPerSet;
}
