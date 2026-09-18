/**
 * R10-B4B — Menu 画面（Server Component）の feature flag 境界。
 *
 * flag OFF のときは Running v2 の読み込み・評価を**一度も実行しない**（表示を隠すだけ、ではない）。
 * ここでは実際の page を呼び、返ってきた要素ツリーと、view builder の呼び出し回数の両方で確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../../helpers";
import { saveMenuRunningContext } from "@/infra/repositories/running-item-repository";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const buildRunningMenuViewSpy = vi.fn();
vi.mock("@/actions/_running-menu-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/actions/_running-menu-view")>();
  return {
    ...actual,
    buildRunningMenuView: (...args: Parameters<typeof actual.buildRunningMenuView>) => {
      buildRunningMenuViewSpy(...args);
      return actual.buildRunningMenuView(...args);
    },
  };
});

const MenuDetailPage = (await import("@/app/menus/[id]/page")).default;
const { RunningMenuPanel } = await import("@/components/running/running-menu-panel");
const { MenuBlockEditor } = await import("@/components/menu/menu-block-editor");

/** 関数コンポーネントを呼ばずに要素ツリーを走査する（client component を実行しないため）。 */
function findElements(node: ReactNode, type: unknown, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => findElements(child as ReactNode, type, found));
    return found;
  }
  if (node === null || typeof node !== "object") return found;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === type) found.push(element);
  const props = (element.props ?? {}) as { children?: ReactNode };
  if (props.children !== undefined) findElements(props.children, type, found);
  return found;
}

function contextObject() {
  return {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "短距離ブロック",
      members: [],
      allowAdvancedMethods: false,
    },
    plannedDate: "2026-09-20",
    plannedAt: null,
    availableMinutes: null,
  };
}

beforeEach(resetDb);
beforeEach(() => buildRunningMenuViewSpy.mockClear());
afterEach(() => vi.unstubAllEnvs());

async function makeMenu() {
  const menu = await prisma.menuTemplate.create({
    data: { name: "短距離メニュー", blocks: { create: { name: "主運動", sortOrder: 0 } } },
    include: { blocks: true },
  });
  await saveMenuRunningContext(menu.id, JSON.stringify(contextObject()));
  return menu.id;
}

describe("R10-B4B: Menu 画面の feature flag", () => {
  it("OFF：Running v2 の読み込み・評価を一度も実行せず、走トレーニングの表示も出さない", async () => {
    const id = await makeMenu();
    vi.stubEnv("RUNNING_V2_UI_ENABLED", "false");

    const tree = await MenuDetailPage({ params: Promise.resolve({ id }) });
    expect(buildRunningMenuViewSpy).not.toHaveBeenCalled();
    expect(findElements(tree, RunningMenuPanel)).toHaveLength(0);
    for (const block of findElements(tree, MenuBlockEditor)) {
      expect((block.props as { running?: unknown }).running ?? null).toBeNull();
    }
  });

  it("ON：メニュー1件につき1回だけ評価し、走トレーニングのパネルを出す", async () => {
    const id = await makeMenu();
    vi.stubEnv("RUNNING_V2_UI_ENABLED", "true");

    const tree = await MenuDetailPage({ params: Promise.resolve({ id }) });
    expect(buildRunningMenuViewSpy).toHaveBeenCalledTimes(1);
    expect(findElements(tree, RunningMenuPanel)).toHaveLength(1);
    for (const block of findElements(tree, MenuBlockEditor)) {
      expect((block.props as { running?: unknown }).running).not.toBeNull();
    }
  });

  it("既定以外の値（1 / TRUE など）では ON にしない", async () => {
    const id = await makeMenu();
    for (const value of ["1", "TRUE", "yes", ""]) {
      buildRunningMenuViewSpy.mockClear();
      vi.stubEnv("RUNNING_V2_UI_ENABLED", value);
      const tree = await MenuDetailPage({ params: Promise.resolve({ id }) });
      expect(buildRunningMenuViewSpy, value).not.toHaveBeenCalled();
      expect(findElements(tree, RunningMenuPanel), value).toHaveLength(0);
    }
  });
});
