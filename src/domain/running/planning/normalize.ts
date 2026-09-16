/**
 * Running Prescription Engine v2 — §9.2 step 1: INPUT NORMALIZATION + INPUT PLAUSIBILITY。
 *
 * - 構造検証は `planRequestSchema`（Zod）に一任する。失敗は例外にせず BLOCKED に変換する。
 * - 入力 plausibility の閾値はここに書かない。検査する行は RuleSet の構造化データ
 *   `PlausibilityRule.inputTarget`（TIMED_MARK の event / HEIGHT_CM / COACH_EDIT_APPROACH_DISTANCE_M）で選び、
 *   判定は R3 の `evaluateInputPlausibility()` に委ねる（ruleId の文字列定数や event 名から対象を推測しない）。
 * - 出力 plausibility（総走行距離・sets/reps 取り違え等、§9.2 step 14）は R6 の責務であり、
 *   ここでは実装しない。
 */
import type { PlausibilityRule, RuleSet } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { IsoDate } from "../types/primitives";
import { evaluateInputPlausibility } from "../context/plausibility";
import { itemFinding, planRequestSchema, type PlanRequest } from "./schema";

export type NormalizeResult = { ok: true; request: PlanRequest } | { ok: false; findings: Finding[] };

export function normalizePlanRequest(raw: unknown): NormalizeResult {
  const parsed = planRequestSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, request: parsed.data };
  }
  return {
    ok: false,
    findings: parsed.error.issues.map((issue) =>
      itemFinding("PLAN_REQUEST_INVALID", "BLOCK", { metric: `${issue.path.join(".") || "(root)"}: ${issue.message}` }),
    ),
  };
}

export type InputPlausibilityResult = {
  /** 1件でもあれば PlanResult は BLOCKED（plausibility BLOCK は override 不可。入力を直す）。 */
  blocking: Finding[];
  findings: Finding[];
};

function checkPlausibility(ruleSet: RuleSet, rule: PlausibilityRule, value: number, metric: string, out: InputPlausibilityResult): void {
  const verdict = evaluateInputPlausibility(ruleSet, rule.ruleId, value);
  if (verdict === "BLOCK") {
    out.blocking.push(itemFinding("INPUT_PLAUSIBILITY_BLOCK", "BLOCK", { metric: `${rule.ruleId}:${metric}` }));
  } else if (verdict === "REQUIRE_CONFIRMATION") {
    out.findings.push(itemFinding("INPUT_PLAUSIBILITY_CONFIRM", "REQUIRE_CONFIRMATION", { metric: `${rule.ruleId}:${metric}` }));
  }
}

function checkBirthDate(birthDate: IsoDate | null, planningDate: IsoDate, label: string, out: InputPlausibilityResult): void {
  if (birthDate !== null && birthDate > planningDate) {
    out.blocking.push(itemFinding("INPUT_BIRTHDATE_IN_FUTURE", "BLOCK", { metric: label }));
  }
}

/**
 * subject と coachEdits の入力 plausibility を評価する。BLOCK になる入力が1つでもあれば
 * （処方にその入力を使うかどうかに関わらず）計画を止める — 入力ミスを残したまま
 * 別の値で処方を出さないため（§8.3「plausibility BLOCK は override 不可・入力を修正する」）。
 */
export function checkInputPlausibility(request: PlanRequest, ruleSet: RuleSet): InputPlausibilityResult {
  const out: InputPlausibilityResult = { blocking: [], findings: [] };
  const { subject, planningDate } = request;

  const heightSeries =
    subject.kind === "ATHLETE"
      ? [{ label: "athlete", maturity: subject.profile.maturity }]
      : subject.profile.members.map((m, i) => ({ label: `members[${i}]`, maturity: m.maturity }));

  if (subject.kind === "ATHLETE") {
    checkBirthDate(subject.profile.birthDate, planningDate, "athlete.birthDate", out);
    subject.profile.marks.forEach((mark, i) => {
      if (mark.date > planningDate) {
        // R3 performance.ts は未来の記録を参照に使わない。黙って捨てずに記録する。
        out.findings.push(itemFinding("INPUT_MARK_IN_FUTURE_IGNORED", "INFO", { metric: `marks[${i}]:${mark.event}` }));
      }
    });
  } else {
    subject.profile.members.forEach((member, i) => checkBirthDate(member.birthDate, planningDate, `members[${i}].birthDate`, out));
  }

  for (const rule of ruleSet.plausibility) {
    const target = rule.inputTarget;
    if (target === null) continue;
    switch (target.kind) {
      case "TIMED_MARK":
        if (subject.kind !== "ATHLETE") break;
        subject.profile.marks.forEach((mark, i) => {
          if (mark.date <= planningDate && mark.event === target.event) {
            checkPlausibility(ruleSet, rule, mark.timeS, `marks[${i}]`, out);
          }
        });
        break;
      case "HEIGHT_CM":
        for (const { label, maturity } of heightSeries) {
          for (const point of maturity.heightHistory ?? []) {
            checkPlausibility(ruleSet, rule, point.heightCm, `${label}.height@${point.date}`, out);
          }
        }
        break;
      case "COACH_EDIT_APPROACH_DISTANCE_M":
        for (const edit of request.coachEdits) {
          if (edit.field === "approachDistanceM") checkPlausibility(ruleSet, rule, edit.value, "coachEdits.approachDistanceM", out);
        }
        break;
    }
  }

  return out;
}
