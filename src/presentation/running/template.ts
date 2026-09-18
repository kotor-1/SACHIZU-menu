/**
 * Running Prescription Engine v2 — R10-B3 SessionTemplate の表示。
 *
 * 1. 新規追加 picker: 呼び出し側（B4 の integration boundary）が選んだ RuleSet から、picker に必要な
 *    template の表示データだけを DTO 化する。RuleSet JSON 全体は client へ渡さない。
 *    どの RuleSet を使うか・その template を選べるか（eligibility）はここで決めない。一覧は「候補」であり、
 *    `canAttemptSelection=true` は適格性の保証ではない（最終判定は planRunningItemAction の plan 結果）。
 *    domain の判定結果（EligibilityReason）を渡されたときだけ canAttemptSelection=false と理由文を付ける。
 * 2. 保存済み item の題名: plan 時点の snapshot を優先し、現行 RuleSet の label を primary source にしない。
 *      ① prescriptionJson の構造化 RationaleLine `TEMPLATE_SELECTED.params.templateLabelJa`
 *      ② 保存済み MenuItem.displayName（snapshot-safe な値。文字列を分解しない）
 *      ③ 保存時と exact identity が一致した RuleSet の template.labelJa
 *    日本語の理由文（MenuItem.rationale）を解析して題名を取り出すことはしない。
 */
import type { EligibilityReason } from "@/domain/running/planning/schema";
import type { RuleSet } from "@/domain/running/rules/schema";
import { RUNNING_TRAINING_METHODS } from "@/domain/running/types/method";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { SessionTemplateId } from "@/domain/running/types/template";
import type { RunningTemplateGroupDto, RunningTemplateOptionDto, RunningTemplatePickerDto } from "./dto";
import { eligibilityReasonMessageJa } from "./finding-messages";
import { METHOD_LABEL_JA, RECOVERY_STRUCTURE_LABEL_JA, RULE_SET_NOTICE_LABEL_JA } from "./labels";

/** [R10-B4A] picker は候補一覧であり、適格性の判定ではない。 */
export const TEMPLATE_CANDIDATE_NOTE_JA = "一覧は候補です。この対象・条件で選べるかは、追加するときに判定します。";

/** 保存済み item の題名が何からも取れないときの汎用名。 */
export const RUNNING_ITEM_FALLBACK_TITLE_JA = "走トレーニング";

export type TemplateAvailability = ReadonlyMap<string, { reasons: readonly EligibilityReason[] }>;

export function presentTemplatePicker(ruleSet: RuleSet, options: { unavailable?: TemplateAvailability } = {}): RunningTemplatePickerDto {
  const groups: RunningTemplateGroupDto[] = [];
  for (const method of RUNNING_TRAINING_METHODS) {
    const templates = ruleSet.templates.filter((t) => t.method === method);
    if (templates.length === 0) continue;
    // [R10-B4A.2] RuleSet のデータ（許可された参照 kind）をそのまま写す。Method 名で分岐しない。
    const acceptsCoachTargetSplit = (ruleSet.methods.find((m) => m.method === method)?.allowedIntensityReferences as readonly string[] | undefined)?.includes("TARGET_SPLIT") ?? false;
    groups.push({
      methodInternal: method,
      groupLabel: METHOD_LABEL_JA[method],
      options: templates.map((t): RunningTemplateOptionDto => {
        const restriction = options.unavailable?.get(t.id);
        const messages = restriction ? [...new Set(restriction.reasons.map((r) => eligibilityReasonMessageJa(r.code)))] : [];
        return {
          key: `${method}:${t.id}`,
          methodInternal: method,
          templateIdInternal: t.id as SessionTemplateId,
          label: t.labelJa,
          aliases: [...t.coachingAliases],
          recoveryLabel: t.recoveryStructure === null ? null : RECOVERY_STRUCTURE_LABEL_JA[t.recoveryStructure],
          advancedOnly: t.advancedOnly,
          advancedOnlyLabel: t.advancedOnly ? "上級者向け" : null,
          canAttemptSelection: restriction === undefined,
          restrictionMessage: restriction === undefined ? null : messages.length > 0 ? messages.join(" ") : "この条件では選べません。",
          acceptsCoachTargetSplit,
        };
      }),
    });
  }
  return { ruleSetNoticeLabel: RULE_SET_NOTICE_LABEL_JA[ruleSet.status], candidateNote: TEMPLATE_CANDIDATE_NOTE_JA, groups };
}

/** ① 構造化 RationaleLine の params だけを読む（文章は読まない）。 */
export function savedTemplateLabelOf(prescription: RunningPrescriptionValue): string | null {
  const line = prescription.rationale.find((l) => l.code === "TEMPLATE_SELECTED");
  const label = line?.params?.templateLabelJa;
  return typeof label === "string" && label.trim() !== "" ? label : null;
}

export function savedItemTitle(args: {
  prescription: RunningPrescriptionValue;
  displayName: string | null;
  exactRuleSet: RuleSet | null;
}): string {
  const fromSnapshot = savedTemplateLabelOf(args.prescription);
  if (fromSnapshot !== null) return fromSnapshot;
  if (args.displayName !== null && args.displayName.trim() !== "") return args.displayName;
  const fromExact = args.exactRuleSet?.templates.find((t) => t.id === args.prescription.templateId)?.labelJa;
  return fromExact ?? RUNNING_ITEM_FALLBACK_TITLE_JA;
}
