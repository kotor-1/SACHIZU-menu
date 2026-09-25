/** Running Prescription Engine v2 — input normalization and selected-input plausibility. */
import type { PlausibilityRule, RuleSet } from "../rules/schema";
import type { Finding, FindingSourceRecord, PlausibilityCertainty, PlausibilityPolicy } from "../types/findings";
import type { IsoDate, Unit } from "../types/primitives";
import type { TimedMark } from "../types/intensity";
import type { MaturityAssessment, Subject } from "../types/subject";
import { selectHeightHistoryForGrowth } from "../context/maturity";
import { evaluateInputPlausibility, evaluatePlausibilityThreshold, plausibilityMetadata } from "../plausibility/input";
import { itemFinding, planRequestSchema, type PlanRequest } from "./schema";

export type NormalizeResult = { ok: true; request: PlanRequest } | { ok: false; findings: Finding[] };

export function normalizePlanRequest(raw: unknown): NormalizeResult {
  const parsed = planRequestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, request: parsed.data };
  return {
    ok: false,
    findings: parsed.error.issues.map((issue) => itemFinding("PLAN_REQUEST_INVALID", "BLOCK", { metric: `${issue.path.join(".") || "(root)"}: ${issue.message}` })),
  };
}

export type InputPlausibilityResult = { blocking: Finding[]; findings: Finding[] };

function ruleForInput(ruleSet: RuleSet, kind: "TIMED_MARK" | "HEIGHT_CM" | "COACH_EDIT_APPROACH_DISTANCE_M", event?: TimedMark["event"]): PlausibilityRule | null {
  return ruleSet.plausibility.find((rule) => {
    const target = rule.inputTarget;
    if (target === null || target.kind !== kind) return false;
    return target.kind !== "TIMED_MARK" || target.event === event;
  }) ?? null;
}

function boundaryPolicy(rule: PlausibilityRule, side: "MIN" | "MAX"): PlausibilityPolicy | null {
  return rule.boundaryPolicies[side === "MIN" ? "min" : "max"];
}

function policyFinding(
  rule: PlausibilityRule,
  metric: string,
  value: number,
  policy: PlausibilityPolicy,
  certainty: PlausibilityCertainty,
  side: "MIN" | "MAX" | null,
  threshold: number | null,
  severity: "BLOCK" | "WARN" | "INFO",
  code = "INPUT_PLAUSIBILITY_BLOCK",
  sourceRecord?: FindingSourceRecord,
): Finding {
  const unit = rule.unit as Unit;
  return itemFinding(code, severity, {
    metric,
    value: { lower: value, upper: value, unit, source: "MEASURED", confidence: "HIGH" },
    plausibility: plausibilityMetadata(
      rule.ruleId,
      policy,
      certainty,
      side !== null && threshold !== null ? { side, threshold } : undefined,
      sourceRecord,
    ),
  });
}

function dataQualityFinding(ruleId: string, code: string, metric: string, value?: { value: number; unit: Unit }): Finding {
  return itemFinding(code, "WARN", {
    metric,
    ...(value ? { value: { lower: value.value, upper: value.value, unit: value.unit, source: "MEASURED" as const, confidence: "LOW" as const } } : {}),
    plausibility: plausibilityMetadata(ruleId, "DATA_QUALITY", "DATA_QUALITY"),
  });
}

function applyScalarRule(
  rule: PlausibilityRule,
  value: number,
  metric: string,
  out: InputPlausibilityResult,
  sourceRecord?: FindingSourceRecord,
): void {
  const bounds = { lower: value, upper: value };
  const block = evaluatePlausibilityThreshold(bounds, rule.blockThreshold);
  if (block.certainty !== "CONFIRMED_WITHIN") {
    const policy = block.side === null ? null : boundaryPolicy(rule, block.side);
    if (policy !== null) {
      out.blocking.push(policyFinding(
        rule,
        metric,
        value,
        policy,
        block.certainty,
        block.side,
        block.threshold,
        "BLOCK",
        "INPUT_PLAUSIBILITY_BLOCK",
        sourceRecord,
      ));
      return;
    }
  }
  if (rule.confirmThreshold !== null) {
    const confirmation = evaluatePlausibilityThreshold(bounds, rule.confirmThreshold);
    if (confirmation.certainty === "CONFIRMED_EXCEED" || confirmation.certainty === "POSSIBLE_EXCEED") {
      out.findings.push(itemFinding("INPUT_PLAUSIBILITY_CONFIRM", "REQUIRE_CONFIRMATION", {
        metric: `${rule.ruleId}:${metric}`,
        value: { lower: value, upper: value, unit: rule.unit as Unit, source: "MEASURED", confidence: "HIGH" },
      }));
    }
  }
}

