/**
 * Running Prescription Engine v2 — R10-B3 server presentation service。
 *
 * **server 専用**（Server Component / Server Action から呼ぶ。Client Component から import しない）。
 * 責務:
 *   MenuItem 行 → prescriptionJson を parse → provenanceJson を parse
 *   → 保存時の `ruleSetVersion + ruleSetContentHash` と完全一致する RuleSet を（あれば）読む
 *   → RunningItemPresentationDto
 *
 * - RuleSet は `getRuleSetByIdentity`（exact identity）だけで読む。`getActiveRuleSet` 等の active selector へ
 *   fallback しない。一致しなければ Evidence の詳細と aggregate field の範囲を出さないだけで、処方の表示は続ける。
 * - Prisma を直接使わない（呼び出し側が repository で読んだ行を渡す）。Prisma model / RuleSet object を
 *   client へ渡さない（返すのは DTO だけ）。
 * - feature flag（RUNNING_V2_UI_ENABLED）はここでは読まない（B4 の integration boundary の責務）。
 */
import type { EligibilityReason } from "@/domain/running/planning/schema";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { provenanceSchema } from "@/domain/running/persistence/provenance";
import { getRuleSetByIdentity, type RuleSetIdentityResult } from "@/domain/running/rules/loader";
import type { Finding } from "@/domain/running/types/findings";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";
import type { RunningItemPresentationDto } from "./dto";
import { presentRunningItem } from "./item";
import type { ExactRuleSetLookup } from "./provenance";
import { RUNNING_ITEM_FALLBACK_TITLE_JA } from "./template";

/** repository（MenuItemDetail 等）から渡す最小限の列。Prisma の型には依存しない。 */
export type SavedRunningMenuItemRow = {
  id: string;
  displayName: string | null;
  rationale: string | null;
  prescriptionKind: string;
  prescriptionJson: string | null;
  provenanceJson: string | null;
  ruleSetVersion: string | null;
  ruleSetContentHash: string | null;
};

export type RuleSetIdentityResolver = (identity: { version: string; contentHash: string }) => RuleSetIdentityResult;

export type SavedRunningItemPresentation =
  | { status: "OK"; item: RunningItemPresentationDto }
  /** 処方 JSON を読めない（壊れている）。題名だけ表示し、数値は出さない。 */
  | { status: "UNREADABLE"; id: string; title: string; message: string }
  | { status: "NOT_RUNNING_V2"; id: string };

export const PRESCRIPTION_UNREADABLE_MESSAGE_JA = "この項目の処方データを読み込めません。内容を確認してください。";

/** 保存時の identity と完全一致した RuleSet だけを返す（処方・provenance の版とも一致すること）。 */
export function lookupExactRuleSet(
  row: Pick<SavedRunningMenuItemRow, "ruleSetVersion" | "ruleSetContentHash">,
  storedIdentities: readonly { version: string; contentHash: string }[],
  resolve: RuleSetIdentityResolver = getRuleSetByIdentity,
): ExactRuleSetLookup {
  if (row.ruleSetVersion === null || row.ruleSetContentHash === null) return { status: "UNAVAILABLE" };
  const consistent = storedIdentities.every((id) => id.version === row.ruleSetVersion && id.contentHash === row.ruleSetContentHash);
  if (!consistent) return { status: "UNAVAILABLE" };
  const result = resolve({ version: row.ruleSetVersion, contentHash: row.ruleSetContentHash });
  return result.status === "OK" ? { status: "OK", ruleSet: result.ruleSet } : { status: "UNAVAILABLE" };
}

export function presentSavedRunningMenuItem(
  row: SavedRunningMenuItemRow,
  options: {
    resolveRuleSetByIdentity?: RuleSetIdentityResolver;
    sessionFindings?: readonly Finding[];
    eligibilityReasons?: readonly EligibilityReason[];
  } = {},
): SavedRunningItemPresentation {
  if (row.prescriptionKind !== "RUNNING_V2") return { status: "NOT_RUNNING_V2", id: row.id };

  const prescription = parseJsonColumn(row.prescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
  if (!prescription.ok) {
    return {
      status: "UNREADABLE",
      id: row.id,
      title: row.displayName !== null && row.displayName.trim() !== "" ? row.displayName : RUNNING_ITEM_FALLBACK_TITLE_JA,
      message: PRESCRIPTION_UNREADABLE_MESSAGE_JA,
    };
  }
  const provenance = parseJsonColumn(row.provenanceJson, provenanceSchema, { rejectHealthKeys: true });

  const storedIdentities = [
    { version: prescription.value.ruleSet.version, contentHash: prescription.value.ruleSet.contentHash },
    ...(provenance.ok ? [{ version: provenance.value.ruleSet.version, contentHash: provenance.value.ruleSet.contentHash }] : []),
  ];
  const exactRuleSet = lookupExactRuleSet(row, storedIdentities, options.resolveRuleSetByIdentity);

  return {
    status: "OK",
    item: presentRunningItem({
      id: row.id,
      displayName: row.displayName,
      rationale: row.rationale,
      prescription: prescription.value,
      provenance: provenance.ok ? provenance.value : null,
      exactRuleSet,
      sessionFindings: options.sessionFindings,
      eligibilityReasons: options.eligibilityReasons,
    }),
  };
}
