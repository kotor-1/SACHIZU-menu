/**
 * Running Prescription Engine v2 — [R10-B4B] 保存済みメニューの R6 集計（application helper）。
 *
 * "use server" を付けない通常の server module。B2（`_session-planning-service.ts`）が
 * session 作成時に行っていた「保存済みの RUNNING_V2 + LEGACY 項目をメニュー単位で評価する」部分だけを
 * ここへ抽出し、Menu 画面（B4B）と session 作成（B2）で**同じ policy を共有**する。
 *
 * ここでやること（B2 から移したものと完全に同じ）:
 *   1. RUNNING_V2 項目の exact RuleSet identity を group する（`getRuleSetByIdentity` のみ。active へ fallback しない）
 *   2. RunningMenuContext（GROUP subject / availableMinutes）を読む
 *   3. RUNNING_V2 の prescriptionJson を全件 parse する
 *   4. R6 `evaluateSessionAggregation` + `checkSessionPlausibility` + `checkLegacyItemPlausibility`
 *
 * ここでやらないこと（呼び出し側の責務のまま）:
 *   - fingerprint / weekly context / session 作成の可否判定（B2）
 *   - 表示用の日本語化（B3 presentation）
 *   - plan()（B4B は「保存済みの評価」だけ。再計画ではない）
 *
 * `competitionDay` は呼び出し側が決める。B2 は「実際にセッションを作る日」、B4B のメニュー画面は
 * 「メニューの計画日」で判定する（どちらも日付比較は competition domain の helper に任せる）。
 */
