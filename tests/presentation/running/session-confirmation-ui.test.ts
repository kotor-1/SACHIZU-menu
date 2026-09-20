/**
 * R11-B1 — セッション作成前の確認パネル（共有 UI）。
 *
 * - 内部 code（`AGG_TOTAL_RUNNING_CONFIRM` 等）と challenge hash を画面に出さない
 * - チェックは既定 false。全部チェックするまで送信できない
 * - challenge が変わったら（STALE）チェックを全て外す
 * - flag OFF の入口では確認パネルを出さず、安全側のメッセージだけを出す
 */
import { describe, expect, it } from "vitest";
import { NewSessionFromMenu } from "@/components/session/new-session-from-menu";
import { StartSessionForm } from "@/components/session/start-session-form";
import { SessionConfirmationPanel, sessionConfirmationFailureOf } from "@/components/session/session-confirmation-panel";
import { presentFindings } from "@/presentation/running/findings";
import {
  SESSION_CONFIRMATION_MESSAGE_JA,
  SESSION_CONFIRMATION_STALE_MESSAGE_JA,
  allConfirmed,
  checkedKeysForChallenge,
  confirmedCodesToSubmit,
  presentSessionConfirmation,
} from "@/presentation/running/session-confirmation";
import type { Finding } from "@/domain/running/types/findings";
import { rawKeyLeaks, renderMarkup, stripTags } from "./helpers";

const CHALLENGE = "a".repeat(64);

const FINDINGS: Finding[] = [
  { code: "AGG_TOTAL_RUNNING_CONFIRM", severity: "REQUIRE_CONFIRMATION", scope: "SESSION", metric: "PLA_MENU_TOTAL_DISTANCE", evidenceIds: [] },
  { code: "PLAUSIBILITY_REQUIRE_CONFIRMATION", severity: "REQUIRE_CONFIRMATION", scope: "ITEM", metric: "PLA_ITEM_TOTAL_DISTANCE", evidenceIds: [] },
];

function failure(kind: "CONFIRMATION_REQUIRED" | "CONFIRMATION_STATE_STALE" = "CONFIRMATION_REQUIRED", challenge = CHALLENGE) {
  return {
    kind,
    message: kind === "CONFIRMATION_REQUIRED" ? SESSION_CONFIRMATION_MESSAGE_JA : SESSION_CONFIRMATION_STALE_MESSAGE_JA,
    findings: presentFindings(FINDINGS),
    confirmationChallenge: challenge,
  };
}

