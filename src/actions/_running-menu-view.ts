/**
 * Running Prescription Engine v2 — [R10-B4B] Menu 画面へ渡す DTO の組み立て（server 専用）。
 *
 * "use server" を付けない通常の server module（Server Component から呼ぶ）。
 *
 * 守ること:
 *   - **client へ渡すのは DTO だけ。** RuleSet オブジェクト・Prisma モデル・処方 JSON をそのまま渡さない。
 *   - RuleSet は 2 通りの読み方を混ぜない:
 *       保存済み項目の表示 → `presentSavedRunningMenuItem`（保存時の identity と完全一致のみ）
 *       新規追加の候補     → `templatePickerForMenu`（計画日の active 版。plan と同じ規則）
 *   - feature flag はここでは読まない（呼ぶ側の Server Component が判断する）。ここが呼ばれた時点で ON。
 *   - 計画日・対象グループをこの層で補完しない（未設定なら「未設定」として返す）。
 */
import { resolveCompetitionDay } from "@/domain/running/competition";
import type { CompetitionDayState } from "@/domain/running/aggregation/schema";
import type { RunningMenuContext } from "@/domain/running/persistence/menuContext";
import type { IsoDate } from "@/domain/running/types/primitives";
import { listCompetitionRefs } from "@/infra/repositories/competition-repository";
import type { MenuDetail } from "@/infra/repositories/menu-repository";
import { findMenuRunningContext } from "@/infra/repositories/running-item-repository";
import { contextDraftFrom, type RunningContextDraft } from "@/presentation/running/menu-context";
import { presentMenuAggregation, type MenuAggregationDto } from "@/presentation/running/menu";
import { presentSavedRunningMenuItem, type SavedRunningItemPresentation } from "@/presentation/running/server";
import { evaluateStoredRunningMenu, menuItemRows } from "./_running-menu-evaluation";
import { templatePickerForPlannedDate, type TemplatePickerProviderResult } from "./_running-template-options";

export type RunningContextView = {
  status: "NONE" | "VALID" | "INVALID";
  /** 入力欄の初期値。壊れている・未設定なら空（今日の日付などで補わない）。 */
  draft: RunningContextDraft;
  /** 壊れている場合の案内（安全側の説明。自動では直さない）。 */
  message: string | null;
  /** 計画日（未設定なら null）。候補の取得・表示に使う。 */
  plannedDate: string | null;
};

export type RunningMenuView = {
  context: RunningContextView;
  picker: TemplatePickerProviderResult;
  /** MenuItem.id → 保存済み走項目の表示（RUNNING_V2 の行だけ）。 */
  items: Record<string, SavedRunningItemPresentation>;
  aggregation: MenuAggregationDto;
};

export const RUNNING_CONTEXT_UNREADABLE_MESSAGE_JA =
  "保存されている対象グループ・計画日の設定を読み込めませんでした。内容を入力して保存し直すと置き換わります。";

async function readContext(menuId: string): Promise<RunningContextView> {
  const result = await findMenuRunningContext(menuId);
  if (result === null || result.status === "NONE") {
    return { status: "NONE", draft: contextDraftFrom(null), message: null, plannedDate: null };
  }
  if (result.status === "INVALID") {
    return { status: "INVALID", draft: contextDraftFrom(null), message: RUNNING_CONTEXT_UNREADABLE_MESSAGE_JA, plannedDate: null };
  }
  return { status: "VALID", draft: contextDraftFrom(result.context), message: null, plannedDate: result.context.plannedDate };
}

/** メニューの計画日で「大会の期間中か」を判定する（日付比較は competition domain に任せる）。 */
async function competitionDayForMenu(context: RunningMenuContext): Promise<CompetitionDayState> {
  if (context.plannedDate === null) return "NOT_EVALUATED";
  return resolveCompetitionDay(context.plannedDate as IsoDate, await listCompetitionRefs());
}

export async function buildRunningMenuView(menu: MenuDetail): Promise<RunningMenuView> {
  const context = await readContext(menu.id);

  const items: Record<string, SavedRunningItemPresentation> = {};
  for (const row of menuItemRows(menu)) {
    if (row.prescriptionKind !== "RUNNING_V2") continue;
    items[row.id] = presentSavedRunningMenuItem({
      id: row.id,
      displayName: row.displayName,
      rationale: row.rationale,
      prescriptionKind: row.prescriptionKind,
      prescriptionJson: row.prescriptionJson,
      provenanceJson: row.provenanceJson,
      ruleSetVersion: row.ruleSetVersion,
      ruleSetContentHash: row.ruleSetContentHash,
      note: row.note,
    });
  }

  const evaluation = await evaluateStoredRunningMenu({ menu, competitionDayFor: competitionDayForMenu });

  return {
    context,
    picker: templatePickerForPlannedDate(context.plannedDate),
    items,
    aggregation: presentMenuAggregation(
      evaluation.status === "EVALUATED"
        ? {
            status: "EVALUATED",
            aggregate: evaluation.aggregate,
            plausibilityFindings: evaluation.plausibilityFindings,
            competitionDay: evaluation.competitionDay,
          }
        : evaluation,
    ),
  };
}
