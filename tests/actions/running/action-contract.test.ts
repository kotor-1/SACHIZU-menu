/**
 * R10-B4A — Action Contract Closure の統合テスト（running-actions.ts + _running-plan-service.ts）。
 *
 *   - override の confirmedTwice: Action の入力値をそのまま domain の CoachOverride schema へ（true 固定の廃止）
 *   - REQUIRE_CONFIRMATION の明示確認: confirmedFindingCodes / 現在の結果での照合 / stale / 監査記録 / 引き継がない
 *   - aggregate field の直接 edit 拒否、RunningMenuContext Action、plan 拒否の presentation-ready result
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { makeExercise, resetDb } from "../../helpers";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { addMenuItem } from "@/infra/repositories/menu-repository";
import { createRunningMenuItem, findMenuRunningContext, findRunningMenuItem, saveMenuRunningContext } from "@/infra/repositories/running-item-repository";
import { getRuleSet } from "@/domain/running/rules/loader";
import { athlete, planWith, persistInputFor } from "../../repository/running/fixtures";
import { dtoRawKeyLeaks, rawKeyLeaks } from "../../presentation/running/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { planRunningItemAction, editRunningItemAction, overrideRunningItemAction, recalculateWithActiveRuleSetAction, updateRunningMenuContextAction } =
  await import("@/actions/running-actions");

const PRODUCTION_HASH = "c73297f8850fe8d6a6bf7a4c918b49ceb6fb9477edc429352aecbeddf6b657ba";
const SESSION_CONFIRM = "AGG_TOTAL_RUNNING_CONFIRM";
const ITEM_CONFIRM = "PLAUSIBILITY_REQUIRE_CONFIRMATION";

type ContextOverrides = Partial<{ plannedDate: string | null; plannedAt: string | null; availableMinutes: number | null; ageBandOverride: string; allowAdvancedMethods: boolean }>;

function contextObject(o: ContextOverrides = {}) {
  return {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "テストグループ",
      members: [
        {
          ageBandOverride: o.ageBandOverride ?? "U18",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: "2026-09-01" },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
          primaryEvent: "400m",
        },
      ],
      allowAdvancedMethods: o.allowAdvancedMethods ?? true,
    },
    plannedDate: "plannedDate" in o ? o.plannedDate : "2026-09-20",
    plannedAt: "plannedAt" in o ? o.plannedAt : "2026-09-20T16:00:00+09:00",
    availableMinutes: "availableMinutes" in o ? o.availableMinutes : 90,
  };
}

async function makeMenu(o: ContextOverrides = {}) {
  const menu = await prisma.menuTemplate.create({ data: { name: "走メニュー", blocks: { create: { name: "主運動", sortOrder: 0 } } }, include: { blocks: true } });
  await saveMenuRunningContext(menu.id, JSON.stringify(contextObject(o)));
  return { menu, block: menu.blocks[0]! };
}

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

/** 練習全体の総走行距離を確認範囲（8,000m 超〜30,000m）にする legacy 項目。 */
async function addLongLegacyRun(blockId: string) {
  const ex = await makeExercise({ category: "ENDURANCE" });
  return addMenuItem(blockId, menuItemInputSchema.parse({ exerciseId: ex.id, distanceMeters: "9000" }));
}

async function planAcc(menuId: string, blockId: string, confirmedFindingCodes: string[] = []) {
  return planRunningItemAction(menuId, blockId, null, form({ method: "ACCELERATION", templateId: "ACC_BLOCK_30", positionPreference: "", confirmedFindingCodes }));
}

async function saved(itemId: string) {
  const s = await findRunningMenuItem(itemId);
  if (s?.status !== "VALID") throw new Error(`item not valid: ${JSON.stringify(s)}`);
  return s;
}

beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
beforeEach(resetDb);

// ---------------------------------------------------------------------------
// P0: override confirmedTwice
// ---------------------------------------------------------------------------

