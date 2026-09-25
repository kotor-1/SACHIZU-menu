/**
 * Running Prescription Engine v2 — [OPEN20 F4] PlausibilityIssue → 表示 DTO。
 *
 * - `PlausibilityIssue` は server（Action）が返す current issue のスナップショットで、
 *   client はこれを**表示と digest 参照にだけ**使う。issueDigest / ruleId / digest は内部値であり、
 *   この mapper はそれらを DOM テキストへ出さない（L-4 と同じ境界）。
 * - 数値の authority はすべて server の current issue にある。ここは表示整形だけ。
 * - certainty（CONFIRMED_EXCEED / POSSIBLE_EXCEED）は同じ断定文にしない（§8）。
 *   境界 side（MIN / MAX）も併せて「超えています／下回っています」を区別する。
 * - `import type` のみで domain schema を client bundle へ持ち込まない。
 */
import type { PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import type { PlausibilityReviewIssuePresentationDto } from "./dto";
import { fieldUnitOf, formatIntervalJa, formatValueJa } from "./format";
import { EDITABLE_FIELD_DISPLAY } from "./labels";

const TARGET_FALLBACK_LABEL_JA = "処方値";

const REVIEW_SCOPE_LABEL_JA: Record<PlausibilityIssue["scope"], string> = {
  ITEM: "この項目",
  INPUT: "入力・記録",
  SESSION: "練習全体",
};

/** boundary side × certainty の判定文。POSSIBLE は断定しない（§8）。 */
const JUDGEMENT_LABEL_JA: Record<PlausibilityIssue["boundary"]["side"], Record<PlausibilityIssue["certainty"], string>> = {
  MIN: {
    CONFIRMED_EXCEED: "下限を下回っています",
    POSSIBLE_EXCEED: "下限を下回っている可能性があります",
  },
  MAX: {
    CONFIRMED_EXCEED: "上限を超えています",
    POSSIBLE_EXCEED: "上限を超えている可能性があります",
  },
};

const REVIEW_REQUIRED_NOTE_JA = "コーチの確認が必要です。";

function targetLabel(issue: PlausibilityIssue): string {
  switch (issue.target.kind) {
    case "PRESCRIPTION_FIELD": {
      const display = EDITABLE_FIELD_DISPLAY[issue.target.field as keyof typeof EDITABLE_FIELD_DISPLAY];
      return display !== undefined ? display.label : TARGET_FALLBACK_LABEL_JA;
    }
    case "REP_DISTANCE":
      return "1本の距離";
    case "ITEM_TOTAL_DISTANCE":
      return "項目の合計距離";
    case "TIMED_MARK":
      return "計測したタイム";
    case "HEIGHT_POINT":
      return "身長の計測点";
  }
}

function observationLabel(issue: PlausibilityIssue): string | null {
  const unit = fieldUnitOf(issue.observation.unit);
  if (unit === null) return null;
  if (issue.observation.kind === "SCALAR") return formatValueJa(issue.observation.value, unit);
  return formatIntervalJa({ lower: issue.observation.lower, upper: issue.observation.upper }, unit);
}

function thresholdLabel(issue: PlausibilityIssue): string | null {
  const unit = fieldUnitOf(issue.observation.unit);
  if (unit === null) return null;
  const value = formatValueJa(issue.boundary.threshold, unit);
  return issue.boundary.side === "MAX" ? `上限 ${value}` : `下限 ${value}`;
}

/** PlausibilityIssue[] を表示用 DTO へ。並び順は server の digest 昇順を維持する。 */
export function presentPlausibilityReviewIssues(issues: readonly PlausibilityIssue[]): PlausibilityReviewIssuePresentationDto[] {
  return issues.map((issue) => {
    const valueLabel = observationLabel(issue);
    const threshold = thresholdLabel(issue);
    const certaintyLabel = JUDGEMENT_LABEL_JA[issue.boundary.side][issue.certainty];
    const subjectLabel = targetLabel(issue);
    const scopeLabel = REVIEW_SCOPE_LABEL_JA[issue.scope];

    const facts = [valueLabel !== null ? `現在 ${valueLabel}` : null, threshold].filter((v): v is string => v !== null);
    const message = facts.length > 0
      ? `${subjectLabel}（${facts.join("・")}）は${certaintyLabel}。${REVIEW_REQUIRED_NOTE_JA}`
      : `${subjectLabel}は${certaintyLabel}。${REVIEW_REQUIRED_NOTE_JA}`;

    return {
      issueDigest: issue.issueDigest,
      ruleIdInternal: issue.ruleId,
      subjectLabel,
      valueLabel,
      thresholdLabel: threshold,
      certaintyLabel,
      certaintyInternal: issue.certainty,
      scopeLabel,
      message,
    };
  });
}
