/**
 * Running Prescription Engine v2 — [R11-B1] セッション作成時の確認 UI の表示文と入力の組み立て。
 *
 * 純粋関数だけ（DB も Server Action も触らない）。Finding の日本語化は B3 の `presentFindings` を再利用し、
 * ここでは「確認パネルの文言」と「2回目のリクエストに載せる値」だけを持つ。
 * Finding code（`AGG_TOTAL_RUNNING_CONFIRM` 等）は内部 payload として扱い、画面には出さない（§28）。
 */
import type { FindingPresentationDto } from "./dto";

export const SESSION_CONFIRMATION_MESSAGE_JA =
  "この内容で練習を作る前に、確認が必要な項目があります。内容を確認したうえで、もう一度「この内容で作成」を押してください。";

export const SESSION_CONFIRMATION_STALE_MESSAGE_JA =
  "メニューの内容が変わったため、確認をやり直してください。最新の内容を表示しています。";

export const SESSION_PLANNING_STALE_MESSAGE_JA = "メニュー内容が更新されたため、もう一度開始してください";

export const SESSION_CONFIRMATION_HEADING_JA = "作成する前の確認";

export const SESSION_CONFIRMATION_NOTE_JA =
  "確認しても、この内容は記録に残ります（確認した事実だけが別に記録されます）。";

/** 確認パネルの表示 DTO（Action の失敗結果から作る。challenge は画面に出さない内部値）。 */
export type SessionConfirmationPanelDto = {
  heading: string;
  message: string;
  note: string;
  findings: FindingPresentationDto[];
  /** hidden field / React state として保持する値。ユーザー向けテキストとして描画しない（§34）。 */
  challenge: string;
  /** 明示確認が必要な Finding の確認キー（= Finding code。内部 payload）。 */
  confirmationKeys: string[];
};

export type SessionConfirmationFailureLike = {
  kind: "CONFIRMATION_REQUIRED" | "CONFIRMATION_STATE_STALE";
  message: string;
  findings: FindingPresentationDto[];
  confirmationChallenge: string;
};

export function presentSessionConfirmation(failure: SessionConfirmationFailureLike): SessionConfirmationPanelDto {
  return {
    heading: SESSION_CONFIRMATION_HEADING_JA,
    message: failure.message,
    note: SESSION_CONFIRMATION_NOTE_JA,
    findings: failure.findings,
    challenge: failure.confirmationChallenge,
    confirmationKeys: failure.findings.filter((f) => f.requiresExplicitConfirmation).map((f) => f.confirmationKey),
  };
}

/** すべての確認対象にチェックが入っているか（1つでも未チェックなら 2回目を送らせない。§33）。 */
export function allConfirmed(panel: SessionConfirmationPanelDto, checkedKeys: readonly string[]): boolean {
  return panel.confirmationKeys.length > 0 && panel.confirmationKeys.every((key) => checkedKeys.includes(key));
}

/**
 * challenge が変わったら以前のチェックは無効にする（§35）。
 * 同じ評価（同じ challenge）のあいだはチェック状態を保つ。
 */
export function checkedKeysForChallenge(
  previous: { challenge: string | null; checkedKeys: readonly string[] },
  challenge: string | null,
): string[] {
  return previous.challenge === challenge ? [...previous.checkedKeys] : [];
}

/** 2回目のリクエストに載せる確認済み code（パネルに出ている確認対象だけ）。 */
export function confirmedCodesToSubmit(panel: SessionConfirmationPanelDto, checkedKeys: readonly string[]): string[] {
  return panel.confirmationKeys.filter((key) => checkedKeys.includes(key));
}