function maturityInputs(subject: Subject): { label: string; maturity: MaturityAssessment; memberIdentity: string | null }[] {
  return subject.kind === "ATHLETE"
    ? [{ label: "athlete", maturity: subject.profile.maturity, memberIdentity: null }]
    : subject.profile.members.map((member, index) => ({
        label: `members[${index}]`,
        maturity: member.maturity,
        memberIdentity: member.memberId ?? null,
      }));
}

function inspectHeightHistory(
  maturity: MaturityAssessment,
  planningDate: IsoDate,
  rule: PlausibilityRule,
  label: string,
  memberIdentity: string | null,
  out: InputPlausibilityResult,
): void {
  const history = maturity.heightHistory ?? [];
  const selection = selectHeightHistoryForGrowth(history, planningDate);
  for (const point of selection.futurePoints) {
    out.findings.push(dataQualityFinding(rule.ruleId, "INPUT_HEIGHT_FUTURE_IGNORED", `${label}.height@${point.date}`, { value: point.heightCm, unit: "cm" }));
  }
  for (const point of selection.endpoints) {
    applyScalarRule(rule, point.heightCm, `${label}.height@${point.date}`, out, {
      kind: "HEIGHT_POINT",
      memberIdentity,
      date: point.date,
      heightCm: point.heightCm,
    });
  }
  for (const point of selection.unusedPastPoints) {
    const assessment = evaluatePlausibilityThreshold({ lower: point.heightCm, upper: point.heightCm }, rule.blockThreshold);
    if (assessment.certainty !== "CONFIRMED_WITHIN") {
      out.findings.push(dataQualityFinding(rule.ruleId, "INPUT_HEIGHT_DATA_QUALITY", `${label}.height@${point.date}`, { value: point.heightCm, unit: "cm" }));
    }
  }
}

function checkBirthDate(birthDate: IsoDate | null, planningDate: IsoDate, label: string, out: InputPlausibilityResult): void {
  if (birthDate !== null && birthDate > planningDate) out.blocking.push(itemFinding("INPUT_BIRTHDATE_IN_FUTURE", "BLOCK", { metric: label }));
}

/** Structural input checks, selected height endpoints, and coach-entered approach distance. */
export function checkInputPlausibility(request: PlanRequest, ruleSet: RuleSet): InputPlausibilityResult {
  const out: InputPlausibilityResult = { blocking: [], findings: [] };
  const { subject, planningDate } = request;
  if (subject.kind === "ATHLETE") {
    checkBirthDate(subject.profile.birthDate, planningDate, "athlete.birthDate", out);
    for (const mark of [...subject.profile.marks].sort(compareMarkIdentity)) {
      if (mark.date > planningDate) out.findings.push(dataQualityFinding(`INPUT_MARK_DATE_${mark.event}`, "INPUT_MARK_IN_FUTURE_IGNORED", `future.${markIdentity(mark)}`));
    }
  } else {
    subject.profile.members.forEach((member, index) => checkBirthDate(member.birthDate, planningDate, `members[${index}].birthDate`, out));
  }

  const heightRule = ruleForInput(ruleSet, "HEIGHT_CM");
  if (heightRule) {
    for (const { label, maturity, memberIdentity } of maturityInputs(subject)) {
      inspectHeightHistory(maturity, planningDate, heightRule, label, memberIdentity, out);
    }
  }

  const approachRule = ruleForInput(ruleSet, "COACH_EDIT_APPROACH_DISTANCE_M");
  if (approachRule) {
    for (const edit of request.coachEdits) {
      if (edit.field === "approachDistanceM") {
        const verdict = evaluateInputPlausibility(ruleSet, approachRule.ruleId, edit.value);
        if (verdict === "BLOCK") {
          const assessment = evaluatePlausibilityThreshold({ lower: edit.value, upper: edit.value }, approachRule.blockThreshold);
          const policy = assessment.side === null ? null : boundaryPolicy(approachRule, assessment.side);
          if (policy) out.blocking.push(policyFinding(approachRule, "coachEdits.approachDistanceM", edit.value, policy, assessment.certainty, assessment.side, assessment.threshold, "BLOCK"));
        } else if (verdict === "REQUIRE_CONFIRMATION") {
          out.findings.push(itemFinding("INPUT_PLAUSIBILITY_CONFIRM", "REQUIRE_CONFIRMATION", { metric: `${approachRule.ruleId}:coachEdits.approachDistanceM` }));
        }
      }
    }
  }
  return out;
}

