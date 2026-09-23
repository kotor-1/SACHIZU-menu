/**
 * Running Prescription Engine v2 — RunningPrescription の RuleSet-aware 検証（§19.1）。
 *
 * [R4 helper file] `runningPrescriptionSchema`（Zod）は RuleSet を見ずに決まる構造
 * （method↔template の型、LONG の recoveryStructure、FlyRep の合計、sets/repsPerSet 非 null、
 * FieldValue の3層・origin と position の整合、MAX_INTENT の target=null、snapshot の stopPolicy id 一致等）を
 * 保証する。RuleSet に依存する次の整合は Zod の refine に偽装せず、ここで検証する:
 *   - ruleSet 参照（version / contentHash / status）
 *   - template の実在・method の一致・recoveryStructure が template の値と一致
 *   - stopPolicyId が MethodMeta に含まれ、recoveryStructure に適用される
 *   - monitoringSnapshot が plan 時点の RuleSet の StopPolicy / TimingTolerance 行と一致する（全 timing を含む）
 *   - intensity.reference.kind が MethodMeta で許可されている
 *   - FieldValue の範囲・evidenceIds が該当 Envelope セルと一致（エンジンが範囲を作っていない）
 *   - sets セルの無い template の sets が構造正規化規則（1・STRUCTURAL_FIXED）どおり
 *   - エンジンが置いた rest の位置が MIDDLE 以上
 *   - highSpeedExposureModel=NONE の露出が 0（RULE_DEFINITION）
 */
import type { EnvelopeCell, EnvelopeField, RuleSet } from "../rules/schema";
import type { FieldValue, RunningPrescriptionValue } from "../types/prescription";
import type { Unit } from "../types/primitives";
import { selectEnvelope } from "./envelope";
import { referenceCandidates } from "./individualize";
import { isAtOrAbove, positionPoint } from "./placement";

