/**
 * R10-B1 — running-actions.ts の統合テスト（plan / edit / override / recalculate、legacy guard、
 * feature flag、exact RuleSet 選択、T-AI-07）。
 *
 * 既存 Action テストの規約どおり `next/cache` / `next/navigation` を mock する。
 * DB は prisma/test.db（vitest globalSetup）。実 dev.db には触れない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../../helpers";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { addMenuItem, updateMenuItem, findMenuItemPrescriptionKind } from "@/infra/repositories/menu-repository";
import { createRunningMenuItem, saveMenuRunningContext, findRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { getRuleSet } from "@/domain/running/rules/loader";
import * as loader from "@/domain/running/rules/loader";
import { planWith, persistInputFor } from "../../repository/running/fixtures";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { planRunningItemAction, editRunningItemAction, overrideRunningItemAction, recalculateWithActiveRuleSetAction } = await import(
  "@/actions/running-actions"
);
const { updateMenuItemAction } = await import("@/actions/menu-actions");

const PLANNED_DATE = "2026-09-20";
const PLANNED_AT = "2026-09-20T16:00:00+09:00";

function runningContextJson(overrides: Partial<{ plannedDate: string | null; plannedAt: string | null; availableMinutes: number | null }> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "テストグループ",
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
    plannedDate: "plannedDate" in overrides ? overrides.plannedDate : PLANNED_DATE,
    plannedAt: "plannedAt" in overrides ? overrides.plannedAt : PLANNED_AT,
    availableMinutes: "availableMinutes" in overrides ? overrides.availableMinutes : 90,
  });
}

async function makeMenuWithRunningContext(contextOverrides: Parameters<typeof runningContextJson>[0] = {}) {
  const menu = await prisma.menuTemplate.create({ data: { name: "走メニュー", blocks: { create: { name: "主運動", sortOrder: 0 } } }, include: { blocks: true } });
  await saveMenuRunningContext(menu.id, runningContextJson(contextOverrides));
  return { menu, block: menu.blocks[0] };
}

function planFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function planAccViaAction(menuId: string, blockId: string, positionPreference = "") {
  return planRunningItemAction(
    menuId,
    blockId,
    null,
    planFormData({ method: "ACCELERATION", templateId: "ACC_BLOCK_30", positionPreference }),
  );
}

describe("running-actions: feature flag gate", () => {
  beforeEach(resetDb);
  afterEach(() => vi.unstubAllEnvs());

  it.each(["", "1", "TRUE", "false"])("RUNNING_V2_UI_ENABLED=%s のとき4つの Action すべてを拒否する", async (value) => {
    vi.stubEnv("RUNNING_V2_UI_ENABLED", value);
    const { menu, block } = await makeMenuWithRunningContext();
    const planResult = await planAccViaAction(menu.id, block.id);
    expect(planResult.ok).toBe(false);

    const editResult = await editRunningItemAction(menu.id, null, planFormData({ itemId: "x", field: "repRestS", value: "150" }));
    expect(editResult.ok).toBe(false);
    const overrideResult = await overrideRunningItemAction(
      menu.id,
      null,
      planFormData({ itemId: "x", targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "350", reason: "コーチ判断のテスト理由文" }),
    );
    expect(overrideResult.ok).toBe(false);
    const recalcResult = await recalculateWithActiveRuleSetAction(menu.id, null, planFormData({ itemId: "x" }));
    expect(recalcResult.ok).toBe(false);

    expect(await prisma.menuItem.count()).toBe(0);
  });

  it('RUNNING_V2_UI_ENABLED="true" なら plan が進む（成功する）', async () => {
    vi.stubEnv("RUNNING_V2_UI_ENABLED", "true");
    const { menu, block } = await makeMenuWithRunningContext();
    const result = await planAccViaAction(menu.id, block.id);
    expect(result.ok).toBe(true);
  });

  it("flag OFF でも legacy Action は通常どおり動く（legacy は flag の影響を受けない）", async () => {
    vi.stubEnv("RUNNING_V2_UI_ENABLED", "false");
    const { block } = await makeMenuWithRunningContext();
    const legacy = await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "ドリル", reps: "10" }));
    const fd = planFormData({ exerciseId: "", displayName: "ドリル2", sets: "3", reps: "10" });
    const updated = await updateMenuItemAction(String((await prisma.menuTemplate.findFirstOrThrow()).id), legacy.id, null, fd);
    expect(updated.ok).toBe(true);
  });
});

describe("running-actions: planRunningItemAction", () => {
  beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(resetDb);

  it("method/templateId/positionPreference だけを受け取り、RuleSet version・confidence・evidenceIds はユーザー入力から取らない", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const result = await planAccViaAction(menu.id, block.id, "LOWER");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const saved = await findRunningMenuItem(result.data.id);
    expect(saved?.status).toBe("VALID");
    if (saved?.status !== "VALID") throw new Error("unreachable");
    expect(saved.prescription.method).toBe("ACCELERATION");
    expect(saved.prescription.templateId).toBe("ACC_BLOCK_30");
    expect(saved.prescription.planningControls).toEqual({ positionPreference: "LOWER" });
    expect(saved.prescription.ruleSet.version).toBe("rs-2026.09.0");
    // GROUP subject（marks を持たない）
    expect(saved.prescription.confidence.inputData).not.toBe("HIGH");
    // [R10-B1.1] GROUP に member（ageBandOverride: "U18"）がいるので、provenance は
    // "UNKNOWN" へ丸めず実際に解決された値を記録する。
    expect(saved.provenance.inputsDigest.ageBand).toBe("U18");
    expect(saved.provenance.inputsDigest.trainingAgeTier).toBe("ADVANCED");
  });

  it("positionPreference 未指定（空文字）は null として保存される", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const result = await planAccViaAction(menu.id, block.id, "");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const saved = await findRunningMenuItem(result.data.id);
    if (saved?.status !== "VALID") throw new Error("unreachable");
    expect(saved.prescription.planningControls).toEqual({ positionPreference: null });
  });

  it("plannedDate が無いメニューは PLANNED_DATE_REQUIRED で拒否する（today で代用しない）", async () => {
    const { menu, block } = await makeMenuWithRunningContext({ plannedDate: null, plannedAt: null });
    const result = await planAccViaAction(menu.id, block.id);
    expect(result.ok).toBe(false);
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it("runningContextJson の無いメニューは拒否する", async () => {
    const menu = await prisma.menuTemplate.create({ data: { name: "空メニュー", blocks: { create: { name: "主運動", sortOrder: 0 } } }, include: { blocks: true } });
    const result = await planAccViaAction(menu.id, menu.blocks[0].id);
    expect(result.ok).toBe(false);
  });

  it("otherItems: 同じメニューの他の legacy 項目（Exercise 無し・category 不明）が集計へ渡り、AGG_LEGACY_CATEGORY_UNKNOWN が付く", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    // Exercise 無しの自由入力 legacy 項目（category が RuleSet の LEGACY_CATEGORY に無いため UNKNOWN 扱い）
    await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "ジョグ", distanceMeters: "1000" }));

    const result = await planAccViaAction(menu.id, block.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // §11 の session-scope Finding は prescription.findings（item scope）には入らない。
    // Action の戻り値（sessionFindings）で見る。
    expect(result.data.sessionFindings.some((f) => f.code === "AGG_LEGACY_CATEGORY_UNKNOWN")).toBe(true);
  });

  it("otherItems: 他の RUNNING_V2 項目（先に保存済み）も集計に含まれる（自分自身を二重計上しない）", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const first = await planAccViaAction(menu.id, block.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const firstSaved = await findRunningMenuItem(first.data.id);
    if (firstSaved?.status !== "VALID") throw new Error("unreachable");

    const second = await planAccViaAction(menu.id, block.id);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");

    // 1件目を再取得しても値は変わらない（2件目の追加が1件目を書き換えない）
    const firstAfter = await findRunningMenuItem(first.data.id);
    if (firstAfter?.status !== "VALID") throw new Error("unreachable");
    expect(firstAfter.prescription.sets).toEqual(firstSaved.prescription.sets);
  });
});

describe("running-actions: editRunningItemAction", () => {
  beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(resetDb);

  it("coachEditable 内の値へ編集し、domain の再計画を通して保存する", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const created = await planAccViaAction(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");

    const result = await editRunningItemAction(menu.id, null, planFormData({ itemId: created.data.id, field: "repRestS", value: "250" }));
    expect(result.ok).toBe(true);

    const saved = await findRunningMenuItem(created.data.id);
    if (saved?.status !== "VALID") throw new Error("unreachable");
    expect(saved.prescription.rest.repRestS.value).toBe(250);
    expect(saved.prescription.rest.repRestS.origin).toBe("COACH");
    expect(saved.provenance.coachEdits).toEqual([{ at: expect.any(String), field: "repRestS", from: expect.any(Number), to: 250 }]);
  });

  it("対象が LEGACY なら拒否する（RUNNING_V2 専用）", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const legacy = await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "ドリル", reps: "10" }));
    const result = await editRunningItemAction(menu.id, null, planFormData({ itemId: legacy.id, field: "repRestS", value: "250" }));
    expect(result.ok).toBe(false);
  });

  it("未対応フィールド（totalReps 等）は拒否する（誤った from を捏造しない）", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const created = await planAccViaAction(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    const result = await editRunningItemAction(menu.id, null, planFormData({ itemId: created.data.id, field: "totalReps", value: "10" }));
    expect(result.ok).toBe(false);
  });

  it("旧 snapshot（planningControls 無し）は REPLAN_INPUT_SNAPSHOT_MISSING 相当で拒否する", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const created = await planAccViaAction(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: created.data.id } });
    const old = JSON.parse(item.prescriptionJson!);
    delete old.planningControls;
    await prisma.menuItem.update({ where: { id: created.data.id }, data: { prescriptionJson: JSON.stringify(old) } });

    const result = await editRunningItemAction(menu.id, null, planFormData({ itemId: created.data.id, field: "repRestS", value: "250" }));
    expect(result.ok).toBe(false);
  });
});

describe("running-actions: overrideRunningItemAction", () => {
  beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(resetDb);

  it("CoachActor を伴う FIELD override（coachEditable の外）を保存する。理由10文字未満は拒否", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const created = await planAccViaAction(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");

    const tooShort = await overrideRunningItemAction(
      menu.id,
      null,
      planFormData({ itemId: created.data.id, targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "350", reason: "短い", confirmedTwice: "false" }),
    );
    expect(tooShort.ok).toBe(false);

    const result = await overrideRunningItemAction(
      menu.id,
      null,
      planFormData({ itemId: created.data.id, targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "350", reason: "コーチ判断で例外的に延長する", confirmedTwice: "false" }),
    );
    expect(result.ok).toBe(true);

    const saved = await findRunningMenuItem(created.data.id);
    if (saved?.status !== "VALID") throw new Error("unreachable");
    expect(saved.prescription.rest.repRestS.value).toBe(350);
    expect(saved.prescription.rest.repRestS.origin).toBe("COACH_OVERRIDE");
    expect(saved.provenance.overrides).toHaveLength(1);
    expect(saved.provenance.overrides[0]).toMatchObject({ target: { kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" }, to: 350 });
  });
});

describe("running-actions: exact RuleSet の選択（§16・§17）", () => {
  beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  beforeEach(resetDb);

  it("edit / override は getActiveRuleSet を一度も呼ばない（保存済み version+hash の厳密一致だけを使う。§16 の silent upgrade 禁止）", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const created = await planAccViaAction(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    const before = await prisma.menuItem.findUniqueOrThrow({ where: { id: created.data.id } });

    const activeSpy = vi.spyOn(loader, "getActiveRuleSet");
    const identitySpy = vi.spyOn(loader, "getRuleSetByIdentity");

    const editResult = await editRunningItemAction(menu.id, null, planFormData({ itemId: created.data.id, field: "repRestS", value: "250" }));
    expect(editResult.ok).toBe(true);
    const overrideResult = await overrideRunningItemAction(
      menu.id,
      null,
      planFormData({ itemId: created.data.id, targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "350", reason: "コーチ判断で例外的に延長する", confirmedTwice: "false" }),
    );
    expect(overrideResult.ok).toBe(true);

    expect(activeSpy).not.toHaveBeenCalled();
    expect(identitySpy).toHaveBeenCalledTimes(2);
    expect(identitySpy).toHaveBeenCalledWith({ version: before.ruleSetVersion, contentHash: before.ruleSetContentHash });

    const after = await findRunningMenuItem(created.data.id);
    if (after?.status !== "VALID") throw new Error("unreachable");
    expect(after.prescription.ruleSet.version).toBe(before.ruleSetVersion);
  });

  it("保存済み ruleSetContentHash が改変されていたら edit / override を拒否する（version が実在しても current 版へフォールバックしない）", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const created = await planAccViaAction(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    await prisma.menuItem.update({ where: { id: created.data.id }, data: { ruleSetContentHash: "0".repeat(64) } });

    const editResult = await editRunningItemAction(menu.id, null, planFormData({ itemId: created.data.id, field: "repRestS", value: "250" }));
    expect(editResult.ok).toBe(false);
    // 拒否しただけで、値は書き換わっていない（current 版で黙って上書きしていない）
    const stillBroken = await prisma.menuItem.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(stillBroken.ruleSetContentHash).toBe("0".repeat(64));
  });

  it("recalculate だけが getActiveRuleSet を呼ぶ（plannedDate 基準）。既存 override は引き継がない", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const created = await planAccViaAction(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    // override を持たせておく（recalculate で drop されることを確認するため、直接 provenance を書き換える）
    const withOverride = JSON.parse((await prisma.menuItem.findUniqueOrThrow({ where: { id: created.data.id } })).provenanceJson!);
    withOverride.overrides = [
      { at: "2026-09-15T09:00:00+09:00", target: { kind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE" }, to: 350, reason: "以前の override" },
    ];
    await prisma.menuItem.update({ where: { id: created.data.id }, data: { provenanceJson: JSON.stringify(withOverride) } });

    const activeSpy = vi.spyOn(loader, "getActiveRuleSet");
    const result = await recalculateWithActiveRuleSetAction(menu.id, null, planFormData({ itemId: created.data.id }));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/override/);
    expect(activeSpy).toHaveBeenCalledWith(PLANNED_DATE);

    const saved = await findRunningMenuItem(created.data.id);
    if (saved?.status !== "VALID") throw new Error("unreachable");
    expect(saved.prescription.ruleSet.version).toBe("rs-2026.09.0");
    expect(saved.provenance.overrides).toEqual([]);
  });
});

describe("running-actions: legacy guard（§37/§39。flag と独立して常時有効）", () => {
  beforeEach(resetDb);
  afterEach(() => vi.unstubAllEnvs());

  it("汎用 updateMenuItemAction は RUNNING_V2 行を拒否する。LEGACY は今までどおり動く", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    const legacy = await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "旧ドリル", reps: "10" }));
    const okResult = await updateMenuItemAction(menu.id, legacy.id, null, planFormData({ exerciseId: "", displayName: "旧ドリル2", reps: "12" }));
    expect(okResult.ok).toBe(true);

    const v2 = await createRunningMenuItem(block.id, persistInputFor(planWith({ ruleSet: getRuleSet("rs-2026.09.0")!, contentHash: "dca25fa7fc3d062c98f3a53e43488d8b5163196e35624ba5b67a1dbd750af30e", isDraftFallback: false }, "ACCELERATION", "ACC_BLOCK_30")));
    const rejected = await updateMenuItemAction(menu.id, v2.id, null, planFormData({ exerciseId: "", displayName: "上書きしようとする", sets: "9" }));
    expect(rejected.ok).toBe(false);
    expect(await prisma.menuItem.findUniqueOrThrow({ where: { id: v2.id } })).toMatchObject({ displayName: v2.displayName });
  });

  it("repository の updateMenuItem も独立に RUNNING_V2 を拒否する（二重の守り）", async () => {
    const { block } = await makeMenuWithRunningContext();
    const v2 = await createRunningMenuItem(block.id, persistInputFor(planWith({ ruleSet: getRuleSet("rs-2026.09.0")!, contentHash: "dca25fa7fc3d062c98f3a53e43488d8b5163196e35624ba5b67a1dbd750af30e", isDraftFallback: false }, "ACCELERATION", "ACC_BLOCK_30")));
    await expect(updateMenuItem(v2.id, menuItemInputSchema.parse({ displayName: "直接book", sets: "9" }))).rejects.toThrow();
    expect(await findMenuItemPrescriptionKind(v2.id)).toBe("RUNNING_V2");
  });

  it("move / delete は RUNNING_V2 でも従来どおり許可される", async () => {
    const { block } = await makeMenuWithRunningContext();
    const v2 = await createRunningMenuItem(block.id, persistInputFor(planWith({ ruleSet: getRuleSet("rs-2026.09.0")!, contentHash: "dca25fa7fc3d062c98f3a53e43488d8b5163196e35624ba5b67a1dbd750af30e", isDraftFallback: false }, "ACCELERATION", "ACC_BLOCK_30")));
    const { moveMenuItem, deleteMenuItem } = await import("@/infra/repositories/menu-repository");
    await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "隣", reps: "10" }));
    await expect(moveMenuItem(v2.id, "down")).resolves.not.toThrow();
    await expect(deleteMenuItem(v2.id)).resolves.not.toThrow();
  });
});

describe("T-AI-07 相当: 48h 以内 RACE + Coach 手動 MAX_VELOCITY", () => {
  beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(resetDb);

  it("BLOCK_AUTOGEN が付いても Coach 操作なら保存でき、Finding は保持される", async () => {
    const { menu, block } = await makeMenuWithRunningContext();
    // 24h 前（48h 以内）に大会セッション（RACE 相当）を記録しておく
    await prisma.trainingSession.create({
      data: { title: "大会", date: new Date("2026-09-19T16:00:00+09:00"), status: "COMPLETED", sessionKind: "COMPETITION" },
    });

    const result = await planRunningItemAction(menu.id, block.id, null, planFormData({ method: "MAX_VELOCITY", templateId: "MV_FLY20", positionPreference: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const saved = await findRunningMenuItem(result.data.id);
    if (saved?.status !== "VALID") throw new Error("unreachable");
    expect(saved.prescription.findings.some((f) => f.code === "WEEKLY_HIGH_WITHIN_48H" && f.severity === "BLOCK_AUTOGEN")).toBe(true);
  });
});
