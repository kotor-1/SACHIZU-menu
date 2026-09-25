import { createHash } from "node:crypto";
import { canonicalSourceMenuFingerprintPayload, type FingerprintMenuItemInput } from "@/domain/running/persistence/sessionSnapshot";

/**
 * [R10-B2] `SessionPlanningEvaluationInput.sourceMenuFingerprint`（§30〜§37）の実体。
 *
 * `src/domain/running/**` は Node.js 組み込みモジュールに依存できない（正式仕様 §1.6）ため、
 * SHA-256 の digest 計算だけをここに置く。canonicalization（何を・どの順で含めるか）は
 * domain の `canonicalSourceMenuFingerprintPayload` が決める（ここでは再定義しない）。
 *
 * `_session-planning-service.ts`（評価時点の指紋を作る）と `session-repository.ts`
 * （書込み直前に指紋を再計算して比較する）の両方から呼ばれる、唯一の計算経路。
 */
export function buildSourceMenuFingerprint(items: readonly FingerprintMenuItemInput[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalSourceMenuFingerprintPayload(items))).digest("hex");
}

export type { FingerprintMenuItemInput };

/** Current menu source context, separate from historical Session snapshots. */
export function buildReviewMenuContextFingerprint(menu: { id: string; phase: string | null; runningContextJson: string | null }, sessionDate: string): string {
  return createHash("sha256").update(JSON.stringify({ menuId: menu.id, phase: menu.phase, runningContextJson: menu.runningContextJson, sessionDate })).digest("hex");
}
