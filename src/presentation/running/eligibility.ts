/**
 * Running Prescription Engine v2 — [R10-B4A] EligibilityReason → 表示用 DTO。
 *
 * INELIGIBLE の理由を B3 の message registry で日本語にするだけ。override の可否は domain が返した
 * `overrideAllowed` をそのまま写し、code 文字列から推測しない。
 */
import type { EligibilityReason } from "@/domain/running/planning/schema";
import type { EligibilityReasonPresentationDto } from "./dto";
import { eligibilityReasonMessageJa } from "./finding-messages";

export function presentEligibilityReasons(reasons: readonly EligibilityReason[]): EligibilityReasonPresentationDto[] {
  const seen = new Set<string>();
  const out: EligibilityReasonPresentationDto[] = [];
  for (const reason of reasons) {
    const key = `${reason.code}|${reason.ruleId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      developerCode: reason.code,
      message: eligibilityReasonMessageJa(reason.code),
      ruleIdInternal: reason.ruleId,
      overrideAllowed: reason.overrideAllowed === true,
    });
  }
  return out;
}
