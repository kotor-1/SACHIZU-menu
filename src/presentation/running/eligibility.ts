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

const TI_GROUP_CREATE_UNAVAILABLE_MESSAGE =
  "このグループ向け新規作成では、TIに必要な選手別の測定済み基準値を利用できません。コーチ入力値や適格性の例外設定で測定値を代替できないため、この画面からTIは追加できません。";

export function groupCreateMethodPolicy(method: string | null): {
  available: boolean;
  eligibilityOverrideAvailable: boolean;
  message: string | null;
} {
  if (method === "TEMPO_INTENSIVE") {
    return { available: false, eligibilityOverrideAvailable: false, message: TI_GROUP_CREATE_UNAVAILABLE_MESSAGE };
  }
  return { available: true, eligibilityOverrideAvailable: true, message: null };
}

/** Create-form override controls are offered only for an actual Rule ID that domain marked overrideable. */
export function eligibilityOverrideOptions(
  reasons: readonly EligibilityReasonPresentationDto[],
  method: string | null = null,
): EligibilityReasonPresentationDto[] {
  if (!groupCreateMethodPolicy(method).eligibilityOverrideAvailable) return [];
  return reasons.filter((reason) => reason.overrideAllowed && reason.ruleIdInternal !== null);
}
