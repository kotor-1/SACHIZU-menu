/**
 * Running Prescription Engine v2 — derivePrescriptionConfidence()（§5.4）。
 *
 * 純粋関数。R1 時点では実際の RuleSet / Envelope が存在しないため、
 * synthetic な入力（テストで組み立てた配列）で検証する。
 *
 * §5.4 の判定表を**上から順に最初に該当した条件**で適用する:
 *   1. 使用した数値フィールドの evidence がすべて ENGINE_POLICY → POLICY_ONLY
 *   2. いずれかの directness = INDIRECT、または inputData ∈ {LOW, NONE}、
 *      または 72h 履歴カバレッジ = NONE → LOW
 *      （`NOT_EVALUATED` は NONE ではないため、この条件を満たさない。中立）
 *   3. いずれかが PARTIAL、または inputData = MEDIUM、または
 *      evidence が SECONDARY_REPORT_ONLY のみ → MODERATE
 *   4. それ以外 → HIGH
 */
import type { Directness, InputDataConfidence, PrescriptionConfidence } from "../types/prescription";
import type { EvidenceVerification, SourceType } from "./schema";

export type UsedEvidenceSummary = {
  sourceType: SourceType;
  verification: EvidenceVerification;
  directness: Directness;
};

/**
 * [R4 integration errata] `NOT_EVALUATED` = 週次・履歴評価（§9.2 step 5 / §12）が
 * まだ接続されていない状態。**中立**として扱う（LOW 条件の `NONE` にも、
 * 「完全に確認済み」の `COMPLETE` にも読み替えない）。R7 で step 5 を接続した後は
 * COMPLETE / PARTIAL / NONE のいずれかが入る。
 */
export type HistoryCoverage = "COMPLETE" | "PARTIAL" | "NONE" | "NOT_EVALUATED";

export type ConfidenceInputs = {
  /** その処方項目が実際に参照した Evidence（Envelope フィールドに紐づくもの）。 */
  usedEvidence: UsedEvidenceSummary[];
  /**
   * [R4 errata] `NOT_REQUIRED`（参照が performance データを必要としない）は中立: LOW 条件（LOW / NONE）にも
   * MODERATE 条件（MEDIUM）にも該当せず、confidence は Evidence / directness / 履歴だけで決まる。
   */
  inputDataConfidence: InputDataConfidence;
  historyCoverage72h: HistoryCoverage;
};

export function derivePrescriptionConfidence(inputs: ConfidenceInputs): PrescriptionConfidence {
  const { usedEvidence, inputDataConfidence, historyCoverage72h } = inputs;

  // 空配列に対して .every() は真を返してしまう（vacuous truth）ため、
  // 「1件以上あって、かつ全件が該当する」という条件を明示的に要求する。
  const hasEvidence = usedEvidence.length > 0;
  const allEnginePolicy = hasEvidence && usedEvidence.every((e) => e.sourceType === "ENGINE_POLICY");
  if (allEnginePolicy) {
    return "POLICY_ONLY";
  }

  const hasIndirect = usedEvidence.some((e) => e.directness === "INDIRECT");
  if (
    hasIndirect ||
    inputDataConfidence === "LOW" ||
    inputDataConfidence === "NONE" ||
    historyCoverage72h === "NONE"
  ) {
    return "LOW";
  }

  const hasPartial = usedEvidence.some((e) => e.directness === "PARTIAL");
  const allSecondaryReportOnly =
    hasEvidence && usedEvidence.every((e) => e.verification === "SECONDARY_REPORT_ONLY");
  if (hasPartial || inputDataConfidence === "MEDIUM" || allSecondaryReportOnly) {
    return "MODERATE";
  }

  return "HIGH";
}
