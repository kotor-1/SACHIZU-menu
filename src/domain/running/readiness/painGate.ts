/**
 * Running Prescription Engine v2 — §13.2 Pain gate（hard gate）。
 *
 * red flag のグループ・成長期ガイダンスの部位・年齢帯・loadClass は、すべて RuleSet.readinessRules から読む
 * （TS にしきい値やグループを複製しない）。評価はルールの並び順に依存しない（集合演算と最大値のみ）。
 *
 * 出力に健康情報そのもの（部位名・red flag 名・尺度値）を含めない。表示用の文言は `transientFindings` の
 * コードだけで表し、実際の日本語は rationale / UI 側が出す。
 */
import type { LoadClass, ReadinessRule } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { PainReport, ReadinessActionCode, SafetyOutcome } from "../types/readiness";
import type { ResolvedAgeBand } from "../context/ageBand";
import type { ReadinessTrigger } from "./schema";

export type PainGateResult = {
  stopPlanning: boolean;
  safetyOutcome: SafetyOutcome;
  actions: ReadinessActionCode[];
  /** signal 単位の内訳（override / 適用不能後の再正規化に使う）。 */
  triggers: ReadinessTrigger[];
  /** §13.2 NOT_ASKED（当日の痛みが未確認）。override では解除できない。 */
  painCheckRequired: boolean;
  /** true = このゲートでは高強度を止めない。false / "UNKNOWN" は planning 側で HIGH_* を止める。 */
  highIntensityAllowedToday: boolean | "UNKNOWN";
  transientFindings: Finding[];
};

function transientFinding(code: string, severity: Finding["severity"]): Finding {
  return { code, severity, scope: "ITEM", evidenceIds: [] };
}

/**
 * §13.2 の表をそのまま評価する。
 *   - red flag: 該当するグループのうち **最も severityRank が高いもの**を採用（複数該当でも順序非依存）
 *   - status=PRESENT（red flag なし）: PAIN_PRESENT ルールの actions / safetyOutcome
 *   - status=PRESENT かつ成長期ガイダンスの部位・年齢帯: 表示用 Finding を追加（診断ではない）
 *   - status=NOT_ASKED: 年齢帯が該当すれば painCheckRequired（当日の高強度は UNKNOWN）。
 *     Finding と action は「計画に HIGH_* あり」のときだけ付ける（§13.2 の行の条件）
 *   - status=NONE_REPORTED: gate 通過（高強度の許可ではない。§13.3 を続けて評価する）
 */
export function evaluatePainGate(args: {
  pain: PainReport;
  ageBand: ResolvedAgeBand;
  loadClass: LoadClass;
  rules: readonly ReadinessRule[];
}): PainGateResult {
  const { pain, ageBand, loadClass, rules } = args;

  // ---- red flags（override 不可の STOP） ----
  const reported = new Set<string>(pain.redFlags);
  const matchedGroups = rules.filter(
    (r) => r.kind === "PAIN_RED_FLAG_GROUP" && r.redFlags.some((flag) => reported.has(flag)),
  );
  if (matchedGroups.length > 0) {
    const worst = matchedGroups.reduce((a, b) =>
      (b.kind === "PAIN_RED_FLAG_GROUP" ? b.severityRank : 0) > (a.kind === "PAIN_RED_FLAG_GROUP" ? a.severityRank : 0) ? b : a,
    );
    if (worst.kind !== "PAIN_RED_FLAG_GROUP") throw new Error("unreachable");
    return {
      stopPlanning: true,
      safetyOutcome: worst.safetyOutcome,
      actions: ["REQUIRE_COACH_REVIEW"],
      triggers: [{ ruleId: worst.id, actions: ["REQUIRE_COACH_REVIEW"] }],
      painCheckRequired: false,
      highIntensityAllowedToday: false,
      transientFindings: [
        transientFinding("READINESS_STOP_SAFETY", "BLOCK"),
        ...(worst.safetyOutcome === "MEDICAL_EVALUATION_RECOMMENDED" ? [transientFinding("MEDICAL_EVALUATION_RECOMMENDED", "REQUIRE_COACH_REVIEW")] : []),
      ],
    };
  }

  // ---- status=PRESENT（red flag なし） ----
  if (pain.status === "PRESENT") {
    const rule = rules.find((r) => r.kind === "PAIN_PRESENT");
    const actions = rule && rule.kind === "PAIN_PRESENT" ? [...rule.actions] : [];
    const safetyOutcome: SafetyOutcome = rule && rule.kind === "PAIN_PRESENT" ? rule.safetyOutcome : "COACH_REVIEW";
    const transientFindings: Finding[] = [transientFinding("READINESS_PAIN_PRESENT", "REQUIRE_COACH_REVIEW")];
    const reportedRegions = new Set<string>(pain.regions);
    for (const guidance of rules) {
      if (guidance.kind !== "PAIN_GROWTH_PERIOD_GUIDANCE") continue;
      const ageApplies = (guidance.appliesToAgeBands as readonly string[]).includes(ageBand) || ageBand === "UNKNOWN";
      if (ageApplies && guidance.regions.some((region) => reportedRegions.has(region))) {
        transientFindings.push(transientFinding(guidance.findingCode, "REQUIRE_COACH_REVIEW"));
      }
    }
    return {
      stopPlanning: false,
      safetyOutcome,
      actions,
      triggers: rule && rule.kind === "PAIN_PRESENT" && actions.length > 0 ? [{ ruleId: rule.id, actions }] : [],
      painCheckRequired: false,
      highIntensityAllowedToday: actions.includes("CANCEL_HIGH_INTENSITY") ? false : true,
      transientFindings,
    };
  }

  // ---- status=NOT_ASKED ----
  if (pain.status === "NOT_ASKED") {
    const rule = rules.find((r) => r.kind === "PAIN_NOT_ASKED");
    if (rule && rule.kind === "PAIN_NOT_ASKED") {
      // 年齢帯は「痛みを確認できていない」という当日の状態なので Method に依らず評価する
      // （UNKNOWN の年齢帯は ADULT と決めつけず、保守側＝該当として扱う）。
      const ageApplies = (rule.appliesToAgeBands as readonly string[]).includes(ageBand) || ageBand === "UNKNOWN";
      if (ageApplies) {
        // Finding と action は §13.2 の行どおり「計画に HIGH_* あり」のときだけ付ける。
        const highIntensityContext = (rule.appliesToLoadClasses as readonly string[]).includes(loadClass);
        return {
          stopPlanning: false,
          safetyOutcome: "NONE",
          actions: highIntensityContext ? [...rule.actions] : [],
          triggers: highIntensityContext && rule.actions.length > 0 ? [{ ruleId: rule.id, actions: [...rule.actions] }] : [],
          painCheckRequired: true,
          highIntensityAllowedToday: "UNKNOWN",
          transientFindings: highIntensityContext ? [transientFinding(rule.findingCode, "REQUIRE_COACH_REVIEW")] : [],
        };
      }
    }
  }

  // ---- status=NONE_REPORTED（および該当しない NOT_ASKED）: gate 通過 ----
  return {
    stopPlanning: false,
    safetyOutcome: "NONE",
    actions: [],
    triggers: [],
    painCheckRequired: false,
    highIntensityAllowedToday: true,
    transientFindings: [],
  };
}
