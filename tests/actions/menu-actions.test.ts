import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { createMenuAction } = await import("@/actions/menu-actions");

function menuFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  const base: Record<string, string> = {
    name: "テストメニュー",
    description: "",
    purpose: "",
    phase: "",
    estimatedMinutes: "",
    status: "DRAFT",
    tags: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) fd.set(key, value);
  return fd;
}

/**
 * withDefaultBlocks は「hidden(false) の後ろにチェックボックス(true) を置く」形で
 * 送られてくる（フォーム側の実装は src/components/menu/menu-form.tsx を参照）。
 * このテストは、その多少トリッキーな配列パースが両方の状態を正しく判定できるかを見る。
 */
describe("createMenuAction: withDefaultBlocks checkbox parsing", () => {
  beforeEach(resetDb);

  it("creates the 5 standard blocks when the checkbox is checked (values = [false, true])", async () => {
    const fd = menuFormData();
    fd.append("withDefaultBlocks", "false");
    fd.append("withDefaultBlocks", "true");

    await expect(createMenuAction(null, fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

    const menu = await prisma.menuTemplate.findFirstOrThrow({ include: { blocks: true } });
    expect(menu.blocks).toHaveLength(5);
  });

  it("creates zero blocks when the checkbox is unchecked (values = [false] only)", async () => {
    const fd = menuFormData();
    fd.append("withDefaultBlocks", "false");

    await expect(createMenuAction(null, fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

    const menu = await prisma.menuTemplate.findFirstOrThrow({ include: { blocks: true } });
    expect(menu.blocks).toHaveLength(0);
  });

  it("defaults to creating the standard blocks when the field is missing entirely", async () => {
    const fd = menuFormData(); // withDefaultBlocks not appended at all

    await expect(createMenuAction(null, fd)).rejects.toThrow(/^NEXT_REDIRECT:/);

    const menu = await prisma.menuTemplate.findFirstOrThrow({ include: { blocks: true } });
    expect(menu.blocks).toHaveLength(5);
  });
});
