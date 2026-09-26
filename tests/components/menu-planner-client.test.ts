import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderMarkup, stripTags } from "../presentation/running/helpers";

vi.mock("@/actions/menu-planner-actions", () => ({
  generateMenuPlannerAction: vi.fn(),
  reviseMenuPlannerAction: vi.fn(),
  saveMenuPlannerAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({}));

import { MenuPlannerClient } from "@/components/menu-planner/menu-planner-client";

const ROOT = process.cwd();
const source = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");

describe("R12-A3H MenuPlanner UI boundary", () => {
  it("renders the structured workflow without exposing server internals", () => {
    const markup = renderMarkup(MenuPlannerClient, {
      contextMenus: [{ id: "context-1", name: "短距離ブロック" }],
    });
    const visible = stripTags(markup);

    expect(visible).toContain("希望を入力");
    expect(visible).toContain("メニュー名");
    expect(visible).toContain("参照するメニュー");
    expect(visible).toContain("作りたい練習内容");
    expect(visible).toContain("プレビューを作成");
    expect(visible).not.toMatch(/acceptToken|targetMenuId|RuleSet|materializationDigest|contextFingerprint|A3[ABC]/);
    expect(markup).not.toMatch(/localStorage|sessionStorage|document\.cookie|URLSearchParams/);
  });

  it("keeps client code on the Server Action boundary", () => {
    const client = source("src/components/menu-planner/menu-planner-client.tsx");
    const page = source("src/app/menus/planner/page.tsx");

    expect(client).toMatch(/from ["']@\/actions\/menu-planner-actions["']/);
    expect(client).not.toMatch(/from ["']@\/application\//);
    expect(client).not.toMatch(/from ["']@\/infra\//);
    expect(client).not.toMatch(/@prisma\/client|OPENAI_API_KEY|provider|model|RuleSet loader/);
    // 旧プランナー入口は統合 Composer（/menus/new）への転送のみ。DB / running 内部へ触れない。
    expect(page).toMatch(/redirect\(["']\/menus\/new["']\)/);
    expect(page).not.toMatch(/@\/infra\/repositories|listMenusForPicker|@prisma\/client|catalog|subject|provider|model|ownerId/);
  });

  it("does not add client-side persistence or prescription calculations", () => {
    const client = source("src/components/menu-planner/menu-planner-client.tsx");
    expect(client).not.toMatch(/localStorage|sessionStorage|IndexedDB|document\.cookie|URLSearchParams|console\.(log|debug|info|error)/);
    expect(client).not.toMatch(/\bfetch\s*\(|OpenAI|api\/responses/);
    expect(client).not.toMatch(/estimateSeconds|formatPrescription|\bMath\./);
    expect(client).toMatch(/acceptToken: currentToken/);
    expect(client).not.toMatch(/saveMenuPlannerAction\(\{[^}]*preview/);
    expect(client).not.toMatch(/saveMenuPlannerAction\(\{[^}]*proposal/);
  });
});
