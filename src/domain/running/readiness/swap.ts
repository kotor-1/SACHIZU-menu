/**
 * Running Prescription Engine v2 — §13.4 SWAP 先。
 *
 * ここが返すのは **RuleSet が定める候補の列挙だけ**。候補が本当に使えるか（maturity / 年齢帯制約 /
 * complexity / advancedOnly / 参照データ / actor の自動生成制限）は planning が R3/R4 の既存ロジックで
 * 再評価する（「swap 先だから安全」と仮定しない・eligibility を別 switch に複製しない）。
 *
 * 候補の順序は RuleSet の targets の順 → RuleSet の templates の順（決定的）。
 */
import type { RuleSet } from "../rules/schema";
import type { RunningTrainingMethod } from "../types/method";
import type { RunningSelection } from "../types/template";

export type SwapTargets =
  /** §13.4「変更なし」（STRIDE）。Method を変えずに続行する。 */
  | { outcome: "KEEP_CURRENT" }
  /** SWAP 候補（eligibility 再評価前）。RuleSet に行が無い Method も候補なしとして扱う。 */
  | { outcome: "SWAP"; candidates: RunningSelection[] };

export function resolveSwapTargets(ruleSet: RuleSet, method: RunningTrainingMethod): SwapTargets {
  const rule = ruleSet.readinessRules.find((r) => r.kind === "SWAP_TARGET" && (r.fromMethods as readonly string[]).includes(method));
  if (!rule || rule.kind !== "SWAP_TARGET") return { outcome: "SWAP", candidates: [] };
  if (rule.outcome === "KEEP_CURRENT") return { outcome: "KEEP_CURRENT" };

  const candidates: RunningSelection[] = [];
  for (const target of rule.targets) {
    const templates = ruleSet.templates.filter(
      (t) => t.method === target.method && (target.templateIds === null || (target.templateIds as readonly string[]).includes(t.id)),
    );
    for (const template of templates) {
      candidates.push({ method: target.method, templateId: template.id } as RunningSelection);
    }
  }
  return { outcome: "SWAP", candidates };
}
