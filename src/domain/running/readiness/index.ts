/**
 * Running Prescription Engine v2 — §13 Readiness / Pain gate の公開 API。
 *
 * `resolveReadinessAction(report, ctx)` は **server / domain 側の判定結果**であり、
 * AI が作れるものではない（§13.5）。返す `ReadinessDecision` は健康情報そのものを含まない。
 *
 * **倍率・割合は一切作らない。** 出力は離散 action（§13.3）と STOP / SafetyOutcome だけ。
 */
import { getActiveRuleSet } from "../rules/loader";
import type { LoadClass, RuleSet } from "../rules/schema";
import type { ReadinessReport } from "../types/readiness";
import { readinessReportSchema } from "../types/readiness";
import { evaluatePainGate } from "./painGate";
import { deriveReadinessActions } from "./actions";
import {
  normalizeReadinessActions,
  readinessContextSchema,
  readinessDecisionSchema,
  type ReadinessContext,
  type ReadinessDecision,
} from "./schema";

export type { ReadinessContext, ReadinessDecision, ReadinessWindowState } from "./schema";

/** RuleSet が Method の loadClass の唯一の出所（TS 側に対応表を複製しない）。 */
function loadClassOf(ruleSet: RuleSet, method: ReadinessContext["method"]): LoadClass {
  const meta = ruleSet.methods.find((m) => m.method === method);
  if (!meta) throw new Error(`RuleSet ${ruleSet.ruleSetVersion} に method=${method} の MethodMeta がありません`);
  return meta.loadClass;
}

/**
 * §13.2 → §13.3 の順に評価する。
 *
 *   1. 入力を検証（`.strict()`。自由記述・未知キー・矛盾した PainReport は例外）
 *   2. `planningDate` で RuleSet を選ぶ（domain は現在時刻を読まない）
 *   3. Pain gate（§13.2）。STOP なら §13.3 は評価しない（medical STOP は override 不可）
 *   4. Wellness の action（§13.3）を集め、pain gate の action と合わせて優先順位で正規化
 *
 * `painCheckRequired` / `highIntensityAllowedToday` は Method ではなく**その日**の状態なので、
 * 別の Method へ decision を流用しても安全側に働く。Method 依存の finding だけ `evaluatedFor` に紐づく。
 */
export function resolveReadinessAction(report: ReadinessReport, ctx: ReadinessContext): ReadinessDecision {
  const parsedReport = readinessReportSchema.parse(report);
  const parsedCtx = readinessContextSchema.parse(ctx);

  const { ruleSet, contentHash } = getActiveRuleSet(parsedCtx.planningDate);
  const loadClass = loadClassOf(ruleSet, parsedCtx.method);
  if (parsedCtx.loadClass != null && parsedCtx.loadClass !== loadClass) {
    throw new Error(
      `ReadinessContext.loadClass=${parsedCtx.loadClass} は RuleSet の ${parsedCtx.method}=${loadClass} と一致しません`,
    );
  }

  const gate = evaluatePainGate({
    pain: parsedReport.pain,
    ageBand: parsedCtx.ageBand,
    loadClass,
    rules: ruleSet.readinessRules,
  });

  const identity = {
    version: ruleSet.ruleSetVersion,
    contentHash,
    status: ruleSet.status,
  };
  const evaluatedFor = { method: parsedCtx.method, loadClass };

  if (gate.stopPlanning) {
    return readinessDecisionSchema.parse({
      actions: normalizeReadinessActions(gate.actions),
      triggers: gate.triggers,
      stopPlanning: true,
      safetyOutcome: gate.safetyOutcome,
      highIntensityAllowedToday: false,
      painCheckRequired: gate.painCheckRequired,
      transientFindings: gate.transientFindings,
      ruleSet: identity,
      evaluatedFor,
    });
  }

  const wellness = deriveReadinessActions({
    report: parsedReport,
    windowState: parsedCtx.readinessWindowState,
    rules: ruleSet.readinessRules,
  });

  const triggers = [...gate.triggers, ...wellness.triggers].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  const actions = normalizeReadinessActions(triggers.flatMap((t) => t.actions));
  // その日「高強度をやらない」判断（CANCEL / SWAP）が出ていれば false。
  // pain gate が UNKNOWN（痛み未確認）を返している場合はそれを保つ（true / false へ断定しない）。
  const blocksHighIntensity = actions.includes("CANCEL_HIGH_INTENSITY") || actions.includes("SWAP_TO_LOWER_LOAD_METHOD");
  const highIntensityAllowedToday =
    gate.highIntensityAllowedToday === "UNKNOWN" ? "UNKNOWN" : blocksHighIntensity ? false : gate.highIntensityAllowedToday;

  return readinessDecisionSchema.parse({
    actions: actions.length > 0 ? actions : ["NO_CHANGE"],
    triggers,
    stopPlanning: false,
    safetyOutcome: gate.safetyOutcome,
    highIntensityAllowedToday,
    painCheckRequired: gate.painCheckRequired,
    transientFindings: gate.transientFindings,
    ruleSet: identity,
    evaluatedFor,
  });
}
