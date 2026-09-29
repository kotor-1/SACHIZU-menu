import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderMarkup, stripTags } from "../presentation/running/helpers";

vi.mock("@/actions/menu-planner-actions", () => ({
  generateMenuDraftAction: vi.fn(),
  previewMenuDraftRunningAction: vi.fn(),
  saveMenuDraftAction: vi.fn(),
}));
vi.mock("@/actions/running-menu-preview-actions", () => ({ generateRunningMenuPreviewAction: vi.fn() }));
vi.mock("@/actions/running-actions", () => ({
  editRunningItemAction: vi.fn(),
  overrideRunningItemAction: vi.fn(),
  recalculateWithActiveRuleSetAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { UnifiedMenuComposer } from "@/components/menu/unified-menu-composer";

const ROOT = process.cwd();
const source = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");

describe("R12 unified composer: /menus/new", () => {
  it("最初から AI 自然文入力・AI 生成ボタン・手動追加が同じ画面に並ぶ", () => {
    const markup = renderMarkup(UnifiedMenuComposer, { exercises: [] });
    const visible = stripTags(markup);
    expect(markup).toContain('id="composer-request"');
    expect(visible).toContain("AIでメニューを作成");
    expect(visible).toContain("手動で種目を追加");
    expect(visible).toContain("＋ 種目を追加");
    expect(visible).toContain("メニュー名");
    expect(visible).not.toMatch(/acceptToken|targetMenuId|contextFingerprint|materializationDigest|RuleSet/);
  });

  it("/menus/new は統合 Composer、/menus/planner はそこへ転送するだけ", () => {
    const page = source("src/app/menus/new/page.tsx");
    expect(page).toMatch(/UnifiedMenuComposer/);
    expect(page).not.toMatch(/MenuForm\b|createMenuAction/);
    expect(source("src/app/menus/planner/page.tsx")).toMatch(/redirect\(["']\/menus\/new["']\)/);
  });

  it("client は数値処方を計算せず、Server Action 経由でだけ server に触れる", () => {
    const client = source("src/components/menu/unified-menu-composer.tsx");
    expect(client).toMatch(/from ["']@\/actions\/menu-planner-actions["']/);
    expect(client).not.toMatch(/from ["']@\/application\//);
    expect(client).not.toMatch(/import (?!type)[^;]*from ["']@\/infra\//);
    expect(client).not.toMatch(/localStorage|sessionStorage|document\.cookie|\bfetch\s*\(|OPENAI/);
    expect(client).not.toMatch(/suggestPrescription|planRunningPrescription|estimateSeconds/);
    // 保存に成功したときだけ遷移する
    expect(client).toMatch(/if \(!result\.ok\) \{[\s\S]*?return;\s*\}\s*router\.push\(`\/menus\/\$\{result\.menuId\}`\)/);
  });

  it("並べ替えはマウス（PointerSensor）とタッチ（TouchSensor）の両方を有効にしている", () => {
    const list = source("src/components/menu/sortable-list.tsx");
    expect(list).toMatch(/useSensor\(PointerSensor/);
    expect(list).toMatch(/useSensor\(TouchSensor/);
  });
});