describe("R11-B1: 確認パネルの表示", () => {
  it("日本語の Finding とチェックを出し、内部 code / challenge hash を表示しない", () => {
    const markup = renderMarkup(SessionConfirmationPanel as never, { failure: failure(), idPrefix: "p" } as never);
    const visible = stripTags(markup.replace(/<input[^>]*type="hidden"[^>]*>/g, " "));
    expect(visible).toContain("作成する前の確認");
    expect(visible).toContain("内容を確認しました");
    expect(visible).toMatch(/総走行距離|走行距離/);
    expect(rawKeyLeaks(markup)).toEqual([]);
    // challenge は hidden field としてだけ持ち、本文には出さない
    expect(markup).toContain(`name="confirmationChallenge" value="${CHALLENGE}"`);
    expect(visible).not.toContain(CHALLENGE);
  });

  it("チェックは既定 false。確認済み code だけを hidden field で送る", () => {
    const panel = presentSessionConfirmation(failure());
    expect(panel.confirmationKeys).toEqual(["AGG_TOTAL_RUNNING_CONFIRM", "PLAUSIBILITY_REQUIRE_CONFIRMATION"]);
    expect(allConfirmed(panel, [])).toBe(false);
    expect(allConfirmed(panel, ["AGG_TOTAL_RUNNING_CONFIRM"])).toBe(false);
    expect(allConfirmed(panel, panel.confirmationKeys)).toBe(true);
    expect(confirmedCodesToSubmit(panel, ["AGG_TOTAL_RUNNING_CONFIRM", "UNRELATED"])).toEqual(["AGG_TOTAL_RUNNING_CONFIRM"]);

    const markup = renderMarkup(SessionConfirmationPanel as never, { failure: failure(), idPrefix: "p" } as never);
    // 初期状態では確認済み code を送らない
    expect(markup).not.toContain('name="confirmedFindingCodes"');
    for (const checkbox of markup.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []) expect(checkbox).not.toContain("checked");
  });

  it("確認が必要な Finding が無ければ何も描画しない", () => {
    expect(renderMarkup(SessionConfirmationPanel as never, { failure: null } as never)).toBe("");
  });

  it("STALE のときは最新の内容で出し直す（やり直しを促すメッセージ）", () => {
    const markup = renderMarkup(SessionConfirmationPanel as never, { failure: failure("CONFIRMATION_STATE_STALE"), idPrefix: "p" } as never);
    expect(stripTags(markup)).toContain(SESSION_CONFIRMATION_STALE_MESSAGE_JA);
  });

  it("challenge が変わったらチェックを全て外す（自動再送しない）", () => {
    const codes = ["AGG_TOTAL_RUNNING_CONFIRM", "PLAUSIBILITY_REQUIRE_CONFIRMATION"];
    // 同じ評価のあいだはチェックを保つ
    expect(checkedKeysForChallenge({ challenge: CHALLENGE, checkedKeys: codes }, CHALLENGE)).toEqual(codes);
    // 評価が変われば全て外す（自動で送り直さない）
    expect(checkedKeysForChallenge({ challenge: CHALLENGE, checkedKeys: codes }, "b".repeat(64))).toEqual([]);
    expect(checkedKeysForChallenge({ challenge: CHALLENGE, checkedKeys: codes }, null)).toEqual([]);

    // 新しい challenge で描画したパネルは、確認済み code を1つも送らない
    const markup = renderMarkup(SessionConfirmationPanel as never, {
      failure: failure("CONFIRMATION_STATE_STALE", "b".repeat(64)),
      idPrefix: "p",
    } as never);
    expect(markup).not.toContain('name="confirmedFindingCodes"');
    for (const checkbox of markup.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []) expect(checkbox).not.toContain("checked");
  });

  it("Action の結果から確認対象だけを取り出す", () => {
    expect(sessionConfirmationFailureOf(null)).toBeNull();
    expect(sessionConfirmationFailureOf({ ok: true })).toBeNull();
    expect(sessionConfirmationFailureOf({ ok: false, kind: "REJECTED" })).toBeNull();
    expect(sessionConfirmationFailureOf({ ok: false, kind: "PLANNING_EVALUATION_STALE" })).toBeNull();
    expect(sessionConfirmationFailureOf({ ok: false, kind: "CONFIRMATION_REQUIRED" })).not.toBeNull();
    expect(sessionConfirmationFailureOf({ ok: false, kind: "CONFIRMATION_STATE_STALE" })).not.toBeNull();
  });
});

describe("R11-B1: 2つの入口での feature flag", () => {
  it("flag ON：確認が必要な結果ならパネルを出し、送信ボタンを確認待ちにする", () => {
    for (const markup of [
      renderMarkup(StartSessionForm as never, { menuId: "m1", menuName: "短距離", runningV2Enabled: true } as never),
      renderMarkup(NewSessionFromMenu as never, { menus: [{ id: "m1", name: "短距離", phase: null, estimatedMinutes: null }], runningV2Enabled: true } as never),
    ]) {
      // 初期状態（結果なし）ではパネルを出さない
      expect(stripTags(markup)).not.toContain("作成する前の確認");
      expect(stripTags(markup)).toContain("練習記録を作成");
    }
  });

  it("flag OFF：確認パネルを出さない（Action 側の安全側メッセージだけ）", () => {
    const panelMarkup = renderMarkup(SessionConfirmationPanel as never, { failure: failure(), idPrefix: "p" } as never);
    expect(stripTags(panelMarkup)).toContain("作成する前の確認");

    // 入口は runningV2Enabled=false なら失敗結果を受けてもパネルを描画しない
    const offMarkup = renderMarkup(StartSessionForm as never, { menuId: "m1", menuName: "短距離" } as never);
    expect(stripTags(offMarkup)).not.toContain("作成する前の確認");
  });

  it("入力欄（実施日・練習名・対象・場所）は確認のたびに消えない", () => {
    const markup = renderMarkup(NewSessionFromMenu as never, {
      menus: [{ id: "m1", name: "短距離", phase: null, estimatedMinutes: null }],
      runningV2Enabled: true,
    } as never);
    const names = [...markup.matchAll(/<(?:input|select)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]!);
    expect(names).toEqual(expect.arrayContaining(["menuTemplateId", "date", "title", "groupName", "location"]));
    // 値は defaultValue（uncontrolled）なので、Action 結果の再描画で消えない
    expect(markup).toMatch(/name="date"[^>]*value="20\d\d-\d\d-\d\d"/);
  });
});
