/**
 * R10-B4B — Menu 画面へ渡す DTO（server）と、実際の Server Action を通した追加・編集の流れ。
 *
 * ここでは実 DB（テスト用）と実 Action を使う。plan 結果を作るのは domain engine で、
 * テスト側では処方 JSON を手で組み立てない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../../helpers";
import { findMenu } from "@/infra/repositories/menu-repository";
import { saveMenuRunningContext } from "@/infra/repositories/running-item-repository";
import { addMenuItem } from "@/infra/repositories/menu-repository";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { makeExercise } from "../../helpers";
import { buildRunningMenuView } from "@/actions/_running-menu-view";
import { evaluateStoredRunningMenu } from "@/actions/_running-menu-evaluation";
import { dtoRawKeyLeaks } from "../../presentation/running/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { planRunningItemAction, editRunningItemAction, recalculateWithActiveRuleSetAction, updateRunningMenuContextAction } = await import(
  "@/actions/running-actions"
);

const SPLIT_JSON = JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }] });

function contextObject(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "短距離ブロック",
      members: [
        {
          ageBandOverride: "U18",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: "2026-09-01" },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
          primaryEvent: "400m",
        },
      ],
      allowAdvancedMethods: true,
    },
    plannedDate: "2026-09-20",
    plannedAt: "2026-09-20T16:00:00+09:00",
    availableMinutes: 90,
    ...overrides,
  };
}

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
beforeEach(resetDb);

async function makeMenu(context: Record<string, unknown> | null = contextObject()) {
  const menu = await prisma.menuTemplate.create({
    data: { name: "短距離メニュー", blocks: { create: { name: "主運動", sortOrder: 0 } } },
    include: { blocks: true },
  });
  if (context !== null) await saveMenuRunningContext(menu.id, JSON.stringify(context));
  return { menuId: menu.id, blockId: menu.blocks[0]!.id };
}

async function plan(menuId: string, blockId: string, fields: Record<string, string | string[]>) {
  return planRunningItemAction(menuId, blockId, null, form({ positionPreference: "", ...fields }));
}

async function viewOf(menuId: string) {
  const menu = await findMenu(menuId);
  if (!menu) throw new Error("menu not found");
  return buildRunningMenuView(menu);
}

describe("R10-B4B: 完了条件のマトリクス（実 Action で追加できる）", () => {
  const cases = [
    { name: "加速", fields: { method: "ACCELERATION", templateId: "ACC_BLOCK_30" } },
    { name: "最高速度", fields: { method: "MAX_VELOCITY", templateId: "MV_FLY20" } },
    { name: "流し", fields: { method: "STRIDE", templateId: "ST_RELAXED" } },
    { name: "ロングスプリント（完全回復）", fields: { method: "LONG_SPRINT_RACE_SPECIFIC", templateId: "LSR_SPECIAL_ENDURANCE_I", coachReferenceJson: SPLIT_JSON } },
  ] as const;

  for (const c of cases) {
    it(`${c.name}：追加して、メニュー画面の DTO に出る`, async () => {
      const { menuId, blockId } = await makeMenu();
      const result = await plan(menuId, blockId, c.fields);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error("unreachable");

      const view = await viewOf(menuId);
      const item = view.items[result.data.id];
      expect(item?.status).toBe("OK");
      if (item?.status !== "OK") throw new Error("unreachable");
      expect(item.item.title.length).toBeGreaterThan(0);
      // 内部キー（Method / template id / severity）を表示用の文字列に出さない
      expect(dtoRawKeyLeaks(item.item)).toEqual([]);
      expect(view.aggregation.status).toBe("EVALUATED");
    });
  }
});

describe("R10-B4B: メニュー画面の DTO", () => {
  it("設定が無ければ、候補も合計も出さず理由だけを返す（当日で代用しない）", async () => {
    const { menuId } = await makeMenu(null);
    const view = await viewOf(menuId);
    expect(view.context.status).toBe("NONE");
    expect(view.context.draft.plannedDate).toBe("");
    expect(view.picker.status).toBe("UNAVAILABLE");
    expect(view.aggregation).toEqual({ status: "NONE" });
  });

  it("設定が壊れていたら、空欄＋案内にする（推測して埋めない）", async () => {
    const { menuId, blockId } = await makeMenu();
    await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });
    await prisma.menuTemplate.update({ where: { id: menuId }, data: { runningContextJson: '{"schemaVersion":1,"subject":{}}' } });

    const view = await viewOf(menuId);
    expect(view.context.status).toBe("INVALID");
    expect(view.context.message).not.toBeNull();
    expect(view.context.draft.plannedDate).toBe("");
    expect(view.picker.status).toBe("UNAVAILABLE");
    expect(view.aggregation.status).toBe("NOT_EVALUATED");
    if (view.aggregation.status !== "NOT_EVALUATED") throw new Error("unreachable");
    expect(view.aggregation.message).toContain("対象グループ・計画日の設定");
  });

  it("処方データが壊れている項目は、題名だけ出して合計を計算しない", async () => {
    const { menuId, blockId } = await makeMenu();
    const created = await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });
    if (!created.ok) throw new Error(JSON.stringify(created));
    await prisma.menuItem.update({ where: { id: created.data.id }, data: { prescriptionJson: "{ broken", displayName: "壊れた項目" } });

    const view = await viewOf(menuId);
    expect(view.items[created.data.id]).toMatchObject({ status: "UNREADABLE", title: "壊れた項目" });
    expect(view.aggregation.status).toBe("NOT_EVALUATED");
    if (view.aggregation.status !== "NOT_EVALUATED") throw new Error("unreachable");
    expect(view.aggregation.message).toContain("読み込めない処方データ");
  });

  it("ルールセットの版が混ざっていたら、合計を出さずに揃え方を案内する", async () => {
    const { menuId, blockId } = await makeMenu();
    const a = await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });
    const b = await plan(menuId, blockId, { method: "STRIDE", templateId: "ST_RELAXED" });
    if (!a.ok || !b.ok) throw new Error("plan failed");
    await prisma.menuItem.update({ where: { id: b.data.id }, data: { ruleSetVersion: "rs-2026.08.0" } });

    const view = await viewOf(menuId);
    expect(view.aggregation.status).toBe("NOT_EVALUATED");
    if (view.aggregation.status !== "NOT_EVALUATED") throw new Error("unreachable");
    expect(view.aggregation.message).toContain("現行ルールで再計算");
    // 保存済みの項目自体は、各自の版のまま表示を続ける
    expect(view.items[a.data.id]?.status).toBe("OK");
  });

  it("合計は R6 の評価結果そのもの（B2 の session 作成時と同じ helper を共有する）", async () => {
    const { menuId, blockId } = await makeMenu();
    await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });

    const menu = await findMenu(menuId);
    const evaluated = await evaluateStoredRunningMenu({ menu: menu!, competitionDayFor: () => false });
    expect(evaluated.status).toBe("EVALUATED");
    if (evaluated.status !== "EVALUATED") throw new Error("unreachable");

    const view = await buildRunningMenuView(menu!);
    if (view.aggregation.status !== "EVALUATED") throw new Error(JSON.stringify(view.aggregation));
    const total = view.aggregation.totals.find((t) => t.label === "走行距離の合計");
    expect(total).toBeDefined();
    expect(evaluated.aggregate.totalRunningDistanceM.lower).not.toBeNull();
    expect(dtoRawKeyLeaks(view.aggregation)).toEqual([]);
  });

  it("計画日を設定すると候補が出る（計画日の active 版で、保存済み項目の版は動かさない）", async () => {
    const { menuId, blockId } = await makeMenu();
    const created = await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const before = await prisma.menuItem.findUnique({ where: { id: created.data.id }, select: { ruleSetVersion: true, ruleSetContentHash: true } });

    const view = await viewOf(menuId);
    expect(view.picker.status).toBe("OK");
    const after = await prisma.menuItem.findUnique({ where: { id: created.data.id }, select: { ruleSetVersion: true, ruleSetContentHash: true } });
    expect(after).toEqual(before);
  });
});

describe("R10-B4B: 画面からの保存操作", () => {
  it("設定の保存 → 候補が出る（計画日を今日で補わない）", async () => {
    const { menuId } = await makeMenu(null);
    const saved = await updateRunningMenuContextAction(menuId, null, form({ runningContext: JSON.stringify(contextObject()) }));
    expect(saved.ok, JSON.stringify(saved)).toBe(true);

    const view = await viewOf(menuId);
    expect(view.context.status).toBe("VALID");
    expect(view.context.draft.plannedDate).toBe("2026-09-20");
    expect(view.picker.status).toBe("OK");
  });

  it("数値の調整 → 保存済みの版のまま置き換わる", async () => {
    const { menuId, blockId } = await makeMenu();
    const created = await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const before = await viewOf(menuId);
    const item = before.items[created.data.id];
    if (item?.status !== "OK") throw new Error("unreachable");

    const editable = item.item.editor.fields.find((f) => f.editable && !f.readOnly && f.coachEditable !== null);
    expect(editable, "調整できる項目が1つ以上ある").toBeDefined();
    const target = editable!;
    const newValue = target.coachEditable!.min;
    const result = await editRunningItemAction(menuId, null, form({ itemId: created.data.id, field: target.keyInternal, value: String(newValue) }));
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const row = await prisma.menuItem.findUnique({ where: { id: created.data.id }, select: { ruleSetVersion: true } });
    expect(row?.ruleSetVersion).toBe("rs-2026.09.0");
  });

  it("「現行ルールで再計算」を押したときだけ、版が現行へ動く", async () => {
    const { menuId, blockId } = await makeMenu();
    const created = await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });
    if (!created.ok) throw new Error(JSON.stringify(created));

    const result = await recalculateWithActiveRuleSetAction(menuId, null, form({ itemId: created.data.id }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.message).toContain("現行ルールで再計算");
  });

  it("flag OFF では、画面からの保存操作をすべて拒否する", async () => {
    const { menuId, blockId } = await makeMenu();
    vi.stubEnv("RUNNING_V2_UI_ENABLED", "false");
    const planned = await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });
    const context = await updateRunningMenuContextAction(menuId, null, form({ runningContext: JSON.stringify(contextObject()) }));
    expect(planned.ok).toBe(false);
    expect(context.ok).toBe(false);
    expect(await prisma.menuItem.count()).toBe(0);
  });
});

describe("R10-B4B: 確認が必要なときの往復（UI と同じ FormData 経路）", () => {
  /** 練習全体の総走行距離を確認範囲にする legacy 項目（B4A の action-contract テストと同じ作り方）。 */
  async function addLongLegacyRun(blockId: string) {
    const ex = await makeExercise({ category: "ENDURANCE" });
    return addMenuItem(blockId, menuItemInputSchema.parse({ exerciseId: ex.id, distanceMeters: "9000" }));
  }

  it("確認 → 同じ操作をもう一度、で追加できる（入力値を勝手に直さない）", async () => {
    const { menuId, blockId } = await makeMenu();
    await addLongLegacyRun(blockId);

    const first = await plan(menuId, blockId, { method: "ACCELERATION", templateId: "ACC_BLOCK_30" });
    expect(first.ok).toBe(false);
    if (first.ok || first.kind !== "CONFIRMATION_REQUIRED") throw new Error(JSON.stringify(first));
    expect(first.requiredFindingCodes.length).toBeGreaterThan(0);
    expect(dtoRawKeyLeaks(first.findings)).toEqual([]);
    expect(await prisma.menuItem.count()).toBe(1); // 保存していない（legacy 項目だけ）

    const confirmed = await plan(menuId, blockId, {
      method: "ACCELERATION",
      templateId: "ACC_BLOCK_30",
      confirmedFindingCodes: first.requiredFindingCodes,
    });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    expect(await prisma.menuItem.count()).toBe(2);

    // 画面の合計にも、同じ確認事項がそのまま出る
    const view = await viewOf(menuId);
    if (view.aggregation.status !== "EVALUATED") throw new Error(JSON.stringify(view.aggregation));
    expect(view.aggregation.findings.map((f) => f.developerCode)).toEqual(expect.arrayContaining(first.requiredFindingCodes));
  });

  it("以前の結果に対する確認は使えない（やり直しを求める）", async () => {
    const { menuId, blockId } = await makeMenu();
    const stale = await plan(menuId, blockId, {
      method: "ACCELERATION",
      templateId: "ACC_BLOCK_30",
      confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM"],
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.kind).toBe("CONFIRMATION_STATE_STALE");
    expect(await prisma.menuItem.count()).toBe(0);
  });
});
