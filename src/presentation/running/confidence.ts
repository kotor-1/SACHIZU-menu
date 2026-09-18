/**
 * Running Prescription Engine v2 — R10-B3 confidence / RuleSet status の表示。
 *
 * `prescriptionConfidence = POLICY_ONLY`（暫定ルール）と `RuleSet.status = DRAFT`（ルールセット 暫定版）は
 * 別の事実。片方からもう片方を推測せず、両方を独立に表示できる DTO にする。
 */
import type { RuleSetStatus } from "@/domain/running/rules/schema";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { ConfidencePresentationDto } from "./dto";
import {
  DIRECTNESS_DESCRIPTION_JA,
  DIRECTNESS_LABEL_JA,
  INPUT_DATA_CONFIDENCE_LABEL_JA,
  PRESCRIPTION_CONFIDENCE_DESCRIPTION_JA,
  PRESCRIPTION_CONFIDENCE_LABEL_JA,
  PRESCRIPTION_CONFIDENCE_TONE,
  RULE_SET_NOTICE_LABEL_JA,
  RULE_SET_STATUS_LABEL_JA,
} from "./labels";

export function presentConfidence(
  confidence: RunningPrescriptionValue["confidence"],
  ruleSetStatus: RuleSetStatus,
): ConfidencePresentationDto {
  return {
    prescriptionLabel: PRESCRIPTION_CONFIDENCE_LABEL_JA[confidence.prescription],
    prescriptionDescription: PRESCRIPTION_CONFIDENCE_DESCRIPTION_JA[confidence.prescription],
    prescriptionTone: PRESCRIPTION_CONFIDENCE_TONE[confidence.prescription],
    isPolicyOnly: confidence.prescription === "POLICY_ONLY",
    directnessLabel: DIRECTNESS_LABEL_JA[confidence.directness],
    directnessDescription: DIRECTNESS_DESCRIPTION_JA[confidence.directness],
    inputDataLabel: INPUT_DATA_CONFIDENCE_LABEL_JA[confidence.inputData],
    ruleSetStatusLabel: RULE_SET_STATUS_LABEL_JA[ruleSetStatus],
    ruleSetNoticeLabel: RULE_SET_NOTICE_LABEL_JA[ruleSetStatus],
    ruleSetIsDraft: ruleSetStatus === "DRAFT",
  };
}
