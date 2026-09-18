/**
 * Running Prescription Engine v2 — [R10-B4A] 新規追加 picker 用の template 候補 provider（server 専用）。
 *
 * "use server" を付けない通常の server module（Server Component / Server Action から呼ぶ）。
 *   plannedDate → getActiveRuleSet(plannedDate) → templates → B3 の RunningTemplateOptionDto[]
 *
 * - RuleSet の選択は新規 plan（`planNewRunningItem`）と同じ規則: メニューの `plannedDate` 基準の active 版。
 *   plannedDate が無ければ候補を出さない（当日などで代用しない）。
 * - client へ渡すのは DTO だけ（RuleSet object / JSON 全体は渡さない）。
 * - 一覧は**候補**であり、eligibility の判定ではない（planせずに適格性だけを判定する domain API は作らない）。
 *   最終的に選べるかは `planRunningItemAction` の plan 結果（PLAN_INELIGIBLE 等）が決める。
 * - feature flag は読まない（B4-B の integration boundary が切り替える）。
 */
import { getActiveRuleSet } from "@/domain/running";
import { isValidCalendarDate } from "@/domain/running/planning/schema";
import { isoDateSchema } from "@/domain/running/types/primitives";
import { findMenuRunningContext } from "@/infra/repositories/running-item-repository";
import type { RunningTemplatePickerDto } from "@/presentation/running/dto";
import { presentTemplatePicker } from "@/presentation/running/template";

export type TemplatePickerProviderResult =
  | { status: "OK"; picker: RunningTemplatePickerDto }
  | { status: "UNAVAILABLE"; message: string };

export const PLANNED_DATE_REQUIRED_FOR_PICKER_JA = "計画日が設定されていないため、練習の型の候補を表示できません。先に計画日を設定してください。";
export const RULESET_UNAVAILABLE_FOR_PICKER_JA = "この計画日に使えるルールセットが見つからないため、練習の型の候補を表示できません。";

export function templatePickerForPlannedDate(plannedDate: string | null): TemplatePickerProviderResult {
  const date = plannedDate === null ? null : isoDateSchema.safeParse(plannedDate);
  if (date === null || !date.success || !isValidCalendarDate(date.data)) {
    return { status: "UNAVAILABLE", message: PLANNED_DATE_REQUIRED_FOR_PICKER_JA };
  }
  let ruleSet;
  try {
    ruleSet = getActiveRuleSet(date.data).ruleSet;
  } catch {
    return { status: "UNAVAILABLE", message: RULESET_UNAVAILABLE_FOR_PICKER_JA };
  }
  return { status: "OK", picker: presentTemplatePicker(ruleSet) };
}

/** メニューに保存された RunningMenuContext.plannedDate を使う。 */
export async function templatePickerForMenu(menuId: string): Promise<TemplatePickerProviderResult> {
  const context = await findMenuRunningContext(menuId);
  if (context === null) return { status: "UNAVAILABLE", message: "メニューが見つかりません。" };
  if (context.status !== "VALID") return { status: "UNAVAILABLE", message: PLANNED_DATE_REQUIRED_FOR_PICKER_JA };
  return templatePickerForPlannedDate(context.context.plannedDate);
}