/** GROUP（上級許可なし）では INELIGIBLE になる advancedOnly の保存済み項目（強度基準は保存済み vdec を再利用）。 */
async function savedHeavySledOnRestrictedMenu() {
  const { menu, block } = await makeMenu({ ageBandOverride: "ADULT", allowAdvancedMethods: false });
  const prescription = planWith({ ruleSet: getRuleSet("rs-2026.09.0")!, contentHash: PRODUCTION_HASH, isDraftFallback: false }, "RESISTED_SPRINT", "RS_SLED_HEAVY", {
    subject: athlete({ birthDate: "1998-01-01" as never }),
    coachReference: { kind: "VELOCITY_DECREMENT", band: "HEAVY", measured: true },
  });
  const item = await createRunningMenuItem(block.id, persistInputFor(prescription));
  return { menu, block, item };
}

describe("R10-B4A: override confirmedTwice（Action 入力 → domain schema）", () => {
  it("confirmedTwice の入力が無ければ入力エラー（true / false に補わない）", async () => {
    const { menu, block } = await makeMenu();
    const created = await planAcc(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    const result = await overrideRunningItemAction(
      menu.id,
      null,
      form({ itemId: created.data.id, targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "350", reason: "コーチ判断で例外的に延長する" }),
    );
    expect(result).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    if (result.ok || result.kind !== "INVALID_INPUT") throw new Error("unreachable");
    expect(result.fieldErrors?.confirmedTwice).toBeDefined();
    expect((await saved(created.data.id)).provenance.overrides).toEqual([]);
  });

  it("ELIGIBILITY override: confirmedTwice=false は domain schema が拒否し保存しない。true なら domain の条件を満たして保存でき、記録に true が残る", async () => {
    const { menu, item } = await savedHeavySledOnRestrictedMenu();

    // まず通常 edit は、上級許可の無いグループでは INELIGIBLE（presentation-ready な理由付き）
    const edit = await editRunningItemAction(menu.id, null, form({ itemId: item.id, field: "repRestS", value: "300" }));
    expect(edit).toMatchObject({ ok: false, kind: "PLAN_INELIGIBLE" });
    if (edit.ok || edit.kind !== "PLAN_INELIGIBLE") throw new Error("unreachable");
    const advancedOnly = edit.reasons.find((r) => r.developerCode === "ADVANCED_ONLY_NOT_PERMITTED")!;
    expect(advancedOnly).toMatchObject({ overrideAllowed: true, ruleIdInternal: "ADVANCED_ONLY:RS_SLED_HEAVY" });
    expect(advancedOnly.message).toBe("上級者向けの練習の型のため、この対象では選べません。");
    expect(rawKeyLeaks(edit.message)).toEqual([]);
    expect(dtoRawKeyLeaks(edit.reasons)).toEqual([]);

    const eligibilityForm = (confirmedTwice: string) =>
      form({ itemId: item.id, targetKind: "ELIGIBILITY", ruleId: "ADVANCED_ONLY:RS_SLED_HEAVY", reason: "経験のある成人選手のためコーチ判断で実施する", confirmedTwice });

    const rejected = await overrideRunningItemAction(menu.id, null, eligibilityForm("false"));
    expect(rejected).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    if (rejected.ok || rejected.kind !== "INVALID_INPUT") throw new Error("unreachable");
    expect(rejected.fieldErrors?.confirmedTwice).toEqual(["この例外設定には、2段階の確認が必要です。"]);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).provenanceJson).toBe(item.provenanceJson);

    const accepted = await overrideRunningItemAction(menu.id, null, eligibilityForm("true"));
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    const after = await saved(item.id);
    expect(after.provenance.overrides).toEqual([
      expect.objectContaining({ target: { kind: "ELIGIBILITY", ruleId: "ADVANCED_ONLY:RS_SLED_HEAVY" }, confirmedTwice: true }),
    ]);

    // 以後の edit は保存済みの confirmedTwice=true でそのまま再構築される（自動昇格ではなく記録の値）
    const editAfter = await editRunningItemAction(menu.id, null, form({ itemId: item.id, field: "repRestS", value: "300" }));
    expect(editAfter.ok, JSON.stringify(editAfter)).toBe(true);
  });

  it("確認の記録が無い（B4A より前の）ELIGIBILITY override 履歴は true に昇格せず、再構築を拒否する", async () => {
    const { menu, item } = await savedHeavySledOnRestrictedMenu();
    const ok = await overrideRunningItemAction(
      menu.id,
      null,
      form({ itemId: item.id, targetKind: "ELIGIBILITY", ruleId: "ADVANCED_ONLY:RS_SLED_HEAVY", reason: "経験のある成人選手のためコーチ判断で実施する", confirmedTwice: "true" }),
    );
    expect(ok.ok).toBe(true);
    const row = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    const legacy = JSON.parse(row.provenanceJson!);
    delete legacy.overrides[0].confirmedTwice;
    await prisma.menuItem.update({ where: { id: item.id }, data: { provenanceJson: JSON.stringify(legacy) } });

    const edit = await editRunningItemAction(menu.id, null, form({ itemId: item.id, field: "repRestS", value: "300" }));
    expect(edit).toMatchObject({ ok: false, kind: "REJECTED" });
    if (edit.ok) throw new Error("unreachable");
    expect(edit.message).toMatch(/確認の記録が無い/);
  });

  it("HARD_SAFETY override: confirmedTwice=false は domain schema で拒否。true は schema を通り domain の判定へ進む（本番 RuleSet に hardSafety セルが無いので対象不正で止まる）", async () => {
    const { menu, block } = await makeMenu();
    const created = await planAcc(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    const hardSafetyForm = (confirmedTwice: string) =>
      form({ itemId: created.data.id, targetKind: "FIELD", field: "repRestS", layer: "HARD_SAFETY", newValue: "1000", reason: "安全上の範囲の外を検証するテスト", confirmedTwice });

    const rejected = await overrideRunningItemAction(menu.id, null, hardSafetyForm("false"));
    expect(rejected).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    if (rejected.ok || rejected.kind !== "INVALID_INPUT") throw new Error("unreachable");
    expect(rejected.fieldErrors?.confirmedTwice).toBeDefined();

    const reachesDomain = await overrideRunningItemAction(menu.id, null, hardSafetyForm("true"));
    expect(reachesDomain).toMatchObject({ ok: false, kind: "PLAN_BLOCKED" });
    expect((await saved(created.data.id)).provenance.overrides).toEqual([]);
  });

  it("COACH_EDITABLE override は confirmedTwice=false でも domain が許せば保存でき、送られた false をそのまま記録する", async () => {
    const { menu, block } = await makeMenu();
    const created = await planAcc(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    const result = await overrideRunningItemAction(
      menu.id,
      null,
      form({ itemId: created.data.id, targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "700", reason: "コーチ判断で例外的に延長する", confirmedTwice: "false" }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await saved(created.data.id)).provenance.overrides[0]).toMatchObject({ confirmedTwice: false });
  });

  it("source audit: service / Action に confirmedTwice を true へ固定・補完するコードが無い", () => {
    for (const file of ["src/actions/_running-plan-service.ts", "src/actions/running-actions.ts"]) {
      const code = fs
        .readFileSync(path.join(process.cwd(), file), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code, file).not.toMatch(/confirmedTwice:\s*true/);
      expect(code, file).not.toMatch(/confirmedTwice\s*\?\?\s*true/);
      expect(code, file).not.toMatch(/confirmedTwice[^\n]*\|\|\s*true/);
      expect(code, file).not.toMatch(/confirmedTwice\s*=\s*true/);
    }
  });
});

// ---------------------------------------------------------------------------
// REQUIRE_CONFIRMATION の明示確認
// ---------------------------------------------------------------------------

describe("R10-B4A: Finding confirmation（confirmedFindingCodes）", () => {
  it("確認が必要な Finding が無ければ [] で保存でき、監査記録の key を持たない", async () => {
    const { menu, block } = await makeMenu();
    const result = await planAcc(menu.id, block.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect("findingConfirmations" in (await saved(result.data.id)).provenance).toBe(false);
  });

  it("確認が必要なのに [] なら CONFIRMATION_REQUIRED（保存しない）。日本語の Finding DTO を返し、message に code を出さない", async () => {
    const { menu, block } = await makeMenu();
    await addLongLegacyRun(block.id);
    const before = await prisma.menuItem.count();
    const result = await planAcc(menu.id, block.id);
    expect(result).toMatchObject({ ok: false, kind: "CONFIRMATION_REQUIRED", requiredFindingCodes: [SESSION_CONFIRM] });
    if (result.ok || result.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");
    expect(result.findings.map((f) => f.confirmationKey)).toEqual([SESSION_CONFIRM]);
    expect(result.findings[0]!.message).toMatch(/総走行距離/);
    expect(result.findings[0]!.requiresExplicitConfirmation).toBe(true);
    expect(rawKeyLeaks(result.message)).toEqual([]);
    expect(dtoRawKeyLeaks(result.findings)).toEqual([]);
    expect(await prisma.menuItem.count()).toBe(before);
  });

  it("required A + [A] なら保存。Finding は消さず、provenance に A の確認記録を残す", async () => {
    const { menu, block } = await makeMenu();
    await addLongLegacyRun(block.id);
    const result = await planAcc(menu.id, block.id, [SESSION_CONFIRM]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.sessionFindings.map((f) => f.code)).toContain(SESSION_CONFIRM);
    expect(result.data.sessionFindingViews.some((f) => f.confirmationKey === SESSION_CONFIRM)).toBe(true);
    expect((await saved(result.data.id)).provenance.findingConfirmations).toEqual([{ code: SESSION_CONFIRM, at: expect.any(String) }]);
  });

  it("item の REQUIRE_CONFIRMATION を確認して保存すると、Finding は処方に残る（override したこと自体は確認とみなさない）", async () => {
    const { menu, block } = await makeMenu();
    const created = await planAcc(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    const overrideForm = (confirmedFindingCodes: string[]) =>
      form({ itemId: created.data.id, targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "2500", reason: "特別な回復を取るための例外設定", confirmedTwice: "false", confirmedFindingCodes });

    const unconfirmed = await overrideRunningItemAction(menu.id, null, overrideForm([]));
    expect(unconfirmed).toMatchObject({ ok: false, kind: "CONFIRMATION_REQUIRED", requiredFindingCodes: [ITEM_CONFIRM] });

    const confirmed = await overrideRunningItemAction(menu.id, null, overrideForm([ITEM_CONFIRM]));
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    const after = await saved(created.data.id);
    expect(after.prescription.rest.repRestS.value).toBe(2500);
    expect(after.prescription.findings).toContainEqual(expect.objectContaining({ code: ITEM_CONFIRM, severity: "REQUIRE_CONFIRMATION" }));
    expect(after.provenance.findingConfirmations?.map((c) => c.code)).toEqual([ITEM_CONFIRM]);
  });

  it("required A / B に [A] だけなら保存しない。A と B の両方で保存", async () => {
    const { menu, block } = await makeMenu();
    await addLongLegacyRun(block.id);
    const created = await planAcc(menu.id, block.id, [SESSION_CONFIRM]);
    if (!created.ok) throw new Error("plan failed");
    const overrideForm = (confirmedFindingCodes: string[]) =>
      form({ itemId: created.data.id, targetKind: "FIELD", field: "repRestS", layer: "COACH_EDITABLE", newValue: "2500", reason: "特別な回復を取るための例外設定", confirmedTwice: "false", confirmedFindingCodes });

    const partial = await overrideRunningItemAction(menu.id, null, overrideForm([SESSION_CONFIRM]));
    expect(partial).toMatchObject({ ok: false, kind: "CONFIRMATION_REQUIRED" });
    if (partial.ok || partial.kind !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");
    expect([...partial.requiredFindingCodes].sort()).toEqual([ITEM_CONFIRM, SESSION_CONFIRM].sort());
    expect((await saved(created.data.id)).prescription.rest.repRestS.value).not.toBe(2500);

    const both = await overrideRunningItemAction(menu.id, null, overrideForm([SESSION_CONFIRM, ITEM_CONFIRM]));
    expect(both.ok, JSON.stringify(both)).toBe(true);
    expect((await saved(created.data.id)).provenance.findingConfirmations?.map((c) => c.code).sort()).toEqual([ITEM_CONFIRM, SESSION_CONFIRM].sort());
  });

  it("現在の結果に無い code の確認は stale として拒否（以前の結果の確認を流用しない）", async () => {
    const { menu, block } = await makeMenu();
    const noneRequired = await planAcc(menu.id, block.id, [SESSION_CONFIRM]);
    expect(noneRequired).toMatchObject({ ok: false, kind: "CONFIRMATION_STATE_STALE", requiredFindingCodes: [] });

    await addLongLegacyRun(block.id);
    const extra = await planAcc(menu.id, block.id, [SESSION_CONFIRM, "AGG_OLD_RESULT_CODE"]);
    expect(extra).toMatchObject({ ok: false, kind: "CONFIRMATION_STATE_STALE", requiredFindingCodes: [SESSION_CONFIRM] });
    if (extra.ok || extra.kind !== "CONFIRMATION_STATE_STALE") throw new Error("unreachable");
    expect(extra.message).toBe("計算結果が変わったため、確認をやり直してください。");
    expect(await prisma.menuItem.count({ where: { prescriptionKind: "RUNNING_V2" } })).toBe(0);
  });

  it("edit: 以前の確認は引き継がない。同じ Finding が再発すれば再確認が必要、消えれば記録も残さない", async () => {
    const { menu, block } = await makeMenu();
    const legacy = await addLongLegacyRun(block.id);
    const created = await planAcc(menu.id, block.id, [SESSION_CONFIRM]);
    if (!created.ok) throw new Error("plan failed");
    const firstConfirmedAt = (await saved(created.data.id)).provenance.findingConfirmations![0]!.at;

    const again = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repRestS", value: "250" }));
    expect(again).toMatchObject({ ok: false, kind: "CONFIRMATION_REQUIRED", requiredFindingCodes: [SESSION_CONFIRM] });
    expect((await saved(created.data.id)).prescription.rest.repRestS.value).not.toBe(250);

    const reconfirmed = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repRestS", value: "250", confirmedFindingCodes: [SESSION_CONFIRM] }));
    expect(reconfirmed.ok, JSON.stringify(reconfirmed)).toBe(true);
    const afterReconfirm = await saved(created.data.id);
    expect(afterReconfirm.provenance.findingConfirmations).toHaveLength(1);
    expect(afterReconfirm.provenance.findingConfirmations![0]!.at >= firstConfirmedAt).toBe(true);

    await prisma.menuItem.delete({ where: { id: legacy.id } });
    const noLongerNeeded = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repRestS", value: "260" }));
    expect(noLongerNeeded.ok, JSON.stringify(noLongerNeeded)).toBe(true);
    expect("findingConfirmations" in (await saved(created.data.id)).provenance).toBe(false);
  });

  it("recalculate: 以前の確認は引き継がず、新しい結果で再発すれば再確認が必要", async () => {
    const { menu, block } = await makeMenu();
    await addLongLegacyRun(block.id);
    const created = await planAcc(menu.id, block.id, [SESSION_CONFIRM]);
    if (!created.ok) throw new Error("plan failed");

    const unconfirmed = await recalculateWithActiveRuleSetAction(menu.id, null, form({ itemId: created.data.id }));
    expect(unconfirmed).toMatchObject({ ok: false, kind: "CONFIRMATION_REQUIRED", requiredFindingCodes: [SESSION_CONFIRM] });

    const confirmed = await recalculateWithActiveRuleSetAction(menu.id, null, form({ itemId: created.data.id, confirmedFindingCodes: [SESSION_CONFIRM] }));
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
  });

  it("confirmedFindingCodes は Finding code の形だけを受け付ける（任意の文字列は入力エラー）", async () => {
    const { menu, block } = await makeMenu();
    const result = await planAcc(menu.id, block.id, ["痛みあり"]);
    expect(result).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
  });
});

// ---------------------------------------------------------------------------
// aggregate field / plan 拒否 result
// ---------------------------------------------------------------------------

describe("R10-B4A: aggregate field と plan 拒否の result", () => {
  it.each(["totalReps", "sessionVolumeM", "flyVolumeM", "attempts", "vdecPercent"])("aggregate field %s の直接 edit は拒否（逆算しない・保存しない）", async (field) => {
    const { menu, block } = await makeMenu();
    const created = await planAcc(menu.id, block.id);
    if (!created.ok) throw new Error("plan failed");
    const before = await prisma.menuItem.findUniqueOrThrow({ where: { id: created.data.id } });
    const result = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field, value: "10" }));
    expect(result).toMatchObject({ ok: false, kind: "REJECTED", message: "この値は他の値から決まる合計・制約の値のため、直接は変更できません。" });
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: created.data.id } })).prescriptionJson).toBe(before.prescriptionJson);
  });

  it("PLAN_BLOCKED は Finding を日本語 DTO で返す（enum を message に出さない）", async () => {
    const { menu, block } = await makeMenu();
    const result = await planRunningItemAction(menu.id, block.id, null, form({ method: "ACCELERATION", templateId: "MV_FLY20", positionPreference: "" }));
    expect(result).toMatchObject({ ok: false, kind: "PLAN_BLOCKED" });
    if (result.ok || result.kind !== "PLAN_BLOCKED") throw new Error("unreachable");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(rawKeyLeaks(result.message)).toEqual([]);
    expect(dtoRawKeyLeaks(result.findings)).toEqual([]);
  });

  it("flag OFF なら新しい確認付き入力でも拒否する", async () => {
    vi.stubEnv("RUNNING_V2_UI_ENABLED", "false");
    const { menu, block } = await makeMenu();
    expect(await planAcc(menu.id, block.id, [SESSION_CONFIRM])).toMatchObject({ ok: false, kind: "REJECTED" });
  });
});

