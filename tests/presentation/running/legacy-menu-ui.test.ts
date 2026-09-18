/**
 * R10-B4B — legacy Menu UI の golden（B4B の統合前に固定した振る舞い）。
 *
 * feature flag OFF のとき、Menu ブロックと項目フォームが B4B 実装前とまったく同じ操作・表示を保つことを検査する。
 */
import { describe, expect, it } from "vitest";
import {
  controlsOf,
  legacyBlockMarkup,
  legacyItemFormMarkup,
  runningSelectionValues,
  visibleText,
  LEGACY_BLOCK_BUTTONS,
  LEGACY_BLOCK_FIELDS,
  LEGACY_BLOCK_TEXT,
  LEGACY_ITEM_FORM_FIELDS,
} from "./menu-fixtures";

describe("R10-B4B: legacy Menu UI の golden（flag OFF の基準）", () => {
  it("ブロックの操作一式（ボタンと隠しフォーム）", () => {
    const { buttons, fields } = controlsOf(legacyBlockMarkup());
    expect(buttons).toEqual([...LEGACY_BLOCK_BUTTONS].sort());
    expect(fields).toEqual(LEGACY_BLOCK_FIELDS);
  });

  it("ブロックの表示（ブロック名・種目名・処方・メモ）", () => {
    expect(visibleText(legacyBlockMarkup())).toBe(LEGACY_BLOCK_TEXT);
  });

  it("項目フォームの入力欄", () => {
    expect(controlsOf(legacyItemFormMarkup()).fields).toEqual(LEGACY_ITEM_FORM_FIELDS);
  });

  it("走系の種目を選ぶと「推奨処方を入れる」が出る（legacy の導線）", () => {
    const markup = legacyItemFormMarkup({ initial: runningSelectionValues() });
    expect(controlsOf(markup).buttons).toEqual(["推奨処方を入れる", "追加する"]);
    expect(visibleText(markup)).toContain("推奨処方を入れる");
  });
});
