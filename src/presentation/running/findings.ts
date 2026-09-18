/**
 * Running Prescription Engine v2 — R10-B3 Finding → FindingPresentationDto。
 *
 * - 同じ code の Finding（例: `WEEKLY_HIGH_WITHIN_48H` の BLOCK_AUTOGEN と REQUIRE_COACH_REVIEW の組）は1行にまとめ、
 *   severity のラベルを並べる（同じ文を2回出さない）。これは表示のまとめ方であり、severity を変えない。
 * - 並び順は domain の `FINDING_SEVERITIES` の順（後ろほど強い）で強い順。新しい優先度の規則は作らない。
 * - `metric` は自由形式の内部文字列なので表示しない。完全一致で既知の field / method に解決できたときだけ
 *   対象名（subjectLabel）として使う（文字列の意味を推測しない）。
 */
import { FINDING_SEVERITIES, type Finding, type FindingSeverity } from "@/domain/running/types/findings";
import { RUNNING_TRAINING_METHODS, type RunningTrainingMethod } from "@/domain/running/types/method";
import type { FindingDetailDto, FindingPresentationDto } from "./dto";
import { findingMessageJa } from "./finding-messages";
import { fieldUnitOf, formatIntervalJa, formatRangeJa } from "./format";
import {
  EDITABLE_FIELD_DISPLAY,
  FINDING_SCOPE_LABEL_JA,
  FINDING_SEVERITY_LABEL_JA,
  FINDING_SEVERITY_NOTE_JA,
  FINDING_SEVERITY_TONE,
  METHOD_LABEL_JA,
} from "./labels";

function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.indexOf(severity);
}

function isEditableFieldName(value: string): value is keyof typeof EDITABLE_FIELD_DISPLAY {
  return Object.prototype.hasOwnProperty.call(EDITABLE_FIELD_DISPLAY, value);
}

function isMethod(value: string): value is RunningTrainingMethod {
  return (RUNNING_TRAINING_METHODS as readonly string[]).includes(value);
}

/** metric が「field 名」または「Method:field 名」と完全一致するときだけ日本語の対象名にする。 */
function subjectLabelOf(metric: string | undefined): string | null {
  if (metric === undefined) return null;
  if (isEditableFieldName(metric)) return EDITABLE_FIELD_DISPLAY[metric].label;
  const parts = metric.split(":");
  if (parts.length === 2 && isMethod(parts[0]!) && isEditableFieldName(parts[1]!)) {
    return `${METHOD_LABEL_JA[parts[0] as RunningTrainingMethod]}・${EDITABLE_FIELD_DISPLAY[parts[1] as keyof typeof EDITABLE_FIELD_DISPLAY].label}`;
  }
  return null;
}

function detailOf(finding: Finding): FindingDetailDto {
  const valueUnit = finding.value ? fieldUnitOf(finding.value.unit) : null;
  const limitUnit = finding.limit ? fieldUnitOf(finding.limit.unit) : null;
  const valueText = finding.value && valueUnit ? formatIntervalJa(finding.value, valueUnit) : null;
  return {
    subjectLabel: subjectLabelOf(finding.metric),
    valueLabel: valueText === null ? null : `値: ${valueText}`,
    limitLabel: finding.limit && limitUnit ? `基準: ${formatRangeJa(finding.limit, limitUnit)}` : null,
  };
}

function detailKey(d: FindingDetailDto): string {
  return `${d.subjectLabel ?? ""}|${d.valueLabel ?? ""}|${d.limitLabel ?? ""}`;
}

/** Finding[] を表示用 DTO へ。空の detail（全部 null）は持たない。 */
export function presentFindings(findings: readonly Finding[]): FindingPresentationDto[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const groupKey = `${f.scope}|${f.code}`;
    const list = groups.get(groupKey);
    if (list) list.push(f);
    else groups.set(groupKey, [f]);
  }

  const presented: { dto: FindingPresentationDto; rank: number; order: number }[] = [];
  let order = 0;
  for (const [groupKey, list] of groups) {
    const first = list[0]!;
    const severities = [...new Set(list.map((f) => f.severity))].sort((a, b) => severityRank(b) - severityRank(a));
    const strongest = severities[0]!;
    const { message, known } = findingMessageJa(first.code);

    const details: FindingDetailDto[] = [];
    const seen = new Set<string>();
    for (const f of list) {
      const d = detailOf(f);
      if (d.subjectLabel === null && d.valueLabel === null && d.limitLabel === null) continue;
      const k = detailKey(d);
      if (seen.has(k)) continue;
      seen.add(k);
      details.push(d);
    }

    presented.push({
      rank: severityRank(strongest),
      order: order++,
      dto: {
        key: groupKey,
        developerCode: first.code,
        confirmationKey: first.code,
        severitiesInternal: severities,
        severityLabels: severities.map((s) => FINDING_SEVERITY_LABEL_JA[s]),
        severityNote: FINDING_SEVERITY_NOTE_JA[strongest],
        tone: FINDING_SEVERITY_TONE[strongest],
        scopeLabel: FINDING_SCOPE_LABEL_JA[first.scope],
        message,
        details,
        isKnownCode: known,
        confirmationRecordLabel: null,
        requiresExplicitConfirmation: severities.includes("REQUIRE_CONFIRMATION"),
        needsCoachReview: severities.includes("REQUIRE_COACH_REVIEW"),
        restrictsAutoGeneration: severities.includes("BLOCK_AUTOGEN"),
        blocksCreation: severities.includes("BLOCK"),
      },
    });
  }

  return presented.sort((a, b) => b.rank - a.rank || a.order - b.order).map((p) => p.dto);
}