// ---------------------------------------------------------------------------
// RunningMenuContext Action
// ---------------------------------------------------------------------------

describe("R10-B4A: updateRunningMenuContextAction", () => {
  async function emptyMenu() {
    return prisma.menuTemplate.create({ data: { name: "空メニュー" } });
  }

  it("正しい GROUP context を保存する（plannedDate / plannedAt / availableMinutes / allowAdvancedMethods は明示値のまま）", async () => {
    const menu = await emptyMenu();
    const ctx = contextObject({ plannedDate: "2026-10-03", plannedAt: "2026-10-03T09:30:00+09:00", availableMinutes: 75, allowAdvancedMethods: false });
    const result = await updateRunningMenuContextAction(menu.id, null, form({ runningContext: JSON.stringify(ctx) }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const stored = await findMenuRunningContext(menu.id);
    expect(stored?.status).toBe("VALID");
    if (stored?.status !== "VALID") throw new Error("unreachable");
    expect(stored.context).toMatchObject({ plannedDate: "2026-10-03", plannedAt: "2026-10-03T09:30:00+09:00", availableMinutes: 75 });
    expect(stored.context.subject.allowAdvancedMethods).toBe(false);
    expect(stored.raw).toBe(JSON.stringify(stored.context));
  });

  it("plannedDate を補わない（null のまま保存）。その後の新規 plan は従来どおり計画日が必要として拒否", async () => {
    const menu = await prisma.menuTemplate.create({ data: { name: "日付なし", blocks: { create: { name: "主運動", sortOrder: 0 } } }, include: { blocks: true } });
    const result = await updateRunningMenuContextAction(menu.id, null, form({ runningContext: JSON.stringify(contextObject({ plannedDate: null, plannedAt: null })) }));
    expect(result.ok).toBe(true);
    const stored = await findMenuRunningContext(menu.id);
    if (stored?.status !== "VALID") throw new Error("unreachable");
    expect(stored.context.plannedDate).toBeNull();
    const plan = await planAcc(menu.id, menu.blocks[0]!.id);
    expect(plan).toMatchObject({ ok: false, kind: "REJECTED" });
    if (plan.ok) throw new Error("unreachable");
    expect(plan.message).toMatch(/計画日が設定されていません/);
  });

  it("schema に無い field・日付の不整合・JSON 不正は拒否し、既存の設定を変えない", async () => {
    const { menu } = await makeMenu();
    const before = (await prisma.menuTemplate.findUniqueOrThrow({ where: { id: menu.id } })).runningContextJson;
    const cases = [
      JSON.stringify({ ...contextObject(), extraField: 1 }),
      JSON.stringify(contextObject({ plannedDate: "2026-09-20", plannedAt: "2026-09-21T09:00:00+09:00" })),
      JSON.stringify({ ...contextObject(), subject: { ...contextObject().subject, kind: "ATHLETE" } }),
      "{not json",
    ];
    for (const raw of cases) {
      const result = await updateRunningMenuContextAction(menu.id, null, form({ runningContext: raw }));
      expect(result, raw).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    }
    expect((await prisma.menuTemplate.findUniqueOrThrow({ where: { id: menu.id } })).runningContextJson).toBe(before);
  });

  it("健康情報・個人情報のキー（痛み・睡眠・性別・生年月日）は保存しない", async () => {
    const { menu } = await makeMenu();
    const before = (await prisma.menuTemplate.findUniqueOrThrow({ where: { id: menu.id } })).runningContextJson;
    const base = contextObject();
    for (const extra of [{ pain: "膝" }, { sleepHours: 5 }, { sexForNorms: "FEMALE" }, { birthDate: "2010-01-01" }]) {
      const withHealth = { ...base, subject: { ...base.subject, members: [{ ...base.subject.members[0], ...extra }] } };
      const result = await updateRunningMenuContextAction(menu.id, null, form({ runningContext: JSON.stringify(withHealth) }));
      expect(result, JSON.stringify(extra)).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
      if (result.ok) throw new Error("unreachable");
      expect(result.message).toMatch(/健康情報や個人情報/);
    }
    expect((await prisma.menuTemplate.findUniqueOrThrow({ where: { id: menu.id } })).runningContextJson).toBe(before);
  });

  it("flag OFF・存在しないメニューは拒否", async () => {
    const menu = await emptyMenu();
    vi.stubEnv("RUNNING_V2_UI_ENABLED", "false");
    expect(await updateRunningMenuContextAction(menu.id, null, form({ runningContext: JSON.stringify(contextObject()) }))).toMatchObject({ ok: false, kind: "REJECTED" });
    expect((await prisma.menuTemplate.findUniqueOrThrow({ where: { id: menu.id } })).runningContextJson).toBeNull();
    vi.stubEnv("RUNNING_V2_UI_ENABLED", "true");
    expect(await updateRunningMenuContextAction("missing-menu", null, form({ runningContext: JSON.stringify(contextObject()) }))).toMatchObject({
      ok: false,
      kind: "REJECTED",
      message: "メニューが見つかりません。",
    });
  });
});
