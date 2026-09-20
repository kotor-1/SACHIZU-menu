/**
 * Running Prescription Engine v2 — [R11-B1] セッション作成時の REQUIRE_CONFIRMATION 確認 contract。
 *
 * "use server" を付けない通常の server module（Server Action から呼ぶ）。
 *
 * 目的は「コーチが画面で見た評価」と「保存直前に server が再評価した内容」が同じであることの照合だけ。
 *   - **authorization token ではない**（HMAC や秘密鍵を使わない。§13）
 *   - challenge は request 間の transient state。DB に保存して再利用しない（§59）
 *   - 時刻・乱数を含めない。同じ評価なら再計算で必ず同じ値になる（§14）
 *   - code 単位の照合だけでは不十分（同じ code で値だけが変わる差し替えを防ぐ）。canonical Finding 値と
 *     `sourceMenuFingerprint` を含めた digest で照合する（§9〜§12）
 *   - [R11-B1.1] さらに **planning evaluation 全体の digest**（R6 集計 / R7 週次 / 全 Finding / 評価不能の理由 /
 *     RuleSet identity）を含める。MenuItem が同じでも、対象グループ設定・大会文脈・週次結果が変われば
 *     challenge が変わる。confirmation は raw source data ではなく **policy 評価結果**に対して行う
 *
 * 判定そのもの（どの code が必要か・不足か・stale か）は R10-B4A の domain helper
 * （`requiredConfirmationCodes` / `evaluateFindingConfirmation`）を再利用する。ここに複製しない。
 */
import { createHash } from "node:crypto";
import { evaluateFindingConfirmation, requiredConfirmationCodes } from "@/domain/running/planning/confirmation";
import {
  canonicalConfirmationChallengePayload,
  canonicalSessionConfirmationEvaluationPayload,
  type SessionPlanningEvaluationInput,
} from "@/domain/running/persistence/sessionSnapshot";
import type { Finding } from "@/domain/running/types/findings";
import type { IsoDateTime } from "@/domain/running/types/primitives";
import { isoDateTimeSchema } from "@/domain/running/types/primitives";

export type SessionConfirmationInput = {
  /** コーチが明示確認した Finding code（重複は dedupe してよい。§16）。 */
  confirmedFindingCodes: readonly string[];
  /** 1回目の応答で返した challenge。未送信は null。 */
  confirmationChallenge: string | null;
};

export type SessionConfirmationRequirement = {
  requiredFindingCodes: string[];
  /** 確認が必要な Finding（日本語化は presentation 層。ここでは domain の値のまま）。 */
  findings: Finding[];
  challenge: string;
};

export type SessionConfirmationOutcome =
  /** 確認が要らない評価。confirmation 入力が送られていれば呼び出し側が stale として扱う（§18）。 */
  | { status: "NOT_REQUIRED" }
  /** 確認が足りない（1回目、またはチェック漏れ）。 */
  | { status: "CONFIRMATION_REQUIRED"; requirement: SessionConfirmationRequirement }
  /** 以前の評価に対する確認が送られてきた（code 過剰・challenge 不一致）。最新の内容で出し直す。 */
  | { status: "CONFIRMATION_STATE_STALE"; requirement: SessionConfirmationRequirement }
  /** 現在の評価に対する確認が揃っている。`confirmedCodes` だけを監査記録に残す（§22）。 */
  | { status: "CONFIRMED"; confirmedCodes: string[] };

function sha256Hex(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * [R11-B1.1] 現在の planning evaluation（policy 評価結果）の digest。
 * canonicalization は domain（`canonicalSessionConfirmationEvaluationPayload`）。ここは SHA-256 の計算だけ。
 */
export function buildSessionConfirmationEvaluationDigest(evaluation: SessionPlanningEvaluationInput): string {
  return sha256Hex(canonicalSessionConfirmationEvaluationPayload(evaluation));
}

/** challenge の digest（canonicalization は domain。ここは SHA-256 の計算だけ）。 */
export function buildConfirmationChallenge(args: {
  menuTemplateId: string;
  sessionDate: string;
  sourceMenuFingerprint: string;
  evaluationDigest: string;
  findings: readonly Finding[];
}): string {
  return sha256Hex(canonicalConfirmationChallengePayload(args));
}

/** 確認が必要な Finding（severity = REQUIRE_CONFIRMATION）だけを、評価に出てきた順で返す。 */
export function confirmationFindingsOf(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "REQUIRE_CONFIRMATION");
}

/**
 * 現在の評価に対して、送られてきた確認が有効かを判定する。
 * `evaluation` / `confirmationFindings` は**必ず現在の評価（再実行結果）**を渡す（以前の結果を渡さない。§8）。
 */
export function evaluateSessionConfirmation(args: {
  menuTemplateId: string;
  sessionDate: string;
  /** 現在の planning evaluation（digest の対象。`findingConfirmations` は canonical 化で除外される）。 */
  evaluation: SessionPlanningEvaluationInput;
  /** 現在の評価で明示確認が必要な Finding。 */
  confirmationFindings: readonly Finding[];
  submitted: SessionConfirmationInput;
}): SessionConfirmationOutcome {
  const requiredFindingCodes = requiredConfirmationCodes(args.confirmationFindings);
  if (requiredFindingCodes.length === 0) return { status: "NOT_REQUIRED" };

  const challenge = buildConfirmationChallenge({
    menuTemplateId: args.menuTemplateId,
    sessionDate: args.sessionDate,
    sourceMenuFingerprint: args.evaluation.sourceMenuFingerprint,
    evaluationDigest: buildSessionConfirmationEvaluationDigest(args.evaluation),
    findings: args.confirmationFindings,
  });
  const requirement: SessionConfirmationRequirement = {
    requiredFindingCodes,
    findings: confirmationFindingsOf(args.confirmationFindings),
    challenge,
  };

  const outcome = evaluateFindingConfirmation(requiredFindingCodes, args.submitted.confirmedFindingCodes);
  if (outcome.kind === "CONFIRMATION_STATE_STALE") return { status: "CONFIRMATION_STATE_STALE", requirement };
  if (outcome.kind === "CONFIRMATION_REQUIRED") return { status: "CONFIRMATION_REQUIRED", requirement };

  // code は揃っている。次に「見た評価と同じか」を challenge で照合する（§17）。
  if (args.submitted.confirmationChallenge === null) return { status: "CONFIRMATION_REQUIRED", requirement };
  if (args.submitted.confirmationChallenge !== challenge) return { status: "CONFIRMATION_STATE_STALE", requirement };

  return { status: "CONFIRMED", confirmedCodes: outcome.confirmedCodes };
}

/** 確認成功時の監査記録。時刻は **server clock** だけを使う（client の値を信用しない。§19）。 */
export function findingConfirmationRecords(confirmedCodes: readonly string[]): { code: string; at: IsoDateTime }[] {
  const at = isoDateTimeSchema.parse(new Date().toISOString());
  return confirmedCodes.map((code) => ({ code, at }));
}
