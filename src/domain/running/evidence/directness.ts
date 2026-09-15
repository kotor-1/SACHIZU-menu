/**
 * Running Prescription Engine v2 — deriveDirectness()（§5.3）。
 *
 * 純粋関数。同じ Evidence でも、対象選手の population context によって
 * directness が変わる（Fable C-8 の核心: directness は rule の属性ではなく
 * (rule.population, athlete) の関数）。
 *
 * [DEVIATION] 正式仕様は `deriveDirectness(evidence.population, subjectProfile)`
 * という2引数シグネチャの例を示しているが、§5.3 の判定表の最初の条件
 * 「`sourceType = ENGINE_POLICY` → `NOT_APPLICABLE`」は `sourceType`
 * （`evidence.population` の外側のフィールド）を必要とする。
 * `population` だけでは判定できないため、このファイルでは
 * `Pick<EvidenceRecord, "sourceType" | "population">` を第1引数として
 * 受け取るように実装した（仕様のインライン例と §5.3 表そのものの間にある
 * 矛盾を、表の要求を優先して解消したもの。スコープの逸脱ではなく、
 * 仕様内の不整合の解消として R1 報告で明記する）。
 *
 * `subjectProfile` に相当する第2引数は、R3 の `resolveSubjectProfile()` が
 * まだ存在しないため、比較に必要な最小限のフィールドだけを持つ
 * `EvidencePopulationContext` という暫定の型で代替する。R3 で
 * `SubjectProfile` が実装されたら、そこから同じ4フィールドを取り出して
 * 渡す形に置き換える想定。
 */
import type { AgeBand, MaturityStatus } from "../types/subject";
import type { Directness } from "../types/prescription";
import type { EvidencePopulation, PerformanceLevel, SourceType } from "./schema";

/**
 * §5.3 の比較に必要な最小限の context。
 * 正式な `SubjectProfile`（R3）が実装されるまでの暫定型。
 */
export type EvidencePopulationContext = {
  ageBand: AgeBand;
  maturity: MaturityStatus;
  performanceLevel: PerformanceLevel;
};

export type DirectnessEvidenceInput = {
  sourceType: SourceType;
  population: EvidencePopulation;
};

/**
 * §5.3 の表を、上から順に最初に該当した条件で判定する。
 *   1. sourceType = ENGINE_POLICY → NOT_APPLICABLE
 *   2. sport が TRACK_SPRINT/GENERAL 以外、または maturity 不一致、または
 *      ageBand 不一致 → INDIRECT
 *   3. （2 に該当せず）performanceLevel のみ不一致 → PARTIAL
 *   4. すべて一致（"ANY" は一致扱い） → DIRECT
 *
 * 表に sex（性別）の一致・不一致は登場しない。EvidenceRecord.population.sexes
 * は保持されるが、本関数の判定には使わない（意図的。表の記述どおり）。
 */
export function deriveDirectness(
  evidence: DirectnessEvidenceInput,
  context: EvidencePopulationContext,
): Directness {
  if (evidence.sourceType === "ENGINE_POLICY") {
    return "NOT_APPLICABLE";
  }

  const { population } = evidence;

  const sportOk = population.sport === "TRACK_SPRINT" || population.sport === "GENERAL";
  const maturityOk = population.maturity === "ANY" || population.maturity.includes(context.maturity);
  const ageBandOk = population.ageBands === "ANY" || population.ageBands.includes(context.ageBand);

  if (!sportOk || !maturityOk || !ageBandOk) {
    return "INDIRECT";
  }

  const performanceLevelOk =
    population.performanceLevels === "ANY" ||
    population.performanceLevels.includes(context.performanceLevel);

  if (!performanceLevelOk) {
    return "PARTIAL";
  }

  return "DIRECT";
}