function sameRange(a: { min: number; max: number } | null, b: { min: number; max: number } | null): boolean {
  if (a === null || b === null) return a === b;
  return a.min === b.min && a.max === b.max;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkAgainstCell(problems: string[], label: string, fv: FieldValue<Unit>, cell: EnvelopeCell | undefined): void {
  if (!cell) {
    problems.push(`${label}: Envelope に対応するセルがありません`);
    return;
  }
  if (!sameRange(fv.recommended, cell.recommended) || !sameRange(fv.coachEditable, cell.coachEditable) || !sameRange(fv.hardSafety, cell.hardSafety)) {
    problems.push(`${label}: FieldValue の範囲が Envelope セルと一致しません`);
  }
  if (fv.evidenceIds.length !== cell.evidenceIds.length || fv.evidenceIds.some((id, i) => id !== cell.evidenceIds[i])) {
    problems.push(`${label}: evidenceIds が Envelope セルと一致しません`);
  }
}

function checkRestPosition(problems: string[], label: string, fv: FieldValue<"s">): void {
  if (fv.origin === "COACH" || fv.origin === "COACH_OVERRIDE") return;
  if (fv.origin !== "ENGINE_POSITIONED" || fv.position === null || fv.recommended === null) {
    problems.push(`${label}: エンジンの rest は recommended 内の位置で置く必要があります（origin=${fv.origin}）`);
    return;
  }
  if (!isAtOrAbove(fv.position, "MIDDLE") || fv.value < positionPoint(fv.recommended, "MIDDLE") - 1e-9) {
    problems.push(`${label}: rest が MIDDLE より短く置かれています`);
  }
}

/** SessionTemplate.fixedDistanceField が指すフィールドは template の値（TEMPLATE_FIXED、または同値の CoachOverride）。 */
function checkFixedDistance(problems: string[], label: string, fv: FieldValue<"m">, fixedByTemplate: boolean, fixedValue: number | undefined): void {
  if (fixedByTemplate) {
    if (!(fv.origin === "TEMPLATE_FIXED" || fv.origin === "COACH_OVERRIDE") || fv.value !== fixedValue) {
      problems.push(`${label}: SessionTemplate.fixedDistanceField の値（${fixedValue}）でなければなりません`);
    }
  } else if (fv.origin === "TEMPLATE_FIXED") {
    problems.push(`${label}: SessionTemplate.fixedDistanceField が指していないフィールドは TEMPLATE_FIXED にできません`);
  }
}

export function validatePrescriptionAgainstRuleSet(
  p: RunningPrescriptionValue,
  ruleSet: RuleSet,
  contentHash: string,
): string[] {
  const problems: string[] = [];

  if (p.ruleSet.version !== ruleSet.ruleSetVersion || p.ruleSet.status !== ruleSet.status || p.ruleSet.contentHash !== contentHash) {
    problems.push("ruleSet 参照が使用した RuleSet と一致しません");
  }

  const template = ruleSet.templates.find((t) => t.id === p.templateId);
  const methodMeta = ruleSet.methods.find((m) => m.method === p.method);
  if (!template || template.method !== p.method) problems.push("template が RuleSet に存在しないか method と一致しません");
  if (!methodMeta) {
    problems.push("MethodMeta がありません");
    return problems;
  }
  if (template && template.recoveryStructure !== p.recoveryStructure) {
    problems.push("recoveryStructure が template の定義と一致しません");
  }
  // [R9] 新しい plan の出力は loadSnapshot 必須で、plan に使った RuleSet の MethodMeta と一致する
  if (p.loadSnapshot === undefined) {
    problems.push("loadSnapshot がありません");
  } else if (p.loadSnapshot.loadClass !== methodMeta.loadClass || p.loadSnapshot.weeklyLoadCategory !== methodMeta.weeklyLoadCategory) {
    problems.push("loadSnapshot が plan 時点の RuleSet の MethodMeta と一致しません");
  }
  // [R10-B1] 新しい plan の出力は planningControls 必須（positionPreference の snapshot）
  if (p.planningControls === undefined) {
    problems.push("planningControls がありません");
  }

  // E10: 新しい Vdec plan は分類境界を snapshot するが、分類から数値 target を作らない。
  // 旧 snapshot は旧 target を持つ限り読み取り互換を維持する。
  if (p.intensity.reference.kind === "VELOCITY_DECREMENT") {
    const vdecPolicy = p.monitoringSnapshot.vdecClassificationPolicy;
    if (vdecPolicy !== undefined && canonical(vdecPolicy.bands) !== canonical(ruleSet.vdecClassificationBands)) {
      problems.push("monitoringSnapshot.vdecClassificationPolicy が plan 時点の RuleSet と一致しません");
    }
    if (p.intensity.target === null && vdecPolicy === undefined) {
      problems.push("新しい Vdec plan には vdecClassificationPolicy snapshot が必要です");
    }
  }

  const stopPolicy = ruleSet.stopPolicies.find((sp) => sp.id === p.stopPolicyId);
  if (
    !(methodMeta.stopPolicyIds as readonly string[]).includes(p.stopPolicyId) ||
    !stopPolicy ||
    stopPolicy.method !== p.method ||
    stopPolicy.appliesToRecoveryStructure !== p.recoveryStructure
  ) {
    problems.push("stopPolicyId が MethodMeta / recoveryStructure と一致しません");
  }
  if (stopPolicy && canonical(p.monitoringSnapshot.stopPolicy) !== canonical(stopPolicy)) {
    problems.push("monitoringSnapshot.stopPolicy が plan 時点の RuleSet の StopPolicy と一致しません");
  }
  if (canonical(p.monitoringSnapshot.timingTolerances) !== canonical(ruleSet.timingTolerances)) {
    problems.push("monitoringSnapshot.timingTolerances が plan 時点の RuleSet の TimingTolerance 全件と一致しません");
  }

  if (!referenceCandidates(methodMeta).includes(p.intensity.reference.kind)) {
    problems.push(`intensity.reference.kind=${p.intensity.reference.kind} は MethodMeta で許可されていません`);
  }

  if (methodMeta.highSpeedExposureModel === "NONE") {
    const e = p.exposure.plannedHighSpeedExposureM;
    if (e.lower !== 0 || e.upper !== 0 || e.source !== "RULE_DEFINITION") {
      problems.push("highSpeedExposureModel=NONE の露出は 0（RULE_DEFINITION）である必要があります");
    }
  }

  const envelopeResult = selectEnvelope(ruleSet, { method: p.method, templateId: p.templateId } as Parameters<typeof selectEnvelope>[1], p.tier, p.recoveryStructure);
  if (!envelopeResult.ok) {
    problems.push("tier × template の Envelope が見つかりません");
    return problems;
  }
  const cells = envelopeResult.envelope.fields;
  const cell = (f: EnvelopeField) => cells[f];

  // sets / repsPerSet
  if (cells.sets) {
    checkAgainstCell(problems, "sets", p.sets, cells.sets);
  } else if (
    p.sets.value !== 1 ||
    p.sets.origin !== "STRUCTURAL_FIXED" ||
    p.sets.position !== null ||
    p.sets.evidenceIds.length !== 0 ||
    !sameRange(p.sets.recommended, { min: 1, max: 1 })
  ) {
    problems.push("sets セルの無い template の sets は構造正規化規則（1・STRUCTURAL_FIXED・evidence なし）である必要があります");
  }
  const repsCell = cells.repsPerSet ?? cells.totalReps ?? cells.attempts;
  checkAgainstCell(problems, "repsPerSet", p.repsPerSet, repsCell);

  // rep
  const rep = p.rep;
  switch (rep.kind) {
    case "DISTANCE":
      checkAgainstCell(problems, "rep.distanceM", rep.distanceM, cell("repDistanceM"));
      checkFixedDistance(problems, "rep.distanceM", rep.distanceM, template?.fixedDistanceField === "repDistanceM", template?.displayDistanceM);
      break;
    case "FLY":
      checkAgainstCell(problems, "rep.buildUpDistanceM", rep.buildUpDistanceM, cell("buildUpM"));
      checkAgainstCell(problems, "rep.flyZoneDistanceM", rep.flyZoneDistanceM, cell("flyZoneM"));
      checkFixedDistance(problems, "rep.flyZoneDistanceM", rep.flyZoneDistanceM, template?.fixedDistanceField === "flyZoneM", template?.displayDistanceM);
      if ((rep.decelerationDistanceM === null) !== (cells.decelerationM === undefined)) {
        problems.push("decelerationDistanceM は decelerationM セルがあるときだけ値を持ちます");
      }
      break;
    case "DURATION":
      checkAgainstCell(problems, "rep.durationS", rep.durationS, cell("repDurationS"));
      break;
    case "SPLIT":
      rep.segments.forEach((seg, i) => {
        if (seg.restAfterS) checkAgainstCell(problems, `rep.segments[${i}].restAfterS`, seg.restAfterS, cell("intraRepRestS"));
      });
      break;
    case "ATTEMPTS":
      if (template?.approachType !== rep.approach) problems.push("rep.approach が SessionTemplate.approachType と一致しません");
      break;
  }

  // rest
  checkAgainstCell(problems, "rest.repRestS", p.rest.repRestS, cell("repRestS"));
  checkRestPosition(problems, "rest.repRestS", p.rest.repRestS);
  if (p.rest.setRestS) {
    checkAgainstCell(problems, "rest.setRestS", p.rest.setRestS, cell("setRestS"));
    checkRestPosition(problems, "rest.setRestS", p.rest.setRestS);
  }
  if (p.rest.intraRepRestS) {
    checkAgainstCell(problems, "rest.intraRepRestS", p.rest.intraRepRestS, cell("intraRepRestS"));
    checkRestPosition(problems, "rest.intraRepRestS", p.rest.intraRepRestS);
  }
  if ((p.rest.intraRepRestS !== null) !== (p.recoveryStructure === "INCOMPLETE")) {
    problems.push("intraRepRestS は LONG INCOMPLETE のときだけ値を持ちます");
  }

  return problems;
}