function sameMark(a: TimedMark, b: TimedMark): boolean {
  return a.event === b.event && a.date === b.date && a.timeS === b.timeS && a.timing === b.timing &&
    (a.videoFps ?? null) === (b.videoFps ?? null) && (a.wind ?? null) === (b.wind ?? null) &&
    (a.startType ?? null) === (b.startType ?? null) && (a.surface ?? null) === (b.surface ?? null) &&
    (a.spikes ?? null) === (b.spikes ?? null);
}

function markIdentity(mark: TimedMark): string {
  return `${mark.event}@${mark.date}:${mark.timeS}s:${mark.timing}${mark.videoFps === undefined ? "" : `:${mark.videoFps}fps`}`;
}

function compareMarkIdentity(a: TimedMark, b: TimedMark): number {
  const left = markIdentity(a);
  const right = markIdentity(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function findingMarkIdentity(mark: TimedMark): FindingSourceRecord {
  return {
    kind: "TIMED_MARK",
    record: {
      event: mark.event,
      date: mark.date,
      timeS: mark.timeS,
      timing: mark.timing,
      ...(mark.videoFps !== undefined ? { videoFps: mark.videoFps } : {}),
      ...(mark.wind !== undefined ? { wind: mark.wind } : {}),
      ...(mark.startType !== undefined ? { startType: mark.startType } : {}),
      ...(mark.surface !== undefined ? { surface: mark.surface } : {}),
      ...(mark.spikes !== undefined ? { spikes: mark.spikes } : {}),
    },
  };
}

/** Evaluate only performance records selected into the current reference plan; quarantine other extremes. */
export function checkSelectedPerformanceInputPlausibility(
  request: PlanRequest,
  ruleSet: RuleSet,
  selectedMarks: readonly TimedMark[],
): InputPlausibilityResult {
  const out: InputPlausibilityResult = { blocking: [], findings: [] };
  if (request.subject.kind !== "ATHLETE") return out;
  const marks = request.subject.profile.marks;
  const selected = new Set<TimedMark>();
  for (const mark of selectedMarks) {
    const selectedRecord = marks.find((candidate) => sameMark(candidate, mark));
    if (selectedRecord) selected.add(selectedRecord);
  }

  for (const mark of selected) {
    const rule = ruleForInput(ruleSet, "TIMED_MARK", mark.event);
    if (rule) applyScalarRule(rule, mark.timeS, `selected.${mark.event}@${mark.date}`, out, findingMarkIdentity(mark));
  }
  for (const mark of [...marks].sort(compareMarkIdentity)) {
    if (mark.date > request.planningDate || selected.has(mark)) continue;
    const rule = ruleForInput(ruleSet, "TIMED_MARK", mark.event);
    if (!rule) continue;
    const assessment = evaluatePlausibilityThreshold({ lower: mark.timeS, upper: mark.timeS }, rule.blockThreshold);
    if (assessment.certainty !== "CONFIRMED_WITHIN") {
      out.findings.push(dataQualityFinding(rule.ruleId, "INPUT_MARK_DATA_QUALITY", `unused.${markIdentity(mark)}`, { value: mark.timeS, unit: "s" }));
    }
  }
  return out;
}