import {
  getRuleSetByIdentity,
  type AggregationItem,
  type Finding,
  type RuleSet,
  type SessionAggregate,
} from "@/domain/running";
import { evaluateSessionAggregation } from "@/domain/running/aggregation";
import type { CompetitionDayState } from "@/domain/running/aggregation/schema";
import { checkLegacyItemPlausibility, checkSessionPlausibility } from "@/domain/running/plausibility";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import type { RunningMenuContext } from "@/domain/running/persistence/menuContext";
import type { PLANNING_NOT_EVALUATED_REASONS } from "@/domain/running/persistence/sessionSnapshot";
import { runningPrescriptionSchema, type RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { MenuDetail } from "@/infra/repositories/menu-repository";
import { findMenuRunningContext } from "@/infra/repositories/running-item-repository";

/**
 * この helper が返しうる「評価しなかった理由」。B2 は SNAPSHOT_JSON_INVALID 以外をそのまま
 * REQUIRE_COACH_REVIEW の Finding code として使うため、日本語 message の網羅性テストがここを参照する。
 */
export const STORED_MENU_NOT_EVALUATED_REASONS = [
  "RULESET_VERSION_UNAVAILABLE",
  "MIXED_RULESET_VERSIONS",
  "RUNNING_CONTEXT_UNAVAILABLE",
  "SNAPSHOT_JSON_INVALID",
] as const satisfies readonly (typeof PLANNING_NOT_EVALUATED_REASONS)[number][];

export type StoredRunningMenuNotEvaluatedReason = (typeof STORED_MENU_NOT_EVALUATED_REASONS)[number];

export type MenuItemRow = MenuDetail["blocks"][number]["items"][number];

export type StoredRunningMenuEvaluation =
  /** RUNNING_V2 項目が無い（legacy-only）。評価しない。 */
  | { status: "SKIP" }
  /** 評価に必要な前提が欠けている（版が混在している・context が無い・JSON が壊れている等）。 */
  | { status: "NOT_EVALUATED"; reason: StoredRunningMenuNotEvaluatedReason }
  | {
      status: "EVALUATED";
      ruleSet: RuleSet;
      ruleSetRef: { version: string; contentHash: string };
      context: RunningMenuContext;
      /** 保存済み処方（item 順）。 */
      parsedV2: { itemId: string; prescription: RunningPrescriptionValue }[];
      aggregate: SessionAggregate;
      /** R6 aggregate 以外の（メニュー全体・legacy 項目の）妥当性 Finding。 */
      plausibilityFindings: Finding[];
      competitionDay: CompetitionDayState;
    };

/** legacy MenuItem に Exercise が無い（自由入力）ときの category fallback。RuleSet 側で必ず UNKNOWN 扱いになる。 */
const LEGACY_NO_EXERCISE_CATEGORY = "OTHER";

/** アグリゲーション対象にする legacy 1件（§11 の最小要約）。 */
export function legacyAggregationSummary(item: MenuItemRow) {
  return {
    category: item.exercise?.category ?? LEGACY_NO_EXERCISE_CATEGORY,
    sets: item.sets,
    reps: item.reps,
    distanceMeters: item.distanceMeters,
    durationSeconds: item.durationSeconds,
    restSeconds: item.restSeconds,
  };
}

export function menuItemRows(menu: MenuDetail): MenuItemRow[] {
  return menu.blocks.flatMap((block) => block.items);
}

/**
 * 保存済みメニューを R6 で評価する。
 *
 * `competitionDayFor` は context を読んだ後に呼ばれる（B2 はセッション日で判定するため context を使わない）。
 */
export async function evaluateStoredRunningMenu(args: {
  menu: MenuDetail;
  competitionDayFor: (context: RunningMenuContext) => Promise<CompetitionDayState> | CompetitionDayState;
}): Promise<StoredRunningMenuEvaluation> {
  const { menu } = args;
  const allRows = menuItemRows(menu);
  const v2Rows = allRows.filter((item) => item.prescriptionKind === "RUNNING_V2");
  if (v2Rows.length === 0) return { status: "SKIP" };

  // ---- RUNNING_V2 項目の exact RuleSet identity を group する ----
  const identities = new Set<string>();
  let anyMissingIdentity = false;
  for (const item of v2Rows) {
    if (item.ruleSetVersion === null || item.ruleSetContentHash === null) {
      anyMissingIdentity = true;
      continue;
    }
    identities.add(`${item.ruleSetVersion} ${item.ruleSetContentHash}`);
  }
  if (anyMissingIdentity || identities.size === 0) return { status: "NOT_EVALUATED", reason: "RULESET_VERSION_UNAVAILABLE" };
  if (identities.size > 1) return { status: "NOT_EVALUATED", reason: "MIXED_RULESET_VERSIONS" };

  const [version, contentHash] = [...identities][0]!.split(" ") as [string, string];
  const resolved = getRuleSetByIdentity({ version, contentHash });
  if (resolved.status !== "OK") return { status: "NOT_EVALUATED", reason: "RULESET_VERSION_UNAVAILABLE" };
  const ruleSet = resolved.ruleSet;
  const ruleSetRef = { version, contentHash };

  // ---- RunningMenuContext（GROUP subject / availableMinutes）----
  const contextResult = await findMenuRunningContext(menu.id);
  if (contextResult === null || contextResult.status !== "VALID") return { status: "NOT_EVALUATED", reason: "RUNNING_CONTEXT_UNAVAILABLE" };
  const context = contextResult.context;

  // ---- RUNNING_V2 項目の prescriptionJson を全件 parse できなければ集計しない ----
  const parsedV2: { itemId: string; prescription: RunningPrescriptionValue }[] = [];
  let anyInvalidJson = false;
  for (const item of v2Rows) {
    const parsed = parseJsonColumn(item.prescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
    if (!parsed.ok) {
      anyInvalidJson = true;
      continue;
    }
    parsedV2.push({ itemId: item.id, prescription: parsed.value });
  }
  if (anyInvalidJson) return { status: "NOT_EVALUATED", reason: "SNAPSHOT_JSON_INVALID" };

  // ---- R6 aggregation（RUNNING_V2 + LEGACY 全件）----
  const aggregationItems: AggregationItem[] = allRows.map((item) => {
    if (item.prescriptionKind === "RUNNING_V2") {
      const found = parsedV2.find((p) => p.itemId === item.id)!;
      return { kind: "RUNNING_V2", prescription: found.prescription };
    }
    return { kind: "LEGACY", item: legacyAggregationSummary(item) };
  });

  // GROUP の tier は §4.1 と同じ「1人でも DEVELOPMENTAL なら全体も DEVELOPMENTAL」を、
  // 個々の項目の保存済み tier（plan 時点で解決済み）に対して適用する（tier を再導出しない）。
  const tier = parsedV2.every((p) => p.prescription.tier === "ADVANCED") ? "ADVANCED" : "DEVELOPMENTAL";

  const competitionDay = await args.competitionDayFor(context);

  const aggregate = evaluateSessionAggregation(aggregationItems, {
    ruleSet,
    tier,
    availableMinutes: context.availableMinutes,
    competitionDay,
    mode: "PLANNING",
  });
  const sessionPlausibility = checkSessionPlausibility(aggregate.totalRunningDistanceM, ruleSet);
  const legacyPlausibilityFindings = allRows
    .filter((item) => item.prescriptionKind !== "RUNNING_V2")
    .flatMap((item) => checkLegacyItemPlausibility(legacyAggregationSummary(item), ruleSet).findings);

  return {
    status: "EVALUATED",
    ruleSet,
    ruleSetRef,
    context,
    parsedV2,
    aggregate,
    plausibilityFindings: [...sessionPlausibility.findings, ...legacyPlausibilityFindings],
    competitionDay,
  };
}
