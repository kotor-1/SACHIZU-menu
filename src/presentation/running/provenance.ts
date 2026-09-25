/**
 * Running Prescription Engine v2 — R10-B3 Provenance → ProvenancePresentationDto。
 *
 * - Evidence の出典種類（sourceType）は Provenance.evidenceIds だけでは分からないため RuleSet の EvidenceRecord を引く。
 *   使ってよいのは **保存時の ruleSetVersion + ruleSetContentHash と完全一致した RuleSet だけ**
 *   （`ExactRuleSetLookup`。active / current RuleSet で代用しない）。一致しなければ Evidence の詳細だけ
 *   「根拠の詳細を確認できません」にする（処方や理由文の表示は止めない）。
 * - AI の説明文（aiReason）とエンジンの処方根拠は別の概念として分けて持つ。
 * - 通常画面に出さない技術情報（contentHash / engineVersion / requestId / evidenceId）は DTO に含めない。
 */
import { SOURCE_TYPES, type SourceType } from "@/domain/running/evidence/schema";
import type { Provenance } from "@/domain/running/persistence/provenance";
import type { RuleSet } from "@/domain/running/rules/schema";
import type { PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import type { EvidencePresentationDto, ProvenanceChangeDto, ProvenanceChangesDto, ProvenancePresentationDto } from "./dto";
import { presentConfidence } from "./confidence";
import { formatIsoDateJa, formatValueJa } from "./format";
import { presentPlausibilityReviewIssues } from "./review-issues";
import {
  EDITABLE_FIELD_DISPLAY,
  EVIDENCE_SOURCE_TYPE_LABEL_JA,
  GENERATED_BY_LABEL_JA,
  OVERRIDE_TARGET_LABEL_JA,
  RULE_SET_STATUS_LABEL_JA,
} from "./labels";

/** 保存時の RuleSet identity と完全一致した RuleSet（見つからなければ UNAVAILABLE）。 */
export type ExactRuleSetLookup = { status: "OK"; ruleSet: RuleSet } | { status: "UNAVAILABLE" };

export const EVIDENCE_UNAVAILABLE_MESSAGE_JA = "根拠の詳細を確認できません。";
export const PROVENANCE_UNAVAILABLE_MESSAGE_JA = "作成経緯を確認できません。";

function presentEvidence(evidenceIds: readonly string[], lookup: ExactRuleSetLookup): EvidencePresentationDto {
  if (lookup.status !== "OK") return { status: "UNAVAILABLE", message: EVIDENCE_UNAVAILABLE_MESSAGE_JA };
  if (evidenceIds.length === 0) return { status: "NONE", message: "この処方が参照している根拠の記録はありません。" };

  const counts = new Map<SourceType, number>();
  let unresolved = 0;
  for (const id of evidenceIds) {
    const record = lookup.ruleSet.evidence.find((e) => e.id === id);
    if (!record) {
      unresolved += 1;
      continue;
    }
    counts.set(record.sourceType, (counts.get(record.sourceType) ?? 0) + 1);
  }
  return {
    status: "AVAILABLE",
    sourceTypes: SOURCE_TYPES.filter((t) => counts.has(t)).map((t) => ({ label: EVIDENCE_SOURCE_TYPE_LABEL_JA[t], count: counts.get(t)! })),
    unresolvedCount: unresolved,
    unresolvedMessage: unresolved > 0 ? "一部の根拠の詳細を確認できません。" : null,
  };
}

function changeValueLabel(field: keyof typeof EDITABLE_FIELD_DISPLAY, value: number | undefined): string | null {
  return value === undefined ? null : formatValueJa(value, EDITABLE_FIELD_DISPLAY[field].unit);
}

function presentCoachEdits(edits: Provenance["coachEdits"]): ProvenanceChangesDto {
  const items: ProvenanceChangeDto[] = edits.map((e) => ({
    label: EDITABLE_FIELD_DISPLAY[e.field].label,
    detail:
      e.from === undefined
        ? `初回入力: ${changeValueLabel(e.field, e.to)}`
        : e.from === e.to
          ? `コーチ指定: ${changeValueLabel(e.field, e.to)}`
          : `${changeValueLabel(e.field, e.from)} → ${changeValueLabel(e.field, e.to)}`,
    reason: null,
    atLabel: formatIsoDateJa(e.at),
  }));
  return { summaryLabel: items.length === 0 ? "なし" : `あり（${items.length}件）`, items };
}

function presentOverrides(overrides: Provenance["overrides"]): ProvenanceChangesDto {
  const items: ProvenanceChangeDto[] = overrides.map((o) => {
    const target = o.target;
    if (target.kind === "FIELD") {
      const to = changeValueLabel(target.field, o.to);
      return {
        label: `${EDITABLE_FIELD_DISPLAY[target.field].label}（${target.layer === "HARD_SAFETY" ? OVERRIDE_TARGET_LABEL_JA.FIELD_HARD_SAFETY : OVERRIDE_TARGET_LABEL_JA.FIELD_COACH_EDITABLE}）`,
        detail: to === null ? null : `設定値 ${to}`,
        reason: o.reason,
        atLabel: formatIsoDateJa(o.at),
      };
    }
    return {
      label: target.kind === "ELIGIBILITY" ? OVERRIDE_TARGET_LABEL_JA.ELIGIBILITY : OVERRIDE_TARGET_LABEL_JA.READINESS,
      detail: null,
      reason: o.reason,
      atLabel: formatIsoDateJa(o.at),
    };
  });
  return { summaryLabel: items.length === 0 ? "なし" : `あり（${items.length}件）`, items };
}

/** [OPEN20 F4] 保存されたコーチの妥当性確認（reason・時刻のみ。digest / ruleId は出さない）。 */
function presentPlausibilityReviews(reviews: NonNullable<Provenance["plausibilityReviews"]>): ProvenanceChangesDto {
  const items: ProvenanceChangeDto[] = reviews.map((review) => {
    const [issue] = presentPlausibilityReviewIssues([review as unknown as PlausibilityIssue]);
    return {
      label: issue !== undefined ? `コーチが妥当性を確認（${issue.subjectLabel}）` : "コーチが妥当性を確認",
      detail: null,
      reason: review.reason,
      atLabel: formatIsoDateJa(review.at),
    };
  });
  return { summaryLabel: items.length === 0 ? "なし" : `あり（${items.length}件）`, items };
}

export function presentProvenance(provenance: Provenance | null, lookup: ExactRuleSetLookup): ProvenancePresentationDto {
  if (provenance === null) return { status: "UNAVAILABLE", message: PROVENANCE_UNAVAILABLE_MESSAGE_JA };

  const generated = provenance.generatedBy;
  const proposerKind = generated.proposer.kind;
  const acceptedAt = formatIsoDateJa(generated.acceptedByCoachAt);
  const acceptanceLabel =
    acceptedAt !== null
      ? `コーチ承認済み（${acceptedAt}）`
      : generated.createdByCoach && proposerKind === "ENGINE"
        ? "コーチが作成（承認は不要）"
        : "コーチ未承認";

  return {
    status: "AVAILABLE",
    ruleSetVersionLabel: provenance.ruleSet.version,
    ruleSetStatusLabel: RULE_SET_STATUS_LABEL_JA[provenance.ruleSet.status],
    ruleSetIsDraft: provenance.ruleSet.status === "DRAFT",
    confidence: presentConfidence(provenance.confidence, provenance.ruleSet.status),
    generatedByInternal: proposerKind,
    generatedByLabel: GENERATED_BY_LABEL_JA[proposerKind],
    createdByLabel: generated.createdByCoach ? "コーチが作成" : "自動作成",
    acceptanceLabel,
    aiProposal:
      proposerKind === "AI_PLANNER"
        ? {
            heading: "AIの提案理由",
            reason: provenance.aiReason,
            engineBasisNote: "数値と処方の根拠はエンジンが決めています（AIの説明とは別に表示しています）。",
          }
        : null,
    evidence: presentEvidence(provenance.evidenceIds, lookup),
    coachEdits: presentCoachEdits(provenance.coachEdits),
    overrides: presentOverrides(provenance.overrides),
    plausibilityReviews: presentPlausibilityReviews(provenance.plausibilityReviews ?? []),
  };
}
