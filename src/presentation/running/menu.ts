/**
 * Running Prescription Engine v2 — [R10-B4B] メニュー全体（R6 集計）の表示 DTO。
 *
 * 純粋関数だけ。DB も RuleSet も読まない（application 側が評価した結果を受け取る）。
 * 数値の意味づけ（上限判定・BLOCK か否か）はここで決めない ―― domain が出した Finding をそのまま日本語にする。
 */
import type { CompetitionDayState } from "@/domain/running/aggregation/schema";
import type { SessionAggregate } from "@/domain/running/aggregation/schema";
import type { Finding } from "@/domain/running/types/findings";
import type { PLANNING_NOT_EVALUATED_REASONS } from "@/domain/running/persistence/sessionSnapshot";
import type { FindingPresentationDto } from "./dto";
import { presentFindings } from "./findings";
import { formatIntervalJa, formatNumberJa } from "./format";
import { MENU_AGGREGATION_NOT_EVALUATED_MESSAGE_JA } from "./labels";

export type MenuAggregationTotalDto = { label: string; valueLabel: string };

export type MenuAggregationDto =
  /** 走トレーニング（Running v2）の項目が無いので集計しない。 */
  | { status: "NONE" }
  | { status: "NOT_EVALUATED"; message: string }
  | {
      status: "EVALUATED";
      totals: MenuAggregationTotalDto[];
      findings: FindingPresentationDto[];
      /** 一部の値が確定していない（PARTIAL）ときの注記。 */
      completenessNote: string | null;
      /** 大会当日として評価したか／評価していないかの注記。 */
      competitionDayNote: string | null;
    };

export type StoredMenuEvaluationView =
  | { status: "SKIP" }
  | { status: "NOT_EVALUATED"; reason: (typeof PLANNING_NOT_EVALUATED_REASONS)[number] }
  | { status: "EVALUATED"; aggregate: SessionAggregate; plausibilityFindings: readonly Finding[]; competitionDay: CompetitionDayState };

const PARTIAL_NOTE_JA = "一部の項目は数値が範囲のままのため、合計も範囲で表示しています。";
const COMPETITION_DAY_NOTE_JA = "計画日は大会の期間中です。大会当日として合計を評価しています。";
const COMPETITION_DAY_UNKNOWN_NOTE_JA = "計画日が設定されていないため、大会と重なるかどうかは見ていません。";

/** 距離の合計（両端とも null のものは出さない＝「0」と言わない）。 */
function meterTotal(label: string, interval: { lower: number | null; upper: number | null }): MenuAggregationTotalDto | null {
  const valueLabel = formatIntervalJa(interval, "m");
  return valueLabel === null ? null : { label, valueLabel };
}

export function presentMenuAggregation(view: StoredMenuEvaluationView): MenuAggregationDto {
  if (view.status === "SKIP") return { status: "NONE" };
  if (view.status === "NOT_EVALUATED") {
    return { status: "NOT_EVALUATED", message: MENU_AGGREGATION_NOT_EVALUATED_MESSAGE_JA[view.reason] };
  }

  const a = view.aggregate;
  const contacts = a.plyometricContacts.lower === null && a.plyometricContacts.upper === null ? null : a.plyometricContacts;
  const totals = [
    meterTotal("走行距離の合計", a.totalRunningDistanceM),
    meterTotal("高い速度での距離", a.plannedHighSpeedExposureM),
    meterTotal("最高速度に近い距離", a.nearMaxSprintVolumeM),
    meterTotal("ロングスプリントの距離", a.longSprintVolumeM),
    meterTotal("テンポ走の距離", a.tempoVolumeM),
    meterTotal("流しの距離", a.strideVolumeM),
    contacts === null
      ? null
      : {
          label: "跳躍系の接地回数",
          valueLabel:
            contacts.lower !== null && contacts.upper !== null && contacts.lower !== contacts.upper
              ? `${formatNumberJa(contacts.lower)}〜${formatNumberJa(contacts.upper)}回`
              : `${formatNumberJa((contacts.lower ?? contacts.upper) as number)}回`,
        },
  ].filter((t): t is MenuAggregationTotalDto => t !== null);

  return {
    status: "EVALUATED",
    totals,
    findings: presentFindings([...a.findings, ...view.plausibilityFindings]),
    completenessNote: a.completeness === "PARTIAL" ? PARTIAL_NOTE_JA : null,
    competitionDayNote:
      view.competitionDay === true ? COMPETITION_DAY_NOTE_JA : view.competitionDay === "NOT_EVALUATED" ? COMPETITION_DAY_UNKNOWN_NOTE_JA : null,
  };
}
