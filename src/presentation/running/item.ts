/**
 * Running Prescription Engine v2 — R10-B3 保存済み RUNNING_V2 項目 → RunningItemPresentationDto（純粋関数）。
 *
 * - 理由本文は保存済み `MenuItem.rationale` をそのまま使う（R9 contract: 後から再レンダリングしない）。
 *   `rationale/render-ja.ts` はここから呼ばない。
 * - 題名は plan 時点の snapshot を優先する（`template.ts` の `savedItemTitle`）。
 * - `canEdit` / `canRecalculate` は表示上の目安（B1 の Action が要求する保存済み前提がそろっているか）。
 *   最終的な可否は Action / domain が判定する。
 */
import type { EligibilityReason } from "@/domain/running/planning/schema";
import type { Provenance } from "@/domain/running/persistence/provenance";
import type { Finding } from "@/domain/running/types/findings";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { RunningItemPresentationDto } from "./dto";
import { presentConfidence } from "./confidence";
import { presentDose } from "./dose";
import { presentEditor } from "./editor";
import { presentFindings } from "./findings";
import { formatIsoDateJa } from "./format";
import { METHOD_LABEL_JA, RECOVERY_STRUCTURE_LABEL_JA } from "./labels";
import { presentProvenance, type ExactRuleSetLookup } from "./provenance";
import { savedItemTitle } from "./template";

export const RATIONALE_MISSING_MESSAGE_JA = "保存された処方の根拠の文章がありません。";

export type RunningItemPresentationInput = {
  id: string;
  displayName: string | null;
  /** 保存済み MenuItem.rationale（plan 時点でレンダリング済みの日本語）。 */
  rationale: string | null;
  prescription: RunningPrescriptionValue;
  /** 読めなかった場合は null（処方の表示は続ける）。 */
  provenance: Provenance | null;
  exactRuleSet: ExactRuleSetLookup;
  /** Action が返したメニュー全体の Finding（永続化されない）。 */
  sessionFindings?: readonly Finding[];
  /** domain の INELIGIBLE 結果（override 可能な規則だけを editor に出す）。 */
  eligibilityReasons?: readonly EligibilityReason[];
};

export function presentRunningItem(input: RunningItemPresentationInput): RunningItemPresentationDto {
  const p = input.prescription;
  // [R10-B4A] 保存時にコーチが明示確認した REQUIRE_CONFIRMATION は、Finding を残したまま「確認済み」の記録を添える。
  const confirmations = new Map((input.provenance?.findingConfirmations ?? []).map((c) => [c.code, c.at]));
  const findings = presentFindings(p.findings).map((f) => {
    const at = f.requiresExplicitConfirmation ? confirmations.get(f.developerCode) : undefined;
    return at === undefined ? f : { ...f, confirmationRecordLabel: `コーチ確認済み（${formatIsoDateJa(at) ?? "日時不明"}）` };
  });
  const sessionFindings = presentFindings(input.sessionFindings ?? []);

  const exactAvailable = input.exactRuleSet.status === "OK";
  const hasReplanSnapshot = p.planningControls !== undefined;
  const editUnavailableMessage = !exactAvailable
    ? "保存時のルールの版を確認できないため、この画面では変更できません。"
    : !hasReplanSnapshot
      ? "この処方は再計算に必要な情報を持っていないため、この画面では変更できません。"
      : null;

  return {
    id: input.id,
    title: savedItemTitle({
      prescription: p,
      displayName: input.displayName,
      exactRuleSet: input.exactRuleSet.status === "OK" ? input.exactRuleSet.ruleSet : null,
    }),
    subtitle: p.recoveryStructure === null ? METHOD_LABEL_JA[p.method] : `${METHOD_LABEL_JA[p.method]}・${RECOVERY_STRUCTURE_LABEL_JA[p.recoveryStructure]}`,
    methodInternal: p.method,
    templateIdInternal: p.templateId,
    dose: presentDose(p),
    confidence: presentConfidence(p.confidence, p.ruleSet.status),
    findings,
    sessionFindings,
    rationaleText: input.rationale !== null && input.rationale.trim() !== "" ? input.rationale : RATIONALE_MISSING_MESSAGE_JA,
    provenance: presentProvenance(input.provenance, input.exactRuleSet),
    editor: presentEditor(p, input.exactRuleSet, input.eligibilityReasons ?? []),
    canEdit: editUnavailableMessage === null,
    canRecalculate: editUnavailableMessage === null,
    editUnavailableMessage,
    needsCoachReview: [...findings, ...sessionFindings].some((f) => f.needsCoachReview),
  };
}
